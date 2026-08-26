# FDH-10 — Authority & Mutation Model

Same lesson this project has now applied at least six times (0065, 0068, 0069, 0087, 0091 Part D, and here): **RLS proves row ownership; it never proves column or lifecycle authority.** Every system-derived field below is protected by a `BEFORE UPDATE` trigger gated on the transaction-local GUC `fhip.import_bridge_internal_write`, exactly as migration 0091 Part D established.

## Entity authority matrix

| Entity | Read | Insert | Update | Delete | Canonical writer |
|---|---|---|---|---|---|
| `fdh_liability_statements` | Owner (RLS) | Owner (RLS) | Owner for non-authoritative fields; **no direct authenticated path exists yet for `review_status`/`approval_status`/reconciliation/parser fields** — fails closed (see Residuals) | None (no delete policy) | A future extraction/reconciliation service (not built this phase) |
| `fdh_liability_statement_activities` | Owner (RLS) | Owner (RLS) | Owner for `description`/`category_id`/`merchant_id` (reuses existing review UI); `activity_type`/`amount`/decomposition components/`linked_transaction_id`/`bank_match_status` are authoritative | None | A future matching/decomposition service (engine logic built and certified this phase; not yet wired to a route) |
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

## Residuals (honestly disclosed)

- No approval RPC exists yet for `fdh_liability_statements.review_status`/`approval_status` (mirrors FDH-9's own disclosed gap for `fdh_payroll_events` before its approval RPC was added) — the authoritative-write trigger therefore fails CLOSED: there is no legitimate direct-authenticated path into `approved` today. This is a known, deliberate gap, not an oversight, and matches this project's established "fail closed until a real caller exists" discipline.
- No matching/decomposition SERVICE exists yet that would call the authoritative fields on `fdh_liability_statement_activities` via the internal-write GUC — the engine logic (`bankMatching.ts`, `repaymentDecomposition.ts`) is built and unit-certified, but nothing in `app/` invokes it against real rows yet (see `FDH10_COMPLETION_REPORT.md`).
