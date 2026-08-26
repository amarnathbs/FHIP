# FDH-9 — Authority and Mutation Model

Spec section 11. Written during the FDH-9 hardening pass (2026-08-26), against
migration `0091_fdh9_payslip_income_intelligence.sql` Part D as actually
implemented and certified (`scripts/fdh9_certification.mjs`, 76/76 PASS).

**The distinction this document exists to make explicit (spec section 66):**
RLS proves **tenant confidentiality** — that Tenant A cannot read or write
Tenant B's rows. It says nothing about **authoritative-state integrity** —
whether Tenant A can forge a value on their OWN row that only a trusted
process should ever produce. FDH-9's disclosed defect was entirely of the
second kind: every table below already had correct RLS-based tenant isolation
before this pass. What was missing was column/transition-level authority.

Every row states what a normal authenticated end user can do **directly**
against the table via ordinary PostgREST (i.e. bypassing any application
code entirely) — the same threat model the disclosed defect was found under.

---

## 1. `fdh_payroll_events`

| | |
|---|---|
| Read by user | Own rows only (RLS: `auth.uid() = user_id`). |
| Direct INSERT | **Yes, own rows.** Deliberate: this codebase's payslip pipeline has no service-role ingestion path anywhere (unlike Investment Intelligence's `ii_transactions`) — every read/write in `lib/import-bridge`/`lib/financial-data-hub/payslip` goes through the per-request, RLS-scoped client. The legitimate write of a freshly parsed payroll event is therefore necessarily an authenticated INSERT by the user who uploaded their own payslip. Fabricating a whole fake payroll event this way is a bounded, same-tenant, self-harm data-integrity concern (no different in kind from typing an arbitrary number into the manual Income form today) — not a same-tenant *authority* breach, and out of scope for this hardening pass. |
| Direct UPDATE | **`employer_name` / `employer_normalised` only** (label correction — the one unambiguous "genuine user-editable correction field" spec section 10 names). Every other column — every money field, every tax/retirement/YTD field, `reconciliation_status`/`reconciliation_variance`, `bank_match_status`/`bank_match_transaction_id`/`bank_match_confidence`, `parser_name`/`parser_version`/`extraction_confidence`, `approval_status`/`approved_at`/`approved_by`, `review_status`, `superseded_by_payroll_event_id`, `payslip_fingerprint`, and every relationship column — is **blocked** by `trg_fdh_payroll_events_authoritative_write` for the authenticated role. Certified: `scripts/fdh9_certification.mjs` §2 (forged `gross_pay`, forged `approval_status`, legitimate `employer_name` correction all exercised live). |
| Direct DELETE | No delete policy for the authenticated role. Rows are removed only via `ON DELETE CASCADE` from the owning `auth.users` row. |
| Authoritative writer | **INSERT:** the payslip extraction pipeline (parser output), as the authenticated user. **UPDATE of system-derived fields:** currently **none exists** — no route/UI in this codebase calls UPDATE on this table yet (see `FDH_CONTEXTUAL_IMPORT_ARCHITECTURE.md`'s correction: the UI layer was never built). `fdh9_approve_payroll_event()` (migration 0091 Part D) is the one function permitted to set `approval_status`/`approved_at`/`approved_by`, via the `fhip.import_bridge_internal_write` transaction-local flag. Any future correction/review UI must add its **own** narrowly-scoped RPC rather than widen the authenticated-role allowance on this trigger. |

## 2. `fdh_payroll_components`

| | |
|---|---|
| Read by user | Own rows only. |
| Direct INSERT | Yes, own rows — written alongside the parent payroll event by the same extraction-persistence step, for the same reason as above. |
| Direct UPDATE | No UPDATE policy exists for the authenticated role at all — every component line is immutable once written (it is a record of what one line of one document said). |
| Direct DELETE | No delete policy; removed only via `ON DELETE CASCADE` from the parent payroll event. |
| Authoritative writer | The payslip extraction pipeline, at INSERT time only. |

## 3. `fhip_import_proposals`

| | |
|---|---|
| Read by user | Own rows only. |
| Direct INSERT | Yes, own rows, **constrained to `status = 'ready'`** — a proposal is inert at creation (spec section 6), so ordinary authenticated INSERT is not the defect this pass closes. |
| Direct UPDATE | Row-scoped by ownership (RLS), then narrowed by `trg_fhip_import_proposals_authoritative_write`: the **only** two direct status transitions permitted for the authenticated role are `ready → dismissed` (the user declines — "keep existing") and `ready → superseded` (a fresh proposal supersedes a stale one on regeneration). Every authoritative/identifying column (`user_id`, `target_domain`, `source_kind`, `source_payroll_event_id`, `currency_code`, `target_entity_id`, `target_entity_updated_at`, `recommended_apply_mode`, `duplicate_of_entity_id`, `generated_at`, `applied_at`) is immutable to the authenticated role, and **`applied` is categorically unreachable** through this path — **this is the exact disclosed defect's closure.** Certified live: `scripts/fdh9_certification.mjs` §2, §9a. |
| Direct DELETE | No delete policy; removed only via `ON DELETE CASCADE` from the source payroll event. |
| Authoritative writer | **`applied` transition, exclusively:** `fdh9_apply_income_proposal()` (migration 0091 Part D), via the `fhip.import_bridge_internal_write` flag every hardening trigger in this document checks. |

## 4. `fhip_import_proposal_fields`

| | |
|---|---|
| Read by user | Own rows only. |
| Direct INSERT | Yes, own rows — written once, atomically, alongside the parent proposal. |
| Direct UPDATE | **None at all** — no UPDATE policy exists for the authenticated role. This is a hardening addition beyond the original disclosure: `existing_value` is the **staleness oracle** the apply RPC compares the live target row against, and a snapshot that can be rewritten after the fact is not a snapshot. Certified live: `scripts/fdh9_certification.mjs` §2 ("rewriting the staleness oracle... is BLOCKED"), §9c. |
| Direct DELETE | No delete policy; removed only via `ON DELETE CASCADE` from the parent proposal. |
| Authoritative writer | The proposal-generation step (`persistProposal()`), as the authenticated user, at creation time only. |

## 5. `fhip_import_applications`

| | |
|---|---|
| Read by user | Own rows only. |
| Direct INSERT | **No** — the INSERT policy's `WITH CHECK` requires the `fhip.import_bridge_internal_write` transaction-local flag to be set, which only `fdh9_apply_income_proposal()` ever sets. A direct authenticated INSERT, even with every column value looking legitimate (`user_id`/`applied_by` = self), is refused by RLS itself. **This closes spec section 20's "forged application row" gate** — the original policy (`with check (auth.uid()=user_id and auth.uid()=applied_by)`) did **not** have this protection; it is a hardening addition this pass made, not present in the original disclosure. Certified live: `scripts/fdh9_certification.mjs` §2. |
| Direct UPDATE | No UPDATE policy for the authenticated role — append-only, matching `fdh_classification_history`'s established discipline. |
| Direct DELETE | No delete policy — an application record is a permanent audit trail entry. Removed only via `ON DELETE CASCADE` from the parent proposal (which itself is never hard-deleted by a user). |
| Authoritative writer | `fdh9_apply_income_proposal()`, exclusively. `UNIQUE(proposal_id)` additionally makes duplicate-apply structurally impossible even if this authority boundary were ever bypassed. |

## 6. `income_sources` (pre-existing table; FDH-9 adds three columns)

| | |
|---|---|
| Read by user | Own rows only (unchanged, pre-existing FDH-1-era policy). |
| Direct INSERT / general UPDATE | **Unchanged from before FDH-9** — the pre-existing `"own rows - income" for all` policy stays exactly as permissive as it always was for every ordinary Income field (`source_name`, `amount`, `frequency`, etc.). Manual Income entry, edit and delete are **completely unaffected** by this hardening pass (spec sections 55, 61) — verified live: `scripts/fdh9_certification.mjs` §2 ("manual Income edit... is NOT broken"). |
| Direct UPDATE of `source_type` / `last_import_application_id` / `last_imported_at` | **No** — `trg_income_sources_provenance_write` blocks a direct authenticated write to any of these three columns specifically, so a user cannot cosmetically claim `source_type = 'payslip_import'` on a manually-entered row, or point `last_import_application_id` at an application record without having gone through the apply RPC. Every other column on the same row remains freely user-editable in the same UPDATE statement. |
| Direct DELETE | Unchanged — archived (soft-deleted via `is_active`) through the existing Income API, not this document's concern. |
| Authoritative writer (provenance columns only) | `fdh9_apply_income_proposal()`, via the internal-write flag. |

---

## 7. The mechanism common to every row above: `fhip.import_bridge_internal_write`

A transaction-local Postgres GUC (`set_config('fhip.import_bridge_internal_write', 'true', true)` — the third argument makes it local to the current transaction, so it can never leak into a later, unrelated request even on a pooled connection). `fdh9_apply_income_proposal()` and `fdh9_approve_payroll_event()` are the only two places in the codebase that ever set it, immediately before each of their own authoritative writes. Every hardening trigger in this document reads it (never sets it) via `coalesce(current_setting('fhip.import_bridge_internal_write', true), 'false') = 'true'`.

This was chosen over a `current_user`/function-ownership check (the mechanism `SECURITY DEFINER` would otherwise make available for free) because which role owns a function migrated via the Supabase CLI vs. the SQL editor vs. a hosted project can vary across the PGlite harness, DEV and production — the GUC is provably correct in all three without any assumption about deployment role names. Forging an authoritative transition now requires executing SQL as a role that can both set arbitrary session GUCs **and** write the table directly — i.e. requires already being inside the trusted function body. A raw PostgREST request can never set this GUC.
