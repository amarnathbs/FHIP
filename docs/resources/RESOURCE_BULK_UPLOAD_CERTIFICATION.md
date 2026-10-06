# Resources Bulk Upload — Articles + Money Updates

## Final Completion Report (DEV certification)

### Overall Verdict

**RESOURCES BULK UPLOAD — ARTICLES + MONEY UPDATES — DEV CONDITIONAL PASS**

Every functional, security and workflow gate closed on real DEV. One gate is not closed to the spec's standard and is stated exactly rather than rounded up: **500-row files are marginal against the API's 8 second per-call limit.** Single 500-row applies are normally 3 to 5.7 s of database time and pass, but under DEV load (and when DEV already holds many rows) some single 500-row applies exceeded 8 s and were refused gracefully with nothing created; two simultaneous 500-row applies are 5.9 to 7.1 s each and sometimes both time out. P0 = 0. P1 = 1 (the 500-row cap, below). Open items are listed under "P0 / P1 Open". Production has NOT been touched, nothing is pushed or merged.

### Repository

| | |
|---|---|
| Starting origin/main | `b105cf48bcef8adb1e14d6f3c53ad3015c57e797` (latest migration `0252`, 221 migration files, working tree clean) |
| Branch | `feature/resources-content-bulk-upload-20261006` (worktree `agent-af2cbdf0503559424`) |
| Candidate SHA | see the last commit of the branch (`git log -1`); migrations `0272`, `0273`, `0274` |
| Merge SHA / final origin/main | not applicable (no merge, no push: out of scope for this task) |
| origin/main at the final re-check | still `b105cf4`; `0272` to `0274` unique on origin/main and on all 844 refs; another branch (`fix/po-review-resources-data-20261006`) holds `0275`; `0270`/`0271` NAV2; `0264`-`0268` promo; `0253` look-through. Re-check at merge (checker scripts cannot see unmerged branches) |

Commits: `0f1524b` DB layer (0272) · `c4c1524` framework + adapters · `1d47c2f` routes, UI, capability, Article source picker · `41fa5f6` docs + harness · `f9fd557` fixture fixes · `57b39a0` shared-ingest convention + 0273 · `145b311` 0274 · `f8bf884` graceful timeout, a11y, runbook · evidence commits `0e91f9b`, `ae8f2da`, `4e06405` and the final report commit.

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
| Concurrent apply of one run | PASS | DEV: 2, 3, 4 and 6 parallel applies of one 500-row run: exactly one effect (500 posts), the rest `alreadyApplied` (an earlier 6-parallel attempt timed out for all six under DB load: nothing created) |
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
| Formula cell (XLSX and `=`), `.xls .xlsm .ods .zip .pdf`, 10 MB+, 501 rows, zip bomb, lying header, DTD/XXE, path traversal, random and mangled files | refused with named codes, never an exception (unit-tested; formula, types, size, rows also DEV) |
| Service-role twin (0273): browser cannot call it or name an actor; database re-checks capability and uploader | PASS (PGlite with GRANT/ownership/capability negative controls; DEV 7/7 probes) |

Deliberate bounded deviation from Admin Standard section 6 (`auth.uid()` preference) is recorded with its compensating controls in `RESOURCE_BULK_UPLOAD_SECURITY.md`. Capability affected: `resources.content.bulk_import` (Super Admin, Resource Admin, Editor). Clauses applied: 2, 3, 4, 5, 6 (with the recorded deviation), 11, 13, 14. No other exception requested.

### Existing Feature Regression

PASS (DEV): manual Article, manual Money Update, Create Money Update from Template, manual Guide (opens in its editor), manual FHIP Explainer (opens), Money Update SourcePicker (create route rejects http; save persists the link), Resources public pages (200), `/api/admin/me` capability (editor and super admin true, author false). Unit: 15 existing Resources/admin suites green; the three fixtures I had to touch (two `admin/me` mocks, one factsheet "highest migration" assertion) pass again.

### Engineering

| Item | Result |
|---|---|
| Migration replay | PGlite: full 224-file ledger from empty, each migration in the suites: `resourcesBulkImportDb` 29, `AsActorDb` 12, `FasterApplyDb` 7 |
| Migration collision | `check-migration-versions-against-main`: none; 844 refs scanned: `0272`–`0274` unique |
| Editor-safety lint (NAV2 rule set) on 0272, 0273, 0274 and their parts | PASS (`resourcesBulkImportMigration`, 8) |
| `npx tsc --noEmit` | 0 errors |
| ESLint (whole repo) | 0 errors in any file I touched (repo has 102 pre-existing errors elsewhere); new scripts lint clean |
| My tests (sequential) | 295 / 295 across 12 files |
| Full canonical suite (final code) | 12,269 passed / 55 failed / 35 skipped (12,359). Baseline on exact `origin/main`: 12,881 / 48 / 10 (12,939). Failures are all pre-existing or environmental: **(a)** pre-existing on `origin/main` (reproduced): `adminAnalyticsPhaseAMeRoute` 17, `uploadFieldDispositionRegistry*` 17, `aie1MalwareScanSweepSchedulerPglite` 3, `statementResumeListAndApplyOnce`, `resourcesP0ContentR1_7C`, `m12cServerOnlySecretBoundary`, `lr1UploadSecurityRawFileLifecycle`, `g2AmountColumnAlignment`, `countryGateAccessMatrix`, `aiResidualClosureFailClosed`, live-DEV resource suites; **(b)** a vitest temp-cache race (`ENOENT ... Temp\<id>\ssr\<hash>` while loading the shared `xlsxReader.ts`) that fails whole files that import it when many run in parallel: reproduced on exact `origin/main` with the benchmark group alone (10 files fail there too); every such file passes alone, and all 12 of mine pass sequentially; **(c)** 5 s timeouts under load (`m12bInsuranceAccuracyCorpus`, live-DEV suites). `git checkout -- scripts/` run afterwards |
| `next build` | webpack compile PASS (4.4 min). Next's post-compile route type check then fails on **pre-existing** `app/api/admin/recommendations/gaps/route.ts` (exports a non-route constant; file identical to `origin/main`). Turbopack cannot run in a worktree with the shared `node_modules` junction, so the build was run with `--webpack`. Not a bulk-upload issue; production's own build must be the judge |
| Client bundle scan (`.next/static`, 644 files) | 0 hits: no secrets (4 secret values checked), no local paths, no fixtures, no production ref, no SheetJS or zlib |

### DEV

Project `vqycarelcoijzwlpkpcz` only (production variables were removed from my env copy). Migrations applied by the PO and verified behaviourally by me: `0272` (20/20 probes), `0273` (7/7), `0274` (5 live checks).

| Run | Result |
|---|---|
| HTTP live certification, final code | **167 / 168**; the one failure is the 500-row Money Update apply hitting the time limit (graceful path verified), see below |
| Browser certification (Playwright + axe) | **48 / 48**: chooser, Article and Money Update uploaders, sheet picker, preview (clean and invalid), expandable rows by keyboard (`aria-expanded`), confirmation dialog (exact wording, focus on the safe button, Escape cancels), result screen, history, contextual buttons, denied role redirect; **no horizontal page scroll at 390, 768, 1024, 1440**; automated axe (WCAG 2.0/2.1 A+AA): no serious or critical violations on chooser, uploader, sheet picker, preview (expanded row), invalid preview, result, history, and the SourcePicker added to the Article editor. Axe is automated only (about a third of issues): a manual screen-reader pass is still owed. Screens in `docs/resources/browser_evidence/` |
| Scale 1 / 50 / 100 / 500 (both adapters) | upload and apply pass at 1, 50, 100; upload database round trips constant (9 to 10 queries to 100 rows, 18 at 500 because rows are staged in 50-row chunks); response sizes: upload 245–255 bytes, preview 1.5 KB (1 row) to 396 KB (500 rows), apply 143 B to 19.6 KB. 500-row timing below |
| Residue | `resources_bulk_upload_residue_check_dev.ts`: synthetic posts, sources, categories, tags, authors, CTAs, import runs, import rows, audit rows and auth users **all 0** (also checked inside each harness run) |

**500-row timing on DEV after 0274** (database time = `dbMs` returned by the core; 5 runs per type, posts deleted between runs):

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

1. **Per-file cap of 500 rows is marginal on DEV and unproven on production.** Decision (PO via coordinator): `IMPORT_LIMITS.maxRows` stays **500** (one constant: parser, template notes, upload label). My recommendation is **250** (expected about 3.3 s worst concurrent). Before real bulk files are used, the PO must prove production with synthetic data (500-row Article and Money Update uploads, apply, read `dbMs`, delete the drafts); **if production worst-case `dbMs` exceeds about 6 s set the cap to 250**. Production has the same 8 s limit and a different data volume.

### Items needing the Product Owner

1. Decide the cap after the production synthetic proof (above); 250 is the safe default.
2. Production database steps (not run by me): `0272`, `0273`, `0274` in order, each with its README in `docs/resources/po_apply_bulk_upload*/`; then the production synthetic verification (one clearly synthetic Article, one Money Update, never the real India update; template download, upload, preview, apply, open in the editor, public-hidden proof, cleanup).
3. Written PO confirmation of the deliberate section 6 deviation (twin function) for the certification record; the coordinator relayed his choice.
4. Manual screen-reader pass (axe is automated only).
5. The real India inflation workbook was not available and was **not imported**: all evidence uses synthetic files generated from the templates. The PO uploads his real file himself after production proof (he chooses the sheet).

### Merge notes (for the coordinator)

New routes: `/admin/resources/import` (+ `/upload`, `/runs/[id]`, `/history`), APIs under `/api/admin/resources/import/**` (templates, inspect, runs, runs/[id], rows, results, apply), nav group "Bulk Upload", capability field `resourceContentBulkImport`. Existing files touched: `ResourceContentListClient` (optional `canBulkImport` header link "Upload Articles"), `MoneyUpdateListClient` ("Upload Updates", "Download Template"), `ResourceEditor` + content edit page + content `[id]` PATCH route (SourcePicker, sources saved only when `sourceIds` is sent), Money Update edit page (source options), `lib/admin/adminNav.ts`, `permissions.ts`, `/api/admin/me`, `lib/resources/sources/queries.ts`; tests: `adminAnalyticsPhaseA` fixtures, two `admin/me` mocks, one factsheet assertion. New pages carry breadcrumbs, not a back link (add the shared PageBackLink on merge). Migration number `0275` is held by another branch: mine are `0272`–`0274`.

### Final Verdict

**RESOURCES BULK UPLOAD — ARTICLES + MONEY UPDATES — DEV CONDITIONAL PASS** (every gate closed except the 500-row limit above; no P0).

### Next Action

STOP, WAIT FOR PRODUCT OWNER DIRECTION.
