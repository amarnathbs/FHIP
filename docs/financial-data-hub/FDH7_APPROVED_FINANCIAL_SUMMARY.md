# FDH-7 — Approved Financial Summary

## Purpose (spec 57, 102-107)

A canonical, versioned, per-statement record of approved financial activity, suitable for future FDH-15 bridge consumption — `fdh_approved_financial_summaries` (migration 0076). FDH-7 never writes FHIP Input Data itself (spec 6).

## Computation is pure and independent (spec 84)

`lib/financial-data-hub/domain/approvedSummary.ts#computeApprovedFinancialSummary` — no DB access, exact minor-unit arithmetic throughout (`domain/money.ts`), never a JS float `+=` on money. `services/approvalService.ts#approveStatement` is the only caller; it fetches the real rows and passes them in.

## Treatment rules (documented explicitly per spec 58-62)

- **Transfers** (spec 58, 106): `economic_transaction_type = 'transfer'` transactions/allocations NEVER contribute to `income_total`/`expense_total` — only to `transfer_total` (informational magnitude). This holds regardless of how many statements/accounts are later aggregated, because neither side is EVER routed to the income/expense buckets in the first place.
- **Duplicates** (spec 59): `dedup_status IN ('duplicate_confirmed', 'user_confirmed_duplicate')` contributes nothing to any total, but is counted separately in `duplicate_excluded_count` — the row is never deleted.
- **Splits** (spec 45-47, 59): a transaction with allocations is summed via its allocations ONLY; the parent's own amount/type is never also summed. An invalid split (allocations not summing exactly to the parent) makes the function THROW (`FdhApprovedSummaryError`) rather than silently produce a wrong total.
- **Refunds** (spec 60): a refund's magnitude always adds to `refund_total`. It ADDITIONALLY subtracts from `expense_total` if — and only if — the caller supplies a CONFIRMED `refund_original`/`reversal_original` link naming this refund's original EXPENSE transaction. `100 expense, 20 confirmed-linked refund -> expense_total = 80, refund_total = 20` (spec 60's own worked example, reproduced exactly in the test suite). Never nets against income.
- **Cash withdrawal** (spec 61): its own dedicated bucket, never folded into expense.
- **Unknown** (spec 62, 89): summed into `unknown_total`, always visible, never silently dropped, never folded into any other bucket.

## Approved vs unapproved (spec 62)

Every summary row is inherently scoped to transactions that were genuinely approved at write time (the caller only ever passes the statement's current transaction set at the moment `approved_by` is stamped) — there is no code path by which an unreviewed/unapproved transaction's value can enter a summary row.

## Reopen/versioning (spec 63)

`approval_version` (integer, unique per statement together with `statement_upload_id`) and `superseded` (boolean) together preserve full history — reopening marks the current row superseded; a fresh approval inserts the next version. Nothing is ever deleted or overwritten.

## Bridge-readiness (spec 102-103)

No implementation-specific column leaks (no raw source IDs, no parser internals) — the row exposes only totals, counts, `category_aggregates` (id -> {label, total}), and period bounds. `GET /api/financial-data-hub/documents/{id}/approved-summary` is the read contract; a future FDH-15 `getApprovedFinancialActivity({household, account, period})` can be built directly against this table without FDH-7 having to pre-empt the mapping logic itself.

## Household/multi-account scope (spec 105-107)

Approval and its summary remain account/document-specific by construction (`financial_account_id`, `statement_upload_id` on every row) — no cross-account aggregation is performed BY FDH-7. Cross-account transfer double-counting is prevented structurally (transfers never enter income/expense at the per-statement level, so summing several statements' summaries can never produce a false net either — proven by the transfer negative control operating on two DIFFERENT synthetic "accounts" in the same test).
