# FDH-15 — Live DEV Certification

FRESH FDH-15 EXECUTION. Script: `scripts/fdh15_bridge_governance_live_dev_certification.mjs`. Run
against the real hosted DEV Supabase project (`vqycarelcoijzwlpkpcz`, confirmed via `.env.local`'s
`NEXT_PUBLIC_SUPABASE_URL` matching the project ref this repository has used for every prior FDH
live-DEV round). Two synthetic tenants (A, B) created via the Admin API; every decisive Apply/
security/provenance/stale/cross-tenant call used a **real `authenticated`-role JWT** for that tenant
(obtained via `POST /auth/v1/token?grant_type=password` using the anon key, per repository rule 10),
never the service-role key — the service-role key was used only for fixture seeding, ground-truth
re-queries, and cleanup.

## Result: 28/30 PASS

The 2 failures are the two genuine defects this pass found, root-caused, and fixed (not yet applied
to DEV — see below). No other check failed.

```
--- INCOME BRIDGE ---
  PASS  INC-1  Positive control: legitimate update_existing via real authenticated RPC succeeds
  PASS  INC-1b Self income amount updated to 4200 (exact decimal)
  PASS  INC-1c Apply stamped provenance source_type=payslip_import
  PASS  INC-2  Double apply of same proposal returns ALREADY_APPLIED
  PASS  INC-2b exactly ONE fhip_import_applications row exists (unique(proposal_id) enforced)
  PASS  INC-3  Provenance erase BLOCKED (source_type)
  PASS  INC-3b Provenance erase BLOCKED (last_import_application_id)
  PASS  INC-4  Stale proposal BLOCKED (STALE_PROPOSAL)
  PASS  INC-4b canonical value remains the user's manual edit, not silently overwritten
  PASS  INC-5  Zero-fields Apply -> NO_FIELDS_SELECTED
  FAIL  INC-6  Self->Spouse income target forgery -- NOT blocked (FDH15-DEF-001, fixed in 0120, not yet DEV-applied)

--- RETIREMENT BRIDGE: SELF/SPOUSE BOUNDARY ---
  PASS  RET-0  Real approve RPC succeeds for the owning user
  PASS  RET-1  Positive control: legitimate Self->Self apply succeeds via real RPC
  PASS  RET-1b Self account balance updated to 105000
  FAIL  RET-2  Self->Spouse retirement target forgery -- NOT blocked (FDH15-DEF-002, fixed in 0119, not yet DEV-applied)
  PASS  RET-3  Provenance erase BLOCKED (retirement_accounts.source_type)
  PASS  RET-4  target_retirement_age is NOT an applicable field -> FORBIDDEN_FIELD

--- LIABILITY BRIDGE ---
  PASS  LIA-0  Real approve RPC succeeds for the owning user
  PASS  LIA-1  Positive control: legitimate liability update_existing succeeds via real RPC
  PASS  LIA-1b balance updated, provenance stamped
  PASS  LIA-2  Provenance erase BLOCKED
  PASS  LIA-3  Cross-tenant Apply BLOCKED

--- CROSS-TENANT ISOLATION SWEEP ---
  PASS  XT-1  Cross-tenant READ of proposal BLOCKED (RLS returns empty)
  PASS  XT-2  Cross-tenant WRITE to proposal BLOCKED (zero rows affected)
  PASS  XT-3  Cross-tenant APPLY BLOCKED via real RPC (PROPOSAL_NOT_FOUND)
  PASS  XT-3b Tenant A income unchanged after the blocked attempt
  PASS  XT-4  Cross-tenant DELETE BLOCKED (proposal still exists)
  PASS  XT-5  Foreign canonical target BLOCKED at INSERT (real DB trigger, P0001)

--- CLEANUP ---
  PASS  Tenant A synthetic income rows = 0 after cleanup
  PASS  Tenant A auth user deleted (re-query 404/empty)

28/30 PASS
```

## Cleanup — independently re-verified beyond the script's own inline check

After the run, this certifying agent independently re-queried, by the exact synthetic user ids
created, across all 11 tables the fixtures touched (`income_sources`, `fdh_payroll_events`,
`fhip_import_proposals`, `fhip_import_proposal_fields`, `fhip_import_applications`,
`retirement_members`, `retirement_accounts`, `fdh_retirement_statements`, `liabilities`,
`fdh_liability_statements`, `user_profiles`) plus a direct Admin-API lookup of both auth user ids.
**Result: 0 residual rows, both users 404 (deleted).** A repository-wide sweep for any auth user
whose email matches `%fdh15-bridge%` also returned zero matches.

## Why this run is decisive, not merely PGlite-based (spec sections 149, 164-165, 215)

Every Apply/approve call above used `POST {SUPABASE_URL}/rest/v1/rpc/<function>` with `Authorization:
Bearer <real user JWT>` — the exact HTTP path PostgREST/the app's own API routes use, not a
service-role-authenticated call and not a direct table mutation standing in for the RPC. The
`auth.uid()` value the RPC reads inside its own body is therefore the real value GoTrue placed in
that JWT's claims, exercised through the real RLS/PostgREST stack — not simulated.

## Genuine defects found this pass — not yet closed live

**FDH15-DEF-001** (Income) and **FDH15-DEF-002** (Retirement): both root-caused, fixed in migrations
`0120`/`0119` (create-or-replace only, no schema change), and certified via PGlite with an
anti-vacuity proof (`scripts/fdh15_member_mismatch_pglite_certification.mjs`, 8/8 PASS — the same
forged-target scenario, run against an isolated schema copy with the fix migrations excluded,
reproduces the original live-DEV failure, confirming the harness genuinely detects the guard's
absence). Per repository rule 1, this agent cannot apply DDL to hosted DEV directly — both
migrations are handed to the Product Owner for manual application via the Supabase Dashboard SQL
editor. **Until that happens, the live exploit demonstrated above (INC-6/RET-2) remains live-
exploitable on DEV** — this is disclosed honestly as an open gate, not asserted fixed live, per
repository rule 4 and this project's own "SQL-Editor-success is not sufficient evidence" lesson.
A short follow-up re-run of this same script after DEV application would close the loop (expected
result: 30/30 PASS).
