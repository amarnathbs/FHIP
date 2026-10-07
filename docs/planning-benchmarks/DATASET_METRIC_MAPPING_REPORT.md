# Planning Benchmarks: dataset to metric mapping - report

Prepared 07/10/2026 on branch `feat/pb-dataset-metric-mapping-20261007`, based on `52253bb` (integration `7054e36` plus the allowed-values work). **Not pushed. DEV only. Nothing applied anywhere: migration `0277` is written and PGlite-proven, and waits for the Product Owner** (`po_apply_mapping/README.md`). Admin Architecture Standard and `AGENTS.md` were read in full first.

## 1. Finding closed

The database did not tie a dataset to a metric set or a file kind: any open dataset accepted any registered metric (67 metrics, 12 datasets, 11 open). Now a row of an observed values file or a planning target ranges file is refused unless its metric is mapped to its dataset for that kind of file, in the preview check, at staging and again at activation. Design and trade-offs: `UPLOAD_DESIGN.md` section 14.

## 2. Commits

| SHA | Content |
|---|---|
| `88a07af` | migration 0277 (+ parts, rollback), seed document, validator, allowed-metrics lists, maintenance route and section, first tests |
| `c639907` | remaining tests (validator, route and screen, hand-over query check), `UPLOAD_DESIGN.md` section 14, hand-over README, this report |

(`git log feat/pb-dataset-metric-mapping-20261007` is authoritative.)

## 3. What was built

| Area | Change |
|---|---|
| Migration `0277` (number verified free across every ref in `git log --all` and every worktree; known neighbours: 0264-0268 promo, 0272-0274 bulk upload, 0275 and 0276 integration) | forward-only, additive, idempotent, editor-safe, in three parts. Tables `benchmark_dataset_metrics` (RLS read like the other reference tables, no API write grant) and `benchmark_dataset_metric_events` (append-only). Trigger refusing an unmapped staged row (`PB_E_MAPPING`). Stricter `pb_dataset_readiness` (the activate re-check). Two maintenance functions needing the existing activate capability. Seed of 71 pairs, run only while the table is empty. |
| `allowedValues.ts` | loads the mapping (a missing table is "not installed", any other failure is "unavailable"); per dataset mapped metrics with live figure counts; the one `datasetMetricsSection` source for the Read me sheet, the CSV and the panel; the dataset table now shows a dataset with nothing mapped as not accepting that kind. |
| `uploadValidate.ts` | `METRIC_NOT_MAPPED` (names the allowed metrics with units, says where the metric is mapped if elsewhere, "did you mean" over allowed metrics only, never auto-corrects, once per problem) and the fallback warning `MAPPING_NOT_INSTALLED`. |
| Routes | new `GET`/`POST /api/admin/benchmarks/upload/dataset-metrics`; the preview route reports the mapping state; the error table maps `PB_E_MAPPING` (422) and `PB_E_LIVE` (409). |
| Screen | "Dataset metric mapping" section (read for all tab viewers; add, change, remove for an activate holder, reason and confirmation required, stronger warning when live figures exist); allowed metrics per dataset in the Allowed values panel; stage warnings and a preview banner. |
| Hand-over | `po_apply_mapping/` (README, parts a, b, c, rollback). |

## 4. Fallback when the mapping is not installed (chosen and why)

Chosen: **previous behaviour plus a visible warning**, not fail closed. Failing closed would block every upload on any database that has `0275` but not `0277` (production today) because of deploy order. The database layers (trigger, stricter readiness) do not exist until `0277` either, so app and database agree. The warning appears after staging, in the preview, on the Read me sheet, the CSV and the panel. A real read failure of the table is not "not installed": it is `unavailable` and staging fails closed. An installed but empty table fails closed (nothing mapped, nothing may be uploaded).

## 5. The mapping (full table with evidence: `DATASET_METRIC_MAPPING.md`)

71 pairs, 11 datasets (derived from DEV reads on 07/10/2026 with the public anon key, the first-load files and the schema map; units checked against the metric catalogue).

| Dataset | Pairs | Kind | Metrics |
|---|---|---|---|
| FHIP dependant-band household benchmark model | 11 | values | discretionary_expense_ratio, emergency_fund_months, essential_expense_ratio, expense_growth_12m, fixed_commitment_ratio, housing_cost_ratio, income_interruption_coverage, monthly_surplus, savings_rate, surplus_margin, total_expense_ratio |
| AU household asset composition | 2 | values | property_concentration, total_assets |
| AU household wealth distribution | 1 | values | net_worth |
| AU net worth and income by age band | 2 | values | gross_household_income, net_worth |
| AU high-DTI mortgage threshold | 1 | values | debt_to_income |
| AU average superannuation balance | 1 | values | retirement_balance |
| AU household debt context (superseded, closed) | 1 | values | debt_to_asset_ratio |
| India household assets and debt (rural/urban) | 2 | values | total_assets, debt_to_asset_ratio |
| India EPF/EPS contribution structure | 1 | values | retirement_contribution_rate |
| FHIP Planning Benchmarks v1.0 | 48 | target ranges | the 48 metrics of the draft band set (list in the document) |
| AU ASFA retirement standard | 1 | target ranges | retirement_balance |
| India household consumption expenditure (rural/urban) | 0 | none | needs PO input |

Counts: 71 pairs = 11 + 2 + 1 + 2 + 1 + 1 + 1 + 2 + 1 + 48 + 1. Observed values pairs 22, target ranges pairs 49 (no pair carries both). 12 of the 67 registered metrics are mapped to no dataset (listed in the document).

## 6. Needs Product Owner input (not guessed, not seeded)

1. **India household consumption expenditure (rural/urban)**: no registered metric can hold per-person monthly consumption (schema map P4). Nothing seeded; uploads to it are refused with a message saying none is mapped.
2. **`liquid_asset_share` in India household assets and debt**: DEV holds 2 live seed values, but the PO-approved first-load register refused the pairing. The sources disagree, so it is not seeded; a refreshed upload of it is refused until you decide.
3. `debt_to_asset_ratio` in AU household debt context is seeded on register evidence, but the dataset is superseded (closed) anyway.
4. Other asset-share metrics for AU household asset composition (refused by the register), `debt_to_income` / `debt_service_ratio` for debt context (different definitions): not seeded.
5. The two FHIP planning datasets are mapped for one kind each (the kind DEV holds); add the other kind on the screen if wanted.
6. The FHIP dependant-band model's 198 live seed values are called "draft, methodology not defined" by the register; the mapping follows what DEV holds. Approval of those figures is a separate decision.
7. 12 metrics have no dataset: `cross_border_retirement_coverage`, `currency_concentration`, `debt_at_retirement`, `geographic_diversification`, `income_growth_12m`, `liquid_net_worth`, `net_household_income`, `net_worth_to_income`, `premium_burden`, `priority_alignment`, `retirement_balance_to_income`, `retirement_funding_gap`.

## 7. Admin Architecture Standard

- **Capabilities affected:** none new. Writes use the existing `can_activate_planning_benchmarks` (route and database function); reads use `view` (upload or activate). Upload-only is refused on every write.
- **Clauses and proof:** s2/s4 capability at DB and API, direct-API and database-bypass tests (`NC-R1`, `NC-R2`, PGlite capability test, `NC-MAP4`); s5 separation (upload cannot change the mapping); s8/s13 not installed is 503 and `unavailable`, never an empty list, unexpected reply is not success (route tests); s9 no actor identifier in what the screen receives (route test); s11 not applicable (no new export; the existing CSV and XLSX pass the formula neutraliser); s14 no new capability, no shared privilege, nothing outside the Upload area; s15 audit row per change, rollback script, operating instructions in the hand-over.
- **Exceptions requested:** none.

## 8. Tests

New: 12 (migration text and seed equals document) + 22 (PGlite, full ledger replay) + 17 (validator, lists, fallback, drift guard) + 17 (route and screen) = **68 new tests**, all passing. Existing tests changed only where the new rule changes their premise: the PGlite 0275 suite maps its invented datasets (`mapTestDatasets`, 35 of 35 still pass), the shared fixture gained a mapping table, three allowed-values tests were narrowed to mapped pairs, the panel test counts one more table.

Named negative controls that demonstrably go red: `NC-MAP1` (trigger disabled), `NC-MAP2` (trigger always allows), `NC-MAP3` (readiness rule removed, the unmapped batch activates), `NC-MAP4` (capability check removed, an uploader changes the mapping), `NC-MAP5` (live-figure guard removed), `NC-S2` (the document comparison bites), `NC-M2` (the lint bites), `NC-V1` to `NC-V3`, `NC-R1` to `NC-R4`.

**Failing first:** with the base `uploadValidate.ts` restored, 9 of the 17 validator tests failed (every one marked NEW that depends on the rule or the fallback), 8 passed (controls). The database tests fail by construction on a ledger without `0277` (the migration file does not exist).

Regression: PGlite 0275 suite 35/35; the 3 existing upload test files and the allowed-values files pass; date-format guards, back-link guard, admin capability matrix and first-load tests pass. One unrelated pre-existing failure in `countryGateAccessMatrix.test.ts` (MC-15, the existing account-deletion route), unchanged. Vitest sometimes reports a transient temp-file `ENOENT` when many files run at once; every file was re-run in groups of at most three and passed. `scripts/` was restored with `git checkout -- scripts/`. Typecheck (`NODE_OPTIONS=--max-old-space-size=8192 tsc --noEmit`): no error in any changed file; one pre-existing error in `tests/unit/canonicalCertResidueAllSql.test.ts`. eslint on the changed folders: one pre-existing warning.

## 9. Unverified

- Not applied on DEV or production, so no DEV evidence yet (the planned next step after the PO runs the SQL: seed count 71, a real refusal and acceptance through the route with a fixture admin, the screen in a browser).
- The new section and the panel were server-rendered in tests only (no jsdom); not opened in a browser. Excel and LibreOffice rendering of the longer Read me sheet was not looked at.
- Seed names were checked against the DEV dataset names and against the migration ledger replay (71 rows seeded), not against production: if production dataset names differ, fewer rows seed there and the README check query shows it.
- The live-figure count for target range pairs counts live bands of the metric citing the dataset's source or no source (bands have no dataset column); this is a rule of my choosing, stated in design section 14.6.
- The production Twin read path was not touched.

---

## 10. Follow-up 07/10/2026: walkthrough findings D1, D2, D3 and the combined production hand-over

Source: `WALKTHROUGH_REPORT_07-10-2026.md` of branch `walkthrough/integration-20261007`. Nothing pushed.

### D1 (medium): a values upload preview said "Bands removed 4" - fixed by migration 0278

- **Cause confirmed.** `pb_removed_band_ids` (0275) matched staged rows to live bands by metric, country, life stage and household type and never looked at the kind of file. A values row has a metric and no tier, so it matched legacy bands with empty attributes and "removed" them. It is the only function that produces the number: the staged counts, the preview list, the batch digest and the `bands_removed` of the activation result all read it. `pb_classify_rows` does not count bands. Activation itself only retires bands for a target ranges batch, so no band was ever wrongly retired; the preview and the stored counts were wrong.
- **Fix.** Migration `0278_planning_benchmark_removed_bands_target_ranges_only.sql` (number verified free on `origin/main`, every ref in `git log --all` and every worktree; `0276` is the latest on main) re-emits that one function with a condition that the batch is a target ranges batch, so a values or cohorts batch returns an empty set. Additive, idempotent, editor-safe, one statement (no parts needed), no EXECUTE for API roles. It does **not** touch `pb_dataset_readiness` (0277) or any other object.
- **Effect on staged batches.** A values batch staged before 0278 holds the false count and a digest that contained the false list; Activate recomputes the digest and refuses it as stale. The person discards it and stages the file again. Proven by `NC-B3`.
- **Proof (PGlite, full ledger 0001 to 0278)** `tests/unit/planningBenchmarkRemovedBandsPglite.test.ts`, 10 tests: a values batch over live bands (four live bands including a legacy one, the DEV shape) reports 0 in the counts, the preview list, the function and the activation result, and leaves every band alone; a target ranges batch with a missing tier still reports exactly that tier, and activation end-dates exactly the previewed band plus the changed tier; a first load and a cohorts batch report 0. Failing first: `NC-B1` runs the same assertion against the 0275 function and goes red (counts.removed is above 0). `NC-B2` removes the new condition and goes red. `NC-B3` stale refusal. `NC-B4` the production check query detects an unapplied 0278.

### Production hand-over v2

`docs/planning-benchmarks/po_apply_upload_PRODUCTION_v2/` (README, the three migrations byte-identical, the 0275 and 0277 parts, two rollback scripts). Order 0275, 0277, 0278, then the permissions; before the first Activate; undo in reverse order; marks the earlier 0275-only production README as superseded. `tests/unit/planningBenchmarkProductionHandoverV2.test.ts` proves the byte identity, the part joins, the order and the lint; the README check queries are executed on PGlite and return the promised values. The re-run order issue is documented in the README and in the 0277 README: re-running 0275 puts back both old functions, so run 0277 and 0278 again after any re-run of 0275.

### D2 (low): Money Update template select widened the page at 390 px

Cherry-picked cleanly from the walkthrough branch: `0e4f07e` (failing test) and `17e128e` (fix `min-w-0` and test regex correction). The test passes (3 of 3).

### D3 (low): "Save failed" and the "updated elsewhere" dialog when editing during the second request of the first Save

- **Cause (found, confirmed by reading the code).** After the first Save creates the record (POST) the editor immediately sends the rest of the form (PATCH): that second request is by design (create on first Save, decision F3), not a duplicate. The optimistic-concurrency token `updated_at` was React state. A Save requested while another is in flight is queued and, when the first finishes, run from `doSaveRef.current`, the callback of the last rendered closure. The response handler calls the state setter and, in `finally` and in the same tick, starts the queued save before React has re-rendered, so the queued save sent the token from before the response. The API compared it with the new `updated_at` and answered 409, which the editor shows as "Save failed" plus "updated elsewhere". Waiting lets the render happen first, hence "Saved". It affects any edit made while a save is in flight, and is longest on the first Save because it is two requests.
- **Fix (small, safe).** The token is a ref (`lastUpdatedAtRef`) that every response handler writes synchronously (create, save and workflow transition) and the save reads at send time. Applied to the four editors that share the pattern: Glossary, Article/Guide/Explainer (`ResourceEditor`), Money Update, Video. The FAQ editor has no queued save and was not changed. The token was not rendered anywhere, so nothing else moved. No API change.
- **Proof.** `tests/unit/resourcesEditorVersionTokenQueuedSave.test.ts` (source contract; the repo has no jsdom). It fails on the previous source (4 of 6 red, run against the base files) and passes now; `NC-D3` shows the checker reports the old shape. eslint clean on the four files; the existing editor tests pass.
- **Not fixed, documented (PO to judge).** A title-only first Save shows red "required" errors for the short definition and the primary category straight after the record is created: that is the PATCH answering 422 for fields the person has not filled yet. It is the visible consequence of create-on-first-Save and is unchanged. **Not browser-verified** (no jsdom, no DEV session in this task): the fix removes the cause by construction, but the original reproduction (edit within the second request on the loaded DEV server) should be repeated once.

### Tests and checks for this follow-up

New: 10 (PGlite 0278) + 6 (handover v2) + 6 (D3 contract) = 22. Regression: PGlite 0275 suite and 0277 suite pass (57 of 57). Typecheck: no new error (one pre-existing in `tests/unit/canonicalCertResidueAllSql.test.ts`).

### Follow-up 07/10/2026 (2): figures formatted by their own currency

PO finding: the DEV upload preview showed AUD figures in Indian grouping (1,83,000). Rule now applied: a figure is formatted by its OWN currency or unit, never by the viewer's profile or browser locale (AUD 183,000; INR 1,83,000; percentages, ratios, months, days and counts plain with Australian grouping; up to 4 decimals, none forced, so a reviewer sees the exact figure).

- **Cause.** `num()` in `PlanningBenchmarkUpload.tsx` called `toLocaleString('en-IN')` for every figure, and the database preview row carries the unit but not the currency. The Observed values and Target ranges tabs showed the raw database string (no grouping at all). Counts in the Allowed values lists and the row limit used `en-IN` too.
- **One shared rule, reused.** `localeForCurrencyCode` was added to `lib/engines/money.ts` (the existing home of the AUD/INR grouping rule; `formatMoneyCode` and `formatMoneyExact` now call it instead of repeating the inline test). `lib/planning-benchmarks/figureFormat.ts` (`formatFigure`, `formatCount`) adds only the benchmark specifics: the currency of a figure is its own code, else the currency of its country (bands have none), else "currency not stated" with a visible note and a safe Australian-grouping fallback. No second currency formatter was created.
- **Preview currency without a migration.** `lib/planning-benchmarks/previewFigures.ts` adds the staged currency, the live figure's own currency and the band metric unit to the preview reply, read with the caller's own session (existing viewer read access). 0275's `get_planning_benchmark_upload` is untouched. A failed read returns the reply unchanged and the screen shows "currency not stated".
- **Screens changed.** Upload tab preview (new figure, live figure, removed bands), Observed values and Target ranges tabs (`displayCell`; the target ranges route now also selects the metric `unit`), Allowed values lists and the validator's row-limit message (counts). Datasets tab and the dataset metric mapping section show no figures.
- **Tests.** `planningBenchmarkFigureFormat.test.ts` (22 tests): AUD 183000 reads 183,000 and INR 183000 reads 1,83,000 even with an India-locale viewer (every locale argument is named, spied); currency unit without a currency falls back and says so; band currency by country; the two tabs; the preview enrichment; a source sweep. Failing first: against the previous cell function 3 of the tab tests fail; NC-F1 reproduces the old formatter and fails the AUD assertion; NC-F2 and NC-F3 prove the viewer-locale and hard-coded-locale checks bite. Not browser-verified (client component, no jsdom).

Other places that format by locale rather than the figure's currency (reported, not changed, outside Planning Benchmarks):
- `components/admin/benchmarkData/benchmarkDataUiLogic.ts` (`formatCount`, `formatLevel`) and `MarketIndexDataClient.tsx`: `en-IN` for index levels and counts. Market Index Data is India's catalogue and these are index points and counts, not currency, so this is a judgement call for the PO rather than a defect.
- `components/forecast/ForecastHistoryList.tsx` line 94, `components/reports/ReportV2Charts.tsx` line 332, `app/(app)/goals/new/GoalCreationWizard.tsx` lines 295 to 302: `toLocaleString()` with no locale, so the figure follows the viewer's browser although it carries its own currency code (the forecast closing value and the goal amounts). These are the same defect class and are worth fixing with `formatMoneyCode` / `localeForCurrencyCode`.
- `components/marketing/LandingPage.tsx`: fixed `en-AU` with a `$` sign on illustrative figures: acceptable.
- Investment Intelligence India screens (`HoldingsTable`, `RedemptionSimulator`, `TransactionDetailModal`, `PublishedFundValuations`, `AiExtractionReviewPanel`, India MF report section) use `en-IN` for INR figures: consistent with the rule for INR.
- Financial Twin benchmark cards (`TwinDetailView` through `formatMetricValue`) format with `formatMoney(value, twin currency)`: by the Twin's reporting currency, which equals the benchmark country's currency because the retrieval filters sources by country; correct today, but it would mislabel a peer figure that is in another currency if one were ever served (the retrieval does not read `original_currency`).
- Reference Data Quality panels: no number or currency formatting found.
