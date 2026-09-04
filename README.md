# Costing engine — Lead AI Engineer exercise

One file, [`costing.ts`](costing.ts), reads a DMC's operational quotation (no prices) plus any number of supplier rate documents (a rate pack, a supplier email) and writes a **costed quotation** where every commercial figure carries **provenance** (document, section/row, verbatim excerpt) and a **confidence** level, plus a **`needs_review`** list of everything a human must resolve before it can be sent.

The one rule: **the model never produces a number.** It transcribes documents into typed records and proposes which rate belongs to which service. Every quantity, every calculation, every confidence and every total is plain TypeScript.

## Deliverables

| Item | Where |
|---|---|
| The costed quotation | [`output/costed-quotation.json`](output/costed-quotation.json) |
| What the model extracted (committed, so the result reproduces offline) | [`output/extracted/`](output/extracted/) — `ratebook.json`, `quotation.json`, `matches.json` |
| Golden set (hand-computed line totals) | [`output/expected.json`](output/expected.json) |
| The note | [Note](#note) |
| The supplement | [Supplement](#supplement--from-needs_review-to-actions) |

Source documents: [`input/`](input/). Brief and FAQ: [`docs/`](docs/).

## Run it

Needs [Bun](https://bun.sh), `pdftotext` (poppler) for PDFs, and a [Vercel AI Gateway](https://vercel.com/docs/ai-gateway) key for live extraction only.

```bash
bun install
cp .env.example .env.local           # AI_GATEWAY_API_KEY=...   (never committed)

bun run costing.ts --from-cache      # no network: cost from output/extracted/*.json → output/costed-quotation.json
bun run costing.ts --check           # no network: schema + invariants + golden set on the output

bun run costing.ts                   # live: 4 model calls → output/extracted/*.json → costed-quotation.json
```

`COSTING_MODEL` overrides the model (default `anthropic/claude-opus-5`). The quotation is the input file whose name contains "quotation" (or `--quotation=<file>`); every other file in `input/` is treated as a rate document.

## How it works

```
input/                       model (transcription only)            engine (plain TypeScript)
 ├─ rate pack .pdf  ─┐
 ├─ supplier email  ─┴─▶ 1. rates per document ─┐
 └─ quotation .pdf  ───▶ 2. services ───────────┼─▶ 3. proposed joins ──▶ 4. costQuotation()
                                                │   (rate ids + assumption      quantities · season split
                                                │    text, no numbers)          supersession · validity
                                                └──────────────────────────────  confidence · needs_review · totals
```

1. **Rates.** Each rate document becomes records: supplier, service/room, unit, amount, season bands, validity, `carriedForward`, the verbatim conditions that apply to the row, and provenance. Numbers enter the system here and nowhere else.
2. **Quotation.** Every booked service in printed order: dates, nights, room lines, literal quantity and unit, pickup/dropoff, every `Included: N x …` extra, provenance.
3. **Joins.** For each service, room line and extra: a rate id or `null`, with one sentence per assumption and a reason. Only ids that exist; never money.
4. **Engine.** Quantity from the rate's *unit* (per room per night → rooms × nights; per person sharing → pax × nights; per person per way → pax; per group → 1; levies → pax × nights), never from the quotation's literal multiplier. Per-night season split; a night two bands both claim is costed at the higher band and the alternative is stated. Supersession across documents is resolved by document date (the later document wins; the reviewer is told). Validity vs travel dates and `carriedForward` make a rate `indicative`. Every extra is its own child line; an extra that points at its parent's own rate (an occupancy note) is `0`, not counted twice. Then `needs_review` and honest totals.

**The prompts describe document types, not these documents.** They never mention a supplier, a section, a count or a city. The completeness guard is generic too: the model must first state how many items it sees (`rateCount`, `serviceCount`, `matchCount`) and the list must match its own count, every sequence number must be present once, and every proposed rate id must exist; otherwise the call is retried (up to 3×) and the run refuses to write a partial extraction. With that plan-then-fill step and `temperature: 0`, all four calls completed on the first attempt in every measured run.

### Confidence (derived from facts, never read from the model; worst fact wins)

| Level | Meaning | In this quotation |
|---|---|---|
| `confirmed` | a rate whose validity covers the dates, no assumption needed | meet & greet CPT, tours, transfers with exact routing, the Beach Villa |
| `assumed` | a rate was found but something the documents do not settle had to be assumed; the text travels on the figure | Camissa (email vs later-compiled pack), Marula season boundary, both levies, trailer with 5 pax, Marula→Kudu routing, gate fees, triple "on request" |
| `indicative` | validity does not cover the travel dates or the tariff is carried forward | both helicopter transfers (2025 tariff, valid to 31 Dec 26) |
| `unresolved` | nothing prices it; value `null`, line still emitted | 3 flights (pack §8), "Beach Villa Grande" (not in the pack), Johannesburg meet & greet (only a Cape Town-section rate exists) |

### Result (nett USD)

| | |
|---|---|
| all costed | **30,740** |
| of which confirmed / assumed / indicative | 7,225 / 19,565 / 3,950 |
| unresolved lines | 5 |
| `needs_review` | 21 items (blocking: the unresolved lines and the expired helicopter tariff; confirm: every assumption and the Camissa supersession) |

The line values are identical in every run (they are pinned by the golden set). Which lines are *flagged* is mostly deterministic too: validity, carried-forward tariffs, season boundaries, literal-vs-derived quantities, cross-document supersession and rate conditions that the document itself says are settled later ("on request", "depends on the gate used", "reconfirm") are all engine rules. Only the matcher's own judgement calls (e.g. whether a "Custom Private Tour" with no stated duration is the full-day rate) can still move a line between `confirmed` and `assumed` between runs — and the model's confidence can only ever lower a figure, never raise it.
| `sendable` | **false** |

Three figures worth tracing by hand: Camissa Family Suite `375` (provenance is the email, which supersedes the pack's 340); Kudu Luxury Suite `15 × 890 = 13,350` (5 pax × 3 nights per person sharing, note 4a); Beach Villa Grande `null` with a blocking item.

### Output shape

Each line: `id` (`s03` service, `s03.r1` room, `s03.x1` extra), `parentId`, `quantity { value, unit, derivation }`, `unitRate` and `lineTotal` as `{ value, currency, confidence, provenance { document, location, excerpt }, assumptions[] }`, `needsReview[]`. Each `needs_review` item: `lineIds`, `field`, `severity` (`blocking` | `confirm`), `reason`, `suggestedAction`. `totals`: per bucket, `allCosted`, `unresolvedLineIds`, `sendable`, `note`.

## Knowing the extraction is correct

- **Golden set** — [`output/expected.json`](output/expected.json): every line total computed by hand from the documents (`null` where the line must be unresolved) plus the deterministic totals. `--check` fails on any difference.
- **Invariants** — every service, room line and extra has exactly one line; no `confirmed` figure carries an assumption and every `assumed` one does; every non-`confirmed` line has a `needs_review` item; every valued figure has a provenance excerpt; buckets sum to the total; `sendable` is false while anything is unresolved or indicative; accommodation nights equal the trip span.
- **Provenance trace** — every valued unit rate's excerpt appears in the source text with its amount (checked for all 26 valued rates in the committed run).
- **Completeness guards** on every model call, described above.

## Stack

TypeScript on Bun (the company's product is TypeScript end to end; Bun runs the file directly). Vercel AI SDK v7 through Vercel AI Gateway: one `generateText` + `Output.object` call with a zod schema, one key for any model. `pdftotext` turns PDFs into layout-preserving text, which proved more reliable than sending the PDF binary to the model. No LangChain, no database, no UI.

## Note

**What I built.** A single script that joins an operational quotation to supplier rate documents. The model does three transcription jobs (rates per document, services, proposed joins) and a deterministic engine does everything numeric: quantity from the rate's unit, per-night season splits, supersession by document date, validity checks, a four-level confidence, `needs_review` and totals. Every figure carries a verbatim excerpt a non-technical reviewer can find in the source. Unresolvable items are emitted as `null` lines with blocking review items, never guessed. The extraction is committed so the result reproduces offline.

**Where the model stays out.** All arithmetic, quantity derivation, season and validity logic, supersession, confidence, totals and the checks. The model's confidence is never read; its assumptions can only lower a figure to `assumed`.

**Where the AI got things wrong, and what I overrode.** (1) Structured output came back schema-valid but truncated — 1 or 2 services of 19 — on several first attempts. I stopped trusting a passing schema and made the model commit to a count before listing, then hold it to its own count, with retries; after that every call completed first time. (2) It priced a "Triple" occupancy note a second time at the full suite rate; the engine now treats an extra that points at its parent's own rate as included. (3) It read "1 x Beach Villa & 1 x Beach Villa Grande" as one room line; the prompt now splits combined lines by room type. (4) The reverse: I had assumed the Johannesburg meet & greet could use the Cape Town-section rate and put that in my golden set; the model refused, correctly (pack §9: no corresponding rate → re-quote). I also accepted three of its cautions I had marked confirmed — Camissa's email predates the pack's compile date, the custom tour's duration is not stated, the triple is "on request".

**Next with more time.** A second model voting on the extraction; per-supplier rate scoping; currency and rate-of-exchange; a rate store instead of JSON; the agentic follow-up below.

**Time.** About 3 hours end to end, including a rewrite into a single file once the first version worked.

## Supplement — from needs_review to actions

**1. Ilha Azul Beach Lodge — line `s16.r2` ("Beach Villa Grande"), field `unitRate`.** The pack prices Beach Villa, Infinity Beach Villa and Presidential Villa; "Beach Villa Grande" is none of them. The agent emails the lodge's reservations contact with the dates (14–17 Jul 27) and party, asking for the nett Fully Inclusive rate for that villa (or which pack tier it is), its validity and inclusions. The reply is read by the same extraction step used on the pack into a candidate rate record — amount, unit, validity, provenance pointing at the email — and held behind a human confirm gate. On confirmation: the record joins the rate book, the review item closes, `s16.r2` moves from `unresolved` to `confirmed`, and the engine re-runs: the stay total, the grand totals and `sendable` recompute; the quotation and any proposal regenerate. A quotation already sent gets an amendment, not a rewrite; a booking or invoice gets a change order.

**2. Mozambique air transfer operator — lines `s15` / `s17`, field `unitRate`.** The pack carries a 2025 helicopter tariff "carried forward" and says the operator "indicated a likely increase but has not confirmed". The agent emails the operator (or the DMC contact who holds the relationship) with dates and party, asking for the confirmed 2027 rate and validity. The reply is extracted the same way, behind the same gate. On confirmation both lines move from `indicative` to `confirmed`, the carried-forward rate is superseded by document date, both blocking items close, and recalculation propagates costing → quotation → proposal; a sent quotation gets an amendment, a booked leg a change order.

**What could go wrong.**
- The supplier names a different room or attaches a condition (minimum nights, surcharge) — extraction must capture the condition, not just a number.
- The reply lands after the quotation was sent — it routes to the amendment path, never a silent overwrite.
- The extracted figure disagrees with the surrounding prose — the confirm gate requires a human read before the write.
- The supplier never replies — an expiry window escalates to a human owner instead of blocking forever.
- The confirmed rate is for a different season or party size — re-validate against the actual dates and pax before applying.
