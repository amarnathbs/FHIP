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

**UPDATE 2026-08-28 (terminal certification):** the live end-to-end gap noted below is now closed.
`scripts/r12_live_dev_full_cert.mjs` R12-24, executed against real hosted DEV this round, generated a
real Premium report (`POST /api/reports/generate`) for a user holding a real R12 equity + ETF + MF
mixed portfolio and confirmed `investment_performance` section status = `included` (not a
"Not available"/empty placeholder) — i.e. the populated-report path is proven live, not just
architecturally inherited. The specific "genuinely empty portfolio -> correct empty-state copy, not a
fabricated zero" case was still not separately exercised this round (would need a report generated for
a user with zero II positions) — that narrower placeholder-copy scenario remains a disclosed,
non-blocking gap, distinct from the now-closed "does a populated R12 report actually render" gap this
paragraph used to describe.
