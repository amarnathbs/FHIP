# Migration archive — preserved historical artefacts

**Nothing in this directory is ever executed.** These are the original,
byte-for-byte migration files that were displaced when the Investment
Intelligence / Resources / Phase 0C migration-version collision was reconciled
on 2026-08-21. They are kept as audit evidence of what was actually written and
actually applied, and must not be edited, renumbered, or moved back into
`supabase/migrations/`.

## Why these files were displaced

Three feature streams were developed in parallel off `main` (which tops out at
`0030_contact_submissions.sql`). None of them merged to `main`, and there was no
central registry of allocated migration numbers, so each stream independently
allocated "the next number after 0030". Versions **0031-0040 were each claimed
by two different files**.

DEV survived this because every migration in this project is applied by hand
through the Supabase Dashboard SQL editor rather than by a migration runner, so
both sets of SQL simply ran. What did *not* survive was reproducibility: no
single branch contained the whole chain, and any tool that identifies a
migration by its version prefix would see ten ambiguous versions.

Investment Intelligence was chosen as the canonical owner of the active
`0031`-`0044` range because it is the longer contiguous chain, because the
already-certified FDH-1 migrations `0045`-`0048` were built on top of its
numbering, and because Investment Intelligence R2-R6 all depend on it.

## What is archived here, and what replaces it

| Archived file | Original module | Introduced by | Canonical effects now re-emitted by |
|---|---|---|---|
| `0031_financial_section_status.sql` | Phase 0C (core) | `10bf196` | `0049_reconcile_phase0c_resources_lineage.sql` |
| `0032_section_status_reviewed_with_data.sql` | Phase 0C (core) | `10bf196` | `0049_reconcile_phase0c_resources_lineage.sql` |
| `0033_resources_foundation.sql` | Resources R1.1 | `9bf45c6` | `0049_reconcile_phase0c_resources_lineage.sql` |
| `0034_resources_seed.sql` | Resources R1.1 | `9bf45c6` | `0049_reconcile_phase0c_resources_lineage.sql` |
| `0035_resources_analyst_role_delta.sql` | Resources R1.4 | `98da21d` lineage | `0049_reconcile_phase0c_resources_lineage.sql` |
| `0036_resources_anon_function_grants_fix.sql` | Resources R1.5 | `fd90137` lineage | `0049_reconcile_phase0c_resources_lineage.sql` |
| `0037_resources_editor_support.sql` | Resources R1.3 | `27d466a` lineage | `0049_reconcile_phase0c_resources_lineage.sql` |
| `0038_resources_specialist_content_support.sql` | Resources R1.4 | `98da21d` lineage | `0049_reconcile_phase0c_resources_lineage.sql` |
| `0039_resources_public_settings_read.sql` | Resources R1.5 | `fd90137` lineage | `0049_reconcile_phase0c_resources_lineage.sql` |
| `0040_resources_discovery_context_support.sql` | Resources R1.6 | `24ec9a5` lineage | `0049_reconcile_phase0c_resources_lineage.sql` |

Reconciliation date: **2026-08-21**.

## Note on the file names

`0031_financial_section_status.sql` creates a table called
**`user_financial_section_status`**, not `financial_section_status`. An earlier
audit inferred the table name from the migration filename and reported
`financial_section_status` as "missing from DEV". It never existed under that
name and was never supposed to; the table the migration actually defines is
present and populated in DEV. Do not use these filenames to infer object names.

## Verifying these files are still faithful

Every file here is byte-identical to its counterpart on
`feature/resources-r1-7d-human-editorial-compliance-approval`:

```sh
git rev-parse feature/resources-r1-7d-human-editorial-compliance-approval:supabase/migrations/0033_resources_foundation.sql
git hash-object supabase/migration_archive/0033_resources_foundation.sql
```

The two hashes must match. The same holds for all ten files.
