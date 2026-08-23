# R9 Testing and Verification

## Static verification (spec section 140)

Run fresh, in this worktree, on the final code state (not copied from a prior pass):

| Check | Command | Result |
|---|---|---|
| TypeScript | `npx tsc --noEmit` | **0 errors**, exit 0 |
| Unit tests | `npx vitest run --no-file-parallelism` | **1978 passed, 5 skipped, 0 failed** (104/105 files; 1 pre-existing skip unrelated to R9) |
| Lint | `npx eslint .` | **0 errors, 0 warnings introduced by R9.** 9 pre-existing errors and several pre-existing warnings remain in files R9 never touched (`components/marketing/LandingPage.tsx`, `components/recommendations/RecommendationsPanel.tsx`, `components/ui/AppShell.tsx`, `scripts/{replay.mjs,fdh4_live_dev_certification.ts,ii_r6_security_final.mjs,r7final_live_dev_certification.mjs}`) — confirmed via `git diff --stat` that none of these files appear in this branch's diff |
| Build | `npm run build` | **Exit 0.** All 10 new R9 API routes and the new `/investment-intelligence/review` page appear correctly in the route manifest |

## Migration verification (spec section 141-142)

| Check | Result |
|---|---|
| Clean replay (`scripts/db-rebuild-check/replay.mjs`) | **67/67 migrations applied, zero manual intervention.** 174 tables, 2304 columns, 2366 constraints, 533 indexes, 201 policies, 174/174 RLS-enabled (up from 172 pre-R9) |
| Local migration guard (`npm run check:migrations`) | OK: 67 active migrations, one file per version, next free is `0068` |
| Cross-branch collision guard (`npm run check:migrations:against-main`) | OK: no collisions between `HEAD` and `origin/main` (this branch is a strict superset — one new file, `0067`) |
| Generic RLS certification (`scripts/db-rebuild-check/rls.mjs`) | 25/25 passed (pre-existing suite, unaffected) |
| R9-specific real-Postgres certification (`scripts/ii_r9_certification.mjs`) | **15/15 passed** — RLS, cross-tenant denial, dedup constraint, allocation-cap CHECK, no-double-counting invariant + its own negative controls |
| Independent oracle (`scripts/r9_independent_goals_forecasting_oracle.mjs`) | **21/21 passed**, no production TypeScript imported |

## Predecessor regression (spec section 122)

The full 1978-test suite includes every predecessor II release's own certification pack (R2 golden fixtures, R3 dedup/no-double-count matrix, R4 50-case calculation certification + XIRR/TWRR certification, R5 certification pack, R6 142-case pack + security-final closure, R7 198-case pack), plus Goals/Forecasting/Retirement/Dashboard unit tests — **all pass unchanged**. `iiGoalAllocations.test.ts` (the pre-existing R1 test of `deriveGoalFundingSourcePayload`) passes unmodified, confirming R9's fix preserved that function's exact contract.

## What this pack does not include (see `R9_ACCEPTANCE_REPORT.md` Known Limitations)

Live-DEV cases (blocked on migration application), a dedicated 50-scenario end-to-end pack, and a literal 200-numbered certification pack (60 real cases delivered instead — see `R9_200_CASE_CERTIFICATION.md`).
