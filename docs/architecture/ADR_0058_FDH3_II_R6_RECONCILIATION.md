# ADR: FDH-3 + Investment Intelligence R6 migration-`0058` lineage reconciliation

- **Status:** Accepted
- **Date:** 2026-08-23
- **Branch:** `feature/r7-baseline-integration`
- **Supersedes:** nothing
- **Related:** `docs/architecture/ADR_MIGRATION_LINEAGE_RECONCILIATION.md`
  (the prior, structurally similar collision — Investment Intelligence +
  Resources + Phase 0C), `docs/database-reconciliation/0058_*`

## Problem

Two unmerged sibling feature branches — `feature/financial-data-hub-fdh-3-
document-lifecycle` (HEAD `a471a1b`, never pushed) and `feature/investment-
intelligence-r6-security-final` (HEAD `3af02e3`, pushed to `origin`) — each
independently allocated migration version `0058` for genuinely unrelated
schema: `0058_fdh3_document_lifecycle_upload_storage.sql` (Financial Data
Hub document-upload lifecycle) vs `0058_ii_r6_p1_tax_engine.sql`
(Investment Intelligence India tax-lot/FIFO engine). Their common ancestor
is `d18c4ac`; neither branch contains the other's work
(`docs/database-reconciliation/0058_BRANCH_TOPOLOGY.md`).

## Why it happened

Both branches followed this project's binding migration-numbering rule
correctly — "sync main, run `check-migration-versions.mjs`, take the next
free version" — but at *different points in main's history*. FDH-3 forked
from `origin/main`'s current tip (`c868de6`, the certified chain through
`0057`). R6-security-final forked from an earlier ancestor of that same
main line (`d18c4ac`), before FDH-2's `0050`-`0057` (and everything else
between `d18c4ac` and `c868de6`) existed. `0058` was genuinely the next
free version as observed independently from each branch. Neither branch's
own guard run could see the other's allocation — `check-migration-
versions.mjs` inspects only the one checked-out working tree, by design,
and had no way to compare across branches. This is the same root-cause
shape as the prior Investment Intelligence + Resources + Phase 0C
collision, four occurrences before it in this project's history.

## DEV state

Both original `0058` migrations — FDH-3's, and the entirety of Investment
Intelligence R6's displaced `0058`-`0062` chain — had **already been
independently applied to the same shared DEV database** (`vqycarelcoijzwl
pkpcz`), each under its own original filename, in separate sessions earlier
the same day this reconciliation was dispatched. This was independently
re-confirmed by direct query during this reconciliation
(`docs/database-reconciliation/0058_EXPECTED_VS_DEV.md`: 20/20 checks
passed). There was no gap to fill and no missing schema anywhere in DEV.

## Decision

1. **FDH-3 keeps `0058`.** It is the direct continuation of canonical
   `main`'s own certified chain — its merge-base with `origin/main` IS
   `origin/main`'s current tip, whereas R6-security-final's merge-base with
   `origin/main` is the strictly earlier `d18c4ac`. See
   `docs/database-reconciliation/0058_CANONICAL_LINEAGE_DECISION.md` for
   the full reasoning, including the secondary "smaller single file vs.
   five-file already-certified chain" argument.
2. **Investment Intelligence R6's whole 5-migration chain shifts forward
   one slot each**: `0058→0059` (`ii_r6_p1_tax_engine.sql`),
   `0059→0060` (`ii_r6_final_reference_seed.sql`),
   `0060→0061` (`ii_r6_final_tax_profile.sql`),
   `0061→0062` (`ii_r6_final_rls_forgery_fix.sql`),
   `0062→0063` (`ii_r6_debt_fund_fix_reference_seed.sql`). Performed via
   `git mv`, highest-version-first, preserving git rename history.
3. **Zero schema overlap, confirmed not assumed.** Full manifests of both
   sides (`docs/database-reconciliation/0058_FDH3_MANIFEST.md`,
   `0058_II_R6_MANIFEST.md`) show no shared table, column, function,
   trigger, or policy name — only the version number ever collided.

## Forward migration approach: renumbering, not re-emission — and why

The prior reconciliation (Investment Intelligence + Resources + Phase 0C)
used a different mechanism: archive the ten displaced files verbatim to
`supabase/migration_archive/`, and re-emit their combined effects via one
new idempotent forward migration (`0049`). That mechanism exists for a
specific precondition: when the repository cannot be sure the losing
migrations' effects are actually already live in the shared environment,
so a fresh, explicitly-idempotent statement is needed to guarantee
convergence regardless of DEV's true prior state.

**That precondition does not hold here.** Both sides were independently
confirmed already-live in DEV before this reconciliation began. Writing a
new "re-emission" migration would have been at best a no-op file with no
purpose (everything it would create already exists) and at worst a risk
surface (a re-emission migration not written with perfect `IF NOT
EXISTS`/`CREATE OR REPLACE` guards on every single statement could error
against already-existing objects, for zero benefit over simply renaming the
file). Renaming the R6 chain forward is **strictly repository bookkeeping**:
this project's applied-migration mechanism has never been a filename-keyed
ledger (`supabase_migrations.schema_migrations` is never populated — every
migration in this project's history was applied by a human pasting SQL into
the Supabase Dashboard SQL editor, see the prior ADR). DEV only ever knew
the SQL text it ran, and that text — verified byte-for-byte except for
header comments — is unchanged by the rename.

## Why history is not rewritten

The renamed files' SQL content is preserved verbatim; only header comments
gained a collision note and cross-reference. No file was silently rewritten
to look like it always had its new number — the collision, the fork-point
asymmetry, and the renumbering are documented directly inside each renamed
file's own header, permanently. Git's rename detection independently
preserves the authorship/history trail (`git log --follow`,
`git show --stat 3e65043` shows all five as detected renames, not
delete+add pairs). Nothing here manufactures a ledger claim that
"`0059_ii_r6_p1_tax_engine.sql` was applied to DEV under that name" — no
such filename-keyed ledger exists to make that claim in, and none is
created. What is claimed, and independently verified by direct query
(`0058_EXPECTED_VS_DEV.md`), is only the fact that matters: the SQL effects
described in that file's content are live in DEV.

## Future prevention

`scripts/check-migration-versions.mjs` (the existing guard) inspects only
one checked-out working tree and structurally could not have caught this —
neither branch's checkout ever contained the other branch's colliding file.
`scripts/check-migration-versions-against-branch.mjs` (new, this
reconciliation) closes that gap: it diffs the active migration directory on
the current ref against a target ref (default `origin/main`) using `git
ls-tree`/blob-sha comparison, requiring no checkout of the target. A
version claimed by two different files (by name or by content) fails; a
version that matches byte-for-byte — legitimate shared ancestry after a
real merge — does not. Reproducing the actual historical collision
(`--ref=a471a1b --against=3af02e3`) is a permanent regression test
(`tests/unit/migrationVersionsCrossBranch.test.ts`), alongside synthetic
positive/negative controls for all four required cases: identical content
(pass), different content same version (fail), new unique version (pass),
archived non-executable duplicate (excluded, never reaches the comparator).

**Mandatory pre-merge command**, documented in
`docs/architecture/MIGRATION_REGISTRY.md`:

```sh
npm run check:migrations:against-main
```

This is currently a required *manual* step — run it yourself before
opening or merging any branch that carries a migration file — not a wired
CI gate, matching this project's current process-maturity level (no CI
pipeline exists yet to enforce it automatically). The single-working-tree
guard (`npm run check:migrations`, née `node scripts/check-migration-
versions.mjs`) continues to run inside `npm test` unchanged.
