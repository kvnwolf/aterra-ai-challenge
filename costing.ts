#!/usr/bin/env bun
/**
 * costing.ts — joins an operational quotation to supplier rate documents and
 * writes a costed quotation with provenance, confidence and a needs_review list.
 *
 *   bun run costing.ts                 # extract (LLM) + cost → output/costed-quotation.json
 *   bun run costing.ts --from-cache    # cost from output/extracted/*.json, no network
 *   bun run costing.ts --check         # validate the output: schema, invariants, golden set
 *
 * Shape: the LLM only transcribes documents into typed records and proposes
 * which rate belongs to which service (ids + assumption text). Everything that
 * is a number — quantities, season splits, arithmetic, confidence, totals — is
 * plain TypeScript below. The prompts know what these document TYPES look like,
 * never what is in these particular documents.
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, extname, join } from "node:path";
import { gateway, generateText, Output } from "ai";
import { z } from "zod";

// ───────────────────────────────────────────── config ──

const MODEL = process.env.COSTING_MODEL ?? "anthropic/claude-opus-5";
const INPUT_DIR = "input";
const OUT_DIR = "output";
const CACHE_DIR = join(OUT_DIR, "extracted");
const OUTPUT_FILE = join(OUT_DIR, "costed-quotation.json");
const EXPECTED_FILE = join(OUT_DIR, "expected.json");
const MAX_ATTEMPTS = 3;

// ───────────────────────────────────────────── schemas (what the LLM fills) ──

const provenanceSchema = z.object({
  document: z.string().describe("File name of the source document."),
  excerpt: z
    .string()
    .describe("Verbatim text of the row or lines the values were read from."),
  location: z
    .string()
    .describe(
      "Where in the document: section/heading and row label, or a line reference — enough for a person to find it."
    ),
});

const rateSchema = z.object({
  amount: z
    .number()
    .describe(
      "The rate as printed. For a seasonal row, the lowest band; fill seasonBands with every band."
    ),
  basis: z
    .string()
    .nullable()
    .describe(
      "Meal or inclusion basis as printed (e.g. 'Bed & Breakfast', 'Fully Inclusive'), else null."
    ),
  carriedForward: z
    .boolean()
    .describe(
      "true when the document says this rate is carried forward, indicative, provisional, or an older tariff not yet confirmed."
    ),
  category: z.enum([
    "accommodation",
    "transfer",
    "activity",
    "levy",
    "supplement",
    "assistance",
    "other",
  ]),
  conditions: z
    .array(z.string())
    .describe(
      "Verbatim conditions, notes and footnotes that apply to this row: minimums, surcharges, applicability, 'reconfirm', complimentary conditions, what is included/excluded."
    ),
  currency: z.string().describe("ISO currency code."),
  id: z
    .string()
    .describe(
      "kebab-case id, unique within this document, built from supplier + service/room."
    ),
  location: z
    .string()
    .nullable()
    .describe(
      "City / region / section heading the rate is listed under, or null."
    ),
  provenance: provenanceSchema,
  roomType: z
    .string()
    .nullable()
    .describe("Room / villa / unit type for accommodation rates, else null."),
  seasonBands: z
    .array(
      z.object({
        amount: z.number(),
        from: z.string(),
        name: z.string(),
        to: z.string(),
      })
    )
    .describe(
      "Season bands with ISO dates, exactly as printed; empty when the rate is not seasonal."
    ),
  service: z.string().describe("Row label as printed."),
  supplier: z
    .string()
    .describe(
      "Property, operator or company the rate belongs to, as named in the document (use the section heading when the row names none)."
    ),
  unit: z
    .string()
    .describe(
      "Charging unit verbatim: e.g. 'per room per night', 'per person sharing per night', 'per vehicle one way', 'per person per way', 'per group', 'per person per night'."
    ),
  validity: z
    .object({ from: z.string(), to: z.string() })
    .nullable()
    .describe(
      "ISO date range the document states the rate is valid for; null when it states none."
    ),
});

const rateDocumentSchema = z.object({
  documentDate: z
    .string()
    .nullable()
    .describe("ISO date the document was compiled / issued / sent, or null."),
  generalConditions: z
    .array(z.string())
    .describe(
      "Verbatim document-wide conditions: precedence rules, what is not carried, exclusions, currency."
    ),
  rateCount: z
    .number()
    .int()
    .describe(
      "FIRST count every priced item in the document — each room type, service, levy, fee, supplement and each item stated as complimentary counts once. rates.length MUST equal this."
    ),
  rates: z.array(rateSchema),
  supersedesEarlier: z
    .boolean()
    .describe(
      "true when the document states that its rates replace or supersede earlier rates on file."
    ),
});

const serviceSchema = z.object({
  category: z.enum([
    "accommodation",
    "transfer",
    "activity",
    "flight",
    "assistance",
    "other",
  ]),
  date: z.object({
    end: z.string().nullable().describe("ISO date for stays, else null."),
    start: z.string().describe("ISO date."),
  }),
  description: z
    .string()
    .describe("The service line(s) as printed, without the region heading."),
  dropoff: z.string().nullable(),
  extras: z
    .array(
      z.object({
        description: z
          .string()
          .describe("Text after the multiplier, verbatim."),
        literalMultiplier: z.number().describe("The N in 'N x ...'."),
        per: z
          .enum(["group", "pax", "unknown"])
          .describe("'per group' / 'per pax' when printed, else unknown."),
      })
    )
    .describe(
      "Every 'Included: N x ...' style add-on printed under the service."
    ),
  literalQuantity: z
    .number()
    .nullable()
    .describe(
      "Quantity as printed (the N in 'N x'), null when none is printed."
    ),
  literalUnit: z
    .string()
    .nullable()
    .describe(
      "Unit as printed, e.g. 'Per Vehicle One Way', 'Per person', null when none."
    ),
  location: z
    .string()
    .nullable()
    .describe("City / region / heading the service is printed under."),
  nights: z.number().int().nullable().describe("Nights for a stay, else null."),
  notes: z
    .array(z.string())
    .describe("Other verbatim lines under the service (timings, remarks)."),
  pickup: z.string().nullable(),
  provenance: provenanceSchema,
  rooms: z
    .array(
      z.object({
        basis: z.string().nullable(),
        count: z.number().int(),
        roomType: z.string(),
      })
    )
    .describe(
      "For accommodation: one entry per room line as printed. Empty otherwise."
    ),
  sequence: z.number().int().describe("1-based position in printed order."),
  supplier: z
    .string()
    .nullable()
    .describe(
      "Property, operator or airline named for the service, else null."
    ),
});

const quotationSchema = z.object({
  client: z.string().nullable().describe("The travelling party as named."),
  excludes: z.array(z.string()).describe("Verbatim exclusion bullets, if any."),
  includes: z.array(z.string()).describe("Verbatim inclusion bullets, if any."),
  quotationDate: z.string().nullable().describe("ISO date."),
  ref: z.string().nullable().describe("The quotation / booking reference."),
  serviceCount: z
    .number()
    .int()
    .describe(
      "FIRST count every booked service printed in the itinerary (each meet & greet, transfer, stay, activity, tour, flight is one). services.length MUST equal this."
    ),
  services: z.array(serviceSchema),
  travelDates: z
    .object({ end: z.string(), start: z.string() })
    .describe("ISO dates."),
  travellers: z.object({
    adults: z.number().int(),
    children: z.number().int(),
  }),
});

const pickSchema = z.object({
  assumptions: z
    .array(z.string())
    .describe(
      "One sentence per assumption the choice needed; empty when exact."
    ),
  rateId: z
    .string()
    .nullable()
    .describe("A rate id from the rate book, or null."),
  reason: z.string().describe("One sentence: why this rate, or why none."),
});

const matchSchema = z.object({
  alternatives: z.array(z.string()).describe("Other rate ids considered."),
  assumptions: z.array(z.string()),
  extras: z
    .array(pickSchema.extend({ description: z.string() }))
    .describe("One pick per extra of the service, in the same order."),
  rateId: z
    .string()
    .nullable()
    .describe(
      "Rate for the service itself. null for a multi-room stay (see rooms) or when nothing prices it."
    ),
  reason: z.string(),
  rooms: z
    .array(pickSchema.extend({ roomType: z.string() }))
    .describe(
      "One pick per room line of an accommodation service, in the same order."
    ),
  sequence: z.number().int(),
});

const matchesSchema = z.object({
  matchCount: z
    .number()
    .int()
    .describe(
      "Number of services in the quotation. matches.length MUST equal this."
    ),
  matches: z.array(matchSchema),
});

type Rate = z.infer<typeof rateSchema> & {
  documentDate: string | null;
  supersedesEarlier: boolean;
};
type RateDocument = z.infer<typeof rateDocumentSchema>;
type Quotation = z.infer<typeof quotationSchema>;
type Matches = z.infer<typeof matchesSchema>;
type Match = z.infer<typeof matchSchema>;
type Pick = z.infer<typeof pickSchema>;

// ───────────────────────────────────────────── prompts (document types, not documents) ──

const RATE_PROMPT = `You are extracting a travel supplier rate document — a contracted rate sheet or rate pack, a tariff, or a supplier's correspondence that states rates — into structured records. Transcribe; never compute.
- One record per priced item: every room type, service, transfer, activity, levy or park fee, supplement or surcharge, gate or entrance fee, and every item the document states is complimentary or free (amount 0).
- Copy amounts, currency, units, validity dates and season bands exactly as printed, dates as ISO. Seasonal rows: amount = the lowest band, seasonBands = every band.
- Attach to each record, verbatim, every footnote or condition that applies to it (minimum pax, group-size rules, applicability, 'reconfirm before quoting', what a complimentary item requires). Mark carriedForward when the document says a rate is carried forward, provisional, or an older tariff.
- provenance: the file name, the section heading plus row label, and the verbatim row text.
- documentDate: when it was compiled, issued or sent. supersedesEarlier: true when it states its rates replace earlier ones. generalConditions: document-wide rules verbatim (precedence, exclusions, what is not carried).
- Count first: rateCount, then list every item. A list that stops before the end of the document is a failed extraction.`;

const QUOTATION_PROMPT = `You are extracting a travel operator's operational quotation or itinerary — a list of what was booked (services, dates, room types, quantities, units), usually without prices — into structured records. Transcribe literally; never derive quantities, never price anything.
- One record per booked service in printed order, sequence 1..n. A city / region heading applies to every service printed under it until the next heading.
- A stay is one service with one rooms entry per room TYPE (count, room type, basis). A single printed line that names several room types ('1 x A & 1 x B', 'A and B', 'A + B') is several entries, one per type, each with its own count; the basis applies to all of them. Transfers carry pickup and dropoff as printed.
- Every add-on printed under a service as 'Included: N x ...' (or similar) becomes an extra with its literal multiplier and verbatim text. Keep timings and remarks in notes.
- Dates as ISO. literalQuantity / literalUnit exactly as printed; null when not printed.
- provenance: the verbatim block of lines of that service.
- Also transcribe the reference, the party, travellers, travel dates and the inclusion / exclusion lists verbatim.
- Count first: serviceCount, then list every service to the end of the itinerary. A list that stops early is a failed extraction.`;

const MATCH_PROMPT = `You are matching booked services to contracted rates. You receive a quotation (services) and a rate book (rates with ids). For every service, in order, choose the rate id that prices it, or null. Never compute money.
- Match on supplier plus room type / service name / routing. A stay with several room lines gets one pick per room in rooms and rateId null. Every extra gets its own pick (levies, supplements, fees, or null with a reason when the rate document says no charge applies).
- A rate listed under one city or location section does not price a service in another city unless the rate document says so: return null and say why.
- assumptions are ONLY for what the two documents do not settle: a rule the quotation does not meet (e.g. a group-size or minimum the party falls short of), an applicability the rate document says is decided later, a season boundary the dates fall on, a pickup / dropoff or routing that differs from the rate's, a room or basis that only approximately matches. A condition the quotation visibly satisfies (a minimum met, a maximum not exceeded, a stay length reached, a basis that matches) is NOT an assumption — leave assumptions empty.
- A service that names the same routing or time window as a rate, in either direction, is an exact match with no assumption.
- An add-on that the rate document says carries no separate charge (an occupancy note, 'no supplement', 'included') points at the same rate id as its parent room or service, with the reason.
- Only use rate ids that exist in the rate book. When nothing prices a service (the rate document excludes it, or no rate exists), rateId null with the reason.
- alternatives: other rate ids you considered.
- Count first: matchCount = number of services, then exactly one match per service.`;

// ───────────────────────────────────────────── the one LLM seam ──

async function extract<T>(
  schema: z.ZodType<T>,
  prompt: string,
  parts: { label: string; text: string }[]
): Promise<T> {
  const result = await generateText({
    messages: [
      {
        content: [
          { text: prompt, type: "text" },
          ...parts.map((p) => ({
            text: `${p.label}:\n${p.text}`,
            type: "text" as const,
          })),
        ],
        role: "user",
      },
    ],
    model: gateway(MODEL),
    output: Output.object({ schema }),
    temperature: 0,
  });
  console.error(
    `  llm: finish=${result.finishReason} in=${result.usage.inputTokens} out=${result.usage.outputTokens}`
  );
  return result.output;
}

/** Structured output can be schema-valid yet stop early; retry until the record is complete by its own count. */
async function extractComplete<T>(
  label: string,
  call: () => Promise<T>,
  incomplete: (value: T) => string | null
): Promise<T> {
  let reason = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const value = await call();
    const why = incomplete(value);
    if (why === null) {
      return value;
    }
    reason = why;
    console.error(
      `  ${label}: attempt ${attempt}/${MAX_ATTEMPTS} incomplete (${why}); retrying`
    );
  }
  throw new Error(
    `${label}: still incomplete after ${MAX_ATTEMPTS} attempts (${reason}). Refusing to write a partial extraction.`
  );
}

function documentText(path: string): string {
  if (extname(path).toLowerCase() === ".pdf") {
    return execFileSync("pdftotext", ["-layout", path, "-"], {
      encoding: "utf8",
    });
  }
  return readFileSync(path, "utf8");
}

// ───────────────────────────────────────────── extraction ──

async function extractRateBook(paths: string[]): Promise<Rate[]> {
  const rates: Rate[] = [];
  for (const path of paths) {
    const name = basename(path);
    console.error(`extracting rates from ${name}`);
    const doc = await extractComplete<RateDocument>(
      name,
      () =>
        extract(rateDocumentSchema, RATE_PROMPT, [
          { label: `Document "${name}"`, text: documentText(path) },
        ]),
      (d) =>
        d.rates.length === 0
          ? "no rates"
          : d.rates.length === d.rateCount
            ? null
            : `${d.rates.length} rates listed but counted ${d.rateCount}`
    );
    const slug = name
      .replace(/\.[^.]+$/, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-");
    for (const r of doc.rates) {
      rates.push({
        ...r,
        documentDate: doc.documentDate,
        id: `${slug}/${r.id}`,
        provenance: { ...r.provenance, document: name },
        supersedesEarlier: doc.supersedesEarlier,
      });
    }
  }
  return rates;
}

async function extractQuotation(path: string): Promise<Quotation> {
  const name = basename(path);
  console.error(`extracting quotation from ${name}`);
  const q = await extractComplete<Quotation>(
    name,
    () =>
      extract(quotationSchema, QUOTATION_PROMPT, [
        { label: `Document "${name}"`, text: documentText(path) },
      ]),
    (q) => {
      if (q.services.length === 0) {
        return "no services";
      }
      if (q.services.length !== q.serviceCount) {
        return `${q.services.length} services listed but counted ${q.serviceCount}`;
      }
      const seqs = q.services.map((s) => s.sequence).sort((a, b) => a - b);
      if (seqs.some((s, i) => s !== i + 1)) {
        return "sequence numbers are not 1..n";
      }
      return null;
    }
  );
  q.services.sort((a, b) => a.sequence - b.sequence);
  for (const s of q.services) {
    s.provenance.document = name;
  }
  return q;
}

async function proposeMatches(
  quotation: Quotation,
  rates: Rate[]
): Promise<Matches> {
  console.error("proposing matches");
  const ids = new Set(rates.map((r) => r.id));
  const slim = quotation.services.map(({ provenance: _p, ...s }) => s);
  const book = rates.map(({ provenance: _p, ...r }) => r);
  return extractComplete<Matches>(
    "matches",
    () =>
      extract(matchesSchema, MATCH_PROMPT, [
        {
          label: "Quotation",
          text: JSON.stringify({
            excludes: quotation.excludes,
            services: slim,
            travelDates: quotation.travelDates,
            travellers: quotation.travellers,
          }),
        },
        { label: "Rate book", text: JSON.stringify(book) },
      ]),
    (m) => {
      if (m.matches.length !== quotation.services.length) {
        return `${m.matches.length} matches for ${quotation.services.length} services`;
      }
      const seen = new Set(m.matches.map((x) => x.sequence));
      if (seen.size !== quotation.services.length) {
        return "duplicate or missing sequence";
      }
      const picks = m.matches.flatMap((x) => [
        x.rateId,
        ...x.rooms.map((r) => r.rateId),
        ...x.extras.map((e) => e.rateId),
      ]);
      const unknown = picks.find((id) => id !== null && !ids.has(id));
      if (unknown) {
        return `invented rate id ${unknown}`;
      }
      return null;
    }
  );
}

// ───────────────────────────────────────────── output shape ──

type Confidence = "confirmed" | "assumed" | "indicative" | "unresolved";
type Provenance = z.infer<typeof provenanceSchema>;
interface Figure {
  assumptions: string[];
  confidence: Confidence;
  currency: string;
  provenance: Provenance | null;
  value: number | null;
}
interface Line {
  category: string;
  dates: { start: string; end: string | null };
  id: string;
  lineTotal: Figure;
  needsReview: string[];
  nights: number | null;
  parentId: string | null;
  quantity: { value: number; unit: string; derivation: string };
  service: string;
  supplier: string | null;
  unitRate: Figure;
}
interface Review {
  field: string;
  id: string;
  lineIds: string[];
  reason: string;
  severity: "blocking" | "confirm";
  suggestedAction: string;
}
interface Costed {
  client: string | null;
  currency: string;
  generated: { at: string; model: string; sources: string[] };
  lines: Line[];
  needs_review: Review[];
  quotationRef: string | null;
  totals: {
    confirmed: number;
    assumed: number;
    indicative: number;
    allCosted: number;
    unresolvedLineIds: string[];
    sendable: boolean;
    note: string;
  };
  travelDates: { start: string; end: string };
  travellers: number;
}

// ───────────────────────────────────────────── the deterministic engine ──

const RANK: Record<Confidence, number> = {
  assumed: 1,
  confirmed: 0,
  indicative: 2,
  unresolved: 3,
};
const UNSETTLED_CONDITION = /on request|depends on|confirmed by the|reconfirm|to be confirmed|\btbc\b|not yet (released|confirmed)/i;
const worst = (...c: Confidence[]) =>
  c.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), "confirmed");
const round2 = (n: number) => Math.round(n * 100) / 100;
const norm = (s: string | null | undefined) =>
  (s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
const addDays = (iso: string, n: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000)
    .toISOString()
    .slice(0, 10);
const within = (day: string, from: string, to: string) =>
  day >= from && day <= to;

/** Later-dated document wins for the same supplier + room/service; the loser points at the winner. */
function resolveSupersession(rates: Rate[]): {
  winner: Map<string, string>;
  notes: string[];
} {
  const winner = new Map<string, string>();
  const notes: string[] = [];
  // Same supplier + same room/service is the same rate, however each document spells the basis.
  const key = (r: Rate) => `${norm(r.supplier)}|${norm(r.roomType ?? r.service)}`;
  const groups = new Map<string, Rate[]>();
  for (const r of rates) {
    groups.set(key(r), [...(groups.get(key(r)) ?? []), r]);
  }
  for (const group of groups.values()) {
    const docs = new Set(group.map((r) => r.provenance.document));
    if (docs.size < 2) {
      continue;
    }
    // A document that states it supersedes earlier rates wins outright; otherwise the later document wins.
    const sorted = [...group].sort(
      (a, b) =>
        Number(b.supersedesEarlier) - Number(a.supersedesEarlier) ||
        (b.documentDate ?? "").localeCompare(a.documentDate ?? "")
    );
    const win = sorted[0];
    if (!win) continue;
    for (const lose of sorted.slice(1)) {
      winner.set(lose.id, win.id);
      const anomaly = (win.documentDate ?? "") < (lose.documentDate ?? "") ? ` Note: the superseded document was compiled later (${lose.documentDate}) and still carries the old figure.` : "";
      notes.push(
        `${win.provenance.document} (${win.documentDate ?? "undated"}) supersedes ${lose.provenance.document} (${lose.documentDate ?? "undated"}) for ${win.supplier} ${win.roomType ?? win.service}: ${win.amount} replaces ${lose.amount}.${anomaly}`
      );
    }
  }
  return { notes, winner };
}

interface Qty {
  assumptions: string[];
  derivation: string;
  value: number;
}

/** Quantity from the rate's unit and the booking — never from the quotation's literal multiplier. */
function deriveQuantity(
  unit: string,
  pax: number,
  nights: number | null,
  count: number,
  literal: number | null
): Qty {
  const u = norm(unit);
  const n = nights ?? 1;
  const perNight = /\bnight/.test(u);
  const perPerson = /\b(person|pax|pp|adult)\b/.test(u);
  const perUnit = /\b(room|villa|chalet|suite|unit|tent|cottage)\b/.test(u);
  const perGroup =
    /\b(vehicle|group|booking|transfer|entry|movement)\b/.test(u) && !perPerson;
  let q: Qty;
  if (perPerson && perNight) {
    q = {
      assumptions: [],
      derivation: `${pax} pax × ${n} night(s) (${unit})`,
      value: pax * n,
    };
  } else if (perUnit && perNight) {
    q = {
      assumptions: [],
      derivation: `${count} × ${n} night(s) (${unit})`,
      value: count * n,
    };
  } else if (perPerson) {
    q = {
      assumptions: [],
      derivation: `${pax} pax${count > 1 ? ` × ${count}` : ""} (${unit})`,
      value: pax * count,
    };
  } else if (perGroup || perUnit) {
    q = { assumptions: [], derivation: `${count} (${unit})`, value: count };
  } else {
    q = {
      assumptions: [
        `Unit "${unit}" was not recognised; quantity taken from the quotation as printed.`,
      ],
      derivation: `literal quantity ${literal ?? count} (unit "${unit}" not recognised)`,
      value: literal ?? count,
    };
  }
  if (literal !== null && literal !== q.value && (perNight || perPerson)) {
    q.assumptions.push(
      `Quotation prints "${literal} x" but the rate is ${unit}; costed as ${q.derivation}.`
    );
  }
  return q;
}

interface Priced {
  assumptions: string[];
  confidence: Confidence;
  derivation: string;
  total: number;
  unitRate: number;
}

/** Price one quantity against one rate: season bands per night, validity, carried-forward. */
function price(
  rate: Rate,
  qty: Qty,
  start: string,
  nights: number | null,
  count: number
): Priced {
  const assumptions = [...qty.assumptions];
  // A condition the rate document leaves to be settled later ("on request",
  // "depends on", "confirmed by", "reconfirm") is a fact, not a judgement:
  // flag it deterministically so the same document is flagged the same way every run.
  const unsettled = rate.conditions.find((c) => UNSETTLED_CONDITION.test(c));
  if (unsettled) assumptions.push(`Rate condition to be settled later: "${unsettled.trim()}"`);
  let unitRate = rate.amount;
  let total = round2(rate.amount * qty.value);
  let derivation = qty.derivation;
  let confidence: Confidence = "confirmed";
  if (rate.seasonBands.length > 0 && nights) {
    const perNight: number[] = [];
    const alt: number[] = [];
    const parts: string[] = [];
    let ambiguous = false;
    for (let i = 0; i < nights; i++) {
      const day = addDays(start, i);
      const bands = rate.seasonBands.filter((b) => within(day, b.from, b.to));
      if (bands.length === 0) {
        perNight.push(rate.amount);
        alt.push(rate.amount);
        parts.push(`${day} no band → base ${rate.amount}`);
        assumptions.push(
          `No season band covers ${day}; base amount ${rate.amount} used.`
        );
        continue;
      }
      const hi = bands.reduce((a, b) => (b.amount > a.amount ? b : a));
      const lo = bands.reduce((a, b) => (b.amount < a.amount ? b : a));
      perNight.push(hi.amount);
      alt.push(lo.amount);
      parts.push(
        `${day} ${hi.name} ${hi.amount}${bands.length > 1 ? ` (also ${lo.name} ${lo.amount})` : ""}`
      );
      if (bands.length > 1) {
        ambiguous = true;
      }
    }
    total = round2(perNight.reduce((a, b) => a + b, 0) * count);
    unitRate = round2(total / qty.value);
    derivation = `${count} × [${parts.join("; ")}]`;
    if (ambiguous) {
      assumptions.push(
        `A night falls on a date two season bands both claim; costed at the higher band (${total}); the lower reading would be ${round2(alt.reduce((a, b) => a + b, 0) * count)}.`
      );
    }
  }
  if (assumptions.length > 0) {
    confidence = "assumed";
  }
  const end = nights ? addDays(start, nights - 1) : start;
  if (
    rate.validity &&
    !(
      within(start, rate.validity.from, rate.validity.to) &&
      within(end, rate.validity.from, rate.validity.to)
    )
  ) {
    assumptions.push(
      `Rate validity ${rate.validity.from} → ${rate.validity.to} does not cover ${start}${nights ? ` → ${end}` : ""}.`
    );
    confidence = "indicative";
  }
  if (rate.carriedForward) {
    assumptions.push(
      "Rate is carried forward / not yet confirmed for these dates."
    );
    confidence = "indicative";
  }
  return { assumptions, confidence, derivation, total, unitRate };
}

function figure(
  value: number | null,
  currency: string,
  confidence: Confidence,
  provenance: Provenance | null,
  assumptions: string[]
): Figure {
  return { assumptions, confidence, currency, provenance, value };
}

export function costQuotation(
  quotation: Quotation,
  rates: Rate[],
  matches: Matches,
  sources: string[]
): Costed {
  const byId = new Map(rates.map((r) => [r.id, r]));
  const { winner, notes } = resolveSupersession(rates);
  const pax = quotation.travellers.adults + quotation.travellers.children;
  const currency = rates[0]?.currency ?? "USD";
  const lines: Line[] = [];
  const reviews: Review[] = [];
  let reviewSeq = 0;
  const review = (
    lineIds: string[],
    field: string,
    severity: Review["severity"],
    reason: string,
    suggestedAction: string
  ) => {
    const id = `r${String(++reviewSeq).padStart(2, "0")}`;
    reviews.push({ field, id, lineIds, reason, severity, suggestedAction });
    return id;
  };

  /** Resolve a pick to a rate (following supersession) and produce the two figures of a line. */
  const priced = (
    pick: Pick | null,
    ids: string[],
    qtyOf: (rate: Rate) => Qty,
    start: string,
    nights: number | null,
    count: number,
    service: string
  ) => {
    const chosen = pick?.rateId
      ? (winner.get(pick.rateId) ?? pick.rateId)
      : null;
    const rate = chosen ? byId.get(chosen) : undefined;
    if (!rate) {
      const why = pick?.reason ?? "no match proposed";
      const rid = review(
        ids,
        "unitRate",
        "blocking",
        `No rate found for "${service}": ${why}`,
        "Re-quote with the supplier before issuing; do not estimate."
      );
      return {
        qty: { derivation: "no rate", unit: "unknown", value: count },
        rate: null,
        reviewIds: [rid],
        total: figure(null, currency, "unresolved", null, []),
        unit: figure(null, currency, "unresolved", null, []),
      };
    }
    const qty = qtyOf(rate);
    const p = price(rate, qty, start, nights, count);
    const all = [...(pick?.assumptions ?? []), ...p.assumptions];
    const confidence = worst(
      p.confidence,
      all.length > 0 ? "assumed" : "confirmed"
    );
    const reviewIds: string[] = [];
    if (confidence === "indicative") {
      reviewIds.push(
        review(
          ids,
          "unitRate",
          "blocking",
          `Rate for "${service}" is not confirmed for the travel dates: ${p.assumptions.join(" ")}`,
          "Reconfirm the tariff with the supplier before quoting."
        )
      );
    } else if (confidence === "assumed") {
      reviewIds.push(
        review(
          ids,
          "lineTotal",
          "confirm",
          `"${service}" costed on an assumption: ${all.join(" ")}`,
          "Confirm with the supplier or the consultant; adjust the line if the assumption is wrong."
        )
      );
    }
    // The chosen rate replaced an earlier document's rate (whether the matcher
    // picked the winner directly or we swapped it in): the reviewer should see it.
    const supersession = notes.find((n) => n.includes(`for ${rate.supplier} ${rate.roomType ?? rate.service}:`));
    if (supersession && [...winner.values()].includes(rate.id)) {
      reviewIds.push(review(ids, "unitRate", "confirm", supersession, "Confirm the later document is the signed, current one and the earlier rate is withdrawn."));
    }
    return {
      qty: { derivation: p.derivation, unit: rate.unit, value: qty.value },
      rate,
      reviewIds,
      total: figure(p.total, rate.currency, confidence, rate.provenance, all),
      unit: figure(p.unitRate, rate.currency, confidence, rate.provenance, all),
    };
  };

  for (const s of quotation.services) {
    const m: Match | undefined = matches.matches.find(
      (x) => x.sequence === s.sequence
    );
    const id = `s${String(s.sequence).padStart(2, "0")}`;
    const start = s.date.start;
    const children: Line[] = [];

    if (s.category === "accommodation" && s.rooms.length > 0) {
      s.rooms.forEach((room, i) => {
        const pick =
          m?.rooms[i] ??
          (s.rooms.length === 1 && m?.rateId
            ? { assumptions: m.assumptions, rateId: m.rateId, reason: m.reason }
            : null);
        const rid = `${id}.r${i + 1}`;
        const r = priced(
          pick,
          [rid],
          (rate) => deriveQuantity(rate.unit, pax, s.nights, room.count, null),
          start,
          s.nights,
          room.count,
          `${room.roomType}${room.basis ? ` (${room.basis})` : ""}`
        );
        children.push({
          category: "accommodation",
          dates: s.date,
          id: rid,
          lineTotal: r.total,
          needsReview: r.reviewIds,
          nights: s.nights,
          parentId: id,
          quantity: r.qty,
          service: `${room.count} x ${room.roomType}${room.basis ? ` on a ${room.basis} basis` : ""}`,
          supplier: s.supplier,
          unitRate: r.unit,
        });
      });
      const conf = worst(...children.map((c) => c.lineTotal.confidence));
      lines.push(
        {
          category: s.category,
          dates: s.date,
          id,
          lineTotal: figure(null, currency, conf, null, []),
          needsReview: [],
          nights: s.nights,
          parentId: null,
          quantity: {
            derivation: "stay — see room lines",
            unit: "night(s)",
            value: s.nights ?? 1,
          },
          service: s.description,
          supplier: s.supplier,
          unitRate: figure(null, currency, conf, null, []),
        },
        ...children
      );
    } else {
      const pick = m
        ? { assumptions: m.assumptions, rateId: m.rateId, reason: m.reason }
        : null;
      const r = priced(
        pick,
        [id],
        (rate) =>
          deriveQuantity(
            rate.unit,
            pax,
            s.nights,
            s.literalQuantity ?? 1,
            s.literalQuantity
          ),
        start,
        s.nights,
        s.literalQuantity ?? 1,
        s.description
      );
      lines.push({
        category: s.category,
        dates: s.date,
        id,
        lineTotal: r.total,
        needsReview: r.reviewIds,
        nights: s.nights,
        parentId: null,
        quantity: r.qty,
        service: s.description,
        supplier: s.supplier,
        unitRate: r.unit,
      });
    }

    const parentRateIds = new Set([m?.rateId, ...(m?.rooms.map((r) => r.rateId) ?? [])].filter((x): x is string => x !== null && x !== undefined));
    s.extras.forEach((extra, i) => {
      const xid = `${id}.x${i + 1}`;
      const rawPick = m?.extras[i] ?? null;
      // An add-on that points at the very rate its parent is already costed on
      // (an occupancy note such as a triple, "included" wording) is covered by
      // the parent line: never count that rate twice.
      if (rawPick?.rateId && parentRateIds.has(rawPick.rateId)) {
        const rate = byId.get(winner.get(rawPick.rateId) ?? rawPick.rateId);
        const prov = rate?.provenance ?? null;
        lines.push({ id: xid, parentId: id, category: "supplement", service: extra.description, supplier: s.supplier, dates: s.date, nights: s.nights, quantity: { value: extra.literalMultiplier, unit: "included", derivation: `covered by the parent line's rate (${rawPick.rateId}); no separate charge` }, unitRate: figure(0, currency, "confirmed", prov, []), lineTotal: figure(0, currency, "confirmed", prov, []), needsReview: [] });
        return;
      }
      const pick = rawPick;
      const r = priced(
        pick,
        [xid],
        (rate) =>
          deriveQuantity(
            rate.unit,
            pax,
            s.nights,
            extra.literalMultiplier,
            extra.literalMultiplier
          ),
        start,
        s.nights,
        extra.literalMultiplier,
        extra.description
      );
      const zero = r.rate && r.rate.amount === 0;
      lines.push({
        category: r.rate?.category ?? "supplement",
        dates: s.date,
        id: xid,
        lineTotal: zero
          ? figure(
              0,
              currency,
              r.total.confidence,
              r.total.provenance,
              r.total.assumptions
            )
          : r.total,
        needsReview: r.reviewIds,
        nights: s.nights,
        parentId: id,
        quantity: r.qty,
        service: extra.description,
        supplier: s.supplier,
        unitRate: r.unit,
      });
    });
  }

  // Every valued line counts once; stay parents are structural (null) so nothing is double counted.
  const sum = (c: Confidence) =>
    round2(
      lines
        .filter((l) => l.lineTotal.value !== null && l.lineTotal.confidence === c)
        .reduce((a, l) => a + (l.lineTotal.value ?? 0), 0)
    );
  const totals = {
    assumed: sum("assumed"),
    confirmed: sum("confirmed"),
    indicative: sum("indicative"),
  };
  const structural = (l: Line) => l.lineTotal.value === null && lines.some((c) => c.parentId === l.id);
  const unresolvedLineIds = lines
    .filter((l) => l.lineTotal.confidence === "unresolved" && !structural(l))
    .map((l) => l.id);
  const sendable = unresolvedLineIds.length === 0 && totals.indicative === 0;
  return {
    client: quotation.client,
    currency,
    generated: { at: new Date().toISOString(), model: MODEL, sources },
    lines,
    needs_review: reviews,
    quotationRef: quotation.ref,
    totals: {
      ...totals,
      allCosted: round2(totals.confirmed + totals.assumed + totals.indicative),
      note: sendable
        ? "All lines confirmed."
        : `Not sendable: ${unresolvedLineIds.length} unresolved line(s)${totals.indicative > 0 ? " and unconfirmed (indicative) tariffs" : ""}; resolve every needs_review item first.`,
      sendable,
      unresolvedLineIds,
    },
    travelDates: quotation.travelDates,
    travellers: pax,
  };
}

// ───────────────────────────────────────────── check: schema, invariants, golden set ──

function check(costed: Costed, quotation: Quotation): string[] {
  const f: string[] = [];
  const top = costed.lines.filter((l) => l.parentId === null);
  const ids = new Set(costed.lines.map((l) => l.id));
  if (top.length !== quotation.services.length) {
    f.push(
      `${top.length} top-level lines for ${quotation.services.length} services`
    );
  }
  for (const s of quotation.services) {
    const id = `s${String(s.sequence).padStart(2, "0")}`;
    if (!ids.has(id)) {
      f.push(`service ${id} has no line`);
    }
    s.extras.forEach((_, i) => {
      if (!ids.has(`${id}.x${i + 1}`)) {
        f.push(`extra ${id}.x${i + 1} has no line`);
      }
    });
    s.rooms.forEach((_, i) => {
      if (s.category === "accommodation" && !ids.has(`${id}.r${i + 1}`)) {
        f.push(`room ${id}.r${i + 1} has no line`);
      }
    });
  }
  // Structural stay parents (null value, with room children) are exempt; every other line is checked.
  const checked = costed.lines.filter(
    (l) => l.lineTotal.value !== null || !costed.lines.some((c) => c.parentId === l.id)
  );
  for (const l of checked) {
    for (const [name, fig] of [
      ["unitRate", l.unitRate],
      ["lineTotal", l.lineTotal],
    ] as const) {
      if (fig.confidence === "confirmed" && fig.assumptions.length > 0) {
        f.push(`${l.id}.${name} confirmed but carries assumptions`);
      }
      if (fig.confidence === "assumed" && fig.assumptions.length === 0) {
        f.push(`${l.id}.${name} assumed without an assumption`);
      }
      if (fig.value !== null && !fig.provenance?.excerpt) {
        f.push(`${l.id}.${name} has a value but no provenance excerpt`);
      }
      if (fig.confidence === "unresolved" && fig.value !== null) {
        f.push(`${l.id}.${name} unresolved but valued`);
      }
    }
    if (l.lineTotal.confidence !== "confirmed" && l.needsReview.length === 0) {
      f.push(
        `${l.id} is ${l.lineTotal.confidence} but has no needs_review item`
      );
    }
    for (const r of l.needsReview) {
      if (!costed.needs_review.some((x) => x.id === r)) {
        f.push(`${l.id} references missing review ${r}`);
      }
    }
  }
  const t = costed.totals;
  if (round2(t.confirmed + t.assumed + t.indicative) !== t.allCosted) {
    f.push("bucket totals do not sum to allCosted");
  }
  if (t.sendable && (t.unresolvedLineIds.length > 0 || t.indicative > 0)) {
    f.push("sendable while unresolved/indicative lines exist");
  }
  const nights = top
    .filter((l) => l.category === "accommodation")
    .reduce((a, l) => a + (l.nights ?? 0), 0);
  const span = Math.round(
    (Date.parse(quotation.travelDates.end) -
      Date.parse(quotation.travelDates.start)) /
      86_400_000
  );
  if (nights !== span) {
    f.push(`accommodation nights ${nights} ≠ trip span ${span}`);
  }
  if (existsSync(EXPECTED_FILE)) {
    // Golden set: hand-computed line totals for these documents (null = must be unresolved).
    const expected = JSON.parse(readFileSync(EXPECTED_FILE, "utf8")) as {
      lines: Record<string, number | null>;
      totals?: Record<string, number>;
    };
    for (const [id, want] of Object.entries(expected.lines)) {
      const got = costed.lines.find((l) => l.id === id)?.lineTotal.value;
      if (got === undefined) {
        f.push(`golden: line ${id} missing`);
      } else if (got !== want) {
        f.push(`golden: ${id} = ${got}, expected ${want}`);
      }
    }
    for (const [k, want] of Object.entries(expected.totals ?? {})) {
      if ((t as unknown as Record<string, number>)[k] !== want) {
        f.push(
          `golden: totals.${k} = ${(t as unknown as Record<string, number>)[k]}, expected ${want}`
        );
      }
    }
  }
  return f;
}

// ───────────────────────────────────────────── main ──

async function main() {
  const args = new Set(process.argv.slice(2));
  const read = <T>(name: string, schema: z.ZodType<T>): T =>
    schema.parse(JSON.parse(readFileSync(join(CACHE_DIR, name), "utf8")));
  const cachedRates = z.array(
    rateSchema.extend({
      documentDate: z.string().nullable(),
      supersedesEarlier: z.boolean(),
    })
  );

  if (args.has("--check")) {
    const costed = JSON.parse(readFileSync(OUTPUT_FILE, "utf8")) as Costed;
    const findings = check(costed, read("quotation.json", quotationSchema));
    for (const x of findings) {
      console.log(`✗ ${x}`);
    }
    console.log(
      findings.length === 0
        ? "all invariants pass"
        : `${findings.length} finding(s)`
    );
    process.exit(findings.length === 0 ? 0 : 1);
  }

  const inputs = readdirSync(INPUT_DIR)
    .map((f) => join(INPUT_DIR, f))
    .filter((f) => /\.(pdf|txt|md|eml)$/i.test(f));
  const quotationArg = [...args]
    .find((a) => a.startsWith("--quotation="))
    ?.slice("--quotation=".length);
  const quotationPath =
    quotationArg ??
    inputs.find((f) => /quotation|itinerary|booking/i.test(basename(f)));
  if (!quotationPath) {
    throw new Error("No quotation found in input/ — pass --quotation=<file>.");
  }
  const ratePaths = inputs.filter((f) => f !== quotationPath);

  let rates: Rate[];
  let quotation: Quotation;
  let matches: Matches;
  if (args.has("--from-cache")) {
    rates = read("ratebook.json", cachedRates);
    quotation = read("quotation.json", quotationSchema);
    matches = read("matches.json", matchesSchema);
    console.error(
      `loaded ${rates.length} rates, ${quotation.services.length} services, ${matches.matches.length} matches from ${CACHE_DIR}`
    );
  } else {
    if (!process.env.AI_GATEWAY_API_KEY) {
      console.error(
        "AI_GATEWAY_API_KEY is not set (see .env.example); use --from-cache to cost without the network."
      );
      process.exit(1);
    }
    mkdirSync(CACHE_DIR, { recursive: true });
    rates = await extractRateBook(ratePaths);
    writeFileSync(
      join(CACHE_DIR, "ratebook.json"),
      `${JSON.stringify(rates, null, 2)}\n`
    );
    quotation = await extractQuotation(quotationPath);
    writeFileSync(
      join(CACHE_DIR, "quotation.json"),
      `${JSON.stringify(quotation, null, 2)}\n`
    );
    matches = await proposeMatches(quotation, rates);
    writeFileSync(
      join(CACHE_DIR, "matches.json"),
      `${JSON.stringify(matches, null, 2)}\n`
    );
  }

  const costed = costQuotation(
    quotation,
    rates,
    matches,
    inputs.map((f) => basename(f))
  );
  writeFileSync(OUTPUT_FILE, `${JSON.stringify(costed, null, 2)}\n`);
  const t = costed.totals;
  console.log(
    `${costed.lines.length} lines, ${costed.needs_review.length} needs_review → confirmed ${t.confirmed} · assumed ${t.assumed} · indicative ${t.indicative} · all ${t.allCosted} · sendable ${t.sendable} → ${OUTPUT_FILE}`
  );
}

if (import.meta.main) {
  await main();
}
