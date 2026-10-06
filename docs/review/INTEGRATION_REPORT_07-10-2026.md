# Integration report: PO review fixes, owner-before-upload fixes (07-10-2026)

Branch `integrate/po-review-and-owner-fixes-20261007`, created from `origin/main` **`b105cf48bcef8adb1e14d6f3c53ad3015c57e797`** (unchanged from the expected `b105cf4` after `git fetch origin`). Nothing pushed, `main` and production and Amplify untouched, no database call (all work local; DEV not needed). Final tip: see section 11.

## 1. What was merged, in order

| # | Merge | Tip merged | Notes |
|---|---|---|---|
| 1 | `fix/owner-before-upload-dev-cert-20261006` | `a877b51` | Clean, no conflict. |
| 2 | Mission A | **`131fcc7`** | **The named branch `fix/po-review-nav-dates-20261006` is still at `b105cf4` (no commits).** The Mission A work lives on `worktree-agent-a14f1c601e7ddf318` (tip `131fcc7`, commits `5c5a710` ... `131fcc7`). That is what was merged. Clean, no conflict. |
| 3 | `fix/po-review-resources-data-20261006` (Mission B) | `1d99288` | 8 conflicts, resolved (section 2). |
| 4 | `fix/owner-before-upload-dev-cert-20261006` again | **`d20ffd9`** | **The owner branch moved after the brief:** commit `d20ffd9` (07-10-2026 07:37) adds migration `0276_household_members_one_active_self.sql`, the app handling of its violation, a PGlite proof (20 checks) and a PO hand-over pack `docs/ownership/po_apply_self_member_unique/`. It was merged as its own merge commit so it can be reverted alone (`git revert -m 1 62bc4d0`) if the PO does not want 0276 yet. Clean merge. |

Then small commits on top: tsc and lint repairs, and the PO decisions of 07-10-2026 (section 9).

## 2. Conflicts and how they were resolved

All conflicts were in Mission B's merge, in files Mission A had wrapped. A's pattern is `async function XPageContent(props)` plus a default-exported wrapper that renders `PageBackLink` first. B's changes (the `current` role object, `canDeleteDrafts`, `searchParams`, blank-post editors) were kept inside `XPageContent`; the wrapper forwards `props`.

| File | Resolution |
|---|---|
| `app/(app)/admin/resources/content/page.tsx`, `content/drafts/page.tsx` | B's `const current = await requireResourceAdminAccess()` and `canDeleteDrafts` inside A's wrapper. |
| `content/[id]/page.tsx` | B's `current` (delete button, linked-videos panel) inside A's wrapper. |
| `content/new/page.tsx`, `glossary/new/page.tsx`, `money-updates/new/page.tsx` | B's blank-post editors and `searchParams` type; wrapper forwards `props` (`Parameters<typeof XContent>[0]`). |
| `videos/[id]/edit/page.tsx` | Both imports kept (`PageBackLink` and `Link`: B's repair-form breadcrumb stays); B's repair form and linked-content panel inside A's wrapper. |
| `components/admin/ReferenceDataQualityClient.tsx` | **Real design conflict, decided here.** A wrote the header dates with `formatDateShort(.., 'INR')` (India: **dd-mm-yyyy**); B wrote them with its own time-zone-safe helpers (`formatDateDMY`, **dd/mm/yyyy**) and used the same helpers for every date on the page. Mixed formats on one page is worse than either, and the PO standing rule is India dd-mm-yyyy (A's documented decision for this page). Resolution: B's helpers kept (24-hour time, no timezone drift), their separator changed to `-` in one module (`pc6/referenceDataQualityView.ts`) and the three affected test files updated (`referenceDataQualityView`, `referenceDataQualityPanelsRender`, `mfnavApprovedFallbackRegister`: date literals only, behaviour unchanged). **If the PO wants dd/mm/yyyy on this page instead, it is a three-line change in that module; say so.** |

Auto-merged without conflict and checked by reading: `components/resources/editor/FormField.tsx` (`DateTextField`), `MetadataSidebar.tsx`, `MoneyUpdateEditor.tsx`, `VideoEditor.tsx` (A's `DateTextField` lines and B's no-autosave and delete both present), `lib/admin/adminNav.ts` (A's "Premium and Promo Codes" group and B's two Planning Benchmarks capability fields both present; `SourcePicker.tsx` has no overlap), `app/api/admin/me/route.ts`.

Added by hand after the merge:

* **`PageBackLink` on every page Mission B created or changed.** The only new page was `app/(app)/admin/benchmarks/upload/page.tsx` (parent `/admin/benchmarks`, "Back to Planning Benchmarks"), added in A's wrapper pattern, with its row in `docs/ux/BACK_NAVIGATION_INVENTORY.md` (now 123 pages, 113 with the link, 10 exempt). **Mission B's editor pages (finding F2)** all carry it through the pages: Article/Guide/Explainer `content/[id]/edit` and `content/new`, Money Update `money-updates/[id]/edit` and `new`, Glossary `[id]/edit` and `new`, Video `videos/[id]/edit` and `new`; the detail page `content/[id]`, `content`, `content/drafts`. `tests/unit/pageBackLinkGuard.test.ts` passes (17).
* **Date guard** (`dateFormatVisibleTextGuard`, 13 tests) failed once on B: `referenceDataQualityView.ts` calls `Intl.DateTimeFormat` to read year/month/day PARTS in a time zone and builds the text itself. Added to the guard's `ALLOWED_LOCALE_FILES` with the reason (same precedent as `lib/read-models/core/window.ts`). No `yyyy-mm-dd` text was found on any of B's new screens (Planning Benchmarks upload, video repair and link panels, combobox, Reference Data Quality).
* **Type errors** that neither branch saw because both ran only scoped type checks: `lib/planning-benchmarks/uploadService.ts` (regex `s` flag, tsconfig target ES2017: `next build` would have failed on it) and the same in A's `pageBackLinkGuard.test.ts`; five `AdminCapabilities` test fixtures in `adminAnalyticsPhaseA.test.ts` missing B's two new fields.
* **Lint**: `PlanningBenchmarkUpload.tsx` called `Date.now()` during render (now a lazy `useState`); `ensureSelfConcurrency.test.ts` `any` in a query-builder test double (eslint-disable with reason).
* **Tests that assumed the old tree**: `adminA02Wave5ResultStateAndHelp` (counts the Upload tab: 6 to 7 Help declarations) and `factsheetReaderMigration` ("0252 is the highest migration" can never survive any later migration; now "0252 exists, no sibling, everything after it is a higher number").
* Removed Mission A's stray, committed `tsconfig.tmpcheck.json` (a scoped type-check helper).

## 3. Migration ledger

On the integration tree: 223 migration files, one file per version, next free number 0277 (`npm run check:migrations`: OK).

| Number | File | Where | Status |
|---|---|---|---|
| 0236 | `owner_before_upload_phase1` | on `origin/main` | Applied on DEV (PO grids). **Production state not read here.** |
| **0275** | `planning_benchmark_staged_upload` | Mission B (this integration) | Not applied anywhere. Hand-over `docs/planning-benchmarks/po_apply_upload/`. |
| **0276** | `household_members_one_active_self` | owner branch `d20ffd9` (this integration) | Not applied anywhere. Hand-over `docs/ownership/po_apply_self_member_unique/`. Refuses to run while any user has two active self members. |
| 0260-0263 (applied on DEV), 0269-0271 | NAV2 | `feat/nav2-stage2-datefmt-20261005` | Unmerged. |
| 0264-0268 | promo hardening | `feat/promo-premium-hardening-20261005` | Unmerged. |
| 0272-0274 | Resources bulk import | `feature/resources-content-bulk-upload-20261006` | Unmerged. |

`check-migration-versions-against-branch.mjs` against `origin/main`, the bulk-upload branch, the promo-hardening branch and the NAV2 branch: **no collision with any**. No renumbering was needed. 0275 and 0276 drop and recreate no shared CHECK constraint (0275 adds two `admin_users` columns, three tables and functions; 0276 adds one partial unique index).

## 4. Verification

| Check | Result |
|---|---|
| `NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit` (whole project) | **One error, identical on a clean `origin/main`**: `tests/unit/canonicalCertResidueAllSql.test.ts(127,75)` (`s.preUpdates` is `unknown`). Zero errors from this work. (Run on the final tree after the 0276 merge.) |
| ESLint on the 275 changed ts/tsx files | Errors only in code this work did not change (`forecast/goals/page.tsx`, `profile/page.tsx` unescaped entities and `<a>`, `AppShell.tsx:143` set-state-in-effect, all present on `origin/main`); the two new-code errors found were fixed. |
| Guard tests: `pageBackLinkGuard` (17), `dateFormatVisibleTextGuard` (13) | Pass. |
| Changed-area suites | Pass: Resources F3/F11/F12, F3 cleanup SQL (PGlite), sidebar order and axe, `twinBenchmarkRetrievalFilter`, Planning Benchmarks upload (migration, routes 12, schema 14, UI, **PGlite 35 checks**), Reference Data Quality view/panels/mfnav, `pc6ReferenceMarketData`, `benchmarkDataUiLogic`, owner-before-upload suites incl. `ensureSelfConcurrency`, `selfMemberUnique`, `uploadFieldDispositionRegistry`, `g2AmountColumnAlignment`, `aie1MalwareScanSweepSchedulerPglite` (the owner branch's three repairs: all green on the merged tree). |
| **Production-style build** `npx next build` (Turbopack, Next 16.2.12) | **Compiled, TypeScript finished, 315 static pages, exit 0.** The `gaps/route.ts` type-validation failure the brief mentioned did not occur on Turbopack. Two environment notes: Turbopack refuses a `node_modules` junction that points outside the project, so I built with `turbopack.root` temporarily set to `D:/FHIP` (reverted; `next.config.mjs` is unchanged on the branch); and a build needs `NEXT_PUBLIC_SUPABASE_URL` / `..._ANON_KEY` to prerender `/forgot-password`, so placeholders were passed on the command line (no secret used). |
| Migration collision tooling | OK, see section 3. |
| `git checkout -- scripts/` after test runs | Done; `git status` clean. |

### Full suite (`vitest run --maxWorkers=3..4 --testTimeout=60000`, PGlite and repo-walking tests included)

| Tree | Files | Tests | Passed | Failed | Files that failed |
|---|---|---|---|---|---|
| Clean `origin/main` (`b105cf4`, own worktree, 4 workers) | 675 | 12,934 | 12,872 | 44 | 14 |
| Integration, run 1 (before the 0276 merge and the test fixes; 4 workers) | 694 | 12,504 | 12,432 | 29 | 28 |
| Integration, run 2 (final tree, 3 workers, a Turbopack build running at the same time) | 695 | 12,281 | 12,234 | 29 | 27 |

The integration totals are **lower** than the baseline only because, under load, 13 to 15 files fail to load at all (`ENOENT`/`EPERM` in Vite's temp `ssr` cache on Windows: their tests are not counted). Every one of them passes when run alone (`benchmarkData*` x 11, `factsheetReaderAdminRoutes`, `schemeMappingProposals`, `planningBenchmarkUploadRoutes`, `planningBenchmarkUploadSchemaValidation`, `heldSchemes`, `ownerBeforeUploadScripts`, `reportNavHistoryGateGenerate`, `fdh1Isolation`: 1,000+ tests). Also load-only, passing alone.

**Failures that remain on the final tree are exactly the baseline's own, with the same counts, each re-proven failing identically on the clean `origin/main` worktree:** `adminAnalyticsPhaseAMeRoute` (17), `aiResidualClosureFailClosed` (1), `countryGateAccessMatrix` MC-15 (1), `lr1UploadSecurityRawFileLifecycle` (1), `m12cServerOnlySecretBoundary` (1), plus the environment-only files `resourcesP0ContentR1_7C` (needs a file outside the repository), `resourcesImportR1_7LiveDev` and `resourcesP0ContentR1_7CLiveDev` (need `.env.local`), `resourcesR1_1` (live DEV).

**Failures on `origin/main` that the integration fixes (22 fewer):** `uploadFieldDispositionRegistry` (3) and `...AntiVacuity` (14), `g2AmountColumnAlignment` (1), `aie1MalwareScanSweepSchedulerPglite` (3), `statementResumeListAndApplyOnce` (1) (all from the owner branch).

**Regressions the merge itself caused, found by this run and fixed:** `adminA02Wave5ResultStateAndHelp` (Upload tab), `factsheetReaderMigration` (0252 "highest"), and the type errors of section 2. No other new failure.
## 5. What must be deployed together, and in what order

1. **One push carries everything** (the three branches are one deploy). The code is safe before any migration (section 6).
2. **The Twin read-path filter (U2) ships in the same deploy and must be live before the first Planning Benchmarks Activate.** The first Activate that supersedes a figure is what gives a live row an `effective_to`; without the filter the Twin would read the old figure. It is harmless before that (no row has `effective_to` today; the columns exist since migration 0011).
3. Apply **0275** only when the PO is ready to use the upload (DEV first, U7), then grant the two capabilities to different named people. Nothing in the app grants either.
4. **0276 is optional and independent**: the app works with or without it (without it, `ensureSelfHouseholdMember` settles on the oldest self row; with it, a duplicate insert is a 409 `self_member_exists`). Run its read-only detection query first.
5. **0236 must already be applied on production** for owner-before-upload (this is true of `origin/main` today, not new to this integration): this integration adds no new dependency on it beyond what `main` already has (the owner branch's code changes are the Self-member race guard, the saved owner review keeping its target signature, the 375 px row wrap, the right-aligned joint amounts, the field-disposition entries for the five 0236 columns).

## 6. Behaviour if deployed BEFORE migration 0275 (read-only code analysis; no production read)

**The code fails closed when the 0275 columns or tables are missing. Pushing before 0275 is safe.**

| Surface | Without 0275 | Evidence |
|---|---|---|
| `/api/admin/me` (drives the whole Admin nav for every admin) | The new capability read is its own try/catch; a missing column returns all-false for the two new capabilities. **Every other admin capability and the nav are unaffected** (this was the one place a missing column could have hidden the nav for everyone). | `readPlanningBenchmarkCapabilities` in `app/api/admin/me/route.ts`; the call is separate from the other reads. |
| Upload tab on `/admin/benchmarks` | Hidden (shown only when `planningBenchmarkUpload` or `planningBenchmarkActivate` is true, which is false). | `AdminBenchmarksClient.tsx` `showUploadTab`. |
| `/admin/benchmarks/upload` direct URL | Redirects to `/dashboard` (capability read fails or is false: never an empty page). | `requirePlanningBenchmarkPage`. |
| `/api/admin/benchmarks/upload` (GET list, POST stage, activate, discard) | 503 `DEPENDENCY_UNAVAILABLE` ("not installed on this database"), distinguishable from 403; never a grant, never an empty 200. If the guard somehow passed, the list read maps a missing table to `state: unavailable`; the RPCs map a missing function (`PGRST202`) to 503. | `guards.ts`, `upload/route.ts`; tests NC-R3 and the `mapRpcError` case in `planningBenchmarkUploadRoutes.test.ts`. |
| Twin benchmark read filter | Works: filters on `effective_to`, which exists since 0011. | `twinBenchmarkRetrieval.ts`. |
| F3 draft delete, F11 combobox, F12 video link and repair, F7/F8, Mission A | No migration dependency (existing tables, existing RLS, the free-text `resource_audit_log.action`). F12 uses the existing `resource_related_content` `related` type; the delete route relies on the existing "managers delete posts" policy. | Mission B report s2, s5, s6; `0049` audit table has no CHECK on `action`. |
| Owner fixes | No new schema dependency; 0276 handled both ways (section 5). | `ensureSelfMember.ts`, `selfMemberUnique.ts`. |

**Not verified:** nothing was executed against a database with the 0275 columns missing other than the unit and PGlite tests above; production schema was not read (the 0011 and 0049 assumptions follow from the migration ledger, which is the same lineage on every environment).

## 7. What the PO must do after deploy

1. (Optional, later) Apply **0275** on DEV, then production when ready, then **grant `can_upload_planning_benchmarks` and `can_activate_planning_benchmarks`** to different named people (U1). Until then the Upload tab is invisible to everyone.
2. (Optional) Run the 0276 detection query, merge or deactivate any duplicate self members by hand, then apply 0276.
3. Production cleanup of empty "Untitled" drafts: `docs/resources/po_apply_f3_cleanup/` (look first, then remove); DEV `--apply` of the 35 pristine drafts is the PO's call.
4. The 20 planned video scripts (VID-001 to VID-020) need their real YouTube URLs entered through the new repair form.
5. Walkthrough on DEV or after deploy, logged in: Back control on Resources editors after Save, Approve, View and the "Leave without saving?" prompt when dirty; Account / Profile first in the user sidebar; one "Premium and Promo Codes" Admin group; Event Date shows DD-MM-YYYY; Reference Data Quality "As at dd-mm-yyyy".
6. Owner-before-upload residue SQL for DEV (`PO_residue_liability_chains_DEV.sql`) is still the PO's step from the owner report.

## 8. Unverified or not done

* No logged-in browser verification of the **merged** tree (no dev server run; the three branches were each browser-verified on their own, A in an isolated harness). The merged editors (A's back link above B's editors) were checked by the guard tests and by reading, not by rendering.
* `tests/e2e/navigation.spec.ts` is stale on `origin/main` and needs DEV credentials: not run. Mission A's note about `role="menu"` semantics stands.
* Live-DEV vitest files (`resources*LiveDev`, `resourcesR1_1`, `resourcesDiscoveryR1_6LiveDev`) depend on DEV state or credentials and were not treated as signal; one of them attempted a DEV write during the full run and was refused by RLS (it needs a harness user).
* Planning Benchmarks upload is not DEV-verified (waits on 0275). `sheet`/`xlsx` end to end through the real database is PGlite only.
* Mission A's section 18 and Mission B's U1 to U7 are now PO-decided (section 9); the F5 DEV certification is still outstanding.

## 9. PO decisions of 07-10-2026 applied here ("go with your recommendations")

1. **Admin Standard section 18 ratified.** History row 1.1 now reads "Ratified by the Product Owner on 07-10-2026 (section 16.2)".
2. **Upload layout dropdown**: the visible ISO sample (`2024-01-31`) is removed; the plain-words label "Year first (year, month, day)" stays. The month-first option also lost its sample (`01/31/2024`), since the rule is that year-first and month-first text must not appear on screen; day-first samples stay. Searched the app for similar visible samples: none found (the only ISO examples left are in AI prompts, which no person reads). `benchmarkDataUiLogic.test.ts` now enforces it.
3. **Dates**: public and Admin Resources dates stay as Mission A made them (dd/mm/yyyy with the Australian fallback where no country is known, dd-mm-yyyy for India context). Recorded as PO-confirmed in `docs/ux/DATE_FORMAT_RULE.md`.
4. **Planning Benchmarks U1 to U7** accepted as recommended; `docs/planning-benchmarks/UPLOAD_DESIGN.md` section 12 now says "Decided by the PO 07-10-2026". Code checked against each: U3 (Activate also activates the dataset: RPC sets `data_status = 'active'`, PGlite-tested), U4 (day-first dates accepted in files, month-first and two-digit years refused, tested), U5 (an unrestated tier is end-dated, shown in the preview, counted as `bands_removed`, PGlite-tested), U1 (self-activation needs the recorded acknowledgement, enforced in the RPC), U2 (filter in the Twin path), U6 (no unique key in 0275). **No mismatch found; no code change was needed.**
5. **First-level Admin tools return to the Dashboard** (Admin has no home page; `/admin/resources/analytics` also returns to the Dashboard so an Analyst-only caller is not sent to a page they cannot enter). PO accepted.
