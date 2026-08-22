# Clean-rebuild verification harness

Proves that `supabase/migrations/` rebuilds an empty database deterministically.
Built for the 2026-08-21 migration-lineage reconciliation
(`docs/architecture/ADR_MIGRATION_LINEAGE_RECONCILIATION.md`) and kept as a
standing check.

This sandbox has no Docker, Supabase CLI, `psql` or `pg_dump`, so the harness
uses **PGlite** — real PostgreSQL 18 compiled to WebAssembly, running
in-process. It enforces real constraints, foreign keys, CHECK expressions and
row-level security.

## Setup

PGlite is intentionally **not** in `package.json` — it is a verification-only
tool, not an application dependency:

```sh
npm i --no-save @electric-sql/pglite
```

## Scripts

| Script | What it proves |
|---|---|
| `replay.mjs` | The whole chain applies from empty, one file per version, zero manual intervention. Emits `fresh_manifest.json`. |
| `equiv.mjs` | Re-emitting the archived migrations at 0049 yields a schema byte-identical to the original 0031-0040 ordering; 0049 is idempotent; and a negative control proves the comparison can actually fail. |
| `rls.mjs` | Tenant isolation on real populated data across all three affected lineages, with negative controls that disable RLS and confirm the leak appears. |

```sh
node scripts/db-rebuild-check/replay.mjs
node scripts/db-rebuild-check/equiv.mjs
node scripts/db-rebuild-check/rls.mjs
```

`replay.mjs` exits non-zero on a duplicate version (2) or a failed migration (3).
`rls.mjs` exits non-zero if any isolation check or negative control fails.

## `shim.sql`

Recreates the Supabase managed-platform surface that exists *before* any project
migration runs: the `auth` / `storage` / `extensions` / `cron` / `net` schemas,
the `anon` / `authenticated` / `service_role` / `authenticator` roles,
`auth.users`, `auth.uid()` and friends reading `request.jwt.claims`,
`storage.objects` and `storage.foldername()`, and Supabase's default grants.

It defines **no project schema** — every project object must come from the
migrations, or the rebuild has not actually proven anything.

## Known substitutions

`pg_cron` and `pg_net` are C extensions PGlite cannot load. The two
`create extension` statements in `0010_module9_reports.sql` are replaced with
no-ops; both create zero project objects and the shim supplies `cron.schedule`,
`cron.unschedule` and `net.http_post`. Every substitution is printed on each run.

## Known pre-existing quirk

`supabase/seed.sql` must be applied straight after `0001_foundation.sql`, not at
the end: `0012_module8_benchmark_seed.sql` inserts rows with foreign keys into
`countries`, which no migration seeds. A stock `supabase db reset` (all
migrations, then seed) would fail at `0012`. This is a latent defect in the base
chain, unrelated to the lineage reconciliation — see
`docs/database-reconciliation/CLEAN_REBUILD_CERTIFICATION.md`.
