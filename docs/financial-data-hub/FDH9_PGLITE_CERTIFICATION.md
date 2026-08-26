# FDH-9 — PGlite Certification

`scripts/fdh9_certification.mjs`, re-run fresh in this pass (2026-08-26,
live-DEV-cert + Income-tab pass) against real, unmodified Postgres via
`@electric-sql/pglite`, after every code/enum change this pass made.

## Result: 76 passed, 0 failed (unchanged from the prior hardening pass)

```
=== SECTION 1-8 SUBTOTAL: 68 passed, 0 failed ===
=== FINAL RESULT: 76 passed, 0 failed ===
```

No regression from this pass's changes — expected, since this pass touched
the **application** layer (routes, services, UI, one TS enum), not migration
`0091`'s SQL, which this script rebuilds from disk on every run.

## Coverage (unchanged structure from the prior pass; re-verified, not re-described from memory)

1. **Schema** (14 checks) — tables, constraints, indexes, RLS, functions,
   triggers, grants all present.
2. **Same-tenant authoritative-write forgery** (9 checks) — the originally
   disclosed defect and its closure, plus the four related findings from the
   same hardening pass (forged application row, forged payroll fields, forged
   provenance, rewritten staleness oracle) — each paired with a "legitimate
   write is NOT over-hardened" control.
3. **Atomic apply RPC happy paths** (13 checks) — `add_new`,
   `update_existing`, `apply_selected_fields`, `keep_existing`, each verified
   against the real Income row and the real application audit row, not just
   the RPC's return value.
4. **Mid-operation failure / atomicity** (4 checks) — a forced failure inside
   the RPC's own transaction leaves Income, the proposal status, and the
   application-row count all exactly as they were before the call.
5. **Stale proposal** (3 checks).
6. **Duplicate / concurrent apply** (4 checks) — a second call against an
   already-applied proposal is refused, and two genuinely concurrent calls
   against the same proposal produce exactly one applied outcome (proven via
   the row lock inside the RPC, not merely by application-level sequencing).
7. **Field allow-list** (1 check).
8. **Cross-tenant security** (8 checks) — Tenant B cannot read or mutate any
   of Tenant A's payroll/proposal/Income/application data, and a forged
   cross-tenant target (Income or bank transaction) is blocked at write time.
9. **Harness self-checks** (8 checks, spec section 65) — each PASS above is
   proven non-vacuous by deliberately weakening the corresponding control in
   an isolated throwaway schema copy and confirming the harness would have
   caught it; this includes the two financial-integrity oracles
   (double-count: $4,250+$4,250 correctly recognised as ONE $4,250 economic
   event, not $8,500; YTD: a $40,000 YTD figure never contaminates the
   $5,000 current-period gross).

## What PGlite proves, and what it does not

PGlite is a real Postgres engine — every trigger, RLS policy, constraint and
`SECURITY DEFINER` function in migration 0091 runs exactly as it would on
Supabase, and `set_config('request.jwt.claims', ...)` + `set role
authenticated` genuinely exercises RLS rather than simulating it. What it
cannot prove is anything specific to the **hosted Supabase environment**
itself (connection pooling behaviour, PostgREST's own request handling, the
Management API, storage). That gap is exactly what live-DEV certification
(spec sections 11-20) exists to close, and — per `FDH9_LIVE_DEV_
CERTIFICATION.md` — this environment cannot currently attempt it.
