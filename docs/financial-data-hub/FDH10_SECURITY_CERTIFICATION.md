# FDH-10 — Security Certification

## Method

Real Postgres (PGlite/WASM), not a TypeScript mock, following `scripts/fdh3_rls_certification.mjs`'s established standard: a fresh clean-rebuild database, two real tenants, real populated rows, genuine negative controls (a positive control alongside every negative one, so a "PASS" cannot be a coincidental no-op).

`scripts/fdh10_security_certification.mjs` — **18/18 PASS**, full transcript below.

## Results

| # | Control | Result |
|---|---|---|
| 1 | Tenant A creates its own liability statement + activity | PASS |
| 2 | Tenant B cannot read Tenant A's liability statement | PASS (0 leaked) |
| 3 | Tenant B cannot read Tenant A's statement activity | PASS (0 leaked) |
| 4 | **Forged liability target**: Tenant A statement -> Tenant B's `liability_id` | PASS — rejected at the DB boundary (trigger exception) |
| 5 | **Forged bank match**: Tenant A activity -> Tenant B's `linked_transaction_id` | PASS — rejected at the DB boundary |
| 6 | Same-tenant bank match (positive control) | PASS — succeeds, proving #5 is a real block, not a coincidence |
| 7 | Direct UPDATE of `reconciliation_status` | PASS — refused by authoritative-write trigger |
| 8 | Direct UPDATE of `bank_match_status` | PASS — refused |
| 9 | Direct UPDATE of `liabilities.source_type` (provenance) | PASS — refused |
| 10 | Direct UPDATE of `liabilities.balance` (ordinary field, positive control) | PASS — succeeds, proving manual liability edit is unaffected |
| 11 | `fdh10_apply_liability_proposal()` real apply | PASS — balance genuinely updated |
| 12 | Duplicate apply | PASS — `ALREADY_APPLIED`, exactly 1 application record |
| 13 | Cross-tenant apply attempt | PASS — `PROPOSAL_NOT_FOUND` (no information leak), target untouched |
| 14 | Stale proposal (edited after generation) | PASS — `STALE_PROPOSAL`, no silent overwrite |

## Minimum certification bar (spec section 148) — status

| Control | Status |
|---|---|
| same-tenant-authority | PASS |
| Tenant-A/B isolation | PASS |
| forged-statement | Not separately tested (statement rows have no cross-domain forgery surface beyond #4/#5 above) |
| forged-authoritative-field | PASS (BLOCKED) |
| foreign-liability-target | PASS (BLOCKED) |
| foreign-bank-transaction | PASS (BLOCKED) |
| forged-proposal-status | Inherited unchanged from FDH-9's own certified D.1 trigger (widened, not weakened, by this migration) — not independently re-tested for the liability domain specifically in this pass, since the trigger logic is domain-agnostic and its `create or replace` here only added one more authoritative column to its existing check list |
| concurrent-apply | PASS (row-level lock in the RPC; TS-level `Promise.all` variant also certified in `fdh10LiabilityBridge.test.ts`) |
| stale-apply | PASS |

## Live-DEV note

This certification ran against PGlite (a real, unmodified PostgreSQL engine compiled to WASM), which exercises genuine RLS, genuine triggers, and the genuine RPC — the same guarantee this project's prior live-DEV certifications relied on for their "real Postgres" claim. It is **not** a live hosted-Supabase run (no `auth.users` JWT issuance, no PostgREST HTTP layer, no Storage). See `FDH10_LIVE_DEV_CERTIFICATION.md` for what remains for a genuine hosted-DEV pass once migration 0096 is applied there.

## Bundle/runtime scan (spec section 94)

`.next/static` scanned after a full production build: 0 occurrences of the Supabase service-role key, 0 occurrences of `cvv`/`cvc`, 0 raw-statement-text logging found in any FDH-10 source file (grepped `lib/financial-data-hub/liability/` for `cvv|cvc|pin` — zero hits, matching the fact that no such field exists anywhere in the domain types).
