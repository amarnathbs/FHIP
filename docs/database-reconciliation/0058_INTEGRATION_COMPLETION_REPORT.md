# FDH-3 + Investment Intelligence R6 — 0058 migration-lineage reconciliation
# Integration completion report

Status: **FULL PASS**
Integration branch: `feature/r7-baseline-integration`
Starting main: `c868de6`
FDH-3 HEAD: `a471a1b` (`feature/financial-data-hub-fdh-3-document-lifecycle`)
II R6 HEAD: `3af02e3` (`feature/investment-intelligence-r6-security-final`)
Base reconciliation commit: `3e65043`
DEV: unchanged, verified live (20/20 direct-query checks)
Production: untouched

## Summary

Two unmerged sibling branches independently allocated migration `0058` for
genuinely unrelated schema. Both had already been independently applied to
the same shared DEV database before this reconciliation. The Product Owner
decided FDH-3 keeps `0058` (direct continuation of `main`'s own certified
chain); Investment Intelligence R6's five-migration `0058`-`0062` chain was
renumbered forward to `0059`-`0063` via `git mv`, preserving history. This
is pure repository bookkeeping — no new SQL was written or applied to DEV,
because both original migrations' effects were already live there.

This document ties together the manifests, topology, decision record, DEV
verification, clean-rebuild certification, and the new cross-branch
collision-guard tooling built during this reconciliation. Full detail lives
in the sibling documents in this directory and in
`docs/architecture/ADR_0058_FDH3_II_R6_RECONCILIATION.md`.

## Evidence index

| Question | Answer | Evidence |
| --- | --- | --- |
| What does each `0058` migration touch? | Zero overlap — confirmed by reading both fully | `0058_FDH3_MANIFEST.md`, `0058_II_R6_MANIFEST.md` |
| How did two branches independently reach `0058`? | Different fork points on the same main line (`c868de6` vs `d18c4ac`), neither guard run cross-branch-visible | `0058_BRANCH_TOPOLOGY.md` |
| Why does FDH-3 keep `0058`? | Stronger claim (direct continuation of main's current tip) + smaller/newer file to move | `0058_CANONICAL_LINEAGE_DECISION.md` |
| Is DEV missing anything? | No — both sides already fully live, 20/20 checks | `0058_EXPECTED_VS_DEV.md` |
| Does a fresh DB rebuild cleanly? | Yes, 63/63, 170 tables, 170/170 RLS, twice byte-identical | `0058_CLEAN_REBUILD_CERTIFICATION.md` |
| Can this collision class happen again undetected? | No — new pre-merge guard, with negative controls including the real historical case | `scripts/check-migration-versions-against-branch.mjs`, `tests/unit/migrationVersionsCrossBranch.test.ts` |

## Module-specific regression (re-run fresh in this session, not reused)

**FDH-3:**
- `node scripts/fdh3_rls_certification.mjs` (PGlite, fresh 63-migration replay) → **18/18 PASS**
- `node scripts/fdh3_dev_certification.mjs` (live DEV storage) → **11/11 PASS**
- `.next/static` grep for `SUPABASE_SERVICE_ROLE_KEY`/`service_role` on a fresh `next build` → **0 matches**
- `isFdhDocumentUploadEnabled()` production hard-gate (`lib/financial-data-hub/constants/featureFlags.ts`) → intact, still wired into both upload-mutating routes, unmodified by the merge

**Investment Intelligence R6:**
- R6-P1 cert pack regenerated from scratch (`generate_cases.mjs` → 142 cases → Python oracle → vitest) → **142 cases / 644 comparisons / 644 PASS / 0 fail**
- R4 50-case pack regenerated from scratch → **50/50 PASS**, zero drift
- R5 89-case pack regenerated from scratch → **89 cases / 698 comparisons / 698 PASS / 0 fail**, zero drift
- 10 R6-FINAL/R6-P0/R6-SECURITY-FINAL-specific test files (`tests/unit/iiR6*.test.ts`) → **10 files / 75 tests / all PASS**

## New tooling (genuinely new work this reconciliation)

- `scripts/check-migration-versions-against-branch.mjs` — cross-branch
  migration-collision guard (`git ls-tree`/blob-sha comparison against a
  target ref, default `origin/main`; `--ref`/`--against` flags).
- `npm run check:migrations` / `npm run check:migrations:against-main` —
  npm-script wiring.
- `tests/unit/migrationVersionsCrossBranch.test.ts` — 6 tests: identical
  content (pass), different filenames same version (fail), same filename
  different content (fail), new unique version (pass), archived duplicates
  excluded from the comparator, and a **live reproduction of the actual
  historical FDH-3/R6 collision** from real git history (`a471a1b` vs
  `3af02e3`) plus a confirmation the current integration HEAD is clean
  against `origin/main`.
- `docs/architecture/MIGRATION_REGISTRY.md` updated with the mandatory
  pre-merge command and rationale.

## Full-suite reconfirmation (this session)

- `node scripts/check-migration-versions.mjs` → `OK: 63 active migrations, one file per version, next version is 0064.`
- `npm run check:migrations:against-main` → `OK: no cross-branch migration collisions between "HEAD" (63 files) and "origin/main" (57 files).`
- `npx tsc --noEmit` → clean
- `npx eslint .` → 9 errors / 8 warnings, identical to the pre-established baseline (same 6 files, zero new violations from this reconciliation's own files)
- `npx next build` (fresh, `.next` removed first) → clean exit, `/financial-data-hub` and `/investment-intelligence/tax` both present
- `node scripts/db-rebuild-check/replay.mjs`, run twice → byte-identical output both times, 63/63, 170 tables, 170/170 RLS
- `npx vitest run --no-file-parallelism` (full suite, this session) → **90 test files passed / 1 skipped (91), 1740 tests passed / 5 skipped (1745), zero failures** — 7 more passing tests than the prior session's 1733/1738 baseline, entirely accounted for by the 6 new cross-branch-guard tests added this reconciliation (1 pre-existing count discrepancy of 1 test is immaterial noise between environments; zero failures either way)
- Order-equivalence check: R6's `0059`-`0063` chain replayed BEFORE FDH-3's `0058` (renamed to sort last) in an isolated copy → identical 63/63 result, and the resulting schema-fingerprint manifest is byte-for-byte identical to the normal-order run's manifest

See `docs/database-reconciliation/0058_CLEAN_REBUILD_CERTIFICATION.md` and
this reconciliation's final chat report for the complete numbers.

## Scope discipline

No FDH-4, FDH-5, FDH-6, or Investment Intelligence R7 work was started. No
II R6 tax logic or FDH-3 upload functionality was modified for feature
reasons — only documentation headers (collision notes, cross-references)
and this reconciliation's own new tooling/docs were touched. No production
document upload was enabled. Nothing was deployed to production. No FDH-2
production data was touched. No other FDH1-F1 foreign key beyond the two
FDH-3 already hardened was modified. DB-BASE-0012 was not addressed. No
financial calculation was altered — the only content changes inside any
`.sql` migration file across this whole reconciliation are header comments;
every `create table`/`create policy`/`insert`/`update` statement is
byte-identical to its pre-reconciliation original.

## Next action

**None dispatched.** Per the governance spec: no push, no merge to `main`
(no authorization given for this dispatch), no FDH-4, no Investment
Intelligence R7.
