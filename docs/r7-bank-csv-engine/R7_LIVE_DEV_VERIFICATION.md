# R7 — Live DEV Verification

## Status: NOT YET PERFORMED — migration 0064 is not applied to the live DEV Supabase project

This is disclosed honestly rather than fabricated. The spec requires (§79-84) genuine authenticated tests against the real, migrated DEV database — 15 live cases and 10 independent live reconciliations. That work is **blocked on migration 0064 actually being applied to `vqycarelcoijzwlpkpcz`**, and this session has no credential path capable of applying it.

## What was checked, and why the blocker is real (not assumed)

`scripts/fdh1_closure_capability_probe.mjs` was re-run live against the actual DEV project this session:

```
host vqycarelcoijzwlpkpcz.supabase.co
rpc/exec_sql:    http 404 (function not found)
rpc/execute_sql: http 404
rpc/run_sql:     http 404
rpc/admin_exec:  http 404
public.tables (catalog): http 404
information_schema:      http 406 (schema not exposed via PostgREST)
```

`.env.local` in this worktree carries `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` only — no database password, no `DATABASE_URL`, no linked Supabase CLI project (`npx supabase` is present but unauthenticated/unlinked). The Supabase JS client with a service-role key can bypass **RLS** for data operations, but PostgREST (the only channel that key reaches) does not execute arbitrary DDL, and no `exec_sql`-shaped RPC exists on this project to route through. Every prior phase's "migration applied to DEV" (FDH-1 through FDH-3, II R1-R6, this session's own 0049 reconciliation) was performed by the human Product Owner via the Supabase SQL editor or CLI with the DB password — never by an agent session, and no such credential is present in this worktree.

## What WAS independently verified as the strongest available substitute

Given the same real-PostgreSQL-engine constraint, this release instead ran the exact methodology `scripts/db-rebuild-check/` established for the project's own migration-lineage reconciliation, extended with an R7-specific script:

1. **`scripts/db-rebuild-check/replay.mjs`** — the full 64-migration chain, including 0064, replays cleanly against a fresh PGlite (real PostgreSQL 18/WASM) database with zero manual intervention. 172 tables, all RLS-enabled, 0 disabled. FDH table count: 34 → 36 (the 2 new R7 tables).
2. **`scripts/r7_security_certification.mjs`** — real seeded two-tenant data across all 8 R7-touched tables, cross-tenant isolation, same-user forgery with valid own FKs, service-write regression, and negative controls. 45/45 passed. Full detail: `R7_SECURITY_VERIFICATION.md`.

This proves the migration is genuinely deployable and the RLS/trigger design is genuinely correct against a real Postgres engine — it does **not** prove anything about the live DEV project's actual current state, existing rows, or its specific Supabase platform configuration (connection pooling, storage bucket policies already live, etc.).

## What remains for the Product Owner to unblock

1. Apply `supabase/migrations/0064_r7_bank_csv_engine_foundation.sql` to DEV (`vqycarelcoijzwlpkpcz`) via the SQL editor or `supabase db push`.
2. Re-invoke this same session (or a fresh one) to run the 15 live cases below and the 10 independent live reconciliations against the now-migrated DEV project, using the existing `.env.local` service-role credential for data-level (not DDL) operations — which the JS client CAN do.

## The 15 live cases this release defines (not yet executed)

LIVE-R7-001 exact re-import · 002 overlapping import · 003 separate debit/credit (CBA fixture) · 004 signed amount (Westpac fixture) · 005 DR/CR format (SBI fixture) · 006 ambiguous date mapping · 007 user mapping flow (generic adapter → `/map` → `/process`) · 008 reconciliation pass · 009 reconciliation failure (deliberately-broken balance fixture) · 010 duplicate candidate (no-reference fixture) · 011 legitimate identical transactions · 012 multi-account · 013 multi-currency (AUD + INR accounts) · 014 >1000 transactions (the same 2500-row fixture already proven in-memory by `tests/unit/r7LargeFile.test.ts`, now through the real API + real Postgres) · 015 unsupported format (a non-CSV-shaped file, expect `rejected`).

Each would: upload the fixture via `POST /bank-csv/upload`, call `/detect`, `/map` where needed, `/process`, then independently compute the expected canonical rows outside production code (the same Python oracle already used for the static certification, `scripts/r7_independent_bank_csv_oracle.py`), query the real `fdh_transactions`/`fdh_reconciliation_results` rows via the service-role client for read-only comparison, and diff.

## Honest classification impact

Because §79-84 are unmet, this release cannot claim **UNCONDITIONAL FULL PASS** under the spec's own acceptance rule (§93 explicitly requires "live DEV verification"). See `R7_ACCEPTANCE_REPORT.md` for the resulting classification.
