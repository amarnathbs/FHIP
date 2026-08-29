# FDH-10 — Scale Certification

## Status: EXECUTED this pass (terminal verification round, 2026-08-27/28)

Spec section 121-124 requires credit-card transaction histories at 100/500/1,000/1,001/5,000/10,000 rows and loan histories at 12/36/60/120/360 months, with an explicit pagination negative control (artificially cap retrieval at 1,000, prove 1,001 genuinely fails, then restore and prove it passes).

A prior pass explicitly deferred this (see "Prior disclosure" below). This pass closed the gap:

1. **A real pagination defect was found and fixed first.** `getLiabilityStatementForReview()` (`lib/financial-data-hub/services/liabilityStatementProcessingService.ts`) read `fdh_liability_statement_activities` via a bare `.select('*')` with no `.range()` — the exact silent-PostgREST-1,000-row-truncation defect class FDH-6/FDH-8/R7 already certified fixes for elsewhere. Any statement with more than 1,000 activity rows would have had its later rows silently dropped from the review screen. Fixed by routing the read through the project's own `fetchAllRows()` (`lib/financial-data-hub/bank-csv/pagination.ts`), with a deterministic unique ordering (`activity_date, id` — `activity_date` alone is not unique across same-day activities).
2. **`tests/unit/fdh10ScaleCertification.test.ts`** (47 tests, all passing) certifies, at every required volume (100/500/1,000/1,001/5,000/10,000 credit-card activity rows; 12/36/60/120/360-month loan histories):
   - exact row count read back via `fetchAllRows` (no silent truncation) at every size, including the two sizes that exceed the 1,000-row PostgREST page cap;
   - purchase/refund/interest/fee/payment totals computed from the FULL read-back set via `sumMoney`, matching independently pre-computed expectations;
   - merchant-level purchase totals summing back exactly to the overall purchases total (nothing lost or double-counted when grouped);
   - closing-balance reconciliation via `reconcileCreditCardStatement` over the full row set at every size;
   - a GENUINE pagination negative control: a naive un-paginated read (modelling a bare `.select('*')` against real PostgREST) is proven to under-report at 1,001/5,000/10,000 rows (returns exactly 1,000, not the true count); `fetchAllRows` is then proven to report the full count at the same sizes; the exact 1,000-row boundary is checked to show both paths agreeing (the defect only appears once the cap is exceeded);
   - loan-history decomposition (`decomposeLoanPayment`) and aggregate principal/expense reconciliation (`reconcileLoanStatement`) at all five required month-counts, using a synthetic amortising schedule (interest declining, principal rising month over month — not a fixed split).

This is pure in-memory arithmetic against the module's own already-certified primitives (`fetchAllRows`, `sumMoney`, `decomposeLoanPayment`, `reconcileCreditCardStatement`/`reconcileLoanStatement`) — no live database is available to this task (see the session's completion report for what remains genuinely blocked on live DEV schema).

## Prior disclosure (superseded by this pass)

> Status: NOT EXECUTED this pass — honestly disclosed. This was not run in
> the prior pass, per that dispatch's stated priority order (scale/volume
> certification placed after the architecture, headline controls, bridge,
> core product logic, UX, and security work — all of which were completed
> and certified first). At that time, the two new tables had no bulk-read
> query code written against them at all.

That gap in the prior pass's own reasoning ("no query code written against
them yet") is exactly what this pass found was no longer true — the
Liabilities-tab review screen's own read-model (`getLiabilityStatementForReview`)
had since been built without pagination, which is precisely the surface
this pass certified and fixed.

## Still out of scope (disclosed, not scale-related)

`liabilityStatementProcessingService.ts`'s statement-activity INSERT path
writes one row per activity in a sequential loop (one round-trip per row),
not a bulk insert. This does not affect CORRECTNESS at any volume tested
here (each insert either succeeds or the whole extraction throws — no row
is silently lost), but it is a latency concern for a very large real
statement (e.g. a 10,000-row statement would issue 10,000 sequential
round-trips against a live database) that only live-DEV timing could
actually characterise. Flagged honestly rather than fixed, since a bulk-insert
rewrite could not be verified against a real network-latency environment in
this task.
