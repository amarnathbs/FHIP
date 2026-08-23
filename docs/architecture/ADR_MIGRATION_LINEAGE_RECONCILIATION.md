# ADR: Migration-lineage reconciliation (Investment Intelligence + Resources + Phase 0C)

- **Status:** Accepted
- **Date:** 2026-08-21
- **Branch:** `fix/migration-lineage-ii-resources`
- **Supersedes:** nothing
- **Related:** `docs/database-reconciliation/`, `supabase/migration_archive/README.md`

## Context

`main` tops out at `0030_contact_submissions.sql`. Three feature streams were
then developed in parallel, none of which merged back to `main`:

| Stream | Versions claimed | Files |
|---|---|---|
| Phase 0C (core section status) | 0031-0032 | 2 |
| Resources CMS | 0033-0040 | 8 |
| Investment Intelligence | 0031-0044 | 14 |
| Financial Data Hub (FDH-1) | 0045-0048 | 4 |

Because each stream branched from `main` and independently allocated "the next
number after 0030", **versions 0031-0040 were each claimed by two different
files** — ten collisions in total.

Two properties of this project let the collision go unnoticed for a long time:

1. **No migration runner is used against DEV.** There is no Supabase CLI project
   link and no reachable SQL RPC; every one of the ~58 migrations was applied by
   a human pasting SQL into the Supabase Dashboard SQL editor. Dashboard
   execution does not write to `supabase_migrations.schema_migrations`, so no
   ledger ever recorded a version and no runner ever had the opportunity to skip
   the second file claiming a given version. Both sets of SQL simply ran.
2. **The two lineages are schema-disjoint.** No Investment Intelligence or FDH
   migration references any `resource_*` object or `user_financial_section_status`,
   and no Resources or Phase 0C migration references any `ii_*` or `fdh_*`
   object. Running them in either order produces the same result, so DEV ended
   up correct despite the ambiguity.

The damage was therefore not to DEV but to **reproducibility**: no single branch
contained the whole chain, FDH-1's branch skips 0031-0044 entirely, and any tool
that identifies a migration by its version prefix would see ten ambiguous
versions. A fresh database could not be rebuilt deterministically.

A prior audit also reported `financial_section_status` as "missing from DEV".
That was a false positive: the migration file named
`0031_financial_section_status.sql` creates a table called
**`user_financial_section_status`**, which is present and populated in DEV. The
object name had been inferred from the filename.

## Decision

**1. Canonical historical ownership.** Investment Intelligence retains
`0031`-`0044` as the active legacy lineage. It is the longer contiguous chain,
the certified FDH-1 migrations `0045`-`0048` were already built on top of its
numbering, and Investment Intelligence R2-R6 all depend on it. Re-numbering it
would have invalidated four already-certified migrations.

**2. Preserve, do not rewrite, history.** The ten displaced Phase 0C and
Resources files are moved verbatim to `supabase/migration_archive/`, which is
never executed. Their contents are unchanged and are byte-identical to their
source branch. No applied-migration history is deleted, falsified, or invented;
because no ledger was ever populated, there is no ledger to rewrite.

**3. Forward-only re-emission.** The canonical effects of the ten archived files
are re-emitted by a single new migration,
`0049_reconcile_phase0c_resources_lineage.sql`, allocated against the current
highest active version at execution time. Every statement in it is idempotent
(`IF NOT EXISTS`, `DROP ... IF EXISTS` before `CREATE`, `CREATE OR REPLACE`), so
it builds the objects on an empty database and is a verified no-op against DEV,
where all 21 tables already exist and are populated. The displaced migrations
were **not** renamed and re-run blindly.

**4. Automated recurrence guard.** `scripts/check-migration-versions.mjs` fails
if two files in the active migration directory share a version prefix, and
`tests/unit/migrationVersions.test.ts` runs it inside the existing `npm test`
gate, so a reintroduced collision breaks the build. The guard inspects only
`supabase/migrations` — the archive legitimately reuses old numbers.

## Why the historical ledger is not rewritten

Rewriting or back-filling migration history to manufacture a clean sequence
would destroy the only audit evidence of what was actually applied to a shared
environment, and would make future divergence undetectable. The applied database
state is a fact; the repository's representation of it is what was wrong. We
changed the representation and left the facts alone.

## Consequences

- A fresh database rebuilds deterministically from `0001` to `0049` with no
  duplicate versions and no manual intervention (certified — see
  `docs/database-reconciliation/CLEAN_REBUILD_CERTIFICATION.md`).
- DEV needs no repair. It already matches the canonical schema across all 54
  in-scope tables and 676 columns.
- `0049` is a no-op against DEV. Applying it is a consistency formality, not a
  fix, and it cannot mutate existing rows.
- The archive must be carried forward indefinitely. It is evidence.
- Anyone reading `supabase/migrations` now sees one file per version and can
  trust the ordering.

## Migration-numbering rule (binding going forward)

1. Sync the latest `main`.
2. Run `node scripts/check-migration-versions.mjs`; it reports the next free
   version.
3. Record the allocation in `docs/architecture/MIGRATION_REGISTRY.md` **before**
   writing the migration.
4. If a branch stays open while another migration merges, re-run the guard
   before merging.
5. If an unmerged, unapplied migration collides, renumber **it**. Never renumber
   a migration that has already been applied to a shared environment — re-emit
   its effects forward instead, as `0049` does.
