# NAV2 (Fund Analytics) production release plan

Prepared 07-10-2026 on the integration branch `integrate/nav2-production-20261007`. **Nothing was pushed, merged to main or applied anywhere.** No production database was read or written (the only database used was an in-process Postgres, PGlite, and read-only checks of DEV were not needed). The Product Owner runs the SQL and pushes.

## Summary

- **Recommended order: database first, then the code, then switch the report on.** The seven NAV2 migrations are additive; the old code is unaffected by them (proved on a production-like PGlite ledger up to 0278, section 4.3). The new code on the old database is also safe (section 4.2). The order costs nothing and lets you check the database shape before anything new is visible.
- **Everything ships OFF.** All four NAV2 job switches (`nav2_fund_analytics`, `nav2_trigger_planner`, `nav2_correction_worker`, `nav2_risk_free_weekly_refresh`) are created OFF by the migrations. After the push nothing new is visible to anyone. Turning Fund analytics on for Premium people is a separate, reversible step (pilot, README section 8).
- **One real defect found by the deploy-order analysis and fixed on the integration branch:** `GET /api/reports/fund-analytics` (the list) answered a 500 for a Premium person when the NAV2 tables did not exist. It now answers the same plain 404 as generation while the switch is OFF or missing (tests NC-D1, NC-F7).
- **Two things to know before you push** (section 4.1): migration 0261 replaces the retention function `pc6_nav_row_is_candidate` assuming production holds the 0219 text (pre-check P3 verifies it and stops the release if not); and this release also changes, for every user, how a statement line is matched when its ISIN and its AMFI code point at two different funds (it now opens a review question instead of silently choosing the ISIN's fund).
- **Menu entry added:** Reports, Fund Analytics, shown only to a Premium person while the Fund analytics switch is ON; free people never see a dead link.
- **Limits** (section 6): generation is synchronous inside one web request that Amplify ends at 28 seconds; a report covers at most 20 funds (a person with more chooses); a larger report is prepared in steps.
- **Not verified / not activated:** sections 7 and 8. Beta and alpha stay NOT ACTIVATED (no licensed benchmark data); the weekly RBI refresh stays OFF until its final-build dry run passes (Product Owner decision: RBI's written confirmation is not required); the PDF export on the Amplify runtime has not been exercised anywhere for NAV2; the DEV Stage 3 verdict is CONDITIONAL PASS and production has never run any of this.

## 1. The integration branch

| Item | Value |
|---|---|
| Branch | `integrate/nav2-production-20261007` (local only, not pushed) |
| Base | `origin/main` = `e829a8b` (fetched 07-10-2026; migrations on main go up to 0278) |
| NAV2 source | `feat/nav2-stage2-datefmt-20261005`, final tip `2d456b0` (the NAV2 worktree branch `worktree-agent-a8ad709cd64e17988` carried the same work). Merged twice: first at `ba24bfb`, then the later tips `6cf4074`, `ecb5902`, `2d456b0` (clean merge) |
| Release commit (what you push) | **<RELEASE_SHA> (the tip of the branch, given in the hand-off message; verify with `git rev-parse integrate/nav2-production-20261007`)** |

**The release commit is a fast forward of `e829a8b`** (checked with `git merge-base --is-ancestor origin/main HEAD`). If `origin/main` has moved by the time you push, tell me before pushing and I will merge again.

**Conflicts in the first merge: 43 files, resolved as follows.**

| Group | Files | Resolution |
|---|---|---|
| Parallel day-first date work (PO review F13). The NAV2 branch carried an earlier copy of the same change that main now has in its final form | 38 (activity layout, goal and onboarding wizards, profile, import panels, 10 investment-intelligence API messages, admin date columns, resources and SMSF date helpers, taskHelp, schema wording and 4 tests) | main's side taken for every file, including main's API wording ("an ISO 8601 calendar date") and its `DateInput` usage; the NAV2 copies in 21 further files that merged without a textual conflict (duplicate imports, a second `DateInput` handling in the payslip and liability panels) were reset to main's version. `components/ui/DateInput.tsx` is identical to main |
| `app/api/admin/me/route.ts` | 1 | both capability readers kept: planning benchmark upload and activate, and risk-free upload and series switch (each its own read of `admin_users`, each fails closed) |
| `lib/admin/adminNav.ts` | 1 | main's "Premium and Promo Codes" group kept and the "Risk-free Rates" group added; "Fund Analytics Health" stays in Reference Data |
| `tests/unit/adminAnalyticsPhaseA.test.ts` | 1 | capability fixtures carry all four new flags |
| `components/ui/AppShell.tsx` | 1 | main's version (the sidebar data moved to `lib/nav/appNavGroups.ts`); the Fund Analytics entry re-added there (below) |
| `PerformanceClient.tsx` | not a conflict | the NAV2 side had converted the file to CRLF (1,466 changed lines); restored LF so the real change is 2 lines |

**Changes made on top of the merge (all in the integration branch):**

- `lib/nav/appNavGroups.ts`, `lib/nav/appNavCapability.ts`, `components/ui/AppShell.tsx`, `app/api/capabilities/nav/route.ts`: the Fund Analytics menu entry, Premium and switch gated, fail closed (test `nav2FundAnalyticsNavEntry.test.ts`, 8 tests with controls NC-N1 to NC-N6).
- `PageBackLink` on the three new pages (Fund analytics, parent Reports; Risk-free Rate Data and Fund Analytics Health, parent Dashboard like their sibling Admin tools); the print page named as an exempt render target in `BACK_LINK_EXEMPT` (limit raised from 10 to 11) and four rows added to `docs/ux/BACK_NAVIGATION_INVENTORY.md`.
- `app/api/reports/fund-analytics/route.ts`: the list answers 404 while the switch is OFF or unreadable (deploy-order fix).
- `tests/unit/dateFormatsRepoWideVisibleStrings.test.ts` deleted: it duplicated main's `dateFormatVisibleTextGuard.test.ts`, which has the same rules plus more and the same allow-list mechanism; the one NAV2 prompt line it allowed (`rbiAiReader.ts`) now says "an ISO 8601 calendar date" like main's other AI prompt.
- `scripts/nav2_stage3/build_statements.ts`: an `eslint-disable` for `any` in a DEV-only script.
- `scripts/nav2_schema_inventory.mjs` now includes 0269, 0270 and 0271 in the expected inventory (it covered 0260 to 0263 only); `docs/nav2/dev_inventory/*` regenerated (134 columns, 153 constraints, 28 indexes, 8 policies, 48 grants, 9 triggers, 17 functions incl. the redefined retention function; identical from empty (parts and whole file), from partial and on re-run).
- `docs/nav2/risk_free_first_load/` (the three RBI CSV files and the provenance note) added to the branch (they existed only in a working copy).
- The hand-over pack `docs/nav2/po_apply_production/`, `scripts/nav2_production_deploy_order_proof.mjs` and the tests `nav2ProductionHandoverPack`, `nav2DeployOrderNewCodeOldSchema`, `nav2FundAnalyticsNavEntry`.

**Migration numbers.** `check-migration-versions` OK (232 files, next free 0279); `check-migration-versions-against-branch` against `origin/main` and against `feat/promo-hardening-release-20261007`, `feature/resources-content-bulk-upload-20261006`, `feat/promo-premium-hardening-20261005` and `feat/promo-code-email-20261003`: no collisions. NAV2 keeps 0260 to 0263 and 0269 to 0271; no merged migration owns them. Across every ref in the repository the only other file at one of these numbers is an old `0270_planning_benchmark_staged_upload.sql` on a branch that main renumbered to 0275 (main has no 0270 other than NAV2's). Held by unmerged branches and untouched here: 0264 to 0268 and 0279 (promo hardening), 0272 to 0274 (bulk upload). Re-check before pushing: the checkers cannot see unpushed work.

## 2. Verification results

| Check | Result |
|---|---|
| `tsc --noEmit` (`NODE_OPTIONS=--max-old-space-size=8192`) | exit 0, no output, run after the last merge |
| eslint on every added or modified source file (194 files) | 0 errors in the code this release adds or changes, 29 warnings (unused variables in DEV scripts and tests). One error remains in `components/ui/AppShell.tsx` (a state update inside an effect, line 151): the same error exists on `origin/main` (line 143 there), not introduced here |
| NAV2 tests together (`tests/unit/nav2`) plus the guards and the nav and capability suites (`pageBackLinkGuard`, `dateFormatVisibleTextGuard`, `dateFormatsDayFirst*`, `dateInput`, `sidebarAccessibility`, `sidebarOrderAndGroups`, `appNavCapability`, `appCapabilityManifest`, `adminAnalyticsPhaseA`, `adminA02Wave2CapabilityMatrix`, `planningBenchmarkUploadUi`, and four conflict-resolved date tests), run after the last merge | 1,342 tests, 1,341 pass. The one failure (`nav2SchemaContract`, an in-process Postgres replay) timed out under load and passes alone (13 of 13), as it did earlier |
| Full unit suite on the integration branch (before the last NAV2 merge, 3 workers) | 13,099 tests: 13,055 pass, 26 fail, 18 skipped. Every failing file was re-run alone and on a clean `e829a8b` checkout, see below |
| Failures, identical on the clean base | `adminAnalyticsPhaseAMeRoute` (17), `aiResidualClosureFailClosed` (1), `countryGateAccessMatrix` MC-15 (1), `lr1UploadSecurityRawFileLifecycle` (1), `m12cServerOnlySecretBoundary` (1), `resourcesR1_1` (1, a 5 second timeout), plus three files that read a local `.env.local` or content file that does not exist in a worktree (`resourcesImportR1_7LiveDev`, `resourcesP0ContentR1_7C`, `resourcesP0ContentR1_7CLiveDev`). Same counts and test names on base and integration. The pinned list in `docs/nav2/BASELINE_FAILURES.md` was for an older base; this list supersedes it for `e829a8b` |
| 21 files that fail with `ENOENT ... ssr` when run in a group | a test runner fault in this Windows environment (a transformed module cache file goes missing; a clean checkout of main fails the same way). Run one process per file, all 21 pass (benchmark data file and ingestion tests, planning benchmark tests, factsheet reader admin routes, scheme mapping proposals) and `heldSchemes` passes alone |
| Pack proof on PGlite (`scripts/nav2_production_deploy_order_proof.mjs`, after the last merge) | 95 passed, 0 failed (groups A, B, C, D, E, F; about 3 minutes) |
| Pack text tests (`nav2ProductionHandoverPack`, 16) and deploy-order tests (`nav2DeployOrderNewCodeOldSchema`, 10) | pass |
| Housekeeping | `git checkout -- scripts/` after every run (test runs rewrite checked-in artifacts); test-artifact folders deleted |

Not run: the Playwright end-to-end suite (`tests/e2e`, including `navigation.spec.ts`, which lists the Fund Analytics entry), the full unit suite a second time after the last NAV2 merge (only the affected groups above were re-run), and any browser check of the sidebar entry (no dev server was started; the entry is covered by pure function tests, a route test and a source contract on `AppShell`).

## 3. Production-style build

`npx next build` (Next 16.2.12, Turbopack, the build Amplify runs) **exits 0** on the integration branch (built after the last merge): compile, TypeScript (2.8 minutes) and 318 static pages. All 15 NAV2 routes and pages are in the route table (`/reports/fund-analytics`, `/reports/fund-analytics/print`, the three Fund analytics API routes, the two admin pages, five admin routes, two cron routes) plus `/api/capabilities/nav`.

Environment notes, so the result is read correctly: the worktree needed a real copy of `node_modules` (a linked one makes Turbopack stop with "Symlink node_modules is invalid, it points out of the filesystem root"), and the static pages need the two public Supabase variables, which were set to placeholder text (no secret was used). Output size, measured the same way on a clean `e829a8b` build: `.next` 155 MB against 147 MB on the base, `.next/server` 147 MB against 139 MB, `.next/static` 6 MB against 5 MB: **plus about 8 MB**. The Amplify size limit that failed builds 246 and 247 by 2.95 MB on 28-09-2026 is measured on the deployment artifact, which this local figure only approximates; if Amplify rejects the build for size, nothing is deployed and the previous deploy stays (the database steps remain harmless). The build was not run on Amplify.

## 4. Deploy order safety analysis (the crux)

### 4.1 What the release contains, split by blast radius

**New objects (cannot affect anything old):** 12 tables (7 risk-free, 5 `nav2_*`), 16 functions, the Fund analytics page, print route, 4 customer API routes, 2 admin pages, 5 admin routes, 2 cron routes (not scheduled), the Fund Analytics Health page.

**Changes to something that already exists and is used by ordinary production code, database side (migrations 0260 to 0271):**

| Existing object | Change | Who calls it today | Effect on old code |
|---|---|---|---|
| `admin_users` | two new boolean columns, `not null default false` (0260 part a) | every Admin capability read, Resources roles | none: old code selects named columns; a `select *` simply gains two false fields. Brief lock on a tiny table |
| `ii_reference_job_control` | four new rows, all `enabled = false` (0260 part e) | NAV1 and PC6 jobs read their own `job_key`; the Reference Data Quality screen lists all rows | the screen lists four more rows (disabled). No job iterates all rows |
| `ii_reference_corrections` | `AFTER INSERT` hook that writes one inert event row for a price or benchmark correction (0262) | the admin price correction path | the correction itself is unchanged. **Honest limit:** the hook runs in the same statement, so if the events table ever rejected a row the old correction insert would fail; it cannot today (proved: only the listed kinds, `on conflict do nothing`, a missing price row writes nothing). Rows accumulate unprocessed while the worker is OFF (the monitoring "lag" figure then grows: harmless) |
| `pc6_nav_row_is_candidate(uuid, date, date)` | redefined: 0219 text plus two more protections (a pinned report range) (0261). EXECUTE stays service role only | the NAV retention sweep (deletes only pre changeover, unheld, unprotected rows) | strictly more protective; with no pinned report it returns the same answer for every input (proved on a held, held by hold, after changeover and null input). **If production holds any text other than the 0219 text, 0261 silently replaces it:** pre-check P3 compares the live body with the 0219 body (md5 of the function source, `7806e43771e30a14ee55aac7d478c8fd`) and stops the release if different |
| RLS, policies, grants of any existing table | none | | none (the one policy change, 0269, is on a NAV2 table) |
| `nav2_monitoring_snapshot` | created in 0262, replaced in 0270 and 0271 | NAV2 only | none |
| Foreign keys | new tables reference `auth.users` and `ii_instruments` with `on delete cascade` | account deletion, instrument cleanup | a delete now also removes that person's or instrument's NAV2 rows (reports can be deleted with their owner; the immutability trigger refuses only updates). Proved: instrument delete still works |

**Changes to code paths that ordinary (including free) production users already exercise, independent of every switch:**

| Change | Where | Effect |
|---|---|---|
| ISIN versus AMFI code conflict now opens a question (NAV2-F1, a PO decision of 04-10-2026) | `lib/services/investment-intelligence/schemeResolution.ts` | a statement line whose ISIN identifies one fund and whose AMFI code identifies a different fund is no longer matched silently to the ISIN's fund; it becomes an ambiguous instrument case for review. Applies to every statement upload by every user. DEV shows seven incoherent instruments, so some uploads may now raise a question. Not switch controlled |
| CAGR convention sentence on the Performance tab | `components/investment-intelligence/PerformanceClient.tsx` (2 lines) | one extra sentence under the scheme detail explaining the difference from the Fund analytics report |
| After a statement is accepted, the existing "kick" of the price history fetch now calls `runUserNavHistoryForKick` | `pc6/userNavHistoryKick.ts` | with `nav2_trigger_planner` OFF or its row missing it runs the previous function unchanged (proved: NC-D6) |
| Binary search in the as-of lookup used by SIP and rolling windows | `sip/dateAlignment.ts` | same answer for a sorted series (equal by construction and covered by the existing SIP tests) |
| Owner class context also reads `allocation_group_id` | `ownerClass.ts` | the column exists since migration 0153 (pre-check P2 asks for it); a missing column would be swallowed by the existing try/catch and show no entity owners, so P2 guards it |
| Print token waiver in the proxy also covers `/forecast/report/print?token=` | `proxy.ts` | the Consolidated Forecast PDF renderer had no session; its page checks the token (and sends a bad one to `/login`) before reading any data |
| Sidebar: Fund Analytics entry under Reports, visible only to a Premium person while the Fund analytics switch is on | `lib/nav/*`, `AppShell.tsx`, `GET /api/capabilities/nav` | a free person never sees the link; any failure hides it |
| Date wording | | main's day-first work kept everywhere (the NAV2 branch's parallel copy was dropped) |

### 4.2 The new code deployed BEFORE the migrations

The fake database in `tests/unit/nav2/nav2DeployOrderNewCodeOldSchema.test.ts` answers what Postgres answers before the migrations (checked on PGlite: undefined table 42P01, undefined column 42703, undefined function 42883, no switch rows). Results:

| Surface | Behaviour on the old database |
|---|---|
| Free person, any Fund analytics route | the same 403 Premium sentence as with the schema in place |
| Premium person, list reports | **404 "not available yet"** (this release adds the switch check to the list: before it, the list answered 500 from the missing table; found by this analysis, fixed, test NC-D1) |
| Premium person, generate | 404 (the switch row is missing, so the switch is OFF); no report, cache, price or NAV2 table is touched |
| Premium person, read one report, PDF export, print page | 404 / not found; no render starts |
| Page `/reports/fund-analytics` | free: the Premium sentence; Premium: "not available yet" (page reads the switch, a missing row is OFF) |
| Sidebar | the entry is hidden; the nav route answers 200 and the rest of the menu is unchanged |
| Admin: Risk-free Rate Data page, routes | the capability read of the missing column is "no capability": redirect or 403; the status route says the migration is not applied (existing tests); never a grant |
| Admin: Fund Analytics Health | the missing function is reported as "not applied yet" (existing test), not a 500 |
| `/api/admin/me` | still 200; both risk-free flags false |
| Cron routes (not scheduled) | skipped, no read, no write |
| Price history kick after a statement | existing path (planner OFF) |
| Ordinary Premium use, Reports, Dashboard | unaffected |

So deploying the code first is safe and shows nothing new. It is not recommended only because the admin screens would say "unavailable" and the check of the database shape (step 2) is better done with the old code serving.

### 4.3 The migrations applied BEFORE the new code (old code still live)

Proved on PGlite (`scripts/nav2_production_deploy_order_proof.mjs`, groups A, B, D): a production like database (every migration of this tree except the seven NAV2 ones, highest 0278) was seeded; the old paths were recorded; the whole pack was applied; the old paths were recorded again and compared. They are identical (retention predicate for four situations, correction inserts of three kinds, instrument delete, `admin_users` count, Premium rule, EXECUTE rights). The only differences are the intended ones: four more job control rows and one inert event row per price correction. Ordinary users read zero NAV2 rows and cannot call any NAV2 function.

### 4.4 Recommended order and the failure behaviour of each step

1. **Pre-checks P1 to P7** (read only). Failure: nothing changed, stop.
2. **Migrations 0260 a to e, 0261, 0262, 0263, 0269, 0270, 0271, final check.** Each is additive and idempotent; a failed paste is repeated. A stop in the middle leaves a database in which the old code is unaffected (proved from partial states for 0260). Failure points: 0261 is the only step that overwrites something (the retention function): P3 guards it. 0262 adds the correction hook.
3. **Push the code.** Failure: the Amplify build fails and the previous deploy stays. Success with the database in place gives a release that shows nothing new while the four switches are OFF.
4. **Smoke checks (switches OFF), permissions, RBI load.** Failure: switch off all (one statement); nothing else to undo.
5. **Switch Fund analytics ON (pilot).** Failure: `switch_off_fund_analytics.sql`.
6. Later stages (planner, worker, weekly refresh) are separate decisions.

### 4.5 Rollback of the code after the migrations

Reverting the code leaves a harmless database (the old code never reads NAV2 objects; proved). Reverting the migrations after reports exist discards those reports (README section 10).

## 5. What the PO must do, in order

Everything is in `docs/nav2/po_apply_production/README.md`; this is the short form.

1. Run the read-only pre-checks P1 to P7 on production (project `twwpnltizhtjxhamyoxt`) and paste back P1 to P4, P6a and P7. **Stop if P1, P2 or the P3 body check is false.**
2. Paste the migrations in order with their checks: 0260 a to e, 0261, 0262, 0263, 0269, 0270, 0271, final check (all values true). Optionally run the catalog query for the DEV-versus-production shape comparison.
3. Re-check that `origin/main` has not moved, then `git fetch origin`, `git merge-base --is-ancestor origin/main <RELEASE_SHA>`, `git push origin <RELEASE_SHA>:main`. Wait for the Amplify deploy.
4. Smoke checks with all switches OFF (free user, Premium user, administrator, Monthly Report).
5. Grant the upload permission and (to a different person) the series switch permission; with one administrator, grant upload only and revoke it after the load.
6. Load the two RBI files and the gap file through Risk-free Rate Data; read the attestation text.
7. Switch Fund analytics ON (pilot) while you are present, test with your own Premium account (generate, PDF, Fund Analytics Health), keep it ON or switch it OFF.
8. Later and separately: planner, correction worker (stages B and C); the weekly RBI refresh once its final-build dry run has passed (stage D; RBI's written confirmation is not required by Product Owner decision).

## 6. Limits of the report and what users see

- **Generation is synchronous**, in one web request. Amplify ends every request at 28 seconds whatever the route declares; the generation route declares `maxDuration = 28`. Measured engine time on a loaded development machine: 4 funds 3.4 s, 10 funds 10.7 s, 20 funds about 18 s, 40 funds 35 s (plus database reads).
- **At most 20 funds per report** (`lib/config/nav2/reportLimits.ts`, the same number as the pairwise correlation limit so every report has its pair table). A person who holds more is told: "A report covers up to 20 funds. You hold N, so generate it in two reports." The API answers 409 with the funds and a suggested choice, the page shows a selector, and an invalid choice (empty, repeated, over 20, or a fund that is not theirs) is one 422 message that cannot be used to probe other people's funds. The chosen funds are stored in the report manifest and the report says "This report covers X of your N Indian mutual funds, as you chose. The others can go in a second report."
- **The price history gate and the NAV planner still look at all funds held**, not only the chosen ones: the gate runs before the choice, and the planner plans per held fund. A person with 30 funds therefore may see "preparing" for a fund that is not in the chosen 20.
- **20 second safety budget:** a generation never starts engine work that would not finish inside 20 seconds. It prepares as many funds as fit (they go into the shared cache), answers 202 "Your report is large, so it is prepared in steps (n of m funds ready)..." and carries on when the person generates again.
- **Size:** about 0.09 MB per fund stored (0.35 MB for four funds), the PDF about 0.1 to 0.6 MB and not stored; **the largest real report is 20 funds, a 23 page PDF** (summary at most two pages, one page per fund, one comparison page). There is no per-user allowlist: Premium plus the one switch decide who can generate.

## 7. Risks and decisions for the Product Owner

| # | Risk | Where it bites | What I recommend |
|---|---|---|---|
| 1 | Migration 0261 overwrites `pc6_nav_row_is_candidate` | production holds a text other than 0219 | P3 checks the md5 of the function source. If false, do not apply 0261 |
| 2 | The correction hook (0262) runs inside every price correction insert | a future change that makes the events table reject a row would abort corrections | none today (proved); the hook only inserts `on conflict do nothing`. Rollback `rollback_0262.sql` |
| 3 | Statement matching changes for everyone (NAV2-F1, your decision of 04-10-2026) | any upload whose ISIN and AMFI code disagree now opens a reconciliation question | watch open ambiguous instrument cases for a week; DEV has seven such incoherent instruments, production unknown |
| 4 | RBI reuse terms | RBI states "All Rights Reserved"; you accepted the risk (terms status `po_accepted_2026-10-03`); written RBI confirmation is not required | keep "Source: Reserve Bank of India" (already in the report), keep the weekly refresh OFF until its final-build dry run passes |
| 5 | Single operator | one administrator can hold both permissions: logical segregation only, no re-authentication, no preview of a series switch | grant upload only, revoke after the load; do not call it dual control |
| 6 | PDF export on the Amplify runtime | needs headless Chromium (installed in the Amplify build step, the same pattern as the Monthly Report and Forecast PDFs). Never exercised from Amplify for NAV2 | first smoke check of the pilot is "View PDF"; if it fails, the on-screen report still works |
| 7 | Large reports meet the 28 second limit | 20 funds with a cold cache | the 20 second budget and "prepared in steps" handle it; a person with many funds may need a second click |
| 8 | Data quality | DEV Stage 3 found seven instruments with the name of one fund and the AMFI code of another; two of 1,599 loaded prices differ from a second source | the pack has no cheap production test for the same pattern; read the first reports of your own funds |
| 9 | Build size | +8 MB locally against the base; the Amplify limit failed by 2.95 MB on 28-09-2026 | if the Amplify build fails for size, tell me; nothing deploys |
| 10 | Beta and alpha | no licensed benchmark data | stays NOT ACTIVATED; one plain line in the report |

## 8. Not verified

- Production was not read at all. Every production statement rests on the migration files and on your own earlier pastes (0275, 0277 and 0278 applied; main tip e829a8b or later). The pre-checks exist to turn those assumptions into your pasted answers.
- The SQL was run on PGlite (an in-process Postgres with a platform shim), not on Supabase. The editor-safety rules come from a confirmed failure on DEV; the lint is a test, but the editor itself was not used.
- DEV: the catalog comparison (constraints, indexes, policies, grants, function bodies) was never run on DEV; 0260 to 0263 and 0269 to 0271 are applied on DEV and the REST comparison matched. Running the catalog query on DEV and on production gives a direct comparison.
- The Stage 3 verdict is CONDITIONAL PASS. Not shown on DEV: the "timed out" and 500 states, agreement of the report value with Dashboard, Holdings, Investments and Performance for the same timestamp, fairness across many users, a screen reader, production. The Stage 3 DEV evidence was taken on `d0708e2` plus fixes up to `ba24bfb`; the later commits (footnote marks, 28 s, 20-fund cap) are covered by unit and render tests, not by a new DEV journey.
- The sidebar entry was not looked at in a browser, and the Playwright end-to-end tests were not run.
- The 20-fund PDF (23 pages) figure comes from the NAV2 agent's layout judge; it was not re-rendered here.
- Amplify itself: the build, the runtime and the PDF. The release needs no new environment variable (only `APP_BASE_URL`, `CRON_SECRET` and `AIE_AI_FALLBACK_ENABLED`, all existing).
