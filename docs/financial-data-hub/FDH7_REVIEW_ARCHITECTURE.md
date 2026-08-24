# FDH-7 — Review Architecture

## Chain (spec section 5, 159)

```
Canonical Transactions (FDH-1)
  -> Automated Intelligence (R8 merchant/category, FDH-6 economic class/transfer/duplicate/recurring/refund, R7 reconciliation/dedup)
  -> REVIEW QUEUE (FDH-7, GET /api/financial-data-hub/review-queue)
  -> User action (accept / correct / split / confirm-transfer / reject-transfer /
     confirm-duplicate / keep-both / confirm-recurring / dismiss-recurring /
     correct merchant-category-class / request-counterpart-account)
  -> APPROVED TRANSACTION DATA (fdh_transactions.approval_status = 'approved')
  -> Approved Financial Summary (fdh_approved_financial_summaries)
  -> (FDH-15, not this phase) FHIP Input Data Bridge
```

## Review levels (spec 11)

| Level | Table/mechanism | Owner |
|---|---|---|
| DOCUMENT | `fdh_statement_uploads.processing_status`/`review_status` | FDH-3 (reused) |
| STATEMENT | `fdh_reconciliation_results`, `fdh_statement_uploads.approved_by` | R7 (reused) + FDH-7 (new: approval) |
| TRANSACTION | `fdh_transactions.review_status`/`approval_status` | FDH-1 (reused) + FDH-7 (new: approval) |
| RELATIONSHIP | `fdh_transaction_links`, `fdh_duplicate_candidates` | FDH-1 (schema) + R8/FDH-6 (matching, reused) |
| ALLOCATION | `fdh_transaction_allocations` | FDH-1 (schema) + FDH-7 (new: write path) |

## New FDH-7 modules

- `lib/financial-data-hub/domain/approvalPolicy.ts` — centralised review-priority ordering and bulk-action partial-success contract. Pure functions, no DB access.
- `lib/financial-data-hub/domain/approvedSummary.ts` — pure, independently-testable Approved Financial Summary calculation (the certification oracle, spec 84).
- `lib/financial-data-hub/services/transactionSplitService.ts` — split creation/replacement, reusing FDH-1's `domain/allocations.ts` validator.
- `lib/financial-data-hub/services/approvalService.ts` — transaction approval, statement approval (cascade + gate + summary), reopen, bulk approval.
- `app/api/financial-data-hub/bank-transactions/{id}/split`, `{id}/approve`, `bulk-approve`
- `app/api/financial-data-hub/documents/{id}/approve`, `{id}/reopen`, `{id}/review-summary`, `{id}/approved-summary`
- `app/api/financial-data-hub/review-queue`

## What FDH-7 explicitly does NOT build (spec 7, 20)

Charts, monthly spending dashboards, category analytics, budgeting, trend lines, lifestyle insights, a full expense-tracker homepage, an admin transaction browser. The review-queue endpoint returns counts and a keyset-paginated list only.
