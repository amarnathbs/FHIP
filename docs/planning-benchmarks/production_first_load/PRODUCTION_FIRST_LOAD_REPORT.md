# Planning Benchmarks production first load: report

Prepared 07/10/2026. Branch `feat/pb-production-first-load-20261007`, created from `origin/main` `e829a8b` (it already has the upload screen, the mapping, the figure formatting and migrations 0275 to 0278). Committed locally, **not pushed**.

**Evidence labels.** The generator is *unit-tested*. The files are *validated read-only against DEV* (host `vqycarelcoijzwlpkpcz`, public anon key, verified by the script before it reads) and *PGlite-verified* (the whole ledger 0001 to 0278 plus the seed, replayed on an isolated in-memory Postgres, then every file staged, previewed and activated by two different people through the real service code and the real database functions). Nothing was read from or written to production. Nothing was written to DEV. No secret was printed or stored. Not production-verified.

## 1. What was delivered

| Item | Where |
|---|---|
| Generator (deterministic, no network, no clock) | `scripts/planning-benchmarks/buildProductionFirstLoad.ts` (`--check` fails if the folder is stale; `--retarget "<dataset>=<version>" --out <folder>` regenerates for another dataset version) |
| The nine upload files, manifest, row trace | `docs/planning-benchmarks/production_first_load/` (`01_` to `09_*.csv`, `MANIFEST.csv`, `MANIFEST.json`, `TRACE_rows_to_source_observations.csv`) |
| Production runbook for the PO | `docs/planning-benchmarks/production_first_load/PRODUCTION_RUNBOOK.md` |
| DEV read-only validation script and its output | `scripts/planning-benchmarks/validateProductionFirstLoadDev.ts`, `evidence/DEV_READONLY_VALIDATION_07-10-2026.txt` |
| PGlite rehearsal harness, script and its output | `scripts/planning-benchmarks/productionFirstLoadPglite.ts`, `rehearseProductionFirstLoadPglite.ts`, `evidence/PGLITE_REHEARSAL_07-10-2026.txt` |
| Shared validation and negative controls | `scripts/planning-benchmarks/productionFirstLoadValidate.ts` |
| Tests (28) | `tests/unit/planningBenchmarkProductionFirstLoad.test.ts` |
| Byte protection | `.gitattributes` (the files are `-text`, so a checkout never changes line endings and the SHA-256 holds) |

## 2. The files, counts and SHA-256

Column and version-marker names come from `lib/planning-benchmarks/uploadSchema.ts` at build time (`FHIP-PB-COHORTS-1`, `FHIP-PB-VALUES-1`, `FHIP-PB-RANGES-1`); nothing about the template is hard-coded. Mapping: the source `x_` provenance columns become `source_release`, `observation_period_start`, `observation_period_end`, `source_file`, `source_locator`, `retrieval_date`; every date is written day first (`dd/mm/yyyy`); every figure is copied as the exact text of the approved file (no rounding, no unit change: the `x_unit_multiplier` was already applied in `value_numeric`). A source column the generator does not know stops the build.

| Order | File | Dataset | Kind | Rows | SHA-256 |
|---|---|---|---|---|---|
| 1 | `01_cohorts_au_net_worth_income_by_age.csv` | AU net worth and income by age band 1.0 | cohorts | 1 | `f3e6d24b15343508c800f2911f6a5718893917a2b7e558019863f2d2dd58f560` |
| 2 | `02_values_au_household_asset_composition.csv` | AU household asset composition 1.0 | values | 2 | `f4096730ff2e685fa756037b308287bc915555128b8e9f19bf950ec24b7e4fbe` |
| 3 | `03_values_au_household_wealth_distribution.csv` | AU household wealth distribution 1.0 | values | 6 | `4c2b9a5bd1123872a0d4a73cbe59e8b962183be3889436496227487a4c9c3799` |
| 4 | `04_values_au_net_worth_income_by_age.csv` | AU net worth and income by age band 1.0 | values | 28 | `8719578fcc9ef9af37e0cfe2b142262236bd14fd62ce83934d9c74cfb745f1bb` |
| 5 | `05_values_au_high_dti_mortgage_threshold.csv` | AU high-DTI mortgage threshold 1.0 | values | 1 | `bb7f55c3dc0f8d91a8b0b3c43847b0b4f8d901be9f414c8e7b5f0ed814e4f5ea` |
| 6 | `06_values_au_average_super_balance.csv` | AU average superannuation balance 1.0 | values | 2 | `ea211155f08a6f6af371be7ce07d40eb028c270d56c83b9482d2a157f868fd80` |
| 7 | `07_values_india_household_assets_debt_rural_urban.csv` | India household assets and debt (rural/urban) 1.0 | values | 4 | `f3db400fc956bb77c8c1c546a73bb4ea6751a678cb73bcc0deaa860e8d52c9d9` |
| 8 | `08_values_india_epf_eps_contribution_structure.csv` | India EPF/EPS contribution structure 1.0 | values | 1 | `1a36c08181160d534d0b70cbb6121964f1c45f35d83a618d474d67380fed8234` |
| 9 | `09_target_ranges_au_asfa_retirement_standard.csv` | AU ASFA retirement standard 1.0 | target ranges | 4 | `b1d0f78f6df936ec265f6f36d4134e9803e4a8aef3dd600036ec068f7a65d501` |

**Real totals: 44 values, 4 target ranges, 1 cohort.** The earlier plan said 45 values. The difference is dataset 7 (AU household debt context, 1 row): it is a superseded dataset, closed to upload, so it is excluded. 2 + 6 + 28 + 1 + 2 + 4 + 1 = 44. Not loaded, by design: dataset 1 and dataset 11 (drafts, never without your approval), dataset 7 (closed), dataset 8 (nothing importable). The only other cohorts the value rows use (`AU_AGE_25_34` to `AU_AGE_75_PLUS`, `IN_RURAL_ALL`, `IN_URBAN_ALL`) already exist on DEV and in the migration seed, so the cohorts file carries only `AU_AGE_15_24`; the runbook's check A4 proves it on production before anything starts.

## 3. Validation results

**Against DEV (read-only, real validator, real allowed lists including the mapping).** DEV lists read on 07/10/2026: 12 datasets (11 open), 67 metrics, 39 cohorts, mapping installed, 71 pairs, all lists complete.
- Against DEV exactly as it stands today: 8 of 9 files have **0 blockers, 0 warnings**. File 4 has 1 reported blocker (4 rows refused): `AU_AGE_15_24` is not yet a registered cohort. That is correct and expected: file 1 must be activated first.
- After file 1 is activated (the cohort added to the lists): **all 9 files, 0 blockers, 0 warnings, every row accepted.**
- Negative controls (a tampered copy of each shipped file): 54 of 54 refused with the named rule (metric not mapped, unit mismatch, thousands separator, month-first date, wrong template version, unknown dataset, duplicate key, source mismatch, bound order, tier out of range, value outside the closed list). The untouched file never raised those codes. (One control initially did nothing on file 8, because that metric is already a percentage; it was made to pick a different unit, which is how a control that does not bite is found.)

**On PGlite (migration ledger 0001 to 0278 plus seed), through the real stage, preview and activate functions as two different people.** Every file passes the validator with 0 blockers and 0 warnings. Results per file (also in `evidence/PGLITE_REHEARSAL_07-10-2026.txt`, with every row, live figure to new figure):

| File | New | Replaced | Same as live | Conflicts | Bands removed | Added | Replaced and kept as history |
|---|---|---|---|---|---|---|---|
| 1 cohort | 1 | 0 | 0 | 0 | 0 | 1 | 0 |
| 2 asset composition | 2 | 0 | 0 | 0 | 0 | 2 | 0 |
| 3 wealth distribution | 2 | 2 | 2 | 0 | 0 | 4 | 2 |
| 4 age bands | 16 | 10 | 2 | 0 | 0 | 26 | 10 |
| 5 DTI | 0 | 0 | 1 | 0 | 0 | 0 | 0 |
| 6 super | 1 | 1 | 0 | 0 | 0 | 2 | 1 |
| 7 India assets and debt | 2 | 0 | 2 | 0 | 0 | 2 | 0 |
| 8 India EPF/EPS | 0 | 1 | 0 | 0 | 0 | 1 | 1 |
| 9 ASFA target ranges | 0 | 0 | 4 | 0 | 0 | 0 | 0 |

After the whole load: 224 to 261 value rows (37 added), 14 end-dated and kept as history, 247 live, 200 live bands (unchanged), cohorts 39 to 40. The three spot checks hold: net worth median 579,200 (ABS Table 7.2 G10), DTI threshold 6 effective 01/02/2026 (APRA), average super mean 182,781 (ATO Chart 12 J211). No mapping pair is missing for any file: all 11 pairs the files need are in the seeded 71.

Other things the tests prove on the replica: a metric not mapped to its dataset is refused by the database stage function itself when the app validator is bypassed (`PB_E_MAPPING`); file 4 cannot be staged before the cohort is activated; Discard before Activate leaves every live figure unchanged and records the event; the same person staging and activating is refused without the acknowledgement (`PB_E_SELF`) and allowed with it, recorded as self-activated; an activated file cannot be staged a second time (`PB_E_DUPLICATE`); every SQL block of the runbook runs and returns what the runbook says (counts, mapping check, cohorts, grants updating exactly one person, audit queries, the three spot checks, the duplicate-key check with a planted duplicate that it catches); and the documented rollback SQL returns the live figures to exactly the pre-load state for all seven values batches.

**Tests:** `tests/unit/planningBenchmarkProductionFirstLoad.test.ts`, 28 passed (run singly, about 20 to 45 seconds). Also re-run singly and green: `planningBenchmarksFirstLoad.test.ts` (35). `git status` is clean of rewritten `scripts/` artifacts.

## 4. Decisions needed from you (none is a blocker for the pre-check, several change what production will show)

**A. `property_concentration`: the approved file says statistic `share`, the seed row that is live says `mean`.** The upload leaves the seed (56.2, mean) live and adds the sourced 55.7661 (share) beside it. The Twin reads median, then mean, then rate, then threshold, so it keeps using the seed 56.2 and ignores the sourced figure. To make the sourced figure the one the Twin uses, the row would have to be `mean` (it would then replace the seed). I did not change an approved row. Say "change to mean" or "keep as share".

**B. Median rows make the Twin switch from mean to median** for the seven age bands (new median rows) and for average super (new median 63,339), as the register's decision D6 said. Also the seed age figures differ widely from the published ones (for example 25 to 34 mean net worth 242,000 vs 353,800); those means are replaced. Confirm this is what you want live.

**C. Seed rows no file touches stay live.** `AU_AGE_18_24` (2 rows: the ABS band is 15 to 24, decision D3) and the India `liquid_asset_share` seed rows (2: the register refused that metric for this dataset). Nothing in an upload can retire them. Leave them, or approve a documented SQL to end-date them.

**D. Caveats the template has no field for.** The values template has no notes column; the app composes the stored provenance line itself from release, period, file, locator and retrieval date, so the population wording of the old `value_text` is not carried. The caveats that do have a field are kept (derivation method for derived rows, the ASFA band explanation, the cohort description). The ones that cannot be carried are listed per row in `TRACE_rows_to_source_observations.csv` (column `population_note_not_carried_by_the_template`); the important ones: super is PER INDIVIDUAL, not per household; the DTI figure is an ADI portfolio limit, not a personal borrowing rule; India EPF is of basic wages up to the ceiling; AIDIS assets are as at 30/06/2018 (survey year 2019). Options: accept, or have the short note appended to `source_locator` (limit 300 characters, every row has room). Your call; I did not alter approved locators.

**E. Files 5 and 9 are no-ops on a seeded database** (every row "Same as live"). Discard or activate, both fine; the runbook says so.

**F. File 8 "replaces" 24 with 24.** The preview shows the same number on both sides because the sourced row carries the as-at date and provenance of 17/09/2026 (PIB) where the seed has another date. Harmless; explained in the runbook.

**G. The 45th value (dataset 7) stays out** because the dataset is superseded. If you want the debt-to-asset 18% figure, the dataset has to be reopened first (a separate decision).

**H. ASFA copyright (register decision D7)** is still open. File 9 changes nothing live on a seeded database (the four bands are identical), so it does not block the load.

## 5. Things to know before the run

- **Production can differ from DEV.** DEV shows `AU household debt context` as `superseded` and `India household consumption` as `draft`; a database straight from the migrations shows both `active`. No file targets either. DEV's super mean is already 182,781 (your rehearsal), so a DEV preview of file 6 would not match the production table; the production table is the migration-seeded state. If production shows a different dataset version or live counts, the runbook says to stop and send the result; the files are then regenerated with `--retarget`, never edited by hand.
- **Order and one-at-a-time.** File 1 must be activated before file 4. Stage, preview and activate each file in turn; a later activation changes the live data an earlier preview was compared with, and the older staged upload is then refused as stale.
- **Rollback.** Before Activate: Discard (nothing live, recorded). After Activate: no delete; the safe path is a corrected upload; the documented SQL (runbook Part F, PO approval, values batches only, newest first) end-dates the batch's new figures and restores the ones it replaced, and was proven to return the exact pre-load state. After such a rollback the identical file cannot be staged again (duplicate protection); a corrected file can. The SQL does not cover target ranges or cohorts (an unused cohort is harmless; file 9 replaces nothing on a seeded database).
- **Twin filter.** Production main `e829a8b` or later carries the filter that stops serving end-dated figures; the runbook asks you to confirm that before the first Activate that replaces anything.
- **Date rule.** All text a person reads is day first. The SQL editor prints dates year first; the runbook says so where it matters.
- **Not covered by this branch.** No change to the mapping, to any migration, to the upload code or to any approved source figure. The old console runner is untouched (the runbook tells you not to use it).
