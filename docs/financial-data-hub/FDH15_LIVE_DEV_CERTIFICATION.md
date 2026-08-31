# FDH-15 — Live DEV Certification

## Method (repository standing rule #10, spec §149/§164–165/§215)

Script: `scripts/fdh15_bridge_governance_live_dev_certification.mjs`. Target: hosted DEV
(`vqycarelcoijzwlpkpcz.supabase.co`), guarded by an explicit project-ref check that aborts if the
configured URL is not that exact project. Two synthetic tenants (A, B) created via the Admin API
(service-role key), each signed in via `POST /auth/v1/token?grant_type=password` to obtain a real
`role: authenticated` JWT. **Every decisive Apply/security/provenance/stale/cross-tenant call in
this script uses that JWT as the `Authorization: Bearer` header — never the service-role key.** The
service-role key is used only for: creating the synthetic users, seeding evidence-shaped fixture
rows (payroll events, liability/retirement statements — the parts a real upload+parse pipeline
would have produced, which FDH-3/5/9/10/11/12 already certify independently), ground-truth
re-queries, and cleanup.

## Results (final clean run, after the two fixes described below)

```
28/30 PASS (the 2 "FAIL" lines are the two genuine, now-fixed defects — see below)
```

Income suite: INC-1 through INC-5 all PASS (positive control, double-apply idempotency, provenance
forge/erase blocked, stale-proposal blocked, zero-fields controlled outcome). INC-6 (same-tenant
owner forgery) failed pre-fix — see FDH15-DEF-001.

Retirement suite: RET-0/1/1b/3/4 all PASS (real approve RPC, positive control, provenance guard,
`target_retirement_age` FORBIDDEN_FIELD). RET-2 (Self/Spouse forgery) failed pre-fix — see
FDH15-DEF-002.

Liability suite: LIA-0/1/1b/2/3 all PASS (real approve RPC, positive control, provenance guard,
cross-tenant Apply blocked).

Cross-tenant sweep: XT-1 through XT-5 all PASS (read/write/apply/delete blocked; foreign canonical
target blocked at INSERT with a real trigger error message, not a generic RLS silence).

Cleanup: both synthetic auth users deleted and independently re-verified `0` (re-query by
`user_id`, re-query the deleted auth user id → 404). Every fixture row was created via the
`trackA`/`trackB` arrays and deleted in reverse order before the auth users themselves.

## The two defects, live-reproduced, then re-confirmed absent from the exploit path (PGlite)

See `FDH15_RESIDUAL_RISK_REGISTER.md` for the full `FDH15-DEF-xxx` records. Summary:

- **FDH15-DEF-001** (Income, P1): a same-tenant, Self-attributed payslip proposal whose
  `target_entity_id` named a Spouse-owned `income_sources` row was **accepted** by the real
  `fdh9_apply_income_proposal` RPC and silently overwrote the Spouse's income — reproduced live
  twice (consistent) before the fix.
- **FDH15-DEF-002** (Retirement, P1): the identical class for `fdh12_apply_retirement_proposal` —
  reproduced live before the fix.

Both are fixed via migrations `0119` (Retirement) and `0120` (Income), each `CREATE OR REPLACE
FUNCTION` (idempotent, no schema/table change). **The fixes are PGlite-certified (9/9 PASS,
including anti-vacuity proof that the harness genuinely detects the guard's absence on the
unfixed chain) but NOT YET applied to hosted DEV** — per standing rule 1, these migrations are
handed to the Product Owner for manual application via the Supabase Dashboard SQL editor. Per
standing rule 4, this is disclosed honestly as a pending activation step, not asserted as a live
fix. **The exploit reproduced above remains live-exploitable on DEV today until that manual step
happens.**

## What was NOT covered live this round (honest scope disclosure)

- AU Investment's Apply path (no user-invoked RPC; service-role-gated, API-route-authorized) was
  **not** exercised via a real HTTP call to the actual Next.js API route this round (no dev server
  was run against DEV for this purpose) — reused FDH-11's own prior live certification instead
  (unchanged source). This is a real scope gap for Investment specifically: FDH-15's own live proof
  for Investment is weaker than for Income/Liability/Retirement.
- A single combined "golden bridge household" exercising Income+Liability+AU-Investment+Retirement
  in ONE user context via real RPCs/API was not built this round (time-boxed); FDH-15 instead
  proved each generic-bridge domain's real-RPC Apply path independently, plus a cross-tenant sweep.
  FDH-14's own golden-household oracle (service-role writes, not real RPCs) remains the closest
  existing multi-domain single-household evidence — explicitly flagged in
  `FDH15_CROSS_DOMAIN_FINANCIAL_INTEGRITY.md` as not meeting §215's bar for the bridge claim itself.
- Concurrent (simultaneous in-flight) Apply requests, browser-tab/session concurrency, and raw
  HTTP replay were not fault-injected fresh this round — see
  `FDH15_IDEMPOTENCY_AND_CONCURRENCY_CERTIFICATION.md` for the architectural reasoning relied upon
  instead.
- Scale (1000/1001/5000-row proposal lists) was not freshly tested this round.
