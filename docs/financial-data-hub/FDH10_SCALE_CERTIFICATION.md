# FDH-10 — Scale Certification

## Status: NOT EXECUTED this pass — honestly disclosed

Spec section 121-124 requires credit-card transaction histories at 100/500/1,000/1,001/5,000/10,000 rows and loan histories at 12/36/60/120/360 months, with an explicit pagination negative control (artificially cap retrieval at 1,000, prove 1,001 genuinely fails, then restore and prove it passes).

This was not run in this pass, per this dispatch's own stated priority order (hard rule 7 places scale/volume certification after the architecture, headline controls, bridge, core product logic, UX, and security work — all of which were completed and certified first).

## Why this is a lower-risk gap than it might appear

- `financialActivityAnalytics.ts` (FDH-8, reused unmodified by FDH-10) **already has its own certified pagination fix** — `fetchAllRows()` — specifically built to close exactly this defect class (silent PostgREST 1,000-row truncation), documented in its own file header as reused from FDH-6's identical prior fix. FDH-10 introduces no new unbounded-`.select()` query pattern of its own; the two new tables (`fdh_liability_statements`, `fdh_liability_statement_activities`) have no query code written against them yet at all (no service/route reads them in bulk — see the completion report's UI/API gap), so there is no FDH-10-specific pagination surface to certify in this pass.
- All money arithmetic in the new engine modules goes through `lib/financial-data-hub/domain/money.ts`'s exact minor-unit primitives (`sumMoney`/`moneyEquals`/`toMinorUnits`) — the same primitives R7/FDH-8 rely on for their own scale-certified exactness — so no new binary-float arithmetic risk was introduced.

## What a genuine scale pass would need

1. A synthetic-data generator producing 100/500/1,000/1,001/5,000/10,000-row `fdh_liability_statement_activities` sets per statement.
2. A bulk-read service/route over those rows (does not exist yet — see UX gap) to actually exercise pagination.
3. Deterministic principal/interest/fee sequences for 12/36/60/120/360-month loan histories, verified against `decomposeLoanPayment()` at each row.
4. The pagination negative control itself, mirroring FDH-8's own historical test for the identical defect class.

None of this could be executed meaningfully without the read/write service layer FDH10-K would provide, which was not built this pass.
