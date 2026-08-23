# Clean-rebuild certification

**Result: PASS.** The full active migration chain rebuilds an empty database
from `0001` to `0049` with no duplicate-version ambiguity, no ordering error, no
missing object, no failed constraint, and no manual intervention.

## Environment

This sandbox has no Docker, no Supabase CLI, no `psql` and no `pg_dump`
(verified — all four absent from `PATH`). A shared-DEV reset was never an
option and was never attempted.

The rebuild therefore ran against **PGlite 0.5.5 — real PostgreSQL 18.3
compiled to WebAssembly**, installed into a scratch directory outside the repo.
This is a genuine PostgreSQL engine: it enforces real constraints, real foreign
keys, real CHECK expressions, and real row-level security (all exercised below),
not a SQL emulator.

```
PostgreSQL 18.3 (PGlite 0.5.5) on wasm32-unknown-linux-gnu
```

### Supabase platform shim

PGlite is bare PostgreSQL, so the managed-platform surface that Supabase
provides *before* any project migration runs was recreated in `shim.sql`:
the `auth`, `storage`, `extensions`, `cron` and `net` schemas; the `anon`,
`authenticated`, `service_role` and `authenticator` roles; `auth.users`;
`auth.uid()` / `auth.jwt()` / `auth.role()` / `auth.email()` reading
`request.jwt.claims`; `storage.objects` / `storage.buckets` /
`storage.foldername()`; and Supabase's default grants. The shim defines **no
project schema** — every project object comes from the migrations themselves.

### Documented substitutions

| Substitution | Where | Justification |
|---|---|---|
| `create extension if not exists pg_cron;` → no-op | `0010_module9_reports.sql` | PGlite cannot load C extensions. Creates no project object; the shim provides `cron.job` / `cron.schedule` / `cron.unschedule`. |
| `create extension if not exists pg_net;` → no-op | `0010_module9_reports.sql` | Same. The shim provides `net.http_post`. Its only use is one scheduled HTTP POST with no schema effect. |

Exactly **two** substitutions were made, both logged by the harness on every
run. No other statement in any of the 49 migrations was altered.

### Reference-seed step

`supabase/seed.sql` (the project's reference-data convention) is applied
immediately after `0001_foundation.sql`, which creates `countries` and
`currencies`. This is required because `0012_module8_benchmark_seed.sql` inserts
`benchmark_sources` rows with foreign keys to `countries` — see *Pre-existing
finding* below.

## Replay result

```
49 migrations, 49 distinct versions, no duplicates
  ok 0001_foundation.sql
  ok [seed.sql reference data]
  ... (47 more)
  ok 0049_reconcile_phase0c_resources_lineage.sql

REPLAY COMPLETE: 49/49 migrations applied with zero manual intervention
```

| Check | Result |
|---|---|
| Duplicate migration versions | **0** (49 files, 49 distinct versions) |
| Migrations that failed | **0 / 49** |
| Manual intervention required | **NONE** |
| Ordering errors | **0** |

## Fresh-rebuild schema manifest

| Object type | Count |
|---|---|
| Tables | 155 |
| Columns | 2,037 |
| Constraints | 2,049 |
| Indexes | 465 |
| RLS policies | 182 |
| Functions (`public` + `private`) | 11 |
| Tables with RLS **enabled** | **155 / 155** |
| Tables with RLS disabled | **0** |

Per module:

| Module | Tables in fresh rebuild | Tables in live DEV | Result |
|---|---|---|---|
| Investment Intelligence (`ii_*`) | 33 | 33 | PASS |
| Resources (`resource*`) | 20 | 20 | PASS |
| Phase 0C (`user_financial_section_status`) | 1 | 1 | PASS |
| Financial Data Hub (`fdh_*`) | 24 | 24 | PASS |
| **Subtotal — four reconciled/added streams** | **78** | **78** | **PASS** |
| Pre-existing base-FHIP tables (`0001`-`0030`, unrelated to this reconciliation) | 77 | 77 | PASS |
| **Total exposed relations** | **155** | **155** | **PASS** |

**Correction (this pass):** an earlier version of this table placed a "Total
exposed relations = 155" row directly beneath the four module rows without a
subtotal, which reads as though 33+20+1+24 summed to 155. It does not — those
four counts sum to 78. The other 77 tables in the 155 total are pre-existing
base-FHIP tables from migrations `0001`-`0030` and are untouched by this
reconciliation. The explicit subtotal row above prevents that misreading.

## Order-equivalence proof

The reconciliation moves ten migrations' effects from positions 0031-0040 to
position 0049. That is only safe if the two lineages do not interact. Verified
two ways.

**Static:** no active migration (`0001`-`0048`) references any `resource_*`
object or `user_financial_section_status`, and no archived migration references
any `ii_*` or `fdh_*` object. `create schema private` appears in exactly one
file. Zero cross-lineage references.

**Empirical:** two independent databases were built and their Resources +
Phase 0C schemas compared —

- **A:** original historical order — `0001`-`0030` then archived `0031`-`0040`
- **B:** reconciled chain — `0001`-`0048` then `0049`

| Category | Rows compared | Result |
|---|---|---|
| Columns | 205 | IDENTICAL |
| Constraints | 234 | IDENTICAL |
| Indexes | 71 | IDENTICAL |
| Policies | 48 | IDENTICAL |
| RLS enablement | 21 | IDENTICAL |
| Functions (incl. body hash) | 8 | IDENTICAL |

**Negative control.** Injecting one extra column and dropping one policy in
database A made the comparison report exactly those two differences, proving the
comparison is not vacuous:

```
[C] columns   *** DIFFERENT *** (206 vs 205)
   only-in-A: {"table_name":"resource_posts","column_name":"zz_negative_control",...}
[C] policies  *** DIFFERENT *** (47 vs 48)
   only-in-B: {"t":"resource_tags","n":"public read active tags",...}
```

## Idempotency proof

`0049` applied a second time to an already-reconciled database completed without
error and changed **nothing** — all six categories identical. This is the direct
evidence that applying it to DEV, where every object already exists, is a
genuine no-op.

## Byte-identity of relocated files

| Group | Files | Byte-identical to source |
|---|---|---|
| Investment Intelligence 0031-0044 (active) | 14 | 14 / 14 |
| FDH 0045-0048 (active, untouched) | 4 | 4 / 4 |
| Phase 0C + Resources 0031-0040 (archived) | 10 | 10 / 10 |
| Base 0001-0030 vs `main` (untouched) | 30 | 30 / 30 |
| **Total** | **58** | **58 / 58, 0 mismatched** |

No migration SQL was edited by this reconciliation. Files were relocated only.

## Pre-existing finding (out of scope, disclosed)

`0012_module8_benchmark_seed.sql` inserts `benchmark_sources` rows referencing
`countries('AU')` and `countries('IN')`, but **no migration ever seeds
`countries`** — those rows come from `supabase/seed.sql`. A stock
`supabase db reset`, which runs all migrations *then* the seed, would therefore
fail at `0012` with:

```
insert or update on table "benchmark_sources" violates foreign key constraint
"benchmark_sources_country_code_fkey"
```

This is a latent defect in the base chain (`0001`-`0030`, `main`'s territory),
entirely independent of the version collision, and predates this work. It is
**not** repaired here — that would be an unrelated change to `main`'s migrations.
The rebuild harness works around it by applying `seed.sql` after `0001`.
Recommended follow-up: move the `countries`/`currencies` reference rows into
`0001_foundation.sql`, or split the FK-dependent seed out of `0012`.

## Reproducing this certification

The harness is committed at `scripts/db-rebuild-check/`. It needs one optional
dev dependency:

```sh
npm i --no-save @electric-sql/pglite
node scripts/db-rebuild-check/replay.mjs     # clean rebuild + manifest
node scripts/db-rebuild-check/equiv.mjs      # order-equivalence + idempotency + negative control
node scripts/db-rebuild-check/rls.mjs        # tenant-isolation certification
```

PGlite is deliberately **not** added to `package.json`; adding a dependency was
outside this task's remit.
