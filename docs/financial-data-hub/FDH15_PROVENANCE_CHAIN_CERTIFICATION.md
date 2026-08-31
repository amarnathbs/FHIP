# FDH-15 — Provenance Chain Certification

## Evidence chain, one example per domain

**Income**: raw payslip PDF (`fdh_statement_uploads`) → `fdh_payroll_events` (extracted/reconciled
evidence) → `fhip_import_proposals`/`_fields` (`source_kind='payslip'`, `source_payroll_event_id`
FK) → explicit Apply (`fdh9_apply_income_proposal`) → `income_sources` row stamped
`source_type='payslip_import'`, `last_import_application_id` → `fhip_import_applications`
(immutable audit: proposal id, target id, applied/previous/new values, `applied_by`, timestamp).

**Retirement**: raw statement → `fdh_retirement_statements` (`retirement_member_id`,
`canonical_account_id` resolved by matching) → proposal (`source_retirement_statement_id` FK) →
`fdh12_apply_retirement_proposal` → `retirement_accounts` stamped `source_type=
'retirement_statement_import'` → `fhip_import_applications` (`source_retirement_statement_id`
carried through).

Liability and AU Investment follow the analogous shape (liability: `fdh_liability_statements` →
proposal → `liabilities`; investment: evidence row's own `apply_status`/`canonical_transaction_id`
columns, no proposal hop).

## Provenance is system-owned (spec §47–48) — live-reproven this round

Direct authenticated PATCH of `income_sources.source_type`, `.last_import_application_id`,
`liabilities.source_type`, and `retirement_accounts.source_type` were all attempted by the OWNING
user against their own just-imported row, using a real authenticated JWT (never service-role):

- Income (`INC-3`/`INC-3b`): **BLOCKED**, HTTP 400, live value unchanged.
- Liability (`LIA-2`): **BLOCKED**, HTTP 400.
- Retirement (`RET-3`): **BLOCKED**, HTTP 400, live value unchanged.

## Apply may set provenance — positive control (spec §50)

The same live run's legitimate Apply calls (`INC-1`, `LIA-1`, `RET-1`) successfully stamped
`source_type`/`last_import_application_id`/`last_imported_at` on their respective canonical rows —
proving the guard blocks the attacker without also blocking the real Apply path (a guard that
blocks both is not a successful fix; this one does not).

## Cross-tenant provenance reference (spec §49) — the FDH-12 failure class, re-checked across siblings

FDH-12 previously proved a class where a user could point `last_import_application_id` at another
tenant's `fhip_import_applications` row (migration `0114`). This round searched for the equivalent
guard on Income and Liability:

- Income: `fdh9_assert_income_import_link_owner()` (migration `0091`) — same-tenant reference
  guard on `income_sources.last_import_application_id`, present since Income's own original
  certification, confirmed still active by reading current migration state.
- Liability: `fdh10_liabilities_assert_provenance_write()` blocks the column outright for the
  authenticated role (stronger than a reference-owner check — the column cannot be touched at all
  outside the internal-write GUC).
- Retirement: `fdh12_assert_retirement_import_link_owner()` (migration `0114`) — same pattern as
  Income.

All three domains have an equivalent guard; no sibling gap found (spec §217's "if one domain lacks
a guard its structurally identical siblings have, investigate" — investigated, none missing).

## Historical provenance integrity (spec §192)

No Apply RPC or trigger permits rewriting `applied_by`, `applied_at`, or `source_*` columns on an
existing `fhip_import_applications` row — the table has no UPDATE/DELETE RLS policy at all
(append-only by construction), so historical provenance cannot be rewritten by any authenticated
client request, forged or not.

## Purged raw document boundary (spec §55)

Not independently re-tested this round (FDH-3's certified purge lifecycle is unchanged territory).
By construction, every provenance column above references structured evidence rows
(`fdh_payroll_events`, `fdh_retirement_statements`, etc.) or the `fhip_import_applications` audit
row — never the raw uploaded file directly — so a legitimate purge of the raw document (FDH-3's own
certified lifecycle) does not require deleting or breaking any FDH-15 provenance reference.
