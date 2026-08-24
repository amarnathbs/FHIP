# FDH-6 — Scale Certification

## A real defect found while preparing this certification

Building the mandatory 1,000/1,001/5,000/10,000-row scale/pagination test (spec sections 101-103) surfaced a genuine, previously-undisclosed correctness gap: `lib/financial-data-hub/repositories/base.ts`'s generic `listForUser(userId, limit)` / `listActive(limit)` — used by every FDH phase since FDH-1, including R8 and FDH-6's own new code — issue a SINGLE PostgREST request with `.limit(limit)`. PostgREST enforces its own `db-max-rows` cap (1000 on this project, `POSTGREST_PAGE_SIZE` in `bank-csv/pagination.ts`) on every response regardless of what a larger `.limit()` requested — so any call site requesting more than 1,000 rows (e.g. `merchantAliasesRepository.listActive(10_000)`, `transactionLinksRepository.listForUser(userId, 5000)`, both real call sites inside R8's own `transactionClassificationService.ts`) was silently capped at 1,000, with no error and no indication.

## Fix (additive, zero regression to existing callers)

Two NEW methods added to `repositories/base.ts` — `listForUserAll()` and `listActiveAll()` — reuse R7's existing, separately-certified `fetchAllRows()` pagination helper (`bank-csv/pagination.ts`, already used by transaction reads) to page past the 1,000-row cap with deterministic ordering (`created_at`/`id` tiebreak for user-owned tables, `id` for master data). The EXISTING `listForUser`/`listActive` methods are completely unchanged — every one of their many other call sites across FDH-1 through R8 keeps its exact prior behaviour; only the FDH-6/R8 call sites genuinely at risk of exceeding 1,000 rows were switched to the new methods:

- `transactionClassificationService.ts`: `loadReferenceData()` (categories/subcategories/merchants/merchant-aliases/global-rules), `classifyUserTransactions()`'s user-rules/accounts reads, and the transfer/refund existing-links dedup read.
- `classificationReviewService.ts`: `explainTransactionReviewReasons()`'s links/duplicate-candidates reads.

## Certification

`tests/unit/fdh6Pagination.test.ts` proves, using an in-memory fake of the Supabase query-builder chain (same precedented technique `iiR3RepublishFieldRestoration.test.ts` established — this codebase has no general Supabase mock by design):

- `listForUserAll()`/`listActiveAll()` correctly return the FULL row set at 999, 1000, 1001, 5000 and 10000 rows — none silently dropped.
- Tenant/active-flag filtering survives across the page boundary (a second tenant's 1500 rows never leak into a 500-row result for the real tenant, even though the total exceeds 1,000).
- **Negative control**: the OLD `listForUser(userId, 5000)` — run against the identical fixture — genuinely truncates below 5000, proving the fixture is honest and reproducing the exact defect this fix closes.

## Real 1,000/5,000/10,000-transaction classification run

Exercised as part of live-DEV certification (`FDH6_LIVE_DEV_CERTIFICATION.md`) rather than a synthetic unit test — `classifyUserTransactions()` is an orchestration function making real (mocked-out-of-scope-for-unit-tests) Supabase calls end to end; correctness at scale for the CLASSIFICATION LOGIC itself (as opposed to the pagination plumbing) is already proven by the independent certification pack's 98 hand-authored cases, which exercise every code path `classifyUserTransactions()` calls per-transaction — scale changes row COUNT, not per-row logic.

## Idempotency at scale (spec section 103)

Unchanged from R8: `classifyUserTransactions()` computes `changed = result.economicTransactionType !== txn.economic_transaction_type || ...` before writing, and only inserts a `fdh_classification_history` row when a real change occurred. Re-running classification over an unchanged 10,000-row set with unchanged rules/master data therefore writes zero new history rows and zero new transfer/refund/recurring links (the `existingLinkedIds`/`recurring_transaction_id IS NULL` filters this phase's pagination fix ensures are now COMPLETE at scale, closing a latent idempotency risk: before the fix, a >1,000-link household could have seen duplicate link proposals on every re-run simply because the "already linked" check silently missed links past row 1,000).
