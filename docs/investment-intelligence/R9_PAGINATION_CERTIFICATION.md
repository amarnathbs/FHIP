# R9 Pagination Certification

Every R9 read that could exceed PostgREST's silent 1000-row cap uses `fetchAllPages()` (`portfolioAttribution.ts`, `reviewCentreData.ts`) — a `.range()`-paging loop that continues until a page returns fewer than `PAGE_SIZE` (500) rows, applied to: `investments`, `goal_funding_sources`, `investments.ii_last_refreshed_at` reads, `ii_reconciliation_cases`, `ii_analytics_results`, `ii_sip_series`, `ii_capital_gains_computations`. `GET /investment-intelligence/review` itself is cursor-paginated (`created_at` + `id` tie-breaker, capped at 200/page) rather than unbounded.

## >1000 test (spec section 79)

`tests/unit/iiR9PaginationCertification.test.ts`, reusing the project's own empirically-grounded PostgREST-cap mock (the same harness `tests/unit/iiR4AnalyticsRepositoryPagination.test.ts` used after a **real** live-DEV-reproduced truncation defect):

- **R9-PAGE-001**: a 1200-row portfolio with a distinctive value at the 1001st row (0-indexed 1000). `computePortfolioAllocationSummary()`'s `totalValue` is proven to differ by the needle row's exact value between the full (1200-row) read and an artificially-truncated (1000-row) read — the ACTUAL RESULT depends on row 1001+, not just the row count (the literal requirement of spec section 79).
- **R9-PAGE-002**: 1100 funding-source rows, the only non-null `linked_investment_id` at row 1051 — `fetchAllInvestmentFundingSources()` recovers it.

Result: 4/4 pagination tests pass (`npx vitest run tests/unit/iiR9PaginationCertification.test.ts`).

## Negative control 5 (spec section 92)

Disabling continuation (i.e. calling the mock's unbounded `.select()` path directly instead of `fetchAllPages()`) is exactly what "R9-PAGE-000: the mock harness faithfully reproduces PostgREST's silent 1000-row cap" and the "harness sanity check" test in `iiR9PaginationCertification.test.ts` prove fails (returns exactly 1000 rows, silently drops the needle) — demonstrating the guarded case can fail, i.e. the >1000 test is not vacuous.
