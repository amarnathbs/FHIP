# FDH-12 — Authority and Mutation Model

Spec section 95. Every field FDH-12 touches, classified.

| Entity / field | Classification | Mechanism |
| --- | --- | --- |
| `fdh_retirement_statements.fund_name`, `.nickname`, `.masked_account_identifier`, statement dates, `.review_status`, `.supersedes_statement_id`, `.source_provenance` | **User-correctable** | RLS `update own`; deliberately absent from the authoritative-write trigger's locked list. |
| `.opening_balance`, `.closing_balance`, all period/YTD movement columns | **System-derived (parser)** | `fdh12_retirement_statements_assert_authoritative_write()` raises for the `authenticated` role. |
| `.parser`, `.parser_version`, `.extraction_confidence`, `.extraction_status` | **System-derived** | same trigger |
| `.reconciliation_status`, `.reconciliation_variance` | **System-derived** | same trigger |
| `.account_match_status`, `.account_match_candidates`, `.canonical_account_id`, `.retirement_member_id` | **System-derived** | same trigger + ownership trigger (cross-tenant) |
| `.smsf_classification`, `.smsf_evidence` | **System-derived** | same trigger. A user cannot clear their own SMSF routing flag. |
| `.approval_status`, `.approved_at`, `.approved_by` | **RPC-only** | `fdh12_approve_retirement_statement()` is the sole legitimate writer; the trigger blocks direct writes. |
| `.duplicate_of_statement_id` | **System-derived** | same trigger |
| `fdh_retirement_statement_activities.activity_type`, `.amount`, `.currency_code`, dates, `.employer_normalised` | **System-derived** | `fdh12_retirement_activities_assert_authoritative_write()` |
| `.is_summary_total`, `.is_year_to_date` | **System-derived** | same trigger. These drive the no-double-count rules, so a user must not be able to flip them. |
| `.payslip_match_status`, `.matched_payroll_event_id`, `.payslip_match_variance`, `.payslip_match_candidates` | **System-derived** | same trigger + ownership trigger (foreign payslip) + unique index |
| `.bank_match_status`, `.linked_transaction_id`, `.bank_match_candidates` | **System-derived** | same trigger + ownership trigger (foreign bank transaction) + unique index |
| `.rollover_counterpart_activity_id`, `.rollover_match_status` | **System-derived** | same trigger |
| `.activity_fingerprint`, `.duplicate_of_activity_id` | **System-derived** | same trigger + partial unique index |
| `.review_status`, `.description_raw`, `.employer_name_raw`, `.source_row_number` | **User-correctable** | not in the locked list |
| `fdh_retirement_statement_positions.units`, `.unit_price`, `.market_value`, `.currency_code`, `.valuation_date` | **System-derived** | `fdh12_retirement_positions_assert_authoritative_write()` |
| `retirement_accounts.current_balance` | **Retirement-owned; RPC-writable** | Written ONLY by `fdh12_apply_retirement_proposal()`, from the nine-column allow-list. |
| `retirement_accounts.employer_contribution`, `.personal_contribution`, `.contribution_frequency` | **Retirement-owned; RPC-writable, confirmation-gated** | In the allow-list, but proposed with `requires_confirmation = true` and never ticked by default. |
| `retirement_accounts.account_name`, `.account_type`, `.currency_code`, `.country_code`, `.owner` | **Retirement-owned; RPC-writable on ADD NEW only** | The adapter proposes them only when `!target`. |
| `retirement_accounts.target_retirement_age` | **Retirement-owned; NEVER writable by FDH-12** | Absent from `RETIREMENT_APPLICABLE_FIELDS` **and** from the RPC's `v_allowed`. A forged proposal naming it is refused `FORBIDDEN_FIELD`. |
| `retirement_members.target_retirement_age` | **Retirement-owned; NEVER writable by FDH-12** | FDH-12 issues no `insert`/`update` against `retirement_members` at all. |
| `retirement_accounts.master_item_key`, `.is_active`, `.user_id`, `.retirement_member_id`, `.ii_publication_id` | **Retirement-owned; structural, never proposal-driven** | Not in the allow-list. `master_item_key` is forced NULL on ADD NEW. |
| `retirement_accounts.source_type`, `.last_import_application_id`, `.last_imported_at` | **RPC-only provenance** | Stamped by the RPC after a successful apply. |
| `smsf_funds`, `smsf_fund_members`, `smsf_holdings` | **SMSF-owned** | FDH-12 issues no write. The apply RPC refuses an SMSF target; migration 0090's guard is the independent backstop. |
| `ii_*`, `investments` | **Investment-Intelligence-owned** | FDH-12 references none of them. |
| `income_sources`, expenses, `fdh_transactions`, `insurance_policies` | **Out of scope; no write path exists** | Asserted mechanically over the real source tree. |
| Retirement projections, readiness, net worth | **Retirement/Forecasting-owned; derived** | FDH-12 changes no formula. |
| `fhip_import_proposals` / `_fields` / `_applications` | **Bridge-owned** | `fhip.import_bridge_internal_write` GUC + `fdh9_assert_proposal_owner()` / `fdh9_assert_application_owner()`, extended by 0111 for the retirement domain. |

## Same-tenant authority — proven, not assumed

`scripts/fdh12_certification.mjs` section 3 attempts SIX real forgeries as the
`authenticated` role against a real Postgres, and each is refused with
`this field is system-authoritative`. Two positive controls prove the result is
not "all updates fail": the user CAN edit `nickname`, and the service-role
bridge CAN write the authoritative columns.

Section 7 is the anti-vacuity proof: the DB is rebuilt with the guard trigger
deliberately removed, and the forgery then SUCCEEDS.

## Guard mechanism — two kinds, each where it is correct

* **FDH-11 style** (`auth.role() <> 'authenticated'`) on the three evidence
  tables, whose legitimate writer is a service-role client.
* **FDH-9/FDH-10 style** (`current_setting('fhip.import_bridge_internal_write')`)
  inside the apply RPC, whose legitimate writer is a `SECURITY DEFINER`
  function that can set the GUC.

They are not interchangeable: the GUC guard only works when a definer function
sets it.

## Cross-tenant security

| Control | Spec | Result |
| --- | --- | --- |
| Tenant B reads A's statement | 97 | BLOCKED (RLS) |
| Tenant B writes A's statement | 97 | No effect (RLS) |
| Tenant B applies A's proposal | 97 | `PROPOSAL_NOT_FOUND` |
| A's statement targets B's retirement account | 98 | BLOCKED (`cross-tenant reference`) |
| A's activity links B's bank transaction | 99 | BLOCKED |
| A's activity links B's payslip | 100 | BLOCKED |
| A's statement attaches B's member row | 101 | BLOCKED |
| Global reference data mutated by import | 102 | No write path exists |

All verified in `scripts/fdh12_certification.mjs` section 4, each against real
Postgres, with a positive control proving the tenant's OWN references succeed.
