# FDH-10 — Authority & Mutation Model

Same lesson this project has now applied at least six times (0065, 0068, 0069, 0087, 0091 Part D, and here): **RLS proves row ownership; it never proves column or lifecycle authority.** Every system-derived field below is protected by a `BEFORE UPDATE` trigger gated on the transaction-local GUC `fhip.import_bridge_internal_write`, exactly as migration 0091 Part D established.

## Entity authority matrix

| Entity | Read | Insert | Update | Delete | Canonical writer |
|---|---|---|---|---|---|
| `fdh_liability_statements` | Owner (RLS) | Owner (RLS), via `liabilityStatementProcessingService.ts` | Owner for non-authoritative fields; `review_status`/`approval_status`/`approved_at`/`approved_by`/reconciliation/parser fields move ONLY via `fdh10_approve_liability_statement()` (Part F.5, added this continuation round — closes the gap this doc previously disclosed) | None (no delete policy) | `liabilityStatementProcessingService.ts` (extraction/reconciliation) + `fdh10_approve_liability_statement()` (approval) |
| `fdh_liability_statement_activities` | Owner (RLS) | Owner (RLS), via `liabilityStatementProcessingService.ts` (bank matching runs at insert time for PAYMENT activities) | Owner for `description`/`category_id`/`merchant_id` (reuses existing review UI); `activity_type`/`amount`/decomposition components/`linked_transaction_id`/`bank_match_status` are authoritative | None | `liabilityStatementProcessingService.ts` (matching engine logic — `bankMatching.ts` — was built and certified in isolation the prior round; this round wired it to real rows) |
| `liabilities` | Owner (RLS) | Owner (RLS) | Owner for every pre-existing field (manual edit fully unaffected, spec 129); `source_type`/`last_import_application_id`/`last_imported_at` are authoritative | Owner (RLS, unchanged) | `fdh10_apply_liability_proposal()` for provenance columns only |
| `fhip_import_proposals` (liability rows) | Owner (RLS) | Owner, `status='ready'` only (RLS, unchanged from 0091) | Owner may only move `ready -> dismissed/superseded`; every other column (including the new `source_liability_statement_id`) is authoritative | None | `fdh10_apply_liability_proposal()` |
| `fhip_import_proposal_fields` | Owner (RLS) | Owner, at proposal creation (RLS, unchanged) | None (immutable once created — unchanged from 0091) | None | Proposal-generation code path only |
| `fhip_import_applications` (liability rows) | Owner (RLS) | Requires `fhip.import_bridge_internal_write='true'` (RLS, unchanged from 0091) | None | None | `fdh10_apply_liability_proposal()` |
| Bank match / repayment decomposition | N/A (not a standalone entity) | Via `fdh_liability_statement_activities.linked_transaction_id` + `fdh_transaction_allocations` | Authoritative | N/A | A future matching service |
| Canonical Liability (post-Apply value) | Owner (RLS) | — | Via RPC only, for import-derived fields | — | `fdh10_apply_liability_proposal()` |

## Same-tenant referential integrity (spec sections 90-92)

Two new trigger functions enforce ownership on every foreign key the new tables introduce:

- `fdh10_assert_liability_statement_owner()` — `statement_upload_id`, `financial_account_id`, `liability_id` (**forged liability target**), `duplicate_of_statement_id`.
- `fdh10_assert_liability_activity_owner()` — `statement_id`, `linked_transaction_id` (**forged bank match**).

Both were verified live against real Postgres (PGlite) in `scripts/fdh10_security_certification.mjs`: a Tenant-A row referencing a Tenant-B id raises a same-tenant exception; a same-tenant reference of the identical shape succeeds (the positive control that proves the negative control is genuine, not a coincidental failure).

The existing FDH-9 guard functions (`fdh9_assert_proposal_owner`, `fdh9_assert_application_owner`) were widened (`create or replace`) with a `target_domain = 'liability'` branch — the identical pattern their own comments predicted ("A future domain adapter adds its own narrow branch here").

## No raw-statement-text logging, no CVV/PIN/full-card-number

`lib/financial-data-hub/liability/` has no field, variable, or log line named `cvv`/`cvc`/`pin`/full card number anywhere (grepped, zero hits). `masked_identifier` on both `liabilities` and `fdh_liability_statements` carries the same 7-consecutive-digit CHECK constraint FDH-1 established for `fdh_financial_accounts.masked_identifier`. The production bundle scan (`.next/static`) found zero occurrences of the service-role key, zero `cvv`/`cvc` matches.

## User-facing API surface (added this continuation round — spec sections 18-20)

Every route below derives ownership EXCLUSIVELY from `requireUser()`'s authenticated session — none accepts a client-supplied `user_id`/`household_id`/`owner_id` of any kind, and every database call additionally filters `.eq('user_id', userId)` on top of RLS (belt-and-braces, same discipline as `supabaseStore.ts`'s own header comment):

- `POST /api/financial-data-hub/liability-statement/upload` — upload + extract (never touches `liabilities`).
- `GET /api/financial-data-hub/liability-statement/{documentId}` — review read-model (read-only).
- `POST /api/financial-data-hub/liability-statement/{documentId}/approve` — the ONLY path to `fdh10_approve_liability_statement()`.
- `POST`/`GET /api/financial-data-hub/liability-statement/{documentId}/proposal` — generate/read the comparison (never touches `liabilities`).
- `POST /api/financial-data-hub/liability-proposals/{proposalId}/apply` — the ONLY path to `fdh10_apply_liability_proposal()`; never a direct `PATCH liabilities` or `PATCH fhip_import_proposals.status`.

## Residuals (honestly disclosed, updated this continuation round)

- **CLOSED THIS ROUND**: the approval-RPC gap this doc previously disclosed (`fdh_liability_statements.approval_status` had no legitimate direct-authenticated path) is fixed — see `fdh10_approve_liability_statement()`, Part F.5.
- **CLOSED THIS ROUND**: the matching/decomposition engine logic is now wired to real rows via `liabilityStatementProcessingService.ts` for bank-payment matching against `fdh_transactions` at statement-processing time.
- **STILL OPEN**: `creditCardEconomics.ts`/`repaymentDecomposition.ts` (`planCardStatementLedgerWrites`/`decomposeLoanPayment`) remain pure, fully-tested DECISION functions with no caller that writes their output as real `fdh_transactions`/`fdh_transaction_allocations`/`fdh_transaction_links` rows — i.e. a card purchase or loan interest/fee line on an approved, applied statement does not yet become an actual household expense in the ledger the R8/FDH-6/FDH-7/FDH-8 pipeline reports on. Today the pipeline ends at: statement evidence extracted + reconciled + bank-matched -> approved -> proposal -> Apply updates the canonical Liability's `balance`/`interest_rate`/`monthly_repayment`/etc. This is the single largest remaining functional gap after this round's UI/API work — see the round's completion report for the honest scope call.
