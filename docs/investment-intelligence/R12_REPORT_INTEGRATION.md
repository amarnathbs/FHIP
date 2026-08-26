# R12 — Report Integration (R10)

## R10 remains the report engine (spec section 67)

**No code changes to `investmentIntelligenceReportData.ts`.** Architecture discovery found zero
`instrument_class`/`mutual_fund` references in this file — it already builds report data generically
from canonical positions. An equity/ETF position that reaches the canonical publishing/holdings path
flows into the same R10 report data contract mutual funds already use, with no report-local
equity-specific calculation.

## Report source-of-truth (spec section 68)

Unchanged principle: every R12 value a report would show (position value, tax classification, X-Ray
contribution) is read from the same canonical II tables/engines documented elsewhere in this doc set —
R12 introduces no report-local computation.

## Report empty state (spec section 69)

Not independently re-verified this cycle for an equity-containing report (not included in the 41-case
certification or live-DEV script — disclosed gap). The pre-existing R10 "Not available"/"Insufficient
data" convention is architecturally inherited (R10 was not modified), but a live end-to-end premium
report generation with a real R12 equity position was not run as part of this round's live-DEV
verification (`R12_LIVE_DEV_VERIFICATION.md` — LIVE-21 equivalent not completed).
