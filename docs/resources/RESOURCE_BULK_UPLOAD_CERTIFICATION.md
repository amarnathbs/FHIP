# Resources Bulk Upload — Articles + Money Updates

## Re-certification on current main (15-10-2026)

### Overall verdict

**RESOURCES BULK UPLOAD — ARTICLES + MONEY UPDATES — DEV CONDITIONAL PASS, re-certified on the rebased build.** Both types pass every functional, security and workflow gate on real DEV and on real-browser automation, and the production hand-over is prepared and PGlite-proven. It is **not** FULL PASS because the following have no real evidence yet: (1) **no production proof**: production has never been touched, the 250-row limit is DEV-proven only, and the 8 second per-call ceiling was exceeded once on DEV during a DEV latency episode (graceful refusal, nothing created; see "DEV" below); (2) **the human screen-reader and visual pass** (the browser leg is real headless Chromium plus axe, which finds roughly a third of accessibility problems); (3) the two raw tables are not yet the shared `DataTable` (that component is not on `main` yet, see "Merge notes"). P0 = 0. P1 = 0. Nothing is pushed or merged by me. Evidence labels below: UNIT-TESTED, PGLITE-VERIFIED, DEV-verified, BROWSER-verified (automated), UNVERIFIED. Nothing here is PRODUCTION-VERIFIED and nothing is deployed.

### Repository

| | |
|---|---|
| Starting point | branch `feature/resources-content-bulk-upload-20261006` tip `27376ae` (07-10-2026), based on `b105cf48`, 90 commits behind `origin/main` |
| `origin/main` integrated | `af2d330` (14-10-2026, latest migration `0280`, 232 migration files). Re-fetched at the end: unchanged |
| This branch | `feat/resources-bulk-upload-rebased-20261014` (merge, not rebase, nothing force-pushed). Merge commit `893a9cc` |
| Commits on top of main | `893a9cc` merge, `5dd3111` PageBackLink on the four new pages, `0694c45` production pack and harness helpers, `25a7735` reversible profile borrow, `a2a0f93` harness create-contract fix, `fe20c0b` evidence, then the documentation commit(s) that carry this report (see `git log`) |
| Product code changed by the rebase work | four pages (shared back link) and nothing else; every other code change is a re-application of the branch's own work onto main's newer files (below) |

### Merge conflicts, resolved deliberately (7), nothing of main rolled back

| File | Resolution |
|---|---|
| `app/(app)/admin/resources/content/page.tsx` | main's `PageBackLink` wrapper and `canDeleteDrafts` kept, `canBulkImport` added |
| `app/(app)/admin/resources/content/[id]/edit/page.tsx` | main's wrapper, back link, `LinkedVideosPanel` and `canDelete` kept; `sourceOptions` and `initialSourceIds` added for the Article SourcePicker |
| `components/resources/admin/ResourceContentListClient.tsx` | both props: `canDeleteDrafts` (main) and `canBulkImport` |
| `components/resources/editor/ResourceEditor.tsx` | **took main's version** (explicit Save and no autosave, create on first Save, ref-held version token, delete draft) and re-applied only the SourcePicker: optional `sourceOptions`/`initialSourceIds`, `sourceIds` sent on save only when the picker is enabled (a save that omits `sourceIds` still never clears sources), and a new-record editor never sends them |
| `lib/resources/permissions.ts` | both `canDeleteDraftResource` (main) and `canBulkImportResources` (branch) |
| `tests/unit/adminAnalyticsPhaseA.test.ts` | main's capability fixtures with `resourceContentBulkImport: false` re-added to each of the five |
| `tests/unit/factsheetReaderMigration.test.ts` | main's version (equivalent assertion) |

Auto-merged without conflict and re-verified: `app/api/admin/me/route.ts`, `lib/admin/adminNav.ts`, the content `[id]` PATCH route (still writes sources only when `sourceIds` is sent), both money-update pages, the two promo/premium test mocks.

**Admin Standard §18 (new on main, v1.1): every page carries the shared `PageBackLink`.** The merge made `tests/unit/pageBackLinkGuard.test.ts` red for `/admin/resources/import`, `/upload`, `/history` and `/runs/[id]`. Fixed: each page is wrapped like the existing pages (parent Resources for the chooser, Bulk Upload for the other three) and `docs/ux/BACK_NAVIGATION_INVENTORY.md` lists them (127 pages). Guard 17/17.

### Migrations

| Check | Result |
|---|---|
| `0272`, `0273`, `0274` unique | every local and remote branch ref (`git log --all`) and the working directory of every worktree plus the main checkout scanned: `0272`-`0274` exist only on this work; `0269`-`0271` NAV2 (`feat/nav2-release-candidate-20261014` etc., not on main); `0264`-`0268` and `0275`-`0280` are on main; `0253`/`0260`-`0263` are not mine. `integration/module11-0-to-11-7-20261014` carries no migration beyond main. **No renumbering needed, no reference changed.** The numbers sit between `0268` and `0275` on main: harmless, because production migrations are hand-applied and these three are independent of `0275`-`0280` (none of those touches a Resources table; checked by diff) |
| `npm run check:migrations` | OK: 235 active migrations, one file per version, next version `0281` |
| `npm run check:migrations:against-main` | OK: no cross-branch collisions between HEAD (235) and `origin/main` (232) |
| Full ledger replay (PGlite, 235 files) | `resourcesBulkImportDb` 29, `AsActorDb` 12, `FasterApplyDb` 7, plus the new production pack suite 23: all pass on the merged ledger. PGLITE-VERIFIED |
| Editor-safety lint | the three migrations, their parts and **every SQL file of the production pack** (test `PACK-3`, with a negative control that the lint really bites) |

### Validation on the rebased tree

| Gate | Result |
|---|---|
| `tsc --noEmit` | 0 errors (whole project including tests and scripts; machine needs a 6 GB heap and takes about 8 minutes) |
| ESLint on every changed or new file (pages, components, lib, API routes, scripts, tests) | 0 errors, 0 warnings |
| Bulk import suites (12 files), sequential | **296 / 296** on the merged tree (unchanged count: the rebase added no behaviour) |
| Production pack suite `resourcesBulkImportProductionPack` (new) | **23 / 23** (PGlite on the ledger without 0272-0274: precheck, the three migrations with a check after each, backup, synthetic apply through the real functions, cleanup, three named negative controls on the cleanup, stop switch with the negative control that a single revoke does not stop the twin, restore, full rollback and re-apply) |
| `pageBackLinkGuard` | 17 / 17 |
| Full unit suite (one run, whole machine under heavy load from other agents) | 14,205 passed / 50 failed / 5 skipped (14,260). Of the 25 failing files: **17 fail identically on a clean checkout of exact `origin/main` `af2d330`** (reproduced there: `adminAnalyticsPhaseAMeRoute` 17 tests, `m12cServerOnlySecretBoundary` (Amplify forward list), `countryGateAccessMatrix` MC-15, `aieInsuranceIntakeRouteRegistersAdapter`, `aieOwnerBeforeUploadRoutes`, `aiResidualClosureFailClosed`, `fdh1Isolation`, `fdh11Isolation`, `iiNetWorthNavRemarkPublishFlow`, `lr1UploadSecurityRawFileLifecycle`, `m12cPasswordLimiterAndDocumentIdentity`, `ownerBeforeUploadScripts`, `paymentsCheckoutRoute`, `r7LargeFile`, `reportNavHistoryGateGenerate`, `resourcesR1_1`, `m12aFdhBankAccuracyCorpus`, and `resourcesP0ContentR1_7C`, which needs a content JSON that exists only in the main checkout: environmental); **8 other files failed only in the loaded full run and pass when re-run alone with a 120 s timeout** (`aiContextualExplainUiContract`, `benchmarkDataFormContract`, `canonical0207SchemaContract`, `dateFormatsDayFirstSourceContract`, `iiInvestmentDatesRouteImmediateFetch`, `lr3ExpensesBankImportWiringFix`, `paymentWebhookRoutes`, and `countryGateAccessMatrix` MC-16 in the file whose MC-15 is pre-existing); **0 failures are attributable to this work.** Honest limit: the baseline was run only on the 25 files that failed (42 failed / 294 passed there, same machine, same load), not as a second full-suite run. `git checkout -- scripts/` run afterwards |
| `next build` (production, Turbopack as Amplify runs it) | **PASS**: compiled in 84 s, TypeScript 2.5 min, 315 static pages generated; the four import pages and the seven import API routes are in the build manifest. A worktree cannot resolve the shared `node_modules` for Turbopack, so the build ran with a TEMPORARY `turbopack.root` line in `next.config.mjs` that was reverted and is not committed. The webpack variant (`--webpack`) compiles in 7.5 min and then fails Next's route type check on `app/api/admin/recommendations/gaps/route.ts` (exports a non-route constant): that file is byte-identical to `origin/main`, pre-existing, and not part of the Amplify build path. Client bundle scan (`.next/static`, 668 files): 0 hits (no secret values, no local paths, no fixtures, no production ref, no SheetJS or zlib) |

### DEV (project `vqycarelcoijzwlpkpcz` only; production variables were removed from the environment copy used)

**Inventory first (read-only, `scripts/resources_bulk_upload_dev_inventory.ts`):** `0272` present (both staging tables, anon refused `42501` on apply, lookup and purge, RLS on the staging tables); `0273` present (the server-only twin answers the service role with `NOT_AUTHENTICATED` for a null actor, refuses anon with `42501`); `0274` present (PostgREST cannot read `pg_catalog`, so it was proven behaviourally by the timing phase: `db_ms` returned, no per-post version rows, server-assigned post ids; the PO's one catalog query in `po_apply_bulk_upload_0274/README.md` remains the catalog-level proof). All tables the rebased tree uses exist. **Nothing is missing on DEV for this feature; no SQL needs applying on DEV.** Zero synthetic residue before the run.

**Fixture users:** the earlier harnesses created users with passwords; that is no longer allowed. This run used **existing fixture users only** (reserved test domains; never the Product Owner's own account; no password typed, asked for or printed; nine fixtures: Super Admin, Resource Admin, two Editors, Author, Compliance Reviewer, Publisher, Analyst, plain customer). Sessions were minted without a password through a one-time magic-link token (nothing e-mailed). **No existing role fixture passes the mandatory country gate** (every one is unconfirmed), so the helper reversibly borrows the three gate columns of the profile of the nine fixtures (snapshot written first, original values written back and re-read; **8 profiles were borrowed and 8 verified restored, 0 left different**). No user was created or deleted.

| Run | Result |
|---|---|
| HTTP live certification, rebased build | **167 / 167** (`..._DEV_EVIDENCE_bulkrecertmv85prro.json`): four template downloads (headers equal the parser schema, Lookup_Values live), Article and Money Update XLSX and CSV round trips, finished body to `content_blocks`, normal-editor edit saved and persisted, SourcePicker add/remove/persist and a save that omits `sourceIds` never clears them, forced draft/private/not indexable, public hidden **with positive control**, GREEN and AMBER workflow (author cannot publish, editor cannot approve AMBER, publisher publishes GREEN), invalid files refused with named codes and zero writes, create-only, same file twice `FILE_ALREADY_APPLIED`, **6 parallel applies of one run: one effect, 0 duplicates**, **stale preview `STALE_PREVIEW`, no partial write**, atomic apply, **cross-actor denial** (404 read/rows/results, 403 apply), **36 route-by-role denials** (anonymous 401; customer, analyst, publisher, compliance reviewer, author 403), database bypass (author, other editor, anonymous calling the apply RPC directly) denied, **`status`, `visibility`, `published_at`, `approved_by` column injection refused for the whole file (`FORBIDDEN_COLUMN`) with 0 created**, formula cells, `.xls .xlsm .ods .zip .pdf`, 10 MB+, 251 rows, scale 1/50/100/250 for both types with constant upload round trips (no N+1), all manual regressions (Article, Guide, FHIP Explainer, Money Update, Template, Create-from-Template, Money Update SourcePicker, public pages). Zero residue afterwards |
| Earlier run of the same build | 163 / 167 (`..._bulkrecertmv855x15.json`): the four failures were all the harness's manual-create regression calling the create routes without a title, which main's explicit-Save change (PO review F3) now refuses with 422. The harness was updated to send a title; no product change |
| Timing phase at 250 rows, quiet database | **34 / 34** (`..._bulkrecertmv86lcw6.json`): Article database time 1.8 / 2.0 / 2.1 s (min / median / max), Money Update 1.5 / 1.6 / 2.8 s; two concurrent 250-row runs: Article 3.2 s and 3.5 s, Money Update 2.7 s and 2.9 s (all applied). Same as the 07-10-2026 measurements |
| Timing phase during a DEV latency episode | 27 / 34 (`..._bulkrecertmv865h3l.json`): while the DEV database was visibly slow (a plain count query took 7 to 12 seconds, then returned to 0.2 s; other agents were also running live-DEV suites), 250-row applies exceeded the API's 8 second ceiling: **the graceful path fired exactly as designed** (HTTP 503, "Nothing was created. This file is too large to apply in one go right now...", run stays `ready`, no rows, retry safe; one upload also failed under the stall, so the harness got a 404 for a run that did not exist). The same run applied a Money Update at 7.7 s. **This is the honest limit of the design: 250 rows leaves headroom on a quiet database but not under heavy contention, and production performance is unknown.** Hence the production capacity proof is mandatory before real files, and lowering the limit is a one-constant change (`IMPORT_LIMITS.maxRows`) |
| Residue | `resources_bulk_upload_residue_check_dev.ts`: import runs 0, import rows 0, synthetic posts, sources, categories, tags, authors, CTAs, audit and workflow rows, created users: all 0. The cleanup is keyed on the run tag and on rows created by the nine fixtures inside the run's time window; nothing the fixtures owned before is touched |

### Real-browser leg (was it completed? yes, automated; the human pass is still owed)

The earlier 48/48 browser certification ran on the pre-rebase build, so it was **re-run on the rebased build**: Playwright with headless Chromium plus axe (WCAG 2.0/2.1 A and AA), signed in as the existing Editor and Author fixtures (cookie from the password-less session), against the rebased dev server on DEV. **52 / 52** (`..._BROWSER_EVIDENCE_bulkbrwmv86vmti.json`; a first attempt, 19 / 20, stopped on a Next dev-server cold-compile error "Unexpected end of JSON input" and was re-run once warm; kept as `..._bulkbrwmv86prle.json`): chooser, both uploaders, sheet picker, preview (clean and with errors), expandable rows by keyboard (`aria-expanded`), confirmation dialog (exact wording, focus on the safe button, Escape cancels), result screens, history (`Date, File, Type, Actor, Rows, Result, Status`), contextual buttons on All Content and Money Updates, an Author redirected away from the import page; **no horizontal page scroll at 390, 768, 1024 and 1440 px**; axe: no serious or critical violation on every screen; file input programmatic label; **the new shared back link on the chooser, uploader, preview and history ("Back to Resources" / "Back to Bulk Upload") points at the parent and takes keyboard focus**. Screens refreshed in `docs/resources/browser_evidence/` (the phone-width chooser and preview show the back link, 15/10/2026 day-first dates, and the Next dev indicator bubble, which exists only in dev). **Left for the Product Owner's own browser pass (a human, on production or DEV):** a screen reader walk-through (NVDA or VoiceOver) of the upload, preview, confirmation and result screens; a visual check on a real phone; and the print/zoom check at 200 percent. Automated axe cannot replace these.

### Defects and findings of this work

1. **Missing shared back link on four pages** (Admin Standard §18, new on main): guard test red after the merge. Fixed (`5dd3111`).
2. **The runbook's "immediate stop" did not stop anything.** It named `revoke execute ... apply_resource_content_import from authenticated`, but the application calls the server-only twin `apply_resource_content_import_as_actor` first (0273), so uploads would keep applying. Corrected in the runbook; the pack has `R2_disable_apply_only.sql` (revokes both) and `R3`; the PGlite negative control PACK-DB14 shows the single revoke leaves the twin working.
3. Harness drift (not a product defect): manual-create regression vs main's F3 contract; and no existing role fixture passes the country gate (reversible borrow, above).
4. Pre-existing on `main`, not mine and not fixed (Admin Standard §14): the failing suites listed above (notably `adminAnalyticsPhaseAMeRoute`, 17 tests, because main's `/api/admin/me` now reads `admin_users` nine times per request); `tests/unit/countryGateAccessMatrix` MC-15.
5. The 8 second ceiling can be exceeded by a 250-row apply when the database stalls (graceful, nothing created). Production unproven.

### Production hand-over (prepared, NOT executed; I have no production access)

`docs/resources/po_apply_bulk_upload_production/` (README is the one page to read): read-only precheck `P0` (lineage by object, 26 columns the apply writes, the unique keys it relies on, the two role helper functions, the role model and who would receive the Bulk Upload menu entry, sizes, category slugs), the three migrations in order with a check after each (`P1`, `P2`, `P3`), a **proof that the migrations are additive** (new objects only; one foreign key on the new table; `resource_posts` column, constraint and policy counts equal before and after, asserted in PGlite), the **manual backup** of the six tables the synthetic upload writes to (`B1`, in the unexposed `private` schema with RLS on and every API privilege revoked, `B2` check, `B3` drop), the synthetic files (one Article row and one Money Update row, every marker `zz-bulkverify` / `ZZ BULKVERIFY` / `ZZ_BULKVERIFY`) and a click-by-click verification including the public-hidden proof (page, listing, search, sitemap), exact cleanup (`C1` preview, `C2` all-or-nothing with named refusals, `C3` zero-residue), the stop switch and rollback (`R1` to `R4`). All of it PGlite-verified; **UNVERIFIED on production** (production's own data, size, speed). The real India inflation workbook is never part of it.

### Merge notes

- **Global table component.** The brief said main holds the new `DataTable` / `ClampText`; on `af2d330` it does not: they live on `feat/global-table-layout-20261008` (not merged). This branch has **two raw `<table>`s** (`components/resources/import/ImportHistoryTable.tsx` and the row table in `ImportPreview.tsx`, both horizontally scrollable inside their own region, no page scroll at 390 px). That branch's `tests/unit/dataTableGuard.test.ts` fails on any raw `<table>` outside its allow-list, so **whichever of the two branches merges second must convert these two tables to `DataTable` (or allow-list them with a reason)**. I did not touch that branch.
- **Navigation grouping.** Admin Standard §18's grouping sentence ("entries that belong together share one group") is satisfied by one destination; the "Bulk Upload" group is its own because its capability is its own (`resources.content.bulk_import`), unchanged from the PO-reviewed design.
- **Pre-existing red tests on main** listed above are not touched (Standard §14).

### Next action for the Product Owner

See the final report of this task: apply nothing on DEV (nothing is missing); review and merge when ready; then the production steps in the pack, in the order of its README.

## Earlier report (07-10-2026, before the rebase; kept as the record of that certification)

### Overall Verdict

**RESOURCES BULK UPLOAD — ARTICLES + MONEY UPDATES — DEV CONDITIONAL PASS**

Every functional, security and workflow gate closed on real DEV, including the per-file limit. **Update 07-10-2026 (PO: "go with your recommendations"): the per-file limit is now 250 rows** (the single constant `IMPORT_LIMITS.maxRows`). 500-row files had been found marginal against the API's 8 second per-call limit: single 500-row applies took 3 to 5.7 s of database time and mostly passed, but under DEV load some exceeded 8 s and were refused gracefully with nothing created, and two simultaneous 500-row applies took 5.9 to 7.1 s each and sometimes both timed out. At 250 rows the worst single apply measured 2.1 s and the worst of two simultaneous applies 3.3 s of database time (about half of the 6 second line). The verdict stays CONDITIONAL because the limit is only **proven on DEV**: production has the same 8 second ceiling but a different data volume and must be proven with synthetic data under PO control before real files are used (and before the cap may be raised to 500). P0 = 0. P1 = 0. Open conditions are listed under "Open conditions". Production has NOT been touched, nothing is pushed or merged.

### Repository

| | |
|---|---|
| Starting origin/main | `b105cf48bcef8adb1e14d6f3c53ad3015c57e797` (latest migration `0252`, 221 migration files, working tree clean) |
| Branch | `feature/resources-content-bulk-upload-20261006` (worktree `agent-af2cbdf0503559424`) |
| Candidate SHA | see the last commit of the branch (`git log -1`); migrations `0272`, `0273`, `0274` |
| Merge SHA / final origin/main | not applicable (no merge, no push: out of scope for this task) |
| origin/main at the final re-check | still `b105cf4`; `0272` to `0274` unique on origin/main and on all 844 refs; another branch (`fix/po-review-resources-data-20261006`) holds `0275`; `0270`/`0271` NAV2; `0264`-`0268` promo; `0253` look-through. Re-check at merge (checker scripts cannot see unmerged branches) |

Commits: `0f1524b` DB layer (0272) · `c4c1524` framework + adapters · `1d47c2f` routes, UI, capability, Article source picker · `41fa5f6` docs + harness · `f9fd557` fixture fixes · `57b39a0` shared-ingest convention + 0273 · `145b311` 0274 · `f8bf884` graceful timeout, a11y, runbook · evidence commits `0e91f9b`, `ae8f2da`, `4e06405` · `937e1f0` first report · and the 250-row cap commit (the last commit on the branch).

### Shared Import Framework

| Item | Result | Evidence |
|---|---|---|
| CSV + XLSX parsing | PASS | unit-tested (CSV/XLSX parity), DEV round trips |
| One engine, two adapters | PASS | `lib/resources/import/{types,common-schema,file-security,parser,markup,validation,staging,results-csv,template-generator,adapters}.ts` + `article/` + `money-update/` (`schema,validation,mapper,template`) |
| Four template downloads | PASS | DEV-verified (4 files, headers equal the parser schema; XLSX has Instructions / upload sheet / Lookup_Values with live reference data / Example) |
| Template/parser drift impossible | PASS | one schema; drift tests; generated spec docs checked against the schema (`resourcesBulkImportDocs`) |
| Established ingest convention (PO decision) | PASS | operator **chooses the sheet** (inspect route + picker, any sheet name works, preselected template sheet); other sheets and hidden rows disclosed; delimiter auto-detect; header-only CSV; the shared inspector is used **unchanged** (generated templates are sanitised of the unused `.bin` default instead of a local override) |
| Server-side staging, preview ≠ apply authority | PASS | DEV-verified: browser can only send a run id; staging tables have no API write grant |
| Atomic apply (all or none) | PASS | PGlite (late rollback incl. new sources) + DEV |
| Duplicate protection (create-only, same file twice) | PASS | DEV: `FILE_ALREADY_APPLIED`, 0 additional posts; DB partial unique index |
| Concurrent apply of one run | PASS | DEV: 2, 3, 4 and 6 parallel applies of one 500-row run (while 500 was the limit): exactly one effect (500 posts), the rest `alreadyApplied` (an earlier 6-parallel attempt timed out for all six under DB load: nothing created); the final cert (167/167) re-proves it with 6 parallel applies of one 50-row run: one effect, 0 duplicates |
| Stale preview | PASS | DEV + PGlite: `STALE_PREVIEW`, no partial write, run marked stale |
| Import history + audit | PASS | DEV: history lists both types; per-post audit (`created_via=bulk_import`, run id, row, external id) and per-run audit |
| Graceful timeout | PASS | live DEV: plain message "Nothing was created. This file is too large to apply in one go right now. Split it into smaller files or try again.", HTTP 503, run stays `ready`, retry safe, elapsed time logged; unit-tested |

### Article Upload

All PASS (DEV-verified unless noted): XLSX and CSV template download and round trip; finished body to `content_blocks` (callout, 3 key takeaways, 3 H2 incl. financial-health section, 1 H3, paragraphs, bullet and numbered lists, example); normal editor opens it, a paragraph edit saves and persists after reload; source add / remove / reload persistence through the **new Article SourcePicker** (a save that omits `sourceIds` never clears sources); category, tags, author, CTA resolved, SEO blank (fallback applies); preview renders (no escaped JSON, no duplicate block); **public hidden** while draft (URL 404, listing, search, sitemap, direct table read) **with a positive control** (after real publication the URL serves); workflow GREEN draft to published, AMBER needs the compliance reviewer, RED publication blocked; author gate retained. Invalid files (missing title, missing excerpt, empty body, invalid jurisdiction, invalid compliance, unknown category, unsupported markup, bad https source, unknown author, ambiguous author, existing slug): Apply refused, canonical writes 0.

### Money Update Upload

All PASS (DEV-verified): XLSX and CSV round trips; five sections map to the same headings the manual starter uses; event date, affected audience, review date, jurisdiction, compliance, category, source; forced `time_sensitive` / draft / private / not indexable; opens in the normal Money Update editor; public hidden; invalid files (future event date, missing review and expiry, no source, blank section, invalid jurisdiction, unknown category, insecure source): Apply refused, writes 0.

### Security

| Check | Result |
|---|---|
| Anonymous (401), customer, analyst, publisher, compliance reviewer, author: DENIED on every import route (6 routes × 6 callers, 36 live checks), and on the template download for the 5 excluded callers | DENIED (DEV) |
| Pages for those roles redirect, never render | PASS (DEV HTTP + browser) |
| Cross-actor: another editor cannot read (404), download results (404), see rows (404) or apply (403) someone's run; a resource admin can read for history but cannot apply | PASS (DEV) |
| Database bypass: author / other editor / anonymous calling the apply RPC directly; editor inserting or marking a run applied; author reading the staging table | DENIED (DEV) |
| Workflow-state and publish injection: `status`, `visibility`, `content_type`, `published_at`, `approved_by` columns | whole file refused `FORBIDDEN_COLUMN`, 0 created (DEV); staged-value injection ignored (PGlite negative controls) |
| Formula cell (XLSX and `=`), `.xls .xlsm .ods .zip .pdf`, 10 MB+, 251 rows (the limit is 250), zip bomb, lying header, DTD/XXE, path traversal, random and mangled files | refused with named codes, never an exception (unit-tested; formula, types, size, rows also DEV) |
| Service-role twin (0273): browser cannot call it or name an actor; database re-checks capability and uploader | PASS (PGlite with GRANT/ownership/capability negative controls; DEV 7/7 probes) |

Deliberate bounded deviation from Admin Standard section 6 (`auth.uid()` preference), **ACCEPTED by the Product Owner** (decision "A", 06-10-2026, relayed through the orchestrator, reaffirmed 07-10-2026), is recorded with its compensating controls in `RESOURCE_BULK_UPLOAD_SECURITY.md`. Capability affected: `resources.content.bulk_import` (Super Admin, Resource Admin, Editor). Clauses applied: 2, 3, 4, 5, 6 (with the recorded deviation), 11, 13, 14. No other exception requested.

### Existing Feature Regression

PASS (DEV): manual Article, manual Money Update, Create Money Update from Template, manual Guide (opens in its editor), manual FHIP Explainer (opens), Money Update SourcePicker (create route rejects http; save persists the link), Resources public pages (200), `/api/admin/me` capability (editor and super admin true, author false). Unit: 15 existing Resources/admin suites green; the three fixtures I had to touch (two `admin/me` mocks, one factsheet "highest migration" assertion) pass again.

### Engineering

| Item | Result |
|---|---|
| Migration replay | PGlite: full 224-file ledger from empty, each migration in the suites: `resourcesBulkImportDb` 29, `AsActorDb` 12, `FasterApplyDb` 7 |
| Migration collision | `check-migration-versions-against-main`: none; 844 refs scanned: `0272`–`0274` unique |
| Editor-safety lint (NAV2 rule set) on 0272, 0273, 0274 and their parts | PASS (`resourcesBulkImportMigration`, 8) |
| `npx tsc --noEmit` | 0 errors in source after the 250-row change (needs a larger Node heap on this machine; the only messages left are in the stale generated `.next/types` of the earlier build, for routes this work does not touch) |
| ESLint (whole repo) | 0 errors in any file I touched (repo has 102 pre-existing errors elsewhere); new scripts lint clean |
| My tests (sequential) | **after the 250-row change: 296 / 296 across 12 files** (10 `resourcesBulkImport*` files 253 incl. the new limit test, plus `resourcesArticleImport` and `resourcesMoneyUpdateImport` 43). Parser, security and docs suites assert 250 accepted and 251 refused (`TOO_MANY_ROWS`), the template notes, both generated template documents and the upload label all read the one constant, and the generated documents were regenerated (drift test green). One earlier batch run showed a single repo-walking assertion in the Routes file failing under machine load; it passes alone (126/126) and in the clean full rerun |
| Full canonical suite (final code) | 12,269 passed / 55 failed / 35 skipped (12,359). Baseline on exact `origin/main`: 12,881 / 48 / 10 (12,939). Failures are all pre-existing or environmental: **(a)** pre-existing on `origin/main` (reproduced): `adminAnalyticsPhaseAMeRoute` 17, `uploadFieldDispositionRegistry*` 17, `aie1MalwareScanSweepSchedulerPglite` 3, `statementResumeListAndApplyOnce`, `resourcesP0ContentR1_7C`, `m12cServerOnlySecretBoundary`, `lr1UploadSecurityRawFileLifecycle`, `g2AmountColumnAlignment`, `countryGateAccessMatrix`, `aiResidualClosureFailClosed`, live-DEV resource suites; **(b)** a vitest temp-cache race (`ENOENT ... Temp\<id>\ssr\<hash>` while loading the shared `xlsxReader.ts`) that fails whole files that import it when many run in parallel: reproduced on exact `origin/main` with the benchmark group alone (10 files fail there too); every such file passes alone, and all 12 of mine pass sequentially; **(c)** 5 s timeouts under load (`m12bInsuranceAccuracyCorpus`, live-DEV suites). `git checkout -- scripts/` run afterwards |
| `next build` | webpack compile PASS (4.4 min). Next's post-compile route type check then fails on **pre-existing** `app/api/admin/recommendations/gaps/route.ts` (exports a non-route constant; file identical to `origin/main`). Turbopack cannot run in a worktree with the shared `node_modules` junction, so the build was run with `--webpack`. Not a bulk-upload issue; production's own build must be the judge |
| Client bundle scan (`.next/static`, 644 files) | 0 hits: no secrets (4 secret values checked), no local paths, no fixtures, no production ref, no SheetJS or zlib |

### DEV

Project `vqycarelcoijzwlpkpcz` only (production variables were removed from my env copy). Migrations applied by the PO and verified behaviourally by me: `0272` (20/20 probes), `0273` (7/7), `0274` (5 live checks).

| Run | Result |
|---|---|
| HTTP live certification at the 250-row limit (07-10-2026) | **167 / 167** (`RESOURCE_BULK_UPLOAD_DEV_EVIDENCE_bulkcertmux6xvov.json`): includes 251 rows refused (`TOO_MANY_ROWS`), 250-row Article and Money Update upload plus apply, scale 1 / 50 / 100 / 250, no N+1, zero residue. Two preceding runs of this same code scored 166/167: the public-page positive control saw a 404 for about 2 s after publication because this machine's clock runs about 2 s behind the database's (the page hides a post whose published time is in the app clock's future). Measured, a harness timing issue, not a product defect: the harness now polls up to 10 s |
| HTTP live certification at the earlier 500-row limit (history) | 167 / 168, the one failure being the 500-row Money Update apply hitting the time limit (graceful path verified); evidence file `..._bulkcertmuwpuh2p.json` / `ae8f2da` |
| Browser certification (Playwright + axe) | **48 / 48**: chooser, Article and Money Update uploaders, sheet picker, preview (clean and invalid), expandable rows by keyboard (`aria-expanded`), confirmation dialog (exact wording, focus on the safe button, Escape cancels), result screen, history, contextual buttons, denied role redirect; **no horizontal page scroll at 390, 768, 1024, 1440**; automated axe (WCAG 2.0/2.1 A+AA): no serious or critical violations on chooser, uploader, sheet picker, preview (expanded row), invalid preview, result, history, and the SourcePicker added to the Article editor. Axe is automated only (about a third of issues): a manual screen-reader pass is still owed. Screens in `docs/resources/browser_evidence/` |
| Scale 1 / 50 / 100 / 250 (both adapters) | upload and apply pass at every size at the 250 limit; upload database round trips constant with row count (rows staged in 50-row chunks). Earlier 500-row scale (while 500 was the limit): response sizes upload 245–255 bytes, preview 1.5 KB (1 row) to 396 KB (500 rows), apply 143 B to 19.6 KB. Timing below |
| Residue | `resources_bulk_upload_residue_check_dev.ts`: synthetic posts, sources, categories, tags, authors, CTAs, import runs, import rows, audit rows and auth users **all 0** (also checked inside each harness run) |

**250-row timing on DEV after 0274, the chosen limit (07-10-2026)** (database time = `dbMs`; 5 runs per type, posts deleted between runs; evidence `RESOURCE_BULK_UPLOAD_DEV_EVIDENCE_bulkcertmux5udmu.json`):

| | min | median | max |
|---|---|---|---|
| Article, single, 250 rows | 1.62 s | 1.78 s | 2.13 s |
| Money Update, single, 250 rows | 1.52 s | 1.60 s | 1.72 s |
| Article, two concurrent runs of different run ids | 3.26 s and 3.28 s (both applied) | | |
| Money Update, two concurrent runs of different run ids | 3.08 s and 3.05 s (both applied) | | |

One Article run had a 12.7 s client response time with only 1.8 s of database time (a client or network stall, not the database). Worst case at 250 rows is about half of the 6 second line. This is DEV only; production is unproven.

**500-row timing on DEV after 0274, kept for the record** (the limit before this change; database time = `dbMs` returned by the core; 5 runs per type, posts deleted between runs):

| | min | median | max | client time |
|---|---|---|---|---|
| Article, single (run A) | 3.43 s | 3.49 s | 4.64 s | 4.6–9.8 s (round-trip noise) |
| Article, single (run B, 4 ok + 1 timeout) | 3.23 s | 3.80 s | 4.94 s | one apply exceeded 8 s and was refused gracefully |
| Money Update, single (run A) | 2.86 s | 3.03 s | 3.24 s | 4.2–4.9 s |
| Money Update, single (run B / earlier run) | 3.01 s | 3.08 s | 4.09 s (one 5.7 s) | 4.2–7.3 s |
| Two concurrent runs, different run ids | Article 6.5 s and 6.5 s (run A), 7.1 s and 6.8 s (run B), once both refused at the limit; Money Update 5.9 s / 5.8 s and 6.9 s / 6.8 s | | | |
| Before 0274 | 5.3 s to over 8 s alone; 57014 on concurrent | | | |

Cause and design findings: the API login role (`authenticator`: `statement_timeout=8s`, `lock_timeout=8s`) bounds every API call including the service role's. The apply is one transaction (all-or-none); the app has no direct database connection (only the API), so a chunked-but-atomic apply is **not possible**. 0273 (server-only twin) therefore does not remove the limit; 0274 (lighter core) is what brings 500 rows to about 3 to 5 s. Variation with DEV load and table size is large: in three full certification runs the 500-row Money Update apply (executed after about 1,500 other synthetic posts had accumulated) timed out twice and succeeded once; every timeout left zero rows and the run retryable.

### P0 Open

None.

### P1 Open

None. The former P1 (500-row cap marginal against the 8 second limit) is resolved on DEV: **cap 250 chosen** (PO, 07-10-2026, on my recommendation), implemented as the single constant `IMPORT_LIMITS.maxRows`, measured at 1.5 to 2.1 s single and about 3.3 s worst concurrent. **500 is pending the production proof** (below) and is NOT the current limit.

### Open conditions

1. Production proof with synthetic data under PO control (250-row Article and Money Update uploads, apply, read `dbMs`, delete the drafts). Only if production worst-case `dbMs` for **500-row** files, single and two at once, stays under about 6 s may the PO raise `IMPORT_LIMITS.maxRows` to 500 (change the one constant, regenerate the two template documents, update the tests that assert 250, re-prove). If production at 250 already exceeds about 6 s, lower it.
2. Manual screen-reader pass (axe is automated only). The browser certification (48/48) ran while the limit was 500 and has not been re-run: the only screen text that changed is the limit number in the upload file label, which is covered by a unit test that it reads the constant.

### Items needing the Product Owner

1. Run the production synthetic proof (open condition 1). The cap is 250 until that proof shows 500 is safe on production.
2. Production database steps (not run by me): `0272`, `0273`, `0274` in order, each with its README in `docs/resources/po_apply_bulk_upload*/`; then the production synthetic verification (one clearly synthetic Article, one Money Update, never the real India update; template download, upload, preview, apply, open in the editor, public-hidden proof, cleanup).
3. Section 6 deviation (twin function, migration 0273): **ACCEPTED by the Product Owner** as a bounded deviation from Admin Standard section 6 (decision "A", 06-10-2026, relayed through the orchestrator, reaffirmed 07-10-2026). Recorded in `RESOURCE_BULK_UPLOAD_SECURITY.md`. Nothing further needed from the PO for this item.
4. Manual screen-reader pass (axe is automated only).
5. The real India inflation workbook was not available and was **not imported**: all evidence uses synthetic files generated from the templates. The PO uploads his real file himself after production proof (he chooses the sheet).

### Merge notes (for the coordinator)

New routes: `/admin/resources/import` (+ `/upload`, `/runs/[id]`, `/history`), APIs under `/api/admin/resources/import/**` (templates, inspect, runs, runs/[id], rows, results, apply), nav group "Bulk Upload", capability field `resourceContentBulkImport`. Existing files touched: `ResourceContentListClient` (optional `canBulkImport` header link "Upload Articles"), `MoneyUpdateListClient` ("Upload Updates", "Download Template"), `ResourceEditor` + content edit page + content `[id]` PATCH route (SourcePicker, sources saved only when `sourceIds` is sent), Money Update edit page (source options), `lib/admin/adminNav.ts`, `permissions.ts`, `/api/admin/me`, `lib/resources/sources/queries.ts`; tests: `adminAnalyticsPhaseA` fixtures, two `admin/me` mocks, one factsheet assertion. New pages carry breadcrumbs, not a back link (add the shared PageBackLink on merge). Migration number `0275` is held by another branch: mine are `0272`–`0274`.

### Final Verdict

**RESOURCES BULK UPLOAD — ARTICLES + MONEY UPDATES — DEV CONDITIONAL PASS** (P0 = 0, P1 = 0; per-file limit 250 rows, DEV-proven; open conditions: production synthetic proof, which also decides any later raise to 500, and a manual screen-reader pass).

### Next Action

STOP, WAIT FOR PRODUCT OWNER DIRECTION.
