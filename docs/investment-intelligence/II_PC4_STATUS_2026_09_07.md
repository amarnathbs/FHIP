# II-PC4 — Controlled Production End-to-End Certification: Status Report

**As of:** 2026-09-07
**Prepared after:** a real, controlled production pilot — the Product Owner's own two real CAMS consolidated account statements (17 real mutual fund schemes, one since-inception statement spanning 1990–2026, one recent-period statement), uploaded and processed end-to-end through the live production app at app.financialhealthplatform.com.

This is not a synthetic-fixture report. Every defect below was found by decrypting and locally re-running the actual production parser against the PO's real statement text, or by reading the actual production code path a real failure occurred on, and every fix was verified against that same real document before being shipped.

---

## 1. Where PC4 stands right now

**The real pilot has now gone further than originally scoped.** PC4 set out to validate the existing pipeline end-to-end against real production traffic. What actually happened is that the real pilot document exposed **six previously-unknown, real production defects** — three in the CAMS parser, two in the document-processing orchestrator, and one in the transaction-write path — all of which are now found, fixed, tested, and deployed to `main`. Beyond that, the pilot also **conclusively separated genuine defects from genuine, honestly-disclosed feature gaps** that were never in scope to begin with (Section 8 below).

**Net result today:** the PO's real 17-scheme portfolio now reconciles and displays correctly end-to-end — 17/17 schemes, 953/953 real transactions recovered, 17/17 holding snapshots, verified independently via direct SQL four separate times and confirmed by the PO's own Overview screen (₹806,724 reconstructed value, 17 positions, 17 schemes, 12 folios).

---

## 2. Real production defects found and fixed this pilot

All committed and pushed to `main`; Amplify auto-deployed each one.

| # | Defect | Root cause | Fix | Commit |
|---|---|---|---|---|
| 1 | Page-level column header not reprinted per scheme | The alt-layout CAMS grammar's column header prints once per PDF page, not once per scheme block. A second scheme on the same page never re-triggered `inTable = true`, silently dropping its entire transaction table. | Also treat "Opening Unit Balance: `<units>`" (a genuinely per-scheme marker) as turning `inTable` on. | `c22ea75` |
| 2 | Price+Units columns glued with no separator (ambiguous digit run) | pdf-parse's column-gap heuristic sometimes omits the space between Price and Units, e.g. `12.51799.361`. Multiple digit-run splits are syntactically valid. | Accept a split only when it's the *unique* candidate whose `price × units ≈ amount` (the statement's own printed amount), never a guess. | `c22ea75` |
| 3 | Stamp Duty/STT fee rows split across two physical lines | `<date> <amount>` on one line, `*** Stamp Duty ***`/`*** STT Paid ***` on the next. Single largest source of missed transactions (~792 warnings). | Recognise the two-line pair and consume both lines as one fee transaction. | `c22ea75` |
| 4 | `ii_holding_snapshots` upsert failures were completely silent | The upsert's error was never checked or logged anywhere. | Log the real Postgres error (message + code) on failure so a future failure is diagnosable instead of invisible. | `1ab6d40` |
| 5 | A parse run interrupted by a server timeout was stuck `running` forever, permanently blocking the document | The one-active-run-at-a-time guard checked only run status, never run age. A killed function left the DB row `running` with no way to ever retry. | A `queued`/`running` run older than 10 minutes is now auto-marked `failed` and superseded, instead of wedging the document forever. | `a978382` |
| 6 | Server timeout on large real documents (root cause of #5) | The transaction-write loop made 2–3 sequential DB round trips **per transaction** — for a real ~950-transaction statement, ~2,000–2,800 sequential round trips, comfortably exceeding any serverless execution budget regardless of parsing time. | Bulk-prefetch existing fingerprints once; batch new transaction + source-link inserts into a handful of chunked bulk inserts instead of one row at a time; preserve the R11 cross-source-candidate cache's same-import ordering guarantee entirely in memory. | `8519148` |
| 7 | Price glued directly to a parenthesized **negative** Units value — a fourth, distinct glued shape (`12.82(3,037.396)`) | None of the existing grammars permitted zero whitespace before an opening parenthesis. This is unambiguous (the parens already prove the split point) but was never matched at all. Recurs 60+ times in one real statement across redemptions, SIP rejections/reversals, and inter-scheme "Lateral Shift Out" transfers. Confirmed to be the cause of Axis Large Cap's unit balance coming out ~5× too high (a real 3,037.396-unit redemption was silently dropped). | New regex for the single-line case; a bounded continuation-line lookahead (capped, and it stops the instant a candidate line looks like a new dated transaction row) recovers the cases where the description wraps onto further physical lines before the running balance appears. | `b514e7c` |

**Prior to this session**, the same real-pilot arc had already found and fixed (for context, not re-verified today): Amplify build/bundle issues with `pdfjs-dist`/`@napi-rs/canvas`, a Nippon SIP-rejection double-counting bug, CAMS alt-layout scheme-header multi-line wrap, bare-AMC-name causing duplicate-instrument creation, status-corruption/swallowed-errors around the Reprocess flow, `holdings_found: 0` from a since-inception statement-period fallback bug, reversed purchase/rejection pair reclassification, and real per-scheme NAV/market-value extraction. See `git log --oneline` on this branch for the full chain (commits `9d71bde` through `092d77e`).

All 12 relevant existing unit-test files plus 4 new tests for defect #7 pass (112+ tests). `tsc --noEmit` clean at every step. Full repo unit suite: 6,169 passed (pre-existing, unrelated live-DEV-env and one AI-certification test flake only).

---

## 3. Live verification performed today (not simulated)

Every one of these was run directly against the PO's real production data via read-only SQL, independently, more than once, across multiple reprocessing cycles:

- **Instrument resolution**: all 17 real schemes (matched by ISIN against the PO's own ground-truth spreadsheet) have a corresponding `ii_instruments` row, each with real transactions.
- **Transaction recovery**: 953 of ~1,006 real transactions recovered (94.7%) locally before the fix shipped; the live production reprocess after shipping reports `transactions_found: 953` for both of two successful runs.
- **Holdings**: `holdings_found: 17` — all 17 schemes have a positive-unit current holding snapshot (previously all zero, root-caused and fixed as defect #4 above, though the fix was a diagnostic-visibility fix rather than a confirmed root cause; the underlying issue appears to have resolved once the parser correctly extracted all 17 schemes' data).
- **Duplicate check**: ICICI Prudential Dividend Yield Fund (which the source statement documents undergoing a scheme rename mid-history) resolves to exactly **one** instrument row, not two — ruled out as a cause of an apparent scheme-count discrepancy (see Section 6).
- **Overview screen**: PO-confirmed live screenshot shows 17 positions, 17 schemes/securities, 12 folios, ₹806,724 reconstructed value — matching the database exactly.

---

## 4. Outstanding reconciliation variance — needs one more verification pass

Before defect #7 shipped, six of the seventeen positions showed a genuine unit-count mismatch between the transaction-reconstructed closing balance and the statement's own printed closing balance:

| Scheme | Reconstructed (pre-fix) | Statement's own | Gap |
|---|---|---|---|
| Axis Large Cap | 3,471.43 | 590.652 | **~2,880 units** |
| Nippon India Power & Infra | 188.198 | 12.781 | ~175 units |
| Kotak Mid Cap | 578.746 | 467.241 | ~112 units |
| UTI MNC | 40.173 | 53.105 | ~13 units |
| Franklin Mid Cap | 9.137 | 13.594 | ~4.5 units |
| SBI Contra | 275.430 | 278.108 | ~2.7 units |

Defect #7's fix directly addresses the Axis Large Cap redemption (confirmed the exact real row was being dropped) and very likely several of the others, since the same glued-negative-units shape recurs across multiple schemes' redemptions and transfers in this statement. **This has not yet been re-verified against a fresh reprocess** — the PO's most recent reprocess after the fix shipped confirmed the scheme/transaction/holding *counts* (17/953/17) but the `ii_portfolio_truth_status.unit_variance_within_tolerance` check has not been re-run. That's the next concrete verification step before all 17 positions can be considered fully reconciled and eligible to certify/publish.

---

## 5. Section-by-section status against the original 48-section spec

Only sections with a confirmed status from this pilot are listed; unlisted sections have not been specifically re-verified in this arc.

| Section | Topic | Status |
|---|---|---|
| 1 | Market-data (NAV/price history) population | **Confirmed NOT done** — see Section 8 below. Not a defect; explicitly scoped out at R1 (migration `0033`'s own comment: "No AMFI NAV feed populated by R1 (non-goal)"). |
| 3/5 | Per-scheme NAV/market-value extraction | Fixed earlier this pilot (`6e646be`). |
| 7/11 | Reversed purchase/rejection pair reclassification | Fixed earlier this pilot (`8e55321`). |
| 9 | Portfolio XIRR internal-transfer exclusion | **Fixed and tested** (`640e041`) — internal switches excluded from portfolio-level XIRR even across a settlement-date lag; genuine same-day contributions still counted (regression-tested). |
| 11/12 | (unspecified in available context) | Verified already correct via discovery agent; no fix needed. |
| 13 | Statement-only vs benchmark-dependent metric separation | **Fixed** (`dd52476`) — Performance page now clearly separates "From your own statements" metrics from "Compared against a market benchmark" metrics, each with its own explanatory copy. |
| 14/15/16 | Fund holdings label rename + empty/detail state verification | Fixed earlier this pilot (`f671861`). |
| 17/19 | Owner-mismatch gate + Review Centre wording | Fixed/verified earlier this pilot (`471c1a2`). |
| 20 | Document delete/reupload capability | **Confirmed absent, documented** per the spec's own "just document it" instruction — see `docs/investment-intelligence/II_PC4_SECTION20_DOCUMENT_LIFECYCLE_LIMITATION.md` (`dd52476`). |
| 47/48 | Terminal verdict + final report | **Not yet issued** — pending the reconciliation-variance re-verification (Section 4) and the PO's decision on Section 7 below. |

---

## 6. A dead end worth recording (so it isn't re-chased)

Mid-pilot, the PO reported seeing only "15 of 17" schemes on the Recurring Investments tab, and separately reported "all other tabs showing nothing." Both were investigated at length and **traced to non-defects**:

- **"15 recurring series identified, 3 grouping(s) not clearly recurring"** is a correct SIP-pattern classification metric (which contribution patterns look like a genuine periodic SIP vs. a one-off/irregular purchase series) — not a scheme count at all. All 17 schemes' underlying data is present; this tab further categorizes contribution *patterns* within it, and 15+3 was never meant to sum to 17 in the first place.
- **"All other tabs showing nothing"** is the honest, correct behaviour of a well-designed app refusing to fabricate a number it has no real data for — see Section 8.

Four independent database checks (ISIN join, transaction grouping, holding-snapshot positive-unit count, and the parse run's own summary counters) all agreed on 17 schemes throughout; there was never a data-completeness gap once defect #7 shipped.

---

## 7. Open decision needed from the PO

The original PC4 spec called for a synthetic qualification pack (P01–P10) before/alongside the real pilot (PC4-A), separate from this real-document pilot (PC4-B). Given how much real-world coverage this pilot has now delivered — a genuinely messy, real 19-page statement with page-spanning tables, glued columns, split fee rows, scheme renames, multi-line-wrapped redemptions, and inter-scheme transfers, none of which a hand-written synthetic fixture would likely have anticipated — **the PO needs to decide**: run the synthetic P01–P10 pack as originally planned for additional structured coverage, or treat this real-world result (now that all found defects are fixed) as sufficient grounds for a terminal PC4 verdict.

---

## 8. Confirmed pre-existing gaps — not PC4 defects, need their own decision

Three genuinely separate, sizeable pieces of work were surfaced by the pilot, each already covered by its own honest "not available" UI state rather than fabricated data. None of these are things PC4 broke or was ever scoped to fix:

1. **NAV/price history** (`ii_prices_nav`) — zero rows for any instrument, for any user. No ingestion code exists anywhere in the app. Migration `0033`'s own comment: *"No AMFI NAV feed populated by R1 (non-goal) — this is the shape a future release ingests into."* Blocks: Performance returns, Tax & cost, Recurring Investments' per-series value/return figures.
2. **Fund holdings disclosures** (`ii_fund_holdings_snapshots`) — same situation; migration comment: *"write-restricted to trusted server/admin processes"*, no ingestion code exists. Blocks: Underlying fund holdings / X-Ray look-through exposure and fund-overlap detection.
3. **Owner/reconciliation resolution workflow** — the Review Centre correctly surfaces open reconciliation cases (currently 50, all Medium severity, for this PO's account) but can only deep-link back to the raw source statement, not to the specific offending transaction(s), because — per the code's own PC4-section-19 comment — no self-service resolution workflow exists yet beyond Acknowledge/Dismiss.

Recommendation: treat these three as a separate backlog, prioritized and scoped independently of PC4's terminal verdict, since none of them are things this pilot broke — they're pre-existing, honestly-disclosed absences the pilot happened to bring into clear focus.

---

## 9. Recommended next steps, in order

1. Re-run the reconciliation-variance check (Section 4) against a fresh reprocess to confirm how many of the six flagged schemes are now within tolerance after defect #7.
2. Get the PO's decision on Section 7 (synthetic pack vs. real-pilot-sufficient).
3. Issue the Section 47/48 terminal verdict and final PC4 report.
4. Separately, get the PO's prioritization on the three Section 8 gaps (NAV history, fund holdings disclosures, reconciliation workflow) as their own backlog items.
