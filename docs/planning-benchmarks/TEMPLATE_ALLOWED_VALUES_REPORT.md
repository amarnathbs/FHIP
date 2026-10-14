# Planning Benchmarks upload: allowed values on the templates and the screen

Prepared 07/10/2026 on branch `fix/pb-template-allowed-values-20261007`, based on integration tip `7054e36`. Not pushed. Migration 0275 is untouched (no migration in this work).

## 1. The request

PO, verbatim: "read me tab should show all the 12 parameters or any other number currently developed and available which is allowed to upload from this module, so that there is no error uploading the wrong data to the parameter." Added scope from the coordinator: the Upload tab panel also carries the column guide (Column, Required, Type, Description).

## 2. The number (from the code and the database, not from memory)

DEV (`vqycarelcoijzwlpkpcz`), read 06/10/2026 UTC (07/10/2026 local):

| List | Count | Direct read of the table | Match |
|---|---|---|---|
| Datasets registered | 12 | 12 | yes |
| Datasets closed to upload (suspended, archived, superseded) | 1 (AU household debt context, superseded) | 1 | yes |
| **Datasets open for upload today** | **11** (10 active, 1 draft: India household consumption expenditure) | 11 | yes |
| Metrics registered | 67 | 67 | yes |
| Cohorts | 39 | 39 | yes |

So the PO's "about 12" is 12 registered datasets, of which 11 can receive an upload. The Read me heading in the produced file reads "11 datasets are open for upload today".

## 3. What "open for upload" means (derived from migration 0275, not guessed)

- A dataset is named by `dataset_name` plus `dataset_version`, exact and case-sensitive.
- `stage_planning_benchmark_upload` refuses a dataset whose status is suspended, archived or superseded. Every other status can receive a staged file. The constant `CLOSED_DATASET_STATUSES` (uploadSchema.ts) is pinned to the migration text by a test.
- **Finding for the PO:** the database does not tie a dataset to one kind of file. Any open dataset accepts observed values, planning target ranges and cohorts at staging. Only two conditions differ by kind, and the lists print them: a target-range file must cite, in `source_name`, the dataset's own source (the RPC refuses otherwise); and an observed or regulatory dataset that holds no figure yet can only be activated by an observed values file (`pb_dataset_readiness`). I did not invent a class-to-kind rule. If the PO wants one (for example target ranges only into `fhip_planning` datasets), that is a decision and a small migration, not part of this change.
- A metric is accepted when registered. Any registered metric may be used with any open dataset: the database has no metric-to-dataset rule. A value must carry the metric's own unit; band bounds are in the metric's unit (the target-range file has no unit column, which the Read me now says). `statistic_type` is one closed list for every metric (not constrained per metric).
- A `cohort_code` in a values file must be registered, or blank for country-wide.

## 4. What changed

Commit `ddfdd14` (code and tests); this report and the DEV samples are in the following commit.

| Area | Change |
|---|---|
| `lib/planning-benchmarks/allowedValues.ts` (new) | One module: reads the reference tables read-only under the caller's session (datasets, sources, metrics, cohorts, bands, value dataset ids), each with an explicit bound; derives the lists, per-kind acceptance, counts, live band tiers/household types per metric; "did you mean" matching; the printable sections. Failed read or throwing client gives `unavailable`; a list cut by its bound is flagged incomplete. |
| `uploadTemplates.ts` | XLSX "Read me" gets, below the column table, headed lists: datasets (name, version, class, evidence level, status, source, source status, figures held today, acceptance per kind), metrics (code, name, unit, direction, category, status, live band tiers, household types, countries), cohorts, household types / life stages / countries already in live bands, and the closed lists (statistics, units, booleans, tiers, directions, evidence levels). A top line states "N datasets are open for upload today". Unavailable database gives one clear line and the download still works. The Data sheet is unchanged byte for byte. New `buildAllowedValuesCsv`. |
| `uploadSchema.ts` | `CLOSED_DATASET_STATUSES`, boolean words, and `columnGuide(kind)` (moved `typeWords` here) so the Read me column table and the panel print one source. |
| `uploadValidate.ts` | New `allowed` context. Refuses: dataset not registered (names the open datasets, hint, wrong-version case), dataset not open, unlisted metric (names or hints), unlisted cohort, target-range `source_name` that is not the dataset's source. Warns: inactive metric, household type or life stage no live band uses. Unit message now names the unit to use. A problem shared by many rows is reported once; every such row is still refused. A hint never changes the file. |
| `uploadService.ts` | Builds the validation context from `loadAllowedValues` (same lists as the Read me); an unreadable list stages nothing (fail closed). Replaces its own metric read. |
| `app/api/admin/benchmarks/upload/templates/[kind]/route.ts` | XLSX download loads the live lists (CSV template stays header and examples only). |
| `app/api/admin/benchmarks/upload/allowed-values/route.ts` (new) | `GET ?format=json` for the panel, `?format=csv` for the companion download. Same `view` capability, no-store, nosniff. |
| `components/admin/PlanningBenchmarkAllowedValues.tsx` (new), `PlanningBenchmarkUpload.tsx` | "Allowed values (CSV)" link next to the template links, and a collapsible panel with three parts: 1 Columns (kind selector, Column / Required / Type / Description), 2 Allowed datasets and metrics (with counts in headings), 3 Cohorts. Captioned tables, column-scoped headers, named focusable scroll regions, loading / failed / unavailable states. |

## 5. Admin Architecture Standard

- Capabilities affected: none new. The new route and the existing template route use the existing `view` capability (`can_upload_planning_benchmarks` or `can_activate_planning_benchmarks`). No migration, no RPC.
- Clauses: s2 and s4 (capability enforced at API before any read; panel only inside the gated Upload tab; DB layer is the world-readable reference tables, RLS `using (true)`, read under the caller's own session, service-role client not imported); s8 and s13 (failed read is explicit `unavailable`, never an empty list; stage fails closed); s9 (global reference data only); s11 (server-side generation, formula-neutralised cells, non-identifying names, no-store, authorised on the request); s14 (nothing outside the Upload area touched).
- Tests proving each: `planningBenchmarkAllowedValuesRoutes.test.ts` (NC-L1 admin without capability 403, NC-L2 401 and not-admin 403, NC-L3 unreadable database still downloads and says so, no service-role import), `planningBenchmarkAllowedValues.test.ts` (NC-A5 formula neutralising), existing `planningBenchmarkUploadRoutes.test.ts` (static no service-role check still passes).
- Exceptions requested: none.

## 6. Tests

New: 49 tests in 4 files plus one fixture, all passing.

| File | Tests | Covers |
|---|---|---|
| `planningBenchmarkAllowedValues.test.ts` | 18 | lists derived from fake DB, counts, open/closed pinned to migration, XLSX Read me content for every kind (counts, names, units, cohorts, closed lists, Data sheet unchanged), moving count when a dataset is added (NC-A1), unavailable path (NC-A2), bound cut (NC-A4), formula neutralising (NC-A5), CSV companion, **drift guard (NC-A3)**: static source check plus behavioural proof that every listed dataset/metric/unit/cohort is accepted by the validator and unlisted ones are refused |
| `planningBenchmarkWrongParameterValidation.test.ts` | 15 | dataset unknown / wrong version / closed / repeated, metric, unit, cohort, source, household type, incomplete lists |
| `planningBenchmarkAllowedValuesUi.test.ts` | 7 | panel content and counts, accessibility structure, unavailable state (NC-P1), collapsed start and loading state, CSV link placement, no year-first text, **column guide = Read me column table = panel (drift guard)** |
| `planningBenchmarkAllowedValuesRoutes.test.ts` | 9 | route authorisation, JSON and CSV, unreadable database, template route Read me |

Failing-first: with the base `uploadValidate.ts` restored temporarily, 11 of the 14 validation tests then in the file failed (all the NEW ones: unknown dataset, wrong version, closed dataset, once-per-problem, metric hints, inactive metric, unit wording, unknown cohort, source mismatch, household warning), and 3 passed (an open dataset, a blank or registered cohort, and the incomplete-list case, which are non-refusal behaviours). Behaviour that already existed (unknown metric refused with row number, unit mismatch refused with row number) is covered by an added pure CONTROL test that passes before and after. The template and panel tests could not run on the base because the modules they test did not exist.

Regression: the 3 existing upload test files (31 tests), migration, PGlite (35), date-format guards, admin matrix tests all pass. One unrelated pre-existing failure in `countryGateAccessMatrix.test.ts` (it finds the existing `app/api/admin/account-deletions/[id]/execute/route.ts`); not touched by this work. A first parallel run showed a transient vitest temp-file ENOENT; re-run in smaller groups passed. `scripts/` artefacts were restored with `git checkout -- scripts/` after each run. Typecheck (`NODE_OPTIONS=--max-old-space-size=8192 tsc --noEmit`) shows no error in any changed file; eslint on the changed folders shows one pre-existing warning.

## 7. DEV verification (read-only)

Script `scripts/planning-benchmarks/devAllowedValuesSample.ts` verifies the host is `vqycarelcoijzwlpkpcz`, reads with the public anon key (the tables are world-readable), generates the files with the same functions the routes call, reads the produced XLSX back with an independent reader, and compares to direct count reads (table above: all match). No write, no secret stored. Produced files (from DEV, no secrets) are in `docs/planning-benchmarks/sample_downloads/`: `DEV_planning_benchmarks_values_template.xlsx`, `..._target_ranges_template.xlsx`, `..._cohorts_template.xlsx`, `DEV_planning_benchmarks_allowed_values.csv`.

## 8. Unverified

- The route itself was not called on DEV with a logged-in fixture admin (no credentials used); the route is covered by tests against an in-memory fake and the lists by the real loader against DEV with the anon key. The panel was not opened in a browser (no jsdom in the repo; server render only).
- Excel and LibreOffice rendering of the longer Read me sheet (column widths) was not looked at; the content was read back programmatically.
- A pre-existing observation, not changed: the database does not restrict which metrics a dataset may hold or which kind of file a dataset takes (section 3). Recommended PO decision.
- Not done by design: no nearest-match auto-correction; country codes in band files are still checked only by the database.
