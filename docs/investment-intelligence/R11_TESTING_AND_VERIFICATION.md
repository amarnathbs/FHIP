# R11 Testing & Verification

## Static verification

| Check | Command | Result |
|---|---|---|
| TypeScript | `npx tsc --noEmit` | **Clean** across the whole project except one pre-existing, unrelated failure (`scripts/resources/lib/workbook.ts` imports `xlsx`, which is declared in `package.json` but missing from the shared `node_modules`) — confirmed present at baseline commit `36107ba` (R1.7 Resources work), long before R11, and confirmed still missing from `node_modules` independent of anything R11 touched |
| ESLint | `npx eslint` scoped to every new/modified R11 file | **0 errors, 0 warnings** (one unused-helper warning found and fixed by deleting the dead code, not suppressing the lint) |
| Build | `npx next build --webpack` | Webpack compilation itself succeeded ("Compiled successfully in 2.9min"); the build's separate TypeScript-check pass failed on the SAME pre-existing `xlsx` gap as above (Next's build re-runs a project-wide `tsc`-equivalent check, and `tsconfig.json`'s `include` covers `scripts/` too, unrelated to any R11 tsconfig change — R11 did not touch `tsconfig.json`) |

`npm install`/touching the shared `node_modules` was deliberately not attempted, since other background agents in this program share the same `D:/FHIP/node_modules` and modifying it mid-session risks their in-flight work.

## Migration verification

- **Clean replay**: `scripts/r11_rls_certification.mjs` replays migrations `0001`-`0079` from disk against a fresh PGlite instance on every run — verified passing.
- **Migration count**: 79 files, `0078`/`0079` are R11's.
- **Collision guard**: re-checked immediately before writing each migration AND again immediately before this report — `ls supabase/migrations | sort | tail` confirmed `0077` as the highest at both R11-P0 time and migration-writing time; re-checked again at report time and found FDH-8's sibling worktree (`agent-ac0d4506259640f73`, branch `fdh8-closure`) still based on `0077` with no migrations of its own yet — **no collision**.
- **Real bug found and fixed during migration authoring**: `0079`'s `professional_profiles` policy originally referenced `professional_relationships` (defined later in the same file) — PGlite's replay failed with `relation "professional_relationships" does not exist`, root-caused via an isolated debug script, fixed by reordering the dependent policy to after the referenced table. See `R11_MANUAL_RECONCILIATION.md` item 7.
- **RLS policy count**: every one of the 6 new R11 tables has RLS enabled; `183` public tables total after `0079`, `0` without RLS (verified by direct `pg_class`/`pg_namespace` query, not by counting `alter table ... enable row level security` statements in the source).

## Test suites written and passing

- `tests/unit/iiR11CrossSourceIdentity.test.ts` — 49/49
- `tests/unit/r11ProfessionalPermissions.test.ts` — 45/45
- `tests/unit/r11IndependentOracleComparison.test.ts` — 34/34
- `tests/unit/r11ProfessionalSecurityOracleComparison.test.ts` — 24/24
- `scripts/r11_rls_certification.mjs` — 32/32

## Regression (spec sections 132-136)

Full `npx vitest run tests/unit --no-file-parallelism`: **2458 passed, 3 failed, 37 skipped, out of 2498 total.** The 3 failures are, in full:

1. `resourcesEditorR1_3.test.ts` / `resourcesImportR1_7LiveDev.test.ts` / `resourcesP0ContentR1_7CLiveDev.test.ts` — `ENOENT: .env.local` (live-DEV-dependent, Resources module, pre-existing, unrelated to R11).
2. `fdh1Isolation.test.ts` — timeout, the documented pre-existing "naive regex matching 'fdh' in absolute paths" environmental quirk named in the standing orchestration constraints, not a regression caused by this session.
3. `resourcesAdminR1_2.test.ts` — timeout on a live DB query (no `.env.local`), Resources module, unrelated to R11.
4. `resourcesAdminRoleCtaHotfixLiveDev.test.ts` — Supabase Auth OTP rate limit, live-DEV-dependent, Resources module, unrelated to R11.

(Some of these are separate files failing for the same root cause; the vitest summary line reports 6 failed FILES containing 3 failed TESTS total — the other 3 files failed entirely at setup/import time before any test ran.)

**Every II-lineage regression suite specifically named in spec section 132** — R10 Reports, R9 Goals/Forecasting/Review, R6 Tax & Cost, R5 SIP/X-Ray, R4 Performance, R3 Publishing/No-Double-Count, R2 CAS parsing/dedup/reconciliation, R1 data foundation — was run explicitly and passed 100%: `iiR2ParserFixtures`, `iiR2Dedup`, `iiR2Reconciliation`, `iiManualImporter`, `iiR3DedupScenarioMatrix`, `iiR3NetWorthCertification`, `iiR4Certification50Case`, `iiR4ServiceLayer`, `iiR5Certification`, `iiR6FinalTaxpayerLevelAggregation`, `iiR6P1Certification`, `iiR9GoalAllocationLifecycle`, `iiR9PaginationCertification`, `iiR9ReviewCentreEngine`, `reports`, `reportsIIChapters`, `fdh3SchemaContract`, `airConsolidationSchemaContract`, `retirementMemberSchemaContract` = **395 + 91 = 486 regression tests, 486 passed, 0 failed** (both sub-runs reported separately above; both fully green).

## Real bugs found and fixed during this session (full list)

1. Two test-data bugs in `iiR11CrossSourceIdentity.test.ts` (CS-24/CS-25) — a tolerance-boundary miscalculation in the test fixtures, not production code. See `R11_MANUAL_RECONCILIATION.md` item 4.
2. Migration `0079` policy-ordering bug (forward reference to a not-yet-created table). See item 7 above.
3. A test-harness role-context bug in `scripts/r11_rls_certification.mjs` (nesting `asService()` inside `asUser()` silently reverted to the superuser role) that produced a false-positive security-leak reading. See `R11_MANUAL_RECONCILIATION.md` item 9.
4. A test-setup unique-constraint collision in the same script (Section 8 attempting a duplicate `(A, P2)` relationship). See item 8.
5. Two `tsc` errors found and fixed post-write: a nullable-array indexing type error in `investments-summary/route.ts`, and two now-unreachable `@ts-expect-error` directives in the oracle-comparison tests (TypeScript could resolve the `.mjs` imports without them).
6. One ESLint warning (unused helper function `decimalsEqualExact`) found and fixed by deletion.

No defect was found in the CORE identity-resolution or permission-decision algorithms themselves during independent-oracle comparison — both oracles matched production on every case, 0 discrepancies (see `R11_INDEPENDENT_ORACLE_REPORT.md`).
