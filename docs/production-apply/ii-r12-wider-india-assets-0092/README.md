# Production apply package: II-R12 Wider India Assets (migration 0092)

Prepared by an agent with **no ability to execute SQL against production**
and **no authorization to push to `origin/main` or merge to `main`**.
Everything in this folder is for a human (or the orchestrating session,
after independently re-verifying the work) to run. Nothing here has been
applied to production. Prepared during R12 terminal merge-preparation
(2026-08-28), off integration branch `integration/r12-terminal-release`.

## Status at time of preparation

| Item | DEV | Production |
|---|---|---|
| `0092_ii_r12_wider_india_assets_foundation.sql` | **Applied** (Product Owner applied it manually ahead of the 2026-08-28 terminal certification dispatch; confirmed live via REST -- `price_source` column read returns HTTP 200) | **NOT applied** (remains NOT AUTHORISED by this task's own hard rule -- do not apply without separate explicit authorisation) |
| `0094_ii_holding_snapshots_authoritative_forgery_hotfix.sql` | Applied, verified | Applied, verified (shipped standalone ahead of 0092, per its own header -- see `docs/production-apply/ii-holding-snapshots-hotfix-0094/`) |

## 0092 identity proof (repo == DEV-applied == this package, byte-for-byte)

`01_0092_ii_r12_wider_india_assets_foundation.sql` in this folder is a direct,
unmodified copy of `supabase/migrations/0092_ii_r12_wider_india_assets_foundation.sql`
as it exists on `integration/r12-terminal-release` (itself identical to
`origin/main` and to the certification branch's own copy -- confirmed by
direct 3-way `diff`, zero differences).

SHA-256: `8437d0eaddf782361391b7d4f44421d8a14cdd28dee92ecaffc89db4c0eb9df5` (133 lines).

This checksum matches the one independently recorded by the prior round's own
DEV-apply package at `docs/dev-apply/ii-r12-0092-activation/README.md` ("Dollar-
quote and structural sanity check" section, same SHA-256, same line count) --
the file that was actually pasted into the DEV Supabase SQL Editor. Repo,
DEV-applied content, and this production package are therefore the same file,
byte-for-byte, independently confirmed twice (once by the prior DEV-apply
round, once here).

## What 0092 actually does (see the migration's own header for full detail)

Purely additive, four parts:

1. **No-op** (documentation only). This section originally carried RLS
   hardening for `ii_holding_snapshots`; that fix was extracted and shipped
   standalone as migration `0094` (already live in production -- see its own
   package). 0092's own header explains in detail why this section must
   remain a no-op forever: `0094` is now the sole, permanent, canonical owner
   of that policy, and 0092 attempting to also create it would raise
   Postgres error `42710` ("policy already exists") the moment both
   migrations exist in the same replay ordering.
2. Widens `ii_transactions.transaction_type` to add `'sale'` (23rd value;
   22 legacy values unchanged).
3. Adds nullable `ii_holding_snapshots.price_source` column (price
   provenance; null for all pre-existing rows).
4. Widens `ii_scheme_tax_classification.basis` to add
   `'direct_listed_security_rule'` (5th value; 4 legacy values unchanged).

No DROP, no data migration, no backfill, no trigger, no function. Every
statement is `add column if not exists` / `drop constraint if exists` +
`add constraint` -- safe to run as a single paste, and safe to re-run if
ever accidentally run twice.

## How to apply

1. Open the **production** Supabase project's SQL Editor.
2. Run `02_production_precheck.sql` first (fully read-only). Confirm every
   block's actual output matches its `EXPECT` comment before proceeding.
   Record the Part 6 baseline row counts -- you will compare against them
   after applying.
3. Run `01_0092_ii_r12_wider_india_assets_foundation.sql` in full.
4. Run `03_production_verification.sql`. Part A confirms the schema changes
   landed; Part B (wrapped in `begin;...rollback;`, self-cleaning) proves
   the new values are genuinely writable, invalid values are still
   rejected, and migration `0094`'s policy remains the sole, unweakened
   owner of `ii_holding_snapshots`' RLS (policy count 1, zero non-SELECT
   policies for `authenticated`); Part C re-confirms the Part-6 baseline
   counts are byte-identical (0092 is additive-only -- it must not change
   any existing row count); Part D confirms zero synthetic rows survived.
5. Separately (outside SQL, requires production API credentials this agent
   does not have): re-run `scripts/r12_terminal_0092_rest_verification.mjs`
   or `scripts/r12_live_dev_verification.mjs` pointed at production to
   reproduce the real live-REST same-user-forgery-blocked /
   cross-user-blocked / trusted-service-write-allowed proof that was
   already reproduced against DEV. A SQL Editor session runs as a
   privileged role and structurally cannot exercise RLS the way a real
   authenticated PostgREST request does -- Part B's `pg_policies`
   inspection is the strongest proof obtainable from SQL alone; the REST
   scripts are the authoritative live proof.
6. Confirm the existing `GET /api/investment-intelligence/positions`
   endpoint still returns HTTP 200 for a real user with existing mutual-fund
   holdings (manual smoke test -- this migration touches no code path that
   endpoint depends on, but a live confirmation costs nothing).

## What this package does NOT cover (explicitly out of scope, deferred to
the orchestrating session / Product Owner)

- Merging `integration/r12-terminal-release` into `main`, or pushing to
  `origin main` -- reserved per this project's standing operating rule.
- Actually running any of the SQL in this folder against production.
- Deploying the application code that reads `price_source` / writes
  `'sale'` transactions / classifies `direct_listed_security_rule` -- that
  code is already on `main` (merged separately, well before this terminal-
  certification round; see `R12_ACCEPTANCE_REPORT.md` for the full
  application-layer history). This package is the DATABASE half only.

## Files in this package

- `01_0092_ii_r12_wider_india_assets_foundation.sql` -- the migration
  itself, byte-identical to `supabase/migrations/0092_ii_r12_wider_india_assets_foundation.sql`.
- `02_production_precheck.sql` -- read-only checks to run BEFORE applying.
- `03_production_verification.sql` -- checks to run AFTER applying (schema
  + security + existing-investments regression + cleanup confirmation).
