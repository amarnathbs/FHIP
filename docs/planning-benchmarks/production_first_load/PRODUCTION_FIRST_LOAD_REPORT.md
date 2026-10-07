# Planning Benchmarks production first load: report

Prepared 07/10/2026, updated for the PO decisions of 07/10/2026. Branch `feat/pb-production-first-load-20261007`, created from `origin/main` `e829a8b` (it already has the upload screen, the mapping, the figure formatting and migrations 0275 to 0278). Committed locally, **not pushed**.

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
| Tests (32) | `tests/unit/planningBenchmarkProductionFirstLoad.test.ts` |
| Byte protection | `.gitattributes` (the files are `-text`, so a checkout never changes line endings and the SHA-256 holds) |

## 2. The files, counts and SHA-256

Column and version-marker names come from `lib/planning-benchmarks/uploadSchema.ts` at build time (`FHIP-PB-COHORTS-1`, `FHIP-PB-VALUES-1`, `FHIP-PB-RANGES-1`); nothing about the template is hard-coded. Mapping: the source `x_` provenance columns become `source_release`, `observation_period_start`, `observation_period_end`, `source_file`, `source_locator`, `retrieval_date`; every date is written day first (`dd/mm/yyyy`); every figure is copied as the exact text of the approved file (no rounding, no unit change: the `x_unit_multiplier` was already applied in `value_numeric`). A source column the generator does not know stops the build.

| Order | File | Dataset | Kind | Rows | SHA-256 |
|---|---|---|---|---|---|
| 1 | `01_cohorts_au_net_worth_income_by_age.csv` | AU net worth and income by age band 1.0 | cohorts | 1 | `f3e6d24b15343508c800f2911f6a5718893917a2b7e558019863f2d2dd58f560` |
| 2 | `02_values_au_household_asset_composition.csv` | AU household asset composition 1.0 | values | 2 | `a971ff47bca520bf17d8b9ad97e8b521889c0ddd7577a228a174735264356470` |
| 3 | `03_values_au_household_wealth_distribution.csv` | AU household wealth distribution 1.0 | values | 6 | `200c6ac08dcae00825ee31fa4742064e2ba3d8b00ff41f5d31b21566133bfded` |
| 4 | `04_values_au_net_worth_income_by_age.csv` | AU net worth and income by age band 1.0 | values | 28 | `f76360ff1290f1fbe01f719c3907df1ef674468a372fb99fab14b71666b5df2b` |
| 5 | `05_values_au_high_dti_mortgage_threshold.csv` | AU high-DTI mortgage threshold 1.0 | values | 1 | `e4892164a2867e7cfc0fd581c183587cf11d45a54aff71323db5eaf1622de9dd` |
| 6 | `06_values_au_average_super_balance.csv` | AU average superannuation balance 1.0 | values | 2 | `c7f7a59f20e28bb50ad9cfe4d6b56828565b2198faafdbad4e1fa6b1b2b94e76` |
| 7 | `07_values_india_household_assets_debt_rural_urban.csv` | India household assets and debt (rural/urban) 1.0 | values | 4 | `e39123b99bd7e7886f54d9e45479bf3de559f54a5f5808d952c811630bf78966` |
| 8 | `08_values_india_epf_eps_contribution_structure.csv` | India EPF/EPS contribution structure 1.0 | values | 1 | `df14f3eae719ea01fd6e554cc83dc28e389c220ad52b01841245b22eaca3dc92` |
| 9 | `09_target_ranges_au_asfa_retirement_standard.csv` | AU ASFA retirement standard 1.0 | target ranges | 4 | `acaf5a95cabceb8ff35e156420f807f917f1228bf0c18fff6811d8864b20950e` |

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
| 2 asset composition | 1 | 1 | 0 | 0 | 0 | 2 | 1 |
| 3 wealth distribution | 2 | 2 | 2 | 0 | 0 | 4 | 2 |
| 4 age bands | 16 | 10 | 2 | 0 | 0 | 26 | 10 |
| 5 DTI | 0 | 0 | 1 | 0 | 0 | 0 | 0 |
| 6 super | 1 | 1 | 0 | 0 | 0 | 2 | 1 |
| 7 India assets and debt | 2 | 0 | 2 | 0 | 0 | 2 | 0 |
| 8 India EPF/EPS | 0 | 1 | 0 | 0 | 0 | 1 | 1 |
| 9 ASFA target ranges | 0 | 0 | 4 | 0 | 0 | 0 | 0 |

After the whole load: 224 to 261 value rows (37 added), 15 end-dated and kept as history, 246 live, 200 live bands (unchanged), cohorts 39 to 40. **Twin-read check (the real `loadPeerBenchmark` run on the replica, before and after):** `property_concentration` country-wide mean 56.2 becomes mean 55.7661 (the sourced figure replaced the seed and is the one served); `net_worth` 25 to 34 mean 242,000 becomes median 175,700; 55 to 64 mean 1,453,000 becomes median 999,900; `gross_household_income` 25 to 34 mean 119,808 becomes median 112,944; average super mean 183,000 becomes median 63,339; the untouched seeds (18 to 24 net worth mean 129,000, India rural `liquid_asset_share` 4.6) are still served; country-wide net worth median 579,200 and the DTI threshold 6 are unchanged (`evidence/PGLITE_REHEARSAL_07-10-2026.txt`). The three spot checks hold: net worth median 579,200 (ABS Table 7.2 G10), DTI threshold 6 effective 01/02/2026 (APRA), average super mean 182,781 (ATO Chart 12 J211). No mapping pair is missing for any file: all 11 pairs the files need are in the seeded 71.

Other things the tests prove on the replica: a metric not mapped to its dataset is refused by the database stage function itself when the app validator is bypassed (`PB_E_MAPPING`); file 4 cannot be staged before the cohort is activated; Discard before Activate leaves every live figure unchanged and records the event; the same person staging and activating is refused without the acknowledgement (`PB_E_SELF`) and allowed with it, recorded as self-activated; an activated file cannot be staged a second time (`PB_E_DUPLICATE`); every SQL block of the runbook runs and returns what the runbook says (counts, mapping check, cohorts, grants updating exactly one person, audit queries, the three spot checks, the duplicate-key check with a planted duplicate that it catches); and the documented rollback SQL returns the live figures to exactly the pre-load state for all seven values batches.

**Tests:** `tests/unit/planningBenchmarkProductionFirstLoad.test.ts`, 32 passed (run singly, about 15 to 45 seconds). Also re-run singly and green: `planningBenchmarksFirstLoad.test.ts` (35). `git status` is clean of rewritten `scripts/` artifacts.

## 4. PO decisions of 07/10/2026 (A to D applied in this version) and the ones still open

**A. APPLIED: `property_concentration` is written as statistic `mean`** (PO-approved deviation from the register, id `PO-DEV-A`, recorded in `MANIFEST.json` under `poApprovedDeviations` and in the trace file). Reason: the Twin reads median, then mean, then rate, then threshold, never `share`, and the live seed row is `mean`; with `mean` the sourced 55.7661 replaces the seed 56.2 instead of sitting unused beside it. Mapping check: migration 0277 maps by metric, not by statistic (`DATASET_METRIC_MAPPING.md` sections 1 and 5; the closed list of statistic types applies to every row, and `mean` is in it), the validator has no per-metric statistic rule, and the file passes the real validator on DEV and on the replica. The figure and every other column are unchanged. Effect: file 2 now previews 1 New (`total_assets`) and 1 Replaced (`property_concentration`); the Twin read on the replica goes from mean 56.2 to mean 55.7661.

**B. ACCEPTED: the Twin switches from mean to median** for the seven age bands and for average super. The runbook (Read this first, and Part E7) says so, lists seed against sourced for every changed figure (for example 242,000 against 175,700 for net worth 25 to 34, 183,000 against 63,339 for average super), gives a SQL block (`t1`, run before and after) that shows the headline figure the Twin reads, and a check on the Twin itself. Note the seed means are also replaced by the sourced means (for example 25 to 34 net worth mean 242,000 becomes 353,800), and the median rows are new.

**C. DOCUMENTED: four seed rows stay live and no file touches them:** the two `AU_AGE_18_24` rows (net worth mean 129,000, income mean 46,748; the ABS band is 15 to 24, register decision D3) and the two India `liquid_asset_share` rows (4.6 rural, 9.3 urban; the register refused that metric for this dataset). Documented in the runbook (Read this first, item 4, and E7).

**D. APPLIED: a short plain-language caveat is appended to `source_locator`** for every values row and the four ASFA bands, after the register's own locator (` | Caveat: ...`), always under the 300-character limit (the build fails otherwise; the longest locator is the DTI row). The wording per file: asset composition and wealth distribution, "all private households; the 2019-20 survey went online during COVID-19 and may not compare directly with earlier years"; age bands, "ABS age band as published (youngest is 15-24, not the app 18-24); gross household income; ..."; DTI, "the 6x is a limit on each lender (20% of its new lending per cohort), not a personal borrowing rule"; average super, "per INDIVIDUAL (balances summed across accounts by TFN), not per household"; India assets, "average per household, as at 30/06/2018 (survey year 2019)"; India debt-asset ratio, "as at 30/06/2018 (survey year 2019); one decimal, copied from the MoSPI portal table"; EPF, "of BASIC WAGES up to the ceiling; PIB restatement (EPFO blocked)"; ASFA bands, "ASFA copyright: reuse beyond fair dealing needs ASFA permission". The register's own note text per row stays in `TRACE_rows_to_source_observations.csv` next to the caveat actually appended. Caveats that already have a field are as before (derivation method, band explanation, cohort description). The stored provenance line of each live figure now carries the caveat, because the app composes it from the locator.

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
- **Not covered by this branch.** No change to the mapping, to any migration, to the upload code or to any approved source figure (the one change to an approved row is the PO-approved statistic of decision A; the caveats of decision D only extend source_locator). The old console runner is untouched (the runbook tells you not to use it).
