# R12 — Testing and Verification (Engineering Gates)

## TypeScript (`npx tsc --noEmit`)

**0 R12-caused errors.** 3 pre-existing baseline errors remain (`scripts/resources/lib/workbook.ts` —
missing `xlsx` type declarations — confirmed zero diff from `origin/main`, last touched in an unrelated
Resources commit `36107ba` long before this round). Fixed 2 real pre-existing gaps TypeScript surfaced
the moment R12 widened `IiTransactionType`: `reconciliation.ts`'s `DIRECTION_TABLE` was missing
`bonus`/`split`/`sale` entries (bonus/split existed in the DB since migration 0059 but were never added
to this TS union or direction table).

## Vitest (`npx vitest run --no-file-parallelism`)

**Full suite: 2641-2647 tests, 0 genuine failures.** Two separate full runs each showed exactly 1
failure, both confirmed Supabase-OTP-rate-limit / network-timeout flakiness in unrelated Resources
live-DEV suites (re-run in isolation: 100% pass both times). New R12 tests: 71 across 3 files
(`iiR12WiderIndiaAssets.test.ts` 16, `iiR12IndependentOracle.test.ts` 44, plus updates to
`iiR3PublicationLogic.test.ts` and `iiR3DedupScenarioMatrix.test.ts` for the 2 assertions R12
legitimately changes).

## ESLint (`npx eslint .`)

**0 new R12 errors/warnings.** Baseline: 9 errors, 43 warnings, all in files R12 never touched
(`AdminRecommendationsClient.tsx`, `FinancialDataGrid.tsx`, `LandingPage.tsx`, `RecommendationsPanel.tsx`,
`ReportPreview.tsx`, `AppShell.tsx`, assorted `scripts/*.mjs`).

## Production build (`npm run build`)

**BLOCKED by a pre-existing, unrelated baseline issue** — Turbopack compiled the application
successfully ("Compiled successfully in 109s"), but the whole-repo TypeScript pass (which covers
`scripts/` as well as `app/`/`lib/`) fails on `scripts/resources/lib/workbook.ts` importing `xlsx`,
which is declared in `package.json` but genuinely absent from `node_modules` in this environment
(confirmed via `node -e "require.resolve('xlsx')"` → `MODULE_NOT_FOUND`). This file has zero diff from
`origin/main` and was last touched in an unrelated commit predating this round. Not fixed here (a
`node_modules`/lockfile repair is outside R12's remit and risks unrelated side effects this late in
the round).

## Migration clean replay (`scripts/db-rebuild-check/replay.mjs`)

**88/88 migrations applied with zero failures** (run twice, after every substantive schema-adjacent
change). 187 tables, all RLS-enabled, 2482 columns, 2580 constraints, 586 indexes, 224 policies.

## RLS smoke certification (`scripts/db-rebuild-check/rls.mjs`)

25/25 passed (generic multi-lineage RLS check, not R12-specific, re-confirmed still clean after 0092).

## Migration collision guard

`node scripts/check-migration-versions.mjs` → OK, 88 active migrations, next version 0093.
`node scripts/check-migration-versions-against-branch.mjs --against=origin/main` → OK, 0 collisions.
Run at the start of this round AND again immediately before this report.

## DEV cleanup

Live-DEV synthetic data (2 users, 3 instruments, 1 account created by
`scripts/r12_live_dev_verification.mjs`) was cleaned up by the script itself and independently
re-verified via a separate count query: 0 residual rows matching the R12 test naming pattern.
