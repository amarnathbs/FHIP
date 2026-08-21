# Reconciliation plan

**Status: validated through clean rebuild. Ready for DEV application.**
Nothing in this plan has been written to shared DEV. DEV application requires
the Product Owner (see *Execution* below).

## 1. Confirmed root cause

Three feature streams were developed in parallel off `main` (which tops out at
`0030_contact_submissions.sql`), none of which merged back. Each independently
allocated "the next number after 0030", with no central registry:

| Stream | Versions claimed |
|---|---|
| Phase 0C (core section status) | 0031-0032 |
| Resources CMS | 0033-0040 |
| Investment Intelligence | 0031-0044 |
| Financial Data Hub (FDH-1) | 0045-0048 (uncollided) |

**Versions 0031-0040 were each claimed by two files.**

Two conditions made this invisible until now:

1. **No migration runner exists against DEV.** There is no Supabase CLI project
   link and no reachable SQL RPC (`exec_sql`, `execute_sql`, `run_sql`, `sql`
   and `query` all return `PGRST202`; the `supabase_migrations` schema is not
   exposed, `PGRST106`). Every migration was applied by a human pasting SQL into
   the Dashboard SQL editor, which writes no ledger entry. No runner ever had
   the chance to skip the second file claiming a version — both simply ran.
2. **The lineages are schema-disjoint,** so order never mattered and DEV ended
   up correct anyway.

The harm was to reproducibility, not to DEV.

## 2. Affected versions

0031-0040 (ten collisions). 0041-0048 uncollided. See
`LEGACY_MIGRATION_OWNERSHIP.md`.

## 3. Expected schema

Reconstructed from migration definitions — never from DEV, which was treated
only as the comparator:

- `II_EXPECTED_SCHEMA_MANIFEST.md` — 33 tables, 471 columns, 476 constraints, 115 indexes, 33 policies
- `RESOURCES_EXPECTED_SCHEMA_MANIFEST.md` — 21 tables, 205 columns, 234 constraints, 71 indexes, 48 policies

## 4. Actual drift found

**None.** All 54 in-scope tables classify **MATCH**; 676 columns compared with
0 missing, 0 extra and 0 type mismatches. See `II_RESOURCES_EXPECTED_VS_DEV.md`.

The one previously-reported drift — `financial_section_status` "missing from
DEV" — was a **false positive**. The migration named
`0031_financial_section_status.sql` creates a table called
`user_financial_section_status`, which exists in DEV and is populated. The
object name had been inferred from the filename. Migration 0032's widened CHECK
constraint was separately confirmed live by differential probe with a negative
control.

**DEV requires no schema repair.**

## 5. Active-history canonicalization

Investment Intelligence retains active versions 0031-0044. Rationale in
`LEGACY_MIGRATION_OWNERSHIP.md` §"Why Investment Intelligence is the canonical
active owner" — chiefly that the already-certified FDH-1 migrations 0045-0048
were built on its numbering, so renumbering it would invalidate four certified
migrations.

## 6. Archived migrations

The ten displaced Phase 0C and Resources files move verbatim to
`supabase/migration_archive/` (never executed; `README.md` there explains the
mapping). All ten are byte-identical to their source branch, confirmed by
object-hash comparison. 58 of 58 relocated files byte-identical, 0 mismatched.

## 7. Forward migration actions

`supabase/migrations/0049_reconcile_phase0c_resources_lineage.sql` re-emits the
archived effects, forward-only:

| Action | Count |
|---|---|
| Tables created (`IF NOT EXISTS`) | 21 |
| Indexes created (`IF NOT EXISTS`) | 41 |
| Policies (`DROP IF EXISTS` then `CREATE`) | 48 |
| Constraints (`DROP IF EXISTS` then `ADD`) | 5 |
| Columns added (`IF NOT EXISTS`) | 8 |
| Functions (`CREATE OR REPLACE`) | 12 |
| Schemas (`IF NOT EXISTS`) | 1 (`private`) |
| **Total idempotency guards applied** | **124** |

No semantic content was changed — only mechanical idempotency guards were added
to the archived SQL. Proven by the order-equivalence test, which found the
resulting schema byte-identical to the original ordering across columns,
constraints, indexes, policies, RLS enablement and function bodies.

## 8. Data-preservation assessment

| Risk | Assessment |
|---|---|
| Table dropped | None. No `DROP TABLE` anywhere in 0049. |
| Column dropped | None. No `DROP COLUMN`. |
| Data type altered on a populated column | None. |
| Constraint removed | Only `DROP CONSTRAINT IF EXISTS` immediately followed by re-adding the identically-defined constraint. |
| Policy removed | Only `DROP POLICY IF EXISTS` immediately followed by re-creating the identically-defined policy. |
| Seed/content rows overwritten | None. Every `INSERT` is `ON CONFLICT ... DO NOTHING`. The three Phase 0C backfills use `ON CONFLICT (user_id, section) DO NOTHING` and cannot overwrite a user's existing confirmation; the Resources seeds cannot overwrite existing published content. |
| User data rewritten | None. |

Because every object 0049 creates already exists in DEV, and every guard is
`IF NOT EXISTS` / `DO NOTHING`, **the expected row-count delta on DEV is zero
for every table**. This was verified directly: re-applying 0049 to an
already-reconciled database changed nothing across all six comparison
categories.

## 9. Clean-rebuild evidence

`CLEAN_REBUILD_CERTIFICATION.md`. Summary: 49/49 migrations apply to an empty
PostgreSQL 18 database with zero manual intervention; 155 tables, all
RLS-enabled. Of those 155, 78 belong to the four streams reconciled/added in
this and adjacent work (33 II / 20 Resources / 1 Phase 0C / 24 FDH) — **these
four counts sum to 78, not 155**; the remaining 77 tables are pre-existing
base-FHIP tables from migrations `0001`-`0030`, unrelated to this
reconciliation. (An earlier version of this document juxtaposed the 155 total
with the four module counts in a way that could be misread as claiming they
summed to 155; corrected here.) Module counts match live DEV exactly;
order-equivalence, idempotency and negative controls all PASS; 25/25
tenant-isolation checks PASS.

## 10. Execution

**This sandbox cannot apply DDL to DEV.** Verified this session, not assumed:
no Supabase CLI, no Postgres connection string, and every SQL-execution RPC
returns `PGRST202`. Consistent with all 48 prior migrations in this project,
application requires the Product Owner to paste the SQL into the Supabase
Dashboard SQL editor.

**Target: DEV `vqycarelcoijzwlpkpcz` only.** Production `twwpnltizhtjxhamyoxt`
must not be touched, and was not contacted at any point during this work.

Steps:

1. Confirm the Dashboard is on project `vqycarelcoijzwlpkpcz`.
2. Paste and run `supabase/migrations/0049_reconcile_phase0c_resources_lineage.sql`.
3. Expect: success with no rows affected. Every object already exists; this is a
   consistency formality, not a fix.
4. Re-run `node scripts/db-rebuild-check/replay.mjs` and the Expected-vs-DEV
   comparison to confirm convergence is unchanged.

Applying 0049 is **optional** for correctness — DEV already matches the
canonical schema — and is recommended only so DEV and the repository tell the
same story.

## 11. Rollback

Rollback of 0049 is **not recommended and not required**.

- Against DEV it is a no-op, so there is nothing to roll back. Reverting it
  would mean dropping 21 populated tables holding real Resources content and
  real user section-status confirmations — unacceptable, and explicitly out of
  bounds.
- Against a fresh environment, rollback means discarding the whole database
  rather than reversing the migration.
- **Repository rollback** is separate and safe: `git revert` the reconciliation
  commit restores the previous file layout. It changes no database. It would,
  however, reintroduce the duplicate-version collision, which the guard would
  then correctly fail on.

Distinguishing the two: *technical migration rollback* (undo the DDL) is unsafe
here because the objects hold data; *production-safe rollback* (revert the
repository change) is safe and is the only rollback that should ever be used.

## 12. Unresolved items requiring a Product Owner decision

None for this reconciliation. One unrelated pre-existing defect is disclosed for
a future decision: `0012_module8_benchmark_seed.sql` foreign-keys into
`countries`, which no migration seeds, so a stock `supabase db reset` would fail
at 0012. Out of scope here; see `CLEAN_REBUILD_CERTIFICATION.md`.
