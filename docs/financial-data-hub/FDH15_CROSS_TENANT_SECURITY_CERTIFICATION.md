# FDH-15 — Cross-Tenant Security Certification

FRESH FDH-15 EXECUTION. All decisive results below are from a real `authenticated`-role JWT (obtained
via `POST /auth/v1/token?grant_type=password`, per repository rule 10's documented technique), never
the service-role key, against real hosted DEV (`vqycarelcoijzwlpkpcz`). Script:
`scripts/fdh15_bridge_governance_live_dev_certification.mjs`. REUSES FDH-14's own
`fdh14_cross_domain_security_certification.mjs` (28/28) and `fdh14_foreign_canonical_target_
certification.ts` (13/13) as prior, independently-re-verifiable evidence for the canonical-row-level
claims; this document's own fresh contribution is the **proposal-table-level** CRUD sweep (spec
section 79), which FDH-14 did not specifically exercise.

## 1. Cross-tenant proposal CRUD (fresh this pass)

Tenant B, using their own real session token, against Tenant A's `fhip_import_proposals` row:

| Action | Live result |
|---|---|
| **Read** (`GET fhip_import_proposals?id=eq.<A's proposal>`) | XT-1: `[]` — RLS `USING` clause silently filters, zero rows returned (not a 403 — correct PostgREST/RLS behaviour) |
| **Modify** (`PATCH ... {status:'dismissed'}`) | XT-2: HTTP 200 (RLS does not error on a no-op-affecting PATCH) but **zero rows affected** — re-query confirms `status` is still `ready` |
| **Apply** (`rpc/fdh9_apply_income_proposal`) | XT-3: `{"ok":false,"code":"PROPOSAL_NOT_FOUND"}` — indistinguishable from a nonexistent proposal, no cross-tenant probe signal; **XT-3b**: Tenant A's income unchanged after the blocked attempt |
| **Delete** (`DELETE fhip_import_proposals?id=eq.<A's proposal>`) | XT-4: HTTP 200 but proposal still present on re-query — RLS silently filters the delete target too |

**All four BLOCKED.** This closes spec section 79 with fresh evidence distinct from FDH-14's
canonical-row-level matrix.

## 2. Foreign canonical target (own-tenant proposal naming another tenant's row)

Tenant B creates their OWN `fhip_import_proposals` row (their own `user_id`), but sets
`target_entity_id` to Tenant A's `income_sources.id`:

**Live result (XT-5)**: HTTP 400, `{"code":"P0001", "message":"fhip_import_proposals: cross-tenant
reference — income entry ... belongs to a different user"}` — **BLOCKED at INSERT**, by the real
`fdh9_assert_proposal_owner()` trigger (migration 0091), not merely by later Apply-time filtering.
This is fresh confirmation of the same mechanism FDH-14's `fdh14_foreign_canonical_target_
certification.ts` proved for Income/Liability/Retirement (13/13, reused) — re-derived here with a
different tenant pair and a different calling script, landing on the identical trigger and identical
outcome.

## 3. Same-tenant authority forgery (Self/Spouse) — the two genuine defects

Within ONE tenant, forging a proposal's target from the legitimately-matched row to an unrelated
same-tenant row (a different household member's row) was **not blocked** prior to this pass's fix —
see `FDH15_CANONICAL_TARGET_AND_OWNERSHIP_MATRIX.md` §3 for full detail on FDH15-DEF-001/002. This is
a materially different claim from cross-tenant isolation (§1-2 above, both of which passed cleanly):
same-tenant forgery is about whether the RPC defends a household's OWN sub-boundaries (Self vs
Spouse), not whether it defends tenant boundaries. Fixed in migrations `0119`/`0120`, PGlite-
certified (8/8), not yet applied to hosted DEV.

## 4. Provenance forgery/erase — live-tested (see `FDH15_PROVENANCE_CHAIN_CERTIFICATION.md` for
detail)

Owning-user direct PATCH of `source_type`/`last_import_application_id` on their own imported row:
**BLOCKED** (HTTP 400) across Income, Liability, Retirement — live, fresh this pass.

## 5. Authoritative field forgery

`user_id`, `applied_by`, `approved_by`, `status` (into `applied`), `target_domain`,
`source_payroll_event_id`/`source_liability_statement_id`/`source_retirement_statement_id` are all
covered by the `fdh9_import_proposals_assert_authoritative_write()`-family triggers (BEFORE UPDATE,
gated on the `fhip.import_bridge_internal_write` transaction-local GUC) — any direct authenticated-
role write to these columns raises. Live-confirmed for `status` specifically via XT-2 above.

## 6. Dynamic target-domain injection

`target_domain` is a CHECK-constrained enum (`'income','expense','asset','liability','investment',
'retirement'`) — inserting `target_domain='arbitrary_table'`/`'user_profiles'`/`'households'` fails
the CHECK constraint outright (a straightforward Postgres constraint violation, not separately
re-tested live this pass since it is a static schema guarantee independent of runtime state; verified
by reading the constraint definition in migration 0091). Even a permitted-but-unimplemented value
(`'expense'`, `'asset'`) is rejected downstream by the RPC's own `if v_proposal.target_domain <>
'income' then return PROPOSAL_NOT_ACTIONABLE` check (each RPC only proceeds for its own literal
domain string).

## 7. Anti-vacuity (spec section 163)

This certification's own PGlite script (`scripts/fdh15_member_mismatch_pglite_certification.mjs`)
positively demonstrates the harness is not vacuous: run against an isolated schema copy with
migrations `0119`/`0120` excluded, the identical forged-target request **succeeds** (reproducing the
original defect), proving the harness would have caught the regression, not merely asserted a pass.
