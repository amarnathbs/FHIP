# FDH-8 — Transaction Explorer

## Query surface

`getTransactions(userId, filters, paging)` — `TransactionExplorerFilters` covers account/category/merchant/economic-type/approval-status/review-status/recurring/transfer/amount-range/period/text search; `paging` covers `sort` (`newest|oldest|highest|lowest|merchant`, each a deterministic two-column `ORDER BY` with `id` as a stable tie-breaker — spec 76) and `limit` (default 100, max 500 — spec 44/49).

## Search (spec 45)

Text search is `description_clean ILIKE '%needle%'` via PostgREST's `.ilike()`, with the needle stripped of `%`/`,`/`(`/`)` before use — no raw SQL construction, no string-concatenated query (the exact "no SQL exposure" requirement). It does not currently search merchant display name (a join, not a column on `fdh_transactions`) — disclosed as a smaller-scope search than spec 45's full list (description/merchant/category/subcategory); category/subcategory/merchant filtering is available as an exact-match FILTER (`category_id`/`merchant_id`), just not as free-text search terms yet. Open Residual.

## Pagination (spec 49, 96-97)

The SAME deterministic keyset ordering convention as `bank-transactions/route.ts`/`review-queue/route.ts` (`transaction_date desc, id desc` for the default `newest` sort) is available; `getTransactions` in this pass exposes `limit` but not yet a `before_date`/`before_id` cursor parameter at the API-route level (the analytics function returns a flat page; wiring a "load more" cursor into the route is straightforward future work using the same `.or()` pattern the two precedent routes already use). Certified independently at the raw-SQL level for 1,001 rows with a real cursor walk in `scripts/fdh8_certification.mjs` SECTION 3 — the underlying data model and index (`idx_fdh_txn_user_date`) support it; the route-level cursor parameter itself is an Open Residual, not a correctness gap.

## Detail view

Each row carries everything spec 48 asks for directly off `fdh_transactions` (date/merchant_id/description/amount/category_id/economic_transaction_type/financial_account_id/recurring_transaction_id/approval_status/review_status) — a detail expansion needs only a merchant/category name join, already available via the same master-data lookups the breakdown pages use. A "Review/Edit classification" link routes into the existing FDH-7 correction UI/API (`bankTransactionActionsService.ts#correctTransaction`'s consumer surface) rather than duplicating correction logic (spec 49).

See the completion report for the UI build's actual realized file paths and any judgment calls made when wiring the review-link destination.
