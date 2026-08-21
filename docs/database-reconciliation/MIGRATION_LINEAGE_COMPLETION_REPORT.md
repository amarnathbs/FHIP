# Migration-lineage reconciliation — completion report

- **Status:** CONDITIONAL PASS — implementation and certification complete; DEV application requires the Product Owner
- **Branch:** `fix/migration-lineage-ii-resources`
- **Starting `main`:** `fe7a094`
- **DEV environment:** `vqycarelcoijzwlpkpcz`
- **Production:** `twwpnltizhtjxhamyoxt` — **NOT TOUCHED, NOT CONTACTED**
- **Date:** 2026-08-21

## Executive result

The repository migration lineage is repaired and the collision cannot recur.
The active chain now holds exactly one executable migration per version,
`0001`-`0049`, and rebuilds an empty PostgreSQL 18 database with zero manual
intervention. The ten displaced historical files are preserved verbatim in a
never-executed archive, and their canonical effects are re-emitted forward by an
idempotent migration `0049`.

**DEV needed no repair.** All 54 in-scope tables and 676 columns already match
the canonical schema reconstructed from the migration definitions. The single
previously-reported drift — `financial_section_status` "missing" — was a false
positive caused by inferring a table name from a migration filename; the table
that migration actually creates (`user_financial_section_status`) exists and
holds 97 rows.

The one condition on this pass is that this sandbox has no DDL path to shared
DEV — verified, not assumed — so applying `0049` is a Product Owner handoff.
Since `0049` is a proven no-op against DEV, no schema or security defect remains
open either way.

## Root cause

Three streams branched from `main` (top: `0030`) and each allocated "the next
number after 0030" with no shared registry: Phase 0C took 0031-0032, Resources
took 0033-0040, Investment Intelligence took 0031-0044. Ten versions were
double-claimed.

It went undetected because **no migration runner is used against this project**.
There is no Supabase CLI link and no reachable SQL RPC; all 48 migrations were
applied by pasting SQL into the Dashboard SQL editor, which writes no ledger
entry. Nothing ever evaluated migration identity, so nothing ever noticed two
files claiming version 0031 — both simply ran. And because the lineages are
schema-disjoint, order never mattered, so DEV ended up correct regardless.

The damage was to reproducibility, not to DEV.

## Historical collision inventory

Ten collisions, 0031-0040 — full table in `LEGACY_MIGRATION_OWNERSHIP.md` and
`docs/architecture/MIGRATION_REGISTRY.md`. Both files of every colliding pair
were applied to DEV.

## Canonical decision

Investment Intelligence retains active `0031`-`0044`; the FDH-1 migrations
`0045`-`0048` sit on top unchanged. The Phase 0C and Resources files are
archived to `supabase/migration_archive/` and re-emitted by `0049`. Renumbering
Investment Intelligence would have invalidated four already-certified FDH-1
migrations.

## Forward migration

`supabase/migrations/0049_reconcile_phase0c_resources_lineage.sql` — 124
idempotency guards over 21 tables, 41 indexes, 48 policies, 5 constraints,
8 columns, 12 functions, 1 schema. No `DROP TABLE`, no `DROP COLUMN`, no
data-type change; all inserts `ON CONFLICT DO NOTHING`.

## Certification summary

| Area | Result |
|---|---|
| Clean rebuild `0001`-`0049` from empty | **PASS** — 49/49, zero manual intervention |
| Duplicate active versions | **0** |
| Order-equivalence (0049 vs original 0031-0040 ordering) | **PASS** — byte-identical across 205 columns, 234 constraints, 71 indexes, 48 policies, 21 RLS flags, 8 function bodies |
| Idempotency of 0049 | **PASS** — second application a true no-op |
| Negative controls | **PASS** — every comparison and isolation test proven able to fail |
| Expected vs DEV | **54/54 MATCH**, 676 columns, 0 missing / 0 extra / 0 type mismatches |
| Fresh rebuild vs DEV | 155 relations both sides; 33 II / 20 Resources / 1 Phase 0C / 24 FDH both sides |
| RLS certification | **25/25 PASS** on real populated tenant data across all three lineages |
| RLS coverage | **155/155 tables enabled**, 0 disabled |
| Byte-identity of relocated files | **58/58**, 0 mismatched |
| FDH regression | 24 tables, all RLS-enabled, migrations byte-identical — unchanged |
| Data preservation | 5,669 in-scope rows; expected delta 0 |
| TypeScript | **PASS** |
| Unit tests | **129 passed / 129** (124 baseline + 5 new guard tests) |
| ESLint | 6 errors / 6 warnings — **unchanged pre-existing baseline**, all in `app/` and `components/`; new files clean |
| Production build | **PASS** — 103/103 static pages |

Detail in `CLEAN_REBUILD_CERTIFICATION.md` and `DEV_POST_REPAIR_CERTIFICATION.md`.

## Collision guard

- `scripts/check-migration-versions.mjs` — fails with exit 1 if two active
  migrations share a version; reports the next free version. Inspects only
  `supabase/migrations`, excluding the archive.
- `tests/unit/migrationVersions.test.ts` — runs it inside the existing
  `npm test` gate, so a reintroduced collision breaks the build. Includes a
  negative control that constructs a synthetic collision and asserts detection.
- **Live negative control performed:** restoring
  `0033_resources_foundation.sql` into the active directory made the guard fail
  with exit 1 and name both colliding files; removing it restored exit 0.

## Regression scope note

Investment Intelligence and Resources application code and test suites live only
on their own unmerged feature branches. This branch is a database-governance
branch off `main` and **changes zero application code** — the entire diff is
`supabase/`, `scripts/`, `tests/unit/migrationVersions.test.ts` and `docs/`.
Their functional behaviour is therefore unaffected by construction, and this is
reinforced by the stronger structural evidence: all 14 Investment Intelligence
and all 10 archived Resources migration files are byte-identical to their source
branches, and the schema produced by the reconciled chain is byte-identical to
the schema produced by the original ordering.

## Remaining findings

1. **`0049` not yet applied to DEV** — Product Owner action. Verified no-op.
2. **Pre-existing, out of scope:** `0012_module8_benchmark_seed.sql` foreign-keys
   into `countries`, which no migration seeds (the rows come from
   `supabase/seed.sql`). A stock `supabase db reset` would fail at `0012`. This
   is a latent defect in `main`'s base chain, unrelated to the collision, and was
   deliberately not repaired here.
3. **Not in scope, unchanged:** FDH1-F1, the disclosed LOW-severity cross-tenant
   FK referential-integrity finding.

## Verdict

- **Investment Intelligence + Resources migration lineage:** CONDITIONAL PASS
  (repository lineage fully repaired and certified; DEV application pending)
- **DEV canonical schema:** CERTIFIED — matches expected and fresh rebuild
- **Fresh-rebuild migration chain:** CERTIFIED

## FDH-2 gate

**HOLD REMAINS** pending the Product Owner applying `0049` to DEV and confirming
this reconciliation. The blocking condition — the unresolved II/Resources
migration-numbering collision — is technically resolved in the repository, so
the gate is expected to release to GREEN on that confirmation.

FDH-2 (Australia & India Category / MCC / Institution / Merchant Intelligence
Foundation) was **not** started and must not begin without an explicit
instruction.
