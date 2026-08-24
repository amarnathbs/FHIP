# FDH-8 — Scale Certification

## What was actually run

`scripts/fdh8_certification.mjs` SECTION 3, against a fresh PGlite (real Postgres) instance with all 77 migrations replayed:

```
=== SECTION 3: scale — 1,001 approved transactions ===
  PASS  exact count() at 1,001 rows is 1,001, not capped at 1,000
  PASS  keyset pagination walk across the 1,001-row set collects all 1,001 ids with zero duplicates/gaps (collected 1001 across 3 pages)
  PASS  exact sum at 1,001 rows is $1,001.00
```

`tests/unit/fdh8FinancialIntegrityCertification.test.ts` also certifies the pure-function oracle at 1,001 rows (`computeApprovedFinancialSummary` over an in-memory 1,001-element fixture array), independent of the DB layer — both PASS.

## Correctness at the specific scale points the spec calls out (85, 96)

| Scale point | Verified how | Result |
|---|---|---|
| 100 | Implied by every fixture set above (all well under 1,000); no distinct issue expected below the 1,000/500-row page-size boundaries used throughout FDH-8's queries. | Not separately re-run — same code path as 1,001. |
| 1,000 | `EXPLORER_PAGE_SIZE_MAX = 500` in `getTransactions()` and the review-queue/bank-transactions precedents cap a SINGLE PAGE at 500, not 1,000 — so 1,000 rows is two pages, never a truncation boundary by construction. | Structural, not separately fixture-tested. |
| 1,001 | `scripts/fdh8_certification.mjs` SECTION 3 — real `count()`, real keyset walk, real `sum()`. | **PASS**, evidence above. |
| 5,000 / 10,000 | Not run in this session (time-budgeted out; see Open Residuals in the completion report). | **Not certified.** |

This is a genuine, disclosed gap: the spec asks for correctness verification at 100/1000/1001/5000/10000. Only 1,001 (the specific truncation-class boundary previously caught as a real regression in an earlier FDH phase, per spec 49/96's own callout) was actually run against a live-shaped database in this session. The query pattern used at 1,001 rows (deterministic keyset pagination, `count()`-based totals, no client-side full-table aggregation) does not change shape at 5,000/10,000 — there is no `LIMIT 1000` or offset-pagination anywhere in `financialActivityAnalytics.ts` (grep-verified) that would behave differently at larger N — but this is a structural argument, not a re-run measurement, and is reported as such rather than rounded up to "certified at 10,000".

## Performance architecture (spec 77-81, 100-101)

- **No N+1 fetching.** `fetchScopedTransactions()` issues exactly 2 queries per call (transactions, then one batched `IN (...)` query for their allocations) regardless of row count — never one query per transaction. Category/merchant master data is fetched once per analytics call via `listActiveAll()` (a single query each), then joined in-memory — never queried per row.
- **Server-side aggregation.** All summation happens inside `financialActivityAnalytics.ts` (a server-only module, imported only from `app/api/financial-data-hub/activity/*/route.ts` and — per the UI build — server components), never shipped to the client as raw rows for client-side reduction. The Transaction Explorer is the one page that legitimately ships row-level data to the client, and it is capped at 500 rows/page by construction.
- **No arbitrary pass/fail threshold invented.** Per spec 101 ("document observed values, no arbitrary thresholds just to pass"), no p95/p99 latency claim is made here — this session did not run this against a real network-attached Postgres (only PGlite, in-process), so a latency number would not be representative of a real deployment and is deliberately not fabricated.
