# FDH-8 — Scale Certification

**STATUS: CERTIFIED AT 5,000 AND 10,000 ROWS, LIVE DEV — 2026-08-25.** Supersedes the prior version of this document, which certified only 1,001 rows (PGlite) and explicitly disclosed 5,000/10,000 as "not certified — time-budgeted out."

## A real defect found while preparing this certification

Building this test surfaced a genuine, previously-undisclosed correctness gap, of the exact class this whole program has repeatedly found in earlier phases (FDH-6, R4/II): `fetchScopedTransactions()` in `lib/financial-data-hub/analytics/financialActivityAnalytics.ts` issued a single, unbounded PostgREST `select` with no `.range()`/pagination on the transactions query, the allocations lookup, and the refund-links lookup. This DEV project's `db-max-rows` is **1,000** (confirmed via `lib/financial-data-hub/bank-csv/pagination.ts`'s own header comment and FDH-6's own prior certification). Any household with more than 1,000 approved/pending transactions in the requested period would therefore have had EVERY FDH-8 headline number (income, expenses, net cash flow, category totals, merchant totals) silently computed over a truncated slice, with no error surfaced anywhere — exactly the class of PostgREST-truncation defect this program's own R4/FDH-6 phases previously found and fixed.

**Fixed**, before any scale row was inserted: `fetchScopedTransactions()`, its allocations sub-query, and `fetchConfirmedRefundLinks()` now all route through `fetchAllRows()` — the SAME established pagination helper FDH-6 used to close the identical defect class in its own repositories (see `lib/financial-data-hub/bank-csv/pagination.ts`). Every FDH-8 analytics entry point (`getOverview`, `getSpendingBreakdown`, `getIncomeBreakdown`, `getMerchants`, `getTrend`, `getAccounts`) routes through `fetchScopedTransactions`, so this single fix closes the gap everywhere at once. No new pagination concept, no schema change, no migration.

## What actually ran

`scripts/fdh8_scale_live_certification.ts`, run against the real DEV project and the real running app (`http://localhost:3232`). A controlled synthetic dataset with a realistic mixture — approved income, approved expenses across 3 categories, transfers, one merchant concentration, multiple accounts, pending review (10% of every row) — deterministically generated, with **expected totals computed independently in the script itself using plain arithmetic, never by calling any FDH-8 aggregation code**.

**Final result: 31 PASS, 0 FAIL (of 31), both scales.**

## 5,000-row certification

| Check | Expected | Live result |
|---|---|---|
| Row count | 5,000 | **5,000** exact (ground-truth `count()`, service-role) |
| Approved income | $1,500,000.00 | **$1,500,000.00** exact |
| Approved expense | $113,965.00 | **$113,965.00** exact |
| Net cash flow | $1,386,035.00 | **$1,386,035.00** exact |
| Pending-review count | 500 | **500** exact |
| Category total ×3 | $50,970 / $39,500 / $23,495 | all exact |
| Merchant total (1,500 txns) | $50,970.00 | **$50,970.00** exact, 1,500 txns exact |
| Transaction Explorer page | 500 rows, no error | PASS |
| Search filter at scale | ≥1 match | PASS |
| Account filter at scale | only that account's rows | PASS |
| Sort=highest at scale | genuinely descending | PASS |

## 10,000-row certification

| Check | Expected | Live result |
|---|---|---|
| Row count | 10,000 | **10,000** exact |
| Approved income | $3,000,000.00 | **$3,000,000.00** exact |
| Approved expense | $227,970.00 | **$227,970.00** exact |
| Net cash flow | $2,772,030.00 | **$2,772,030.00** exact |
| Pending-review count | 1,000 | **1,000** exact |
| Category total ×3 | $101,970 / $79,000 / $47,000 | all exact |
| Merchant total (3,000 txns) | $101,970.00 | **$101,970.00** exact, 3,000 txns exact |
| Explorer / search / account filter / sort | as above | all PASS |

Missing = 0. Unexpected duplicates = 0 (ground-truth count equals exactly the inserted count at both scales).

## Phase G — Pagination negative control [proves the fix is load-bearing, not a no-op]

A query artificially capped at exactly 1,000 rows (simulating the PRE-FIX behaviour — the same single-request shape `fetchScopedTransactions()` used to issue) was run alongside a genuinely-paginated full-ground-truth query (1,000-row chunks, walked to completion) at N=10,000:

```
Artificially-capped query (1,000 rows):  expense = $25,147.00   (WRONG — under-reports by 89%)
Full ground truth (9,000 approved rows): expense = $227,970.00  (correct)
The REAL live FDH-8 API (post-fix):      expense = $227,970.00  (matches full ground truth exactly)
```

This is a genuine before/after proof, not an assertion: the capped-query figure is dramatically wrong, and the real live API — after this closure's `fetchAllRows()` fix — matches the true figure exactly rather than the capped one. A prior draft of this same negative control made the identical single-Range-request mistake the pre-fix production code made (a single request, however wide the `Range` header, does not bypass PostgREST's server-side `db-max-rows` cap) — that draft's "full" query was ALSO silently truncated to 1,000 rows, producing a misleadingly-equal (and therefore falsely-passing) result. Caught and fixed before this certification was accepted; the corrected version pages through in 1,000-row chunks for genuine ground truth, exactly as `fetchAllRows()` itself does.

## Scale architecture review (Phase H — correctness/architecture sanity check, not a load benchmark)

- **No N+1 fetching.** `fetchScopedTransactions()` issues 2 queries total regardless of row count (transactions, then batched `IN (...)` allocation lookups in bounded 200-id chunks) — never one query per transaction. Category/merchant master data loaded once per call via the already-paginated `listActiveAll()`.
- **Server-side aggregation.** All summation happens inside `financialActivityAnalytics.ts` (server-only), never shipped to the client as raw rows for client-side reduction. The Transaction Explorer is the one page that legitimately ships row-level data, capped at 500 rows/page by construction (a single-page fetch, not a truncation — no cursor-based "load more" is wired at the route level yet, a disclosed pre-existing residual, not new).
- **No repeated aggregate queries** — `getOverview()` computes approved and pending totals from two SEPARATE, single-pass fetches, never re-querying per section of the page.

## Cleanup

Both 5,000-row and 10,000-row datasets deleted (mid-clean between runs plus final cleanup); independently re-queried — `FDH8-SCALE-CLEANUP`: 0 leftover rows. PASS.
