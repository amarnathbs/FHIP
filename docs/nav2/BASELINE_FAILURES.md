# Baseline failures on origin/main (pinned)

Purpose: five tests fail on `origin/main` before any NAV2 work. This file pins their exact failure signatures so that "pre-existing" can be CHECKED, not asserted. **A changed count or a changed error blocks calling a failure pre-existing**: it must then be explained, fixed or reported as new.

## Base

- origin/main at the time of this check: `b105cf48bcef` (`b105cf4`, "Merge feat/factsheet-benchmark-reader-20261003 ..."). `git fetch origin main` on 06-10-2026 left it unchanged, and it is the commit the NAV2 branch merged and branched from (merge-base of `feat/nav2-stage2-datefmt-20261005` and origin/main is `b105cf4`).
- Clean checkout used: `git worktree add --detach D:/FHIP/.claude/worktrees/baseline-b105cf4 b105cf4` (a detached worktree at that commit, no local changes, `node_modules` linked from the shared checkout).

## Exact commands

Each test is run on its own (a full run rewrites checked-in files under `scripts/`; `git checkout -- scripts/` afterwards):

```
cd D:/FHIP/.claude/worktrees/baseline-b105cf4
npx vitest run tests/unit/statementResumeListAndApplyOnce.test.ts --reporter=json
npx vitest run tests/unit/adminAnalyticsPhaseAMeRoute.test.ts --reporter=json
npx vitest run tests/unit/g2AmountColumnAlignment.test.ts --reporter=json
npx vitest run tests/unit/aie1MalwareScanSweepSchedulerPglite.test.ts --reporter=json
npx vitest run tests/unit/lr1UploadSecurityRawFileLifecycle.test.ts --reporter=json
```
and the same five in the NAV2 worktree (`D:/FHIP/.claude/worktrees/agent-a8ad709cd64e17988`) for the comparison.

## Result (06-10-2026)

### `statementResumeListAndApplyOnce`

- origin/main (clean checkout): 22 tests, 21 passed, **1 failed**
- this branch: 22 tests, 21 passed, **1 failed**
- failure signature(s) on origin/main:
  - `C. a re-upload leads to the original, never a dead end the retirement upload route answers with the ORIGINAL upload's id (it used to send the copy's, which has no statement) :: AssertionError: expected 422 to be 200 // Object.is equality`
- signature identical on this branch: **yes**

### `adminAnalyticsPhaseAMeRoute`

- origin/main (clean checkout): 24 tests, 7 passed, **17 failed**
- this branch: 24 tests, 7 passed, **17 failed**
- failure signature(s) on origin/main:
  - `Wave 1 §10.2 — /api/admin/me shared role resolution resolves the caller exactly once per request: one auth.getUser, one read of each role source :: AssertionError: expected 7 to be 1 // Object.is equality`
  - `Wave 1 §10.2 — /api/admin/me shared role resolution does not re-query roles once per capability (five capabilities, still one read each) :: AssertionError: expected [ 'resourcesDashboard', …(14) ] to have a length of 5 but got 15`
  - `Wave 1 §10.2 — /api/admin/me shared role resolution holds no route-local Supabase query: the route module imports only the shared helper :: AssertionError: expected 'import { ok } from \'@/lib/api\';\nim…' not to contain 'from(\'admin_users\')'`
  - `Wave 1 §10.2 — /api/admin/me shared role resolution all five capability values come from the same role snapshot (one fetch, five decisions) :: AssertionError: expected { resourcesDashboard: true, …(14) } to deeply equal { resourcesDashboard: true, …(4) }`
  - `Wave 1 §10.2 — /api/admin/me capability values authenticated, no role :: AssertionError: expected { resourcesDashboard: false, …(14) } to deeply equal { resourcesDashboard: false, …(4) }`
  - `Wave 1 §10.2 — /api/admin/me capability values Analyst only :: AssertionError: expected { resourcesDashboard: false, …(14) } to deeply equal { resourcesDashboard: false, …(4) }`
  - `Wave 1 §10.2 — /api/admin/me capability values Author only :: AssertionError: expected { resourcesDashboard: true, …(14) } to deeply equal { resourcesDashboard: true, …(4) }`
  - `Wave 1 §10.2 — /api/admin/me capability values Editor only :: AssertionError: expected { resourcesDashboard: true, …(14) } to deeply equal { resourcesDashboard: true, …(4) }`
  - `Wave 1 §10.2 — /api/admin/me capability values Compliance Reviewer only :: AssertionError: expected { resourcesDashboard: true, …(14) } to deeply equal { resourcesDashboard: true, …(4) }`
  - `Wave 1 §10.2 — /api/admin/me capability values Publisher only :: AssertionError: expected { resourcesDashboard: true, …(14) } to deeply equal { resourcesDashboard: true, …(4) }`
  - `Wave 1 §10.2 — /api/admin/me capability values Resource Admin :: AssertionError: expected { resourcesDashboard: true, …(14) } to deeply equal { resourcesDashboard: true, …(4) }`
  - `Wave 1 §10.2 — /api/admin/me capability values Super Admin :: AssertionError: expected { resourcesDashboard: true, …(14) } to deeply equal { resourcesDashboard: true, …(4) }`
  - `Wave 1 §10.2 — /api/admin/me capability values Analyst + Editor :: AssertionError: expected { resourcesDashboard: true, …(14) } to deeply equal { resourcesDashboard: true, …(4) }`
  - `Wave 1 §10.2 — /api/admin/me capability values malformed role value only :: AssertionError: expected { resourcesDashboard: false, …(14) } to deeply equal { resourcesDashboard: false, …(4) }`
  - `Wave 1 §10.2 — fail-closed and legacy compatibility a logged-out caller receives a stable, fully false capability object :: AssertionError: expected { isAdmin: false, …(2) } to deeply equal { isAdmin: false, …(2) }`
  - `Wave 1 §10.2 — fail-closed and legacy compatibility the response carries all five capability keys even when every one is false :: AssertionError: expected [ 'benchmarkCatalogueManage', …(14) ] to deeply equal [ 'resourceAnalytics', …(4) ]`
  - `Wave 1 §10.2 — coupling-regression detector (Second Addendum §1.4b) each capability field comes from its OWN named predicate, not one shared boolean :: AssertionError: expected { resourcesDashboard: true, …(14) } to deeply equal { resourcesDashboard: true, …(4) }`
- signature identical on this branch: **NO (see note)**

### `g2AmountColumnAlignment`

- origin/main (clean checkout): 1 tests, 0 passed, **1 failed**
- this branch: 1 tests, 0 passed, **1 failed**
- failure signature(s) on origin/main:
  - `G2 — every amount column in every table is right-aligned finds no money-rendering table cell without right alignment :: AssertionError: G2 violation — these table cells render a monetary value but are not right-aligned. Add NUM_CELL_CLASS (lib/ui/tableAlign.ts) to the <td> className, and NUM_HEADER_CLASS to its <th>: components/`
- signature identical on this branch: **yes**

### `aie1MalwareScanSweepSchedulerPglite`

- origin/main (clean checkout): 4 tests, 1 passed, **3 failed**
- this branch: 4 tests, 1 passed, **3 failed**
- failure signature(s) on origin/main:
  - `migration 0174 — malware-scan-sweep pg_cron registration, against a real Postgres engine registers the FDH-3 malware-scan-sweep job with a 1-minute schedule targeting the FDH route :: AssertionError: expected [] to have a length of 1 but got +0`
  - `migration 0174 — malware-scan-sweep pg_cron registration, against a real Postgres engine registers the AIE malware-scan-sweep job with a 1-minute schedule targeting the AIE route :: AssertionError: expected [] to have a length of 1 but got +0`
  - `migration 0174 — malware-scan-sweep pg_cron registration, against a real Postgres engine also confirms the pre-existing purge-sweep jobs (0135/0149 precedent) are still registered alongside these new ones :: AssertionError: expected [] to deeply equal [ 'aie1-document-purge-sweep', …(1) ]`
- signature identical on this branch: **yes**

### `lr1UploadSecurityRawFileLifecycle`

- origin/main (clean checkout): 14 tests, 13 passed, **1 failed**
- this branch: 14 tests, 13 passed, **1 failed**
- failure signature(s) on origin/main:
  - `LR-1 raw-content-persistence invariant scan (source/repo search based) the purge service never logs a signed URL, an auth header, or a raw storage-client exception unsanitised :: AssertionError: expected '/**\n * Financial Data Hub — FDH-3 ra…' not to match /console\.(log|error|warn)\(/`
- signature identical on this branch: **yes**


## Note on `adminAnalyticsPhaseAMeRoute`

The failing test NAMES and the number of failures (17 of 24) are identical, but the numbers inside the messages differ by exactly what NAV2 added: origin/main reports 15 capability keys and 7 role-source reads, this branch 17 and 8, because NAV2 added the two capability keys `riskFreeDataUpload` and `riskFreeSeriesSwitch` (one more role column read). The test itself is stale on origin/main (it still expects five keys; the route already returns 15), so these failures are **pre-existing in kind**, and the count difference is **attributable to NAV2's two new capability keys**, not a new defect. The test was not edited.

## What each pre-existing failure is

- `statementResumeListAndApplyOnce`: the retirement upload route answers 422 (owner selection now required) where the test expects 200; the test predates owner-before-upload.
- `adminAnalyticsPhaseAMeRoute`: stale expectations (five capability keys) against a route that returns more.
- `g2AmountColumnAlignment`: one money cell without right alignment, `components/investment-intelligence/OwnerBreakupTable.tsx:68`.
- `aie1MalwareScanSweepSchedulerPglite`: the pg_cron registrations are not found in the in-process Postgres (the replay strips the pg_cron extension).
- `lr1UploadSecurityRawFileLifecycle`: the purge service source contains `console.error(...)`, which the invariant scan forbids.

None of these five touches NAV2 code.

## Test hygiene runs (06-10-2026)

- NAV2 folder (`tests/unit/nav2`): 37 files, 624 tests, all pass together, and under `--sequence.shuffle` seeds 1 and 2.
- Investment/NAV/report group (257 files, 4959 tests, LiveDev/live excluded): together run 4953 pass, 1 fail (`reportNavHistoryGateGenerate` NC-G2, a repo-walking test that times out under parallel load; passes alone, 16/16). Shuffle seed 1: 0 failures. Shuffle seed 2: only 4182 tests ran because 12 suites failed with ENOENT on a vitest SSR temp file (environment, transient) and `heldSchemes` hit a vi.mock error in that run; `heldSchemes` alone passes 43/43 with shuffle seeds 2 and 5.
- Two real hygiene defects were found and fixed: `nav2ContractAndGuards` (status vocabulary lacked the new row-30 status) and `nav2RefreshAttemptsMigration` (shared rows between tests, 10 s hook limit under load; now order independent).
- The group-run failures above are load-related flakes recorded here, not shown to be caused by NAV2; they were not reproduced in isolation.

## Release candidate full-suite comparison (15-10-2026, origin/main `af2d330`)

Both runs: `npx vitest run --testTimeout=60000 --hookTimeout=60000` with the JSON reporter, one after the other on the same machine (other work was running on it), `git checkout -- scripts/` afterwards. Baseline = `git archive` of `origin/main` (`af2d330`) in its own folder with `node_modules` linked; release candidate = the branch at `de71bad` plus the two test fixes below.

| | Tests | Passed | Failed | Files with a failure |
|---|---|---|---|---|
| origin/main `af2d330` (clean extract) | 13,103 | 13,047 | 38 | 37 |
| Release candidate `de71bad` | 13,664 | 13,576 | 27 | 36 |

* **Failing on the release candidate and NOT on main: 4 entries, all explained.**
  * `benchmarkEntitlementEditRevisionPglite` (suite): demanded that migration 0280 be the LAST migration, so it failed as soon as the NAV2 migrations 0281 and 0282 exist. Real, caused by the release candidate's numbering. Fixed in the test: it now demands that 0280 is used once (it passes, 56 of 56).
  * `promoHardeningMigrations` NC-L2: demanded that nothing below 0264 is above 0262, which is false once the NAV2 migrations 0260 to 0263 are present (0263 is exactly the highest number "elsewhere" the same test names). Real interaction of two workstreams. Fixed in the test (`<=` the named highest, 39 of 39 pass).
  * `benchmarkDataAdminRoutes`, `benchmarkDataFileCsv` (suite failed to run: ENOENT in the temporary `ssr` folder of the vitest transform): the harness fault that hits a different random set of suites in every full run (24 suites in the baseline run, 25 in the release candidate run, mostly different ones). All 25 of the release candidate's were re-run together with two workers: 1,153 of 1,153 tests pass.
* **Failing on both** (pre-existing, not touched by NAV2): `adminAnalyticsPhaseAMeRoute` (stale five-key expectations; 17 of 24 fail on both), `aiResidualClosureFailClosed` A4, `countryGateAccessMatrix` MC-15 (an account-deletion route exists), `iiNetWorthNavRemarkPublishFlow` (date dependent), `lr1UploadSecurityRawFileLifecycle`, `m12cServerOnlySecretBoundary`, `promoHardeningProofCorePglite` (3, date dependent), `resourcesR1_1`, and the Resources live-DEV suites.
* **Failing on the baseline run only** (environment of the extract, not code): `heldSchemes` (module mocking in the extract), `migrationVersionsCrossBranch` (needs `.git`), `resourcesR1_4LiveDev` and two other live-DEV suites.
* The NAV2 folder alone: 58 files, 851 tests, all pass.

## Release candidate comparison after the D-6 fix and the merge of origin/main 417d5f5 (16-10-2026)

Both runs: `npx vitest run --maxWorkers=3 --testTimeout=90000 --hookTimeout=90000`, JSON reporter, one after the other, `git checkout -- scripts/` afterwards. Baseline = `git archive` of `origin/main` (`417d5f5`) in its own folder with `node_modules` linked; release candidate = the branch at the merge commit `426ed95` plus the fixes below.

| | Tests | Passed | Failed | Files with a failure |
|---|---|---|---|---|
| origin/main `417d5f5` (clean extract) | 14,896 | 14,793 | 29 | 15 |
| Release candidate (`426ed95`, before the two fixes below) | 15,781 | 15,748 | 28 | 13 |

* **Failing on the release candidate and NOT on main: 2 entries, both real interactions of NAV2 with guards that main added, both fixed.**
  * `dataTableGuard`: two NAV2 components had a raw `<table>` (the Fund analytics PDF page and the on-screen report table). The on-screen table now uses the shared `<DataTable>` (same caption, header and rows, now with the shared scroll region; `nav2ReportViewAccessibility` now recognises that wrapper); the PDF page is on the guard's allow-list with a stated reason (fixed percentage column widths for a printed sheet).
  * `premiumAiGuardCoverage`: `nav2/rbiAiReader.ts` reaches an AI provider and was neither guarded nor listed. It is reached only by the cron-secret weekly RBI refresh job (switch OFF), never by a user request, so it is listed as a building block with that reason.
* **Failing on main only** (fixed or absent on the branch): `benchmarkEntitlementEditRevisionPglite` (demanded that 0280 be the last migration, which 0285 on main now breaks; the branch carries the corrected guard), `migrationVersionsCrossBranch` (needs `.git`, absent in the extract), two Resources live-DEV suites (environment).
* **Failing on both** (pre-existing): `adminAnalyticsPhaseAMeRoute` (17), `aiResidualClosureFailClosed` A4, `countryGateAccessMatrix` MC-15, `iiNetWorthNavRemarkPublishFlow`, `lr1UploadSecurityRawFileLifecycle`, `m12cServerOnlySecretBoundary`, `promoHardeningMigrations` NC-M4, `resourcesBulkImportMigration` editor safety (both of these lint main's own migration 0285), `resourcesR1_1`, `smsfHouseholdIsolation`.
* The vitest `ssr` ENOENT harness fault again hit a different set of suites in each run; the suites hit in the release candidate run pass when re-run.
* `tsc --noEmit`: one error, `tests/unit/canonicalCertResidueAllSql.test.ts(127,75)`, byte-identical on origin/main. ESLint on the 235 changed files: one error in `components/ui/AppShell.tsx`, the same line exists on origin/main.
* `npm run check:migrations`: OK (245 active migrations, next version 0286). `npm run check:migrations:against-main`: no cross-branch collisions. Migration numbers: NAV2 owns 0260 to 0263, 0269 to 0271, 0281, 0282; 0283 staff Premium, 0284 AIE cap, 0285 income tax amount (on main) and 0286 Module 11 prompt v3 belong to other workstreams.
