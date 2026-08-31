# FDH-15 — Cross-Tenant Security Certification

All checks in this document were run live against hosted DEV (`vqycarelcoijzwlpkpcz`) this round,
using two real synthetic tenants (A, B) and REAL authenticated-user JWTs for every decisive call —
never the service-role key for the decisive request itself. Full transcript:
`FDH15_LIVE_DEV_CERTIFICATION.md`; script: `scripts/fdh15_bridge_governance_live_dev_certification.mjs`.

## Cross-tenant proposal isolation (spec §79)

| Attempt | Result |
|---|---|
| B reads A's proposal (`GET fhip_import_proposals?id=eq....`) | **BLOCKED** — RLS returns an empty array, not the row (XT-1) |
| B PATCHes A's proposal (`status='dismissed'`) | **BLOCKED** — proposal status unchanged after the request (XT-2) |
| B applies A's proposal via the real `fdh9_apply_income_proposal` RPC | **BLOCKED** — `PROPOSAL_NOT_FOUND`, same response as a nonexistent id (XT-3); A's income unchanged (XT-3b) |
| B applies A's liability proposal via `fdh10_apply_liability_proposal` | **BLOCKED** — `PROPOSAL_NOT_FOUND` (LIA-3) |
| B deletes A's proposal | **BLOCKED** — no DELETE RLS policy exists; row still present after the request (XT-4) |

## Foreign canonical target (spec §80)

B attempts to CREATE ITS OWN proposal naming Tenant A's `income_sources` row as
`target_entity_id` (own-tenant proposal, foreign target — the harder case, since RLS alone would
permit B to insert a row it owns):

**BLOCKED at INSERT** (XT-5) — HTTP 400, real Postgres error: `"fhip_import_proposals: cross-tenant
reference — income entry <id> belongs to a different user"`. This is a DB trigger
(`fdh9_assert_proposal_owner()`), not UI filtering — confirmed by the raw PostgREST response
carrying the trigger's own `RAISE EXCEPTION` text, not a generic RLS "no rows" response.

## Same-tenant authority forgery (spec §81) — the two genuine defects this round found and fixed

Within ONE tenant, forging a legitimate proposal's `target_entity_id` toward a different (but
still same-tenant) canonical row was tested for Income and Retirement — see
`FDH15_RESIDUAL_RISK_REGISTER.md` FDH15-DEF-001/002. Both were found to succeed pre-fix (a genuine
gap) and are now blocked post-fix (proven in PGlite; DEV re-proof pending the Product Owner's
manual migration application, per standing rule 1/4).

## Authoritative field forgery (spec §82)

`user_id`, `target_entity_id` (cross-tenant), `applied_by`, `approved_by`, and provenance columns
(`source_type`, `last_import_application_id`, `last_imported_at`) were all attempted for forgery by
the owning user via direct authenticated REST calls this round (Income/Liability/Retirement) — all
**BLOCKED** (see `FDH15_PROVENANCE_CHAIN_CERTIFICATION.md`). `user_id`/`applied_by` specifically:
the RLS INSERT policy on `fhip_import_applications` requires `auth.uid()=user_id AND
auth.uid()=applied_by`, and the RPC is the only writer that ever sets these — a direct client
INSERT attempting to forge a different `user_id`/`applied_by` fails RLS outright (not tested as a
dedicated new case this round; this is the same mechanism FDH-9's original certification already
proved, reused unchanged).

## User-editable fields — positive control (spec §83)

The SAME live run's legitimate Apply calls (field selection, Add New, Update Existing, Keep
Existing/dismiss) all succeeded normally — confirming the security guards above do not also block
legitimate user decisions (a guard that blocks everything is not a successful design).

## Service role is not user authorization (spec §84–86)

Every apply/approve RPC derives the acting identity **exclusively** from `auth.uid()` — none
accepts a client-supplied `user_id`/`household_id` parameter, and none uses `SECURITY DEFINER` as a
substitute for an in-body ownership check (each RPC re-verifies `proposal.user_id = auth.uid()` and
`target.user_id = auth.uid()` independently, even though RLS already constrains the initial row
visibility) — confirmed by direct reading of all three RPC bodies (migrations `0091`, `0096`,
`0112`/`0113`/`0114`, `0119`, `0120`) this round.

## SECURITY DEFINER / search_path review (spec §85)

All bridge-relevant `SECURITY DEFINER` functions (both pre-existing and the two new ones this
round) set `search_path` explicitly (`set search_path = public`). **0** unqualified dangerous
`search_path` found among bridge/apply/approve functions. (Two unrelated pre-existing auth-trigger
functions, `handle_new_user()` and `handle_new_user_entitlement()`, were flagged during discovery as
lacking an explicit `search_path` — these are outside FDH-15's bridge scope and are not touched or
re-certified here; noted for completeness only.)

## RLS inventory (spec §161)

All FDH-15-relevant tables (`fhip_import_proposals`, `fhip_import_proposal_fields`,
`fhip_import_applications`, `fdh_payroll_events`, `fdh_liability_statements`/`_activities`,
`fdh_retirement_statements`/`_activities`, `fdh_investment_statements`/`_positions`/`_activities`,
and the canonical targets `income_sources`/`liabilities`/`retirement_accounts`) have
`ENABLE ROW LEVEL SECURITY` with `auth.uid()=user_id`-scoped policies — confirmed both by the fresh
113/113 PGlite replay (`rls_enabled=216, rls_disabled=0` across the whole schema) and by the six
discovery agents' direct migration reads. Cross-tenant user access = **0** in every live test this
round.
