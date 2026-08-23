# FDH2_TEST_CERTIFICATION

All numbers below are from live command execution in this session, not
carried over from any prior estimate.

## 1. Baseline (before any FDH-2 code was written)

| Check | Result |
| --- | --- |
| Migration guard (`scripts/check-migration-versions.mjs`) | `OK: 49 active migrations, one file per version, next version is 0050.` |
| `tsc --noEmit` | Clean, zero errors |
| `vitest run` | `18 test files, 249 tests, all passed` |
| `eslint .` | `13 problems (6 errors, 7 warnings)` — matches the documented pre-existing baseline exactly |

No unexplained baseline failures. The two known environment artifacts
(the `wt-hub2` path avoiding the `fdhIsolation` path-substring fragility,
and `core.autocrlf=false` avoiding the CRLF/whitespace-sensitive-test
issue) were both already handled by the orchestrating session before this
work began.

## 2. FDH-2 migration allocation

Guard re-run after inspecting the active migration directory: next
available version was **0050** (verified live, not assumed). Seven FDH-2
migrations allocated: `0050`-`0052` (schema) and `0053`-`0056` (seed data).
Guard re-run after allocation: `OK: 56 active migrations, one file per
version, next version is 0057.`

## 3. Final regression (after all FDH-2 work)

| Check | Result |
| --- | --- |
| Migration guard | `OK: 56 active migrations, one file per version, next version is 0057.` |
| `tsc --noEmit` | Clean, zero errors |
| `vitest run` | `21 test files, 342 tests, all passed` (+93 new tests, 0 regressions) |
| `eslint .` | `13 problems (6 errors, 7 warnings)` — IDENTICAL to baseline; zero new lint issues |
| `next build` | Compiled successfully, TypeScript passed; failed later at static-page PRERENDER of an unrelated `/admin/benchmarks` page due to missing Supabase credentials in this sandbox (no `.env.local`) — a pre-existing environment limitation, not a code regression. See `FDH2_COMPLETION_REPORT.md` "Known Findings". |
| Clean rebuild (`scripts/db-rebuild-check/replay.mjs`) | `56/56 migrations applied with zero manual intervention`; 163 tables, all RLS-enabled; 32 `fdh_` tables (24 FDH-1 + 8 new FDH-2) |
| Master-data certification (`scripts/fdh2_certify_master_data.mjs`) | **43 passed, 0 failed** |
| RLS certification (`scripts/fdh2_rls_certification.mjs`) | **61 passed, 0 failed** |

## 4. New test files (93 new tests)

| File | Tests | Covers |
| --- | --- | --- |
| `tests/unit/fdh2SchemaContract.test.ts` | 28 | Migration file structure, additive-only guarantee, RLS/policy presence, widened-vocabulary parity between SQL and TypeScript, MCC ambiguity constraints, PII gate constraint, coverage-status discipline, seed idempotency-by-construction |
| `tests/unit/fdh2Domain.test.ts` | 32 | Personal-payee guard (9), global-learning governance state machine (8), classification precedence resolver (9), normalisation library (6) |
| `tests/unit/fdh2Validation.test.ts` | 33 | Zod schemas for categories/MCC/MCC-map/institutions/payment-rails/merchants/global-learning-candidates, and the two new classification-rule match/action discriminated-union members |

## 5. Existing FDH-1 tests — re-scoped, not weakened

`tests/unit/fdh1SchemaContract.test.ts` originally imported the (now
FDH-2-widened) `FDH_TABLES`/`FDH_MASTER_DATA_TABLES`/`FDH_INSTITUTION_TYPES`
constants for its "creates exactly this set" and "matches the SQL check
constraint" assertions. Widening those constants globally would have made
this test spuriously fail (it correctly scopes itself to migrations
`0045`-`0048` only). Fixed by introducing FROZEN companion constants
(`FDH1_TABLES`, `FDH1_MASTER_DATA_TABLES`, `FDH1_INSTITUTION_TYPES`) that
snapshot exactly what FDH-1 shipped, and re-pointing the three affected
FDH-1 test assertions at them — the growing, current-state constants
(`FDH_TABLES`, `FDH_MASTER_DATA_TABLES`, `FDH_INSTITUTION_TYPES`) remain
available for general use (the repository-layer allow-list, FDH-2's own
contract test). All 40 pre-existing `fdh1SchemaContract.test.ts` assertions
still pass, unweakened — they check the exact same facts about the exact
same four files as before.

`tests/unit/fdh1Isolation.test.ts` and `tests/unit/fdh1Domain.test.ts`
required no changes: their usages of the growing constants are all either
subset checks or negative ("not in forbidden set") checks, which remain
correct as the constant set grows.

## 6. Pre-existing quirk carried forward unchanged

`DB-BASE-0012` (the pre-existing `supabase/seed.sql`-must-follow-`0001`
quirk in the clean-rebuild harness) is unaffected by FDH-2 and required no
change — `replay.mjs`/`fdh2_certify_master_data.mjs`/
`fdh2_rls_certification.mjs` all already apply `seed.sql` immediately after
`0001`, per the harness's existing convention.
