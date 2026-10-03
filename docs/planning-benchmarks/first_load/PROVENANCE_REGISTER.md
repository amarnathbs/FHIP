# Planning Benchmarks first load - provenance register and status

Prepared 03/10/2026. Branch `feat/planning-benchmarks-first-load-20261003` (from `origin/main` `bf2e101`).
Nothing was loaded anywhere: no database (DEV or production) was read or written, no migration was applied, nothing was pushed or merged.

**Evidence labels used throughout**
- *Extracted* = read programmatically from the official file named in the row (workbook cell, PDF text layer, web page text), not typed from memory.
- *Independently re-read* = I re-opened the source workbook cell (or the official page) myself after the extraction workers had finished and compared it with the import file. Done for 17 headline figures (listed in section 14).
- *Offline-verified* = passed `tests/unit/planningBenchmarksFirstLoad.test.ts` (real Admin route handlers + the real migration-0011 DDL on an in-memory PGlite replica; section 13). Not DEV-verified. Not production-verified.
- Dates in this document are dd/mm/yyyy. The CSV machine columns are ISO yyyy-mm-dd because that is the database format.

## 1. Status of the 12 datasets

| No | Dataset | Status | Rows importable | Why |
|---|---|---|---|---|
| 1 | FHIP dependant-band household model | **DRAFT_NEEDS_PO_APPROVAL - methodology not defined** | 0 (198-key blank worksheet) | no external download exists; nothing invented; never in the import set |
| 2 | AU household asset composition | READY_WITH_CAVEATS | 2 values | ABS HIW 2019-20 (latest and final release). Only `total_assets` and `property_concentration` (derived aggregate share) fit the metric catalogue; superannuation, financial and other asset shares have no metric |
| 3 | AU household wealth distribution | READY_WITH_CAVEATS | 6 values | `net_worth` mean, median, P10, P20, P80, P90 for 2019-20. Group shares, Gini, percentile ratios, net-worth-range counts have no metric. History not loadable with the current consumer |
| 4 | AU net worth and income by age band | READY_WITH_CAVEATS | 28 values + 1 cohort | ABS bands preserved (15-24 ... 75 and over). ABS youngest band is 15-24, the app's is 18-24, so the app's 18-24 households will not match (D3). Weekly income x52 is a disclosed derivation |
| 5 | AU high-DTI mortgage threshold | **READY_TO_IMPORT** | 1 value | APRA letter and implementation PDF: 6x, effective 01/02/2026, no earlier limit exists. The 20%-of-new-lending cap has no metric and is NOT imported (it would be picked up by the Twin as the DTI peer value) |
| 6 | AU average superannuation balance | READY_WITH_CAVEATS | 2 values | ATO Taxation Statistics 2023-24, CC BY 2.5 AU. Figure is PER INDIVIDUAL; the metric is per household. Adding the median changes the Twin's headline peer value from mean to median |
| 7 | AU household debt context | READY_WITH_CAVEATS (1 measure; most BLOCKED) | 1 value | only the survey median debt-to-asset ratio (households with debt) maps to a metric. National-accounts household debt series, share of indebted households, debt-to-income (disposable-income basis) are not importable |
| 8 | India household consumption (rural/urban) | **BLOCKED (schema)** | 0 | MPCE is a per-person monthly amount; no metric definition holds it and no route creates one (P4). Data fully extracted (1,051 rows) |
| 9 | India household assets and debt (rural/urban) | READY_WITH_CAVEATS | 4 values | AIDIS 2019 (reference date 30/06/2018): average assets and debt-asset ratio, rural and urban. Main report No. 588 not found; per-asset-type 2019 rupee values missing; the seed's liquid-asset share is refused (financial assets are not liquid assets) |
| 10 | India EPF/EPS contribution structure | READY_WITH_CAVEATS | 1 value | combined statutory rate 24% of basic wages only. EPFO's own site was blocked (HTTP 403); evidence is Government of India (PIB / Ministry of Labour) restatements. The wage ceiling changed from Rs 15,000 to Rs 25,000 on 17/09/2026. Rule set cannot be held by the table |
| 11 | FHIP Planning Benchmarks v1.0 | **DRAFT_NEEDS_PO_APPROVAL** | 0 (196-band draft) | no external download exists; the draft is a transcription of the repo's own seed. Only 1 band edge (DTI 6x) is supported by evidence gathered here |
| 12 | AU ASFA retirement standard | READY_WITH_CAVEATS | 4 target ranges | lump sums at 67 revised February 2026. ASFA copyright: reproduction needs permission beyond fair dealing (PO decision). Renter figures, weekly/annual budgets, history not importable |

Totals: 45 value rows, 4 target-range rows, 1 cohort row. Everything else is in `extracts/` (full published-figure extraction, 33,000+ rows) and is NOT importable with the existing schema.

## 2. How to read the files

| File | What it is |
|---|---|
| `NN_*.values.csv`, `NN_*.cohorts.csv`, `NN_*.target_ranges.csv` | the importable rows, one row per database row, natural keys + exact database columns + `x_` provenance columns (stripped before sending) |
| `01_*.DRAFT_WORKSHEET.csv`, `11_*.DRAFT_FOR_PO_APPROVAL.target_ranges.csv` | drafts. Excluded by file discovery; cannot be imported by the builder |
| `PROVENANCE_REGISTER.csv` | machine-readable register: one row per (dataset, release, observation period, downloaded file) with size, sha256, retrieval date, licence. 1,081 rows |
| `extracts/NN_*.observations.csv[.gz]` | every figure read from the sources, long format, with source file, table and cell/page and status |

Provenance inside the database: `benchmark_values` has no provenance columns, so `value_text` carries a one-line provenance string (release, observation period, file, table!cell, retrieval date, population note). The Twin never reads `value_text`. `confidence_score` is left empty on every row (no score was invented).

Pure unit conversion ($'000 to $) is recorded in `x_unit_multiplier` and the value is NOT marked derived. Any other arithmetic is marked `is_derived=true` with the method in `derivation_method`, and is recomputed by a test from the cited published observations.

## 3. Dataset 1 - FHIP dependant-band household model

- Parameters the app expects: 11 metrics x 18 cohorts = 198 keys (`schema doc` section 3). Worksheet: `01_fhip_dependant_band_model.DRAFT_WORKSHEET.csv`, every `value_numeric` blank, `approval_status = NEEDS PO APPROVAL - methodology not defined`.
- The column `REFERENCE_ONLY_repo_seed_0023_value` shows what migration 0023 seeds (FHIP-derived from Canstar Blue, AIFS/UNSW, HCES per-capita scaled by an assumed equivalence scale, NAFIS, PLFS and 50/30/20 guideline). It is reference only, not approved, not evidence.
- Evidence candidates (not downloaded, not used): ABS Household Expenditure Survey (AU); MoSPI HCES publishes MPCE only, with no by-dependant-count cross-tab (confirmed in dataset 8 extraction), so the India half cannot be sourced from HCES directly.
- No external file exists for the model itself. Nothing in this load invents it.

## 4. Dataset 2 - AU household asset composition

Source: ABS, Household Income and Wealth, Australia, 2019-20 financial year. Released 28/04/2022 (the workbooks say so; one hidden field on the ABS page says 25/05/2022). **This is the latest and final release**: ABS media statement of 17/07/2025 says the 2023-24 survey will not be published; no 2021-22 release exists. Licence: ABS site states Creative Commons Attribution 4.0 International with attribution (archived cubes carry only a Commonwealth of Australia line; treated as covered, not independently confirmed).

Files:
| File | URL | Bytes | Retrieved | Licence / reuse (paraphrased) |
|---|---|---|---|---|
| 2019-20/2. Household wealth and wealth distribution.xlsx | https://www.abs.gov.au/statistics/economy/finance/household-income-and-wealth-australia/2019-20/2.%20Household | 121181 | 03/10/2026 | ABS states that material on abs.gov.au is licensed under Creative Commons Attribution 4.0 International (credit the ABS), except logos, Coat of Arms,  |
| 2019-20/7. Net worth quintiles.xlsx | https://www.abs.gov.au/statistics/economy/finance/household-income-and-wealth-australia/2019-20/7.%20Net%20wor | 638969 | 03/10/2026 | ABS states that material on abs.gov.au is licensed under Creative Commons Attribution 4.0 International (credit the ABS), except logos, Coat of Arms,  |
| 2019-20/10. Age of reference person.xlsx | https://www.abs.gov.au/statistics/economy/finance/household-income-and-wealth-australia/2019-20/10.%20Age%20of | 613818 | 03/10/2026 | ABS states that material on abs.gov.au is licensed under Creative Commons Attribution 4.0 International (credit the ABS), except logos, Coat of Arms,  |
| 2017-18/Household wealth and wealth distribution.xlsx | https://www.abs.gov.au/statistics/economy/finance/household-income-and-wealth-australia/2017-18/Household%20we | 114723 | 03/10/2026 | ABS states that material on abs.gov.au is licensed under Creative Commons Attribution 4.0 International (credit the ABS), except logos, Coat of Arms,  |
| 2017-18/Net worth quintiles.xlsx | https://www.abs.gov.au/statistics/economy/finance/household-income-and-wealth-australia/2017-18/Net%20worth%20 | 492678 | 03/10/2026 | ABS states that material on abs.gov.au is licensed under Creative Commons Attribution 4.0 International (credit the ABS), except logos, Coat of Arms,  |
| 2017-18/Age of reference person.xlsx | https://www.abs.gov.au/statistics/economy/finance/household-income-and-wealth-australia/2017-18/Age%20of%20ref | 474668 | 03/10/2026 | ABS states that material on abs.gov.au is licensed under Creative Commons Attribution 4.0 International (credit the ABS), except logos, Coat of Arms,  |
| 2015-16/65230do002_201516.xls | https://www.ausstats.abs.gov.au/ausstats/subscriber.nsf/0/3084E62B369D2656CA2581C9000FECF6/$File/65230do002_20 | 315392 | 03/10/2026 | ABS states that material on abs.gov.au is licensed under Creative Commons Attribution 4.0 International (credit the ABS), except logos, Coat of Arms,  |
| 2015-16/65230do008_201516.xls | https://www.ausstats.abs.gov.au/ausstats/subscriber.nsf/0/0132CB124C924304CA2582D5001334EB/$File/65230do008_20 | 199680 | 03/10/2026 | ABS states that material on abs.gov.au is licensed under Creative Commons Attribution 4.0 International (credit the ABS), except logos, Coat of Arms,  |
| 2015-16/65230do012_201516.002.xls | https://www.ausstats.abs.gov.au/ausstats/subscriber.nsf/0/65DB44D4461F26D7CA2582D5001335D9/$File/65230do012_20 | 174080 | 03/10/2026 | ABS states that material on abs.gov.au is licensed under Creative Commons Attribution 4.0 International (credit the ABS), except logos, Coat of Arms,  |
| 2013-14/6523DO00008_201314.xls | https://www.ausstats.abs.gov.au/ausstats/subscriber.nsf/0/1A431B274EA98E68CA257EB5001B7AAC/$File/6523DO00008_2 | 315904 | 03/10/2026 | ABS states that material on abs.gov.au is licensed under Creative Commons Attribution 4.0 International (credit the ABS), except logos, Coat of Arms,  |
| 2013-14/6523DO00012_201314.xls | https://www.ausstats.abs.gov.au/ausstats/subscriber.nsf/0/0F8D7A49F278ED6CCA257EB5001B7B8C/$File/6523DO00012_2 | 508928 | 03/10/2026 | ABS states that material on abs.gov.au is licensed under Creative Commons Attribution 4.0 International (credit the ABS), except logos, Coat of Arms,  |

Loaded (2 rows, 2019-20, Table 2.4 column G): `total_assets` mean $1,245,200 (G28, $'000 x1000); `property_concentration` share 55.77% = G23 (694.4) / G28 (1,245.2) x100, derived, aggregate share of household assets.
Skipped and why: asset-type means (superannuation, financial assets, shares, trusts, vehicles, contents), liabilities, shares of total assets by net-worth quintile (Tables 7.4) - no metric for them; `liquid_asset_share`, `productive_asset_ratio`, `depreciating_asset_ratio` - ABS asset groups do not equal the metric definitions (financial assets include superannuation and shares; contents of dwelling are depreciating but separate) and mapping them would convert a different measure into the field.
History: 2003-04 to 2017-18 asset tables extracted (releases 2013-14 .. 2017-18 restate earlier years in their own dollars) - not loadable (section 12).
Comparability: each release restates earlier years with a CPI factor; same survey year differs across releases (rebasing, not revision). 2019-20 changed to online collection and overlapped COVID-19: ABS warns it may not be directly comparable.
Seed comparison: seed property concentration 56.2% (40.7% + 15.5%, source not reproducible from the 2019-20 tables); sourced 55.77%.
Rows: extracted 3,089 (all releases); imported 2.

## 5. Dataset 3 - AU household wealth distribution

Source and licence as dataset 2. Files:
| File | URL | Bytes | Retrieved | Licence / reuse (paraphrased) |
|---|---|---|---|---|
| 2019-20/2. Household wealth and wealth distribution.xlsx | https://www.abs.gov.au/statistics/economy/finance/household-income-and-wealth-australia/2019-20/2.%20Household | 121181 | 03/10/2026 | ABS states that material on abs.gov.au is licensed under Creative Commons Attribution 4.0 International (credit the ABS), except logos, Coat of Arms,  |
| 2019-20/7. Net worth quintiles.xlsx | https://www.abs.gov.au/statistics/economy/finance/household-income-and-wealth-australia/2019-20/7.%20Net%20wor | 638969 | 03/10/2026 | ABS states that material on abs.gov.au is licensed under Creative Commons Attribution 4.0 International (credit the ABS), except logos, Coat of Arms,  |
| 2017-18/Household wealth and wealth distribution.xlsx | https://www.abs.gov.au/statistics/economy/finance/household-income-and-wealth-australia/2017-18/Household%20we | 114723 | 03/10/2026 | ABS states that material on abs.gov.au is licensed under Creative Commons Attribution 4.0 International (credit the ABS), except logos, Coat of Arms,  |
| 2017-18/Net worth quintiles.xlsx | https://www.abs.gov.au/statistics/economy/finance/household-income-and-wealth-australia/2017-18/Net%20worth%20 | 492678 | 03/10/2026 | ABS states that material on abs.gov.au is licensed under Creative Commons Attribution 4.0 International (credit the ABS), except logos, Coat of Arms,  |
| 2015-16/65230do002_201516.xls | https://www.ausstats.abs.gov.au/ausstats/subscriber.nsf/0/3084E62B369D2656CA2581C9000FECF6/$File/65230do002_20 | 315392 | 03/10/2026 | ABS states that material on abs.gov.au is licensed under Creative Commons Attribution 4.0 International (credit the ABS), except logos, Coat of Arms,  |
| 2015-16/65230do008_201516.xls | https://www.ausstats.abs.gov.au/ausstats/subscriber.nsf/0/0132CB124C924304CA2582D5001334EB/$File/65230do008_20 | 199680 | 03/10/2026 | ABS states that material on abs.gov.au is licensed under Creative Commons Attribution 4.0 International (credit the ABS), except logos, Coat of Arms,  |
| 2013-14/6523do00002_201314.xls | https://www.ausstats.abs.gov.au/ausstats/subscriber.nsf/0/4D96FC4EBA9F1B68CA257EB5001B794E/$File/6523do00002_2 | 140800 | 03/10/2026 | ABS states that material on abs.gov.au is licensed under Creative Commons Attribution 4.0 International (credit the ABS), except logos, Coat of Arms,  |
| 2013-14/6523DO00008_201314.xls | https://www.ausstats.abs.gov.au/ausstats/subscriber.nsf/0/1A431B274EA98E68CA257EB5001B7AAC/$File/6523DO00008_2 | 315904 | 03/10/2026 | ABS states that material on abs.gov.au is licensed under Creative Commons Attribution 4.0 International (credit the ABS), except logos, Coat of Arms,  |
| 2011-12/sih 2011-12 data cubes.xls | https://www.ausstats.abs.gov.au/ausstats/subscriber.nsf/0/E3075D36DB4F7605CA257BC80016E46F/$File/sih%202011-12 | 721408 | 03/10/2026 | ABS states that material on abs.gov.au is licensed under Creative Commons Attribution 4.0 International (credit the ABS), except logos, Coat of Arms,  |
| 2009-10/65230do001_200910.xls | https://www.ausstats.abs.gov.au/ausstats/subscriber.nsf/0/B27053EBE209881BCA2578FB0018523D/$File/65230do001_20 | 661504 | 03/10/2026 | ABS states that material on abs.gov.au is licensed under Creative Commons Attribution 4.0 International (credit the ABS), except logos, Coat of Arms,  |

Loaded (6 rows, 2019-20): net worth mean $1,042,000 (Table 2.1!H13), median $579,200 (Table 7.2!G10), P10 $36,900 (H16), P20 $113,400 (H17), P80 $1,447,800 (H23), P90 $2,257,700 (H24). Means, medians and percentile boundaries are separate rows. The published P50 (579.2, Table 2.1) is not loaded separately (it equals the median row and the Twin derives p50 from the median).
Skipped: quintile shares of aggregate net worth, percentile ratios, Gini, households by net-worth range, equivalised net worth (a different measure, kept distinct in extracts), quintile means - no metric.
Seed comparison (migration 0012): median 579,200 matches; P20 113,400 matches; mean seed 1,040,000 vs published 1,042,000; P80 seed 1,400,000 (flagged derived/approximate) vs published 1,447,800.
Rows: extracted 2,988 across releases 2009-10 .. 2019-20 (survey years 2003-04, 2005-06, 2009-10, 2011-12, 2013-14, 2015-16, 2017-18, 2019-20; 2007-08 had no comprehensive wealth collection); imported 6.

## 6. Dataset 4 - AU net worth and income by age band

Source and licence as dataset 2. Files:
| File | URL | Bytes | Retrieved | Licence / reuse (paraphrased) |
|---|---|---|---|---|
| 2019-20/10. Age of reference person.xlsx | https://www.abs.gov.au/statistics/economy/finance/household-income-and-wealth-australia/2019-20/10.%20Age%20of | 613818 | 03/10/2026 | ABS states that material on abs.gov.au is licensed under Creative Commons Attribution 4.0 International (credit the ABS), except logos, Coat of Arms,  |
| 2017-18/Age of reference person.xlsx | https://www.abs.gov.au/statistics/economy/finance/household-income-and-wealth-australia/2017-18/Age%20of%20ref | 474668 | 03/10/2026 | ABS states that material on abs.gov.au is licensed under Creative Commons Attribution 4.0 International (credit the ABS), except logos, Coat of Arms,  |
| 2015-16/65230do012_201516.002.xls | https://www.ausstats.abs.gov.au/ausstats/subscriber.nsf/0/65DB44D4461F26D7CA2582D5001335D9/$File/65230do012_20 | 174080 | 03/10/2026 | ABS states that material on abs.gov.au is licensed under Creative Commons Attribution 4.0 International (credit the ABS), except logos, Coat of Arms,  |
| 2013-14/6523DO00012_201314.xls | https://www.ausstats.abs.gov.au/ausstats/subscriber.nsf/0/0F8D7A49F278ED6CCA257EB5001B7B8C/$File/6523DO00012_2 | 508928 | 03/10/2026 | ABS states that material on abs.gov.au is licensed under Creative Commons Attribution 4.0 International (credit the ABS), except logos, Coat of Arms,  |
| 2011-12/sih 2011-12 data cubes.xls | https://www.ausstats.abs.gov.au/ausstats/subscriber.nsf/0/E3075D36DB4F7605CA257BC80016E46F/$File/sih%202011-12 | 721408 | 03/10/2026 | ABS states that material on abs.gov.au is licensed under Creative Commons Attribution 4.0 International (credit the ABS), except logos, Coat of Arms,  |
| 2009-10/65230do001_200910.xls | https://www.ausstats.abs.gov.au/ausstats/subscriber.nsf/0/B27053EBE209881BCA2578FB0018523D/$File/65230do001_20 | 661504 | 03/10/2026 | ABS states that material on abs.gov.au is licensed under Creative Commons Attribution 4.0 International (credit the ABS), except logos, Coat of Arms,  |

Loaded (28 values + 1 cohort): for each ABS age-of-reference-person band 15-24, 25-34, 35-44, 45-54, 55-64, 65-74, 75 and over: net worth mean and median ($'000 x1000), and gross household income mean and median (published PER WEEK, multiplied by 52 and marked derived). Cohorts: existing seeded `AU_AGE_25_34 ... AU_AGE_75_PLUS` (edges identical to the ABS bands) and the new `AU_AGE_15_24` (age_band `AGE_15_24`). The ABS "65 years and over" total and "All households" rows are not loaded (the all-households net worth is the dataset-3 figure).
Not recoded: the app's `AGE_18_24` cohort is not used for the 15-24 figures (checked by a named negative control). Consequence: households aged 18-24 find no exact age cohort and fall to the next fallback (D3).
Income definition: gross household income, household-weighted, weekly dollars in survey-year dollars. Equivalised disposable and disposable income exist in the extraction and are not loaded.
Seed comparison: the seed's age figures do not reproduce from any released ABS table. Net worth seed vs 2019-20 ABS mean: 25-34 242,000 vs 353,800; 35-44 555,000 vs 692,600; 45-54 1,055,000 vs 1,124,600; 55-64 1,453,000 vs 1,519,000; 65-74 1,835,000 vs 1,673,800; 75+ 1,167,000 vs 1,167,000 (the only match); seed 18-24 129,000 vs ABS 15-24 83,800. The seed's income figures also differ (for example 25-34 2,304/week vs 2,465).
Rows: extracted 821; imported 28 + 1.

## 7. Dataset 5 - AU high-DTI mortgage threshold

Sources (APRA; reuse per APRA copyright page): files
| File | URL | Bytes | Retrieved | Licence / reuse (paraphrased) |
|---|---|---|---|---|
| apra_n2.html | https://www.apra.gov.au/news-and-publications/activation-debt-income-limits-macroprudential-policy-tool | 324952 | 03/10/2026 | APRA website material is under Creative Commons Attribution 4.0 International except Coat of Arms, APRA logos and third-party material; APRA requests  |
| apra_dti_impl.pdf | https://www.apra.gov.au/sites/default/files/2025-11/Implementation%20Details%20-%20DTI%20limit.pdf | 354874 | 03/10/2026 | APRA website material is under Creative Commons Attribution 4.0 International except Coat of Arms, APRA logos and third-party material; APRA requests  |
| aps220_F2022L01576.pdf | https://www.legislation.gov.au/F2022L01576/asmade/2022-12-05/text/original/pdf | 1000324 | 03/10/2026 | Federal Register of Legislation as-made instrument PDF; licence terms of that register not separately checked by this worker (APRA site content is CC  |
| apra_n1.html | https://www.apra.gov.au/news-and-publications/activating-debt-income-limits-macroprudential-policy-tool | 366437 | 03/10/2026 | APRA website material is under Creative Commons Attribution 4.0 International except Coat of Arms, APRA logos and third-party material; APRA requests  |

What the notice actually says (read by me directly on the APRA page and by the extraction worker from the PDFs): from 01/02/2026 each ADI may write up to 20% of its new owner-occupier loans and up to 20% of its new investment loans at a debt-to-income ratio of six times or more, the two cohorts measured separately; applies to all ADIs doing residential mortgage lending in Australia (large ADIs measured quarterly, smaller ADIs on a rolling four-quarter basis); new-dwelling construction, newly erected dwellings and owner-occupier bridging finance are exempt; DTI is as defined in reporting standard ARS 223.0 (credit limit of all debts over gross income, including HELP/HECS and buy-now-pay-later). Published 27/11/2025 (letter, information paper and media release).
APS 220 (authorised version F2022L01576, in force 01/01/2023) contains no limit; Attachment C only requires ADIs to be able to apply a 4x or 6x DTI limit when told (one month notice). No earlier DTI limit exists and no later amendment was found (APRA release of 28/05/2026 says the limits "remain unchanged"; the full APRA news index was not browsed).
Loaded (1 row): `debt_to_income` threshold 6 ratio, `effective_from` and `base_date` 2026-02-01 (01/02/2026), no `effective_to`, owner-occupier and investment cohorts carry the same 6x (the row traces to the investment observation; the value text names both). **Not backfilled**: a named negative control proves any earlier date is rejected.
Not imported: the 20% cap (no metric; as a `rate` it would outrank the threshold in the Twin's selection and be shown as a DTI benchmark), the APS 220 4x/6x capability thresholds (not limits), three context rows from the information paper (two NEEDS_MANUAL_CHECK: the "8 per cent" period and the "155 to 180 per cent" household indebtedness definition).
Seed comparison: 6.0 effective 01/02/2026 matches. Seed source row `publication_date` 2026-02-01 is the effective date; the notice was published 27/11/2025.

## 8. Dataset 6 - AU average superannuation balance

Source: ATO Taxation Statistics 2023-24, individuals, via data.gov.au, Creative Commons Attribution 2.5 Australia. Files:
| File | URL | Bytes | Retrieved | Licence / reuse (paraphrased) |
|---|---|---|---|---|
| ts2324_Snapshot_Table_5.xlsx | https://data.gov.au/data/dataset/faea4485-f407-457d-97f8-3f0822ccd654/resource/e19017b8-3894-44e2-995a-1c253c9 | 3834180 | 03/10/2026 | Dataset published on data.gov.au under Creative Commons Attribution 2.5 Australia (Creative Commons Attribution 2.5 Australia); reuse permitted with a |
| ts2324_Snapshot_Table_4.xlsx | https://data.gov.au/data/dataset/faea4485-f407-457d-97f8-3f0822ccd654/resource/91631a30-56db-4e50-8456-b329874 | 583748 | 03/10/2026 | Dataset published on data.gov.au under Creative Commons Attribution 2.5 Australia (Creative Commons Attribution 2.5 Australia); reuse permitted with a |
| ts2324_Individuals_Table_20.xlsx | https://data.gov.au/data/dataset/faea4485-f407-457d-97f8-3f0822ccd654/resource/52b66511-f7f8-44a9-b5f1-2d73349 | 545544 | 03/10/2026 | Dataset published on data.gov.au under Creative Commons Attribution 2.5 Australia (Creative Commons Attribution 2.5 Australia); reuse permitted with a |
| ts2324_Individuals_Table_21.xlsx | https://data.gov.au/data/dataset/faea4485-f407-457d-97f8-3f0822ccd654/resource/aceaadfa-c154-4b35-a648-7d14340 | 24739 | 03/10/2026 | Dataset published on data.gov.au under Creative Commons Attribution 2.5 Australia (Creative Commons Attribution 2.5 Australia); reuse permitted with a |
| ts2324_Individuals_Table_22.xlsx | https://data.gov.au/data/dataset/faea4485-f407-457d-97f8-3f0822ccd654/resource/94a7ab8d-d13b-49ad-aef3-8c8ee51 | 65067 | 03/10/2026 | Dataset published on data.gov.au under Creative Commons Attribution 2.5 Australia (Creative Commons Attribution 2.5 Australia); reuse permitted with a |
| ts2324_Individuals_Table_23.xlsx | https://data.gov.au/data/dataset/faea4485-f407-457d-97f8-3f0822ccd654/resource/0c0d97e6-15db-483c-980d-53fef39 | 288777 | 03/10/2026 | Dataset published on data.gov.au under Creative Commons Attribution 2.5 Australia (Creative Commons Attribution 2.5 Australia); reuse permitted with a |
| ts2324_Individuals_Table_24.xlsx | https://data.gov.au/data/dataset/faea4485-f407-457d-97f8-3f0822ccd654/resource/e16e5b5d-dfc4-4e05-a305-006ab89 | 418294 | 03/10/2026 | Dataset published on data.gov.au under Creative Commons Attribution 2.5 Australia (Creative Commons Attribution 2.5 Australia); reuse permitted with a |

Loaded (2 rows): all individuals, 2023-24, mean $182,781 and median $63,339 (Snapshot Table 5, Chart 12 data, sheet '12'!J211 and K211, independently re-read), `effective_from` 25/06/2026 (data.gov.au resource last-modified; the ATO publication date itself was not captured).
Population: per INDIVIDUAL (balances summed across accounts by TFN), individuals with a balance or current-year contributions above zero; counts may double count where no valid TFN was given. The metric `retirement_balance` is per household - this mapping follows the registered dataset's design and the seed; PO decision D6. Adding the median row switches the Twin's headline peer value for `retirement_balance` from the mean to the median (the consumer prefers median); delete that row to keep the seed's behaviour.
Not loaded (no sex or age-band dimension fits the metric catalogue or the app's bands): age x sex mean/median/count for 2013-14 to 2023-24 (11 years), state x sex, taxable-income ranges, APRA-fund-only and SMSF-only series (not comparable with all-funds), 2023-24 cross-tabs (Tables 22, 23A, 24A: count, aggregate dollars, mean, median).
History and comparability: I compared every cell of the age x sex x year table in the 2022-23, 2021-22 and 2020-21 editions with 2023-24: 3,645 cells, 0 differences, so history is not restated across those editions and one copy was kept. Table 10 income brackets change between years. The state-by-sex table in the 2023-24 workbook has two mislabelled year blocks (labelled 2019-20 and 2023-24; they are 2018-19 and 2022-23 - totals identical to the age table and to earlier editions); relabelled in the extraction with the original label in notes. Aggregating Table 23A reproduces Chart 12 only to about 1.5%: do not mix those tables.
Seed comparison: seed 183,000 mean (rounded) vs 182,781.
Rows: extracted 7,722; imported 2. Editions before 2020-21 were not downloaded.

## 9. Dataset 7 - AU household debt context

Sources: (a) ABS Australian National Accounts: Finance and Wealth, June 2026 (released 24/09/2026; next 17/12/2026), CC BY 4.0, tables 1, 2, 34, 35, 36, 51, 52, quarterly 1988 to June 2026; (b) the ABS HIW 2019-20 survey debt tables 2.4, 3.2-3.5. Files:
| File | URL | Bytes | Retrieved | Licence / reuse (paraphrased) |
|---|---|---|---|---|
| 5232035.xlsx | https://www.abs.gov.au/statistics/economy/national-accounts/australian-national-accounts-finance-and-wealth/ju | 83707 | 03/10/2026 | ABS website content is under Creative Commons Attribution 4.0 International (excluding logos/Coat of Arms/third-party material); attribution to ABS re |
| 5232036.xlsx | https://www.abs.gov.au/statistics/economy/national-accounts/australian-national-accounts-finance-and-wealth/ju | 69768 | 03/10/2026 | ABS website content is under Creative Commons Attribution 4.0 International (excluding logos/Coat of Arms/third-party material); attribution to ABS re |
| 5232034.xlsx | https://www.abs.gov.au/statistics/economy/national-accounts/australian-national-accounts-finance-and-wealth/ju | 270965 | 03/10/2026 | ABS website content is under Creative Commons Attribution 4.0 International (excluding logos/Coat of Arms/third-party material); attribution to ABS re |
| 5232001.xlsx | https://www.abs.gov.au/statistics/economy/national-accounts/australian-national-accounts-finance-and-wealth/ju | 287603 | 03/10/2026 | ABS website content is under Creative Commons Attribution 4.0 International (excluding logos/Coat of Arms/third-party material); attribution to ABS re |
| 5232002.xlsx | https://www.abs.gov.au/statistics/economy/national-accounts/australian-national-accounts-finance-and-wealth/ju | 268297 | 03/10/2026 | ABS website content is under Creative Commons Attribution 4.0 International (excluding logos/Coat of Arms/third-party material); attribution to ABS re |
| 5232051.xlsx | https://www.abs.gov.au/statistics/economy/national-accounts/australian-national-accounts-finance-and-wealth/ju | 58065 | 03/10/2026 | ABS website content is under Creative Commons Attribution 4.0 International (excluding logos/Coat of Arms/third-party material); attribution to ABS re |
| 5232052.xlsx | https://www.abs.gov.au/statistics/economy/national-accounts/australian-national-accounts-finance-and-wealth/ju | 58693 | 03/10/2026 | ABS website content is under Creative Commons Attribution 4.0 International (excluding logos/Coat of Arms/third-party material); attribution to ABS re |
| hiw_3.xlsx | https://www.abs.gov.au/statistics/economy/finance/household-income-and-wealth-australia/2019-20/3.%20Income%2C | 938547 | 03/10/2026 | ABS website content is under Creative Commons Attribution 4.0 International (excluding logos/Coat of Arms/third-party material); attribution to ABS re |
| hiw_2.xlsx | https://www.abs.gov.au/statistics/economy/finance/household-income-and-wealth-australia/2019-20/2.%20Household | 121181 | 03/10/2026 | ABS website content is under Creative Commons Attribution 4.0 International (excluding logos/Coat of Arms/third-party material); attribution to ABS re |

Loaded (1 row): `debt_to_asset_ratio` median 18% = published 0.18 x100 (Table 3.4!AB15, independently re-read), 2019-20, **households with debt only** (ABS: ratios are calculated only for households with debt), marked derived (unit change ratio to percentage).
Refused (different population or measure, kept in extracts): national-accounts household sector debt, net worth, credit outstandings (aggregates in $ billion / $ million, "Households" sector label, no ratios are published in those tables - none was computed); share of households with debt (74.6% in 2019-20; no metric); survey debt-to-income median 1.09 (debt over annualised current DISPOSABLE income; the metric is debt over GROSS income and APRA's DTI is a credit-limit-over-gross-income measure at origination); share with debt of 3x income or more; share with debt of 75% of assets or more.
Rows: extracted 16,986 (14,850 national accounts `na_`, 2,136 survey `survey_`); imported 1. Full history is in the extract (national accounts quarterly from 1988; survey years 2009-10 .. 2019-20).
Unreconciled by ABS definition: Table 1 ADI household loans (2,402,982 $m) differs from Table 51 ADI total (2,397,891 $m); not reconciled.

## 10. Datasets 8 and 9 - India (MoSPI / NSO)

Licence (both): MoSPI copyright policy page - accurate reproduction with credit; for NSO/MoSPI datasets in Category A under the 2026 dissemination guidelines, reuse with due credit. Category status of each report was not verified. Pages were parsed from PDF text layers, internal sum checks passed, no human page-image comparison was done.

### Dataset 8 - HCES (BLOCKED, schema)
Files:
| File | URL | Bytes | Retrieved | Licence / reuse (paraphrased) |
|---|---|---|---|---|
| HCES_FactSheet_2023-24.pdf | https://www.mospi.gov.in/sites/default/files/publication_reports/HCES%20FactSheet%202023-24.pdf | 2615083 | 03/10/2026 | Per MoSPI Copyright Policy page (read 03/10/2026): website material may be reproduced accurately; NSO/MoSPI-owned datasets classed Category A under th |
| Factsheet_HCES_2022-23.pdf | https://www.mospi.gov.in/sites/default/files/publication_reports/Factsheet_HCES_2022-23.pdf?download=1 | 5911399 | 03/10/2026 | Per MoSPI Copyright Policy page (read 03/10/2026): website material may be reproduced accurately; NSO/MoSPI-owned datasets classed Category A under th |
| HCES_Report202324_Press_Note_30012025.pdf | https://mospi.gov.in/sites/default/files/press_release/HCES_Report202324_Press_Note_30012025.pdf | 274658 | 03/10/2026 | Per MoSPI Copyright Policy page (read 03/10/2026): website material may be reproduced accurately; NSO/MoSPI-owned datasets classed Category A under th |
| KI-68th-HCE.pdf | https://www.mospi.gov.in/sites/default/files/publication_reports/KI-68th-HCE.pdf | 15800263 | 03/10/2026 | Per MoSPI Copyright Policy page (read 03/10/2026): website material may be reproduced accurately; NSO/MoSPI-owned datasets classed Category A under th |
Extracted (1,051 rows): HCES 2023-24 (Aug 2023 - Jul 2024, latest on the MoSPI page on 03/10/2026) all-India and 36 states/UTs rural and urban MPCE, without imputation (rural Rs 4,122, urban Rs 6,996) and with imputation of free social-welfare items (Rs 4,247 / Rs 7,078); 24 item groups; fractile classes; Gini; HCES 2022-23 the same set; NSS 68th round 2011-12 (URP, MRP, MMRP), earlier rounds only as reproduced in those reports.
Comparability: only HCES 2022-23 and 2023-24 are the same methodology per MoSPI; 2011-12 and earlier differ (item list about 347 vs 405, questionnaires, CAPI, recall periods MRP/MMRP/URP); item-group definitions differ; both imputation bases are tagged on every row; nothing is spliced into one series.
Why not importable: MPCE is Rs per PERSON per month. No metric definition is denominated that way (migration 0012 section 5e says so deliberately) and the Admin API cannot create one. Converting to a household figure needs an explicit household-size method that does not exist. Proposed P4: a `per_capita` metric (the `household_or_person` column already allows 'per_capita').
Seed comparison: the seed's note quotes rural 4,122 / urban 6,996: matches the sourced without-imputation figures.

### Dataset 9 - AIDIS (READY_WITH_CAVEATS)
Files:
| File | URL | Bytes | Retrieved | Licence / reuse (paraphrased) |
|---|---|---|---|---|
| press_note-AIDIS-240821.pdf | https://www.mospi.gov.in/sites/default/files/press_release/press_note-AIDIS-240821.pdf | 370962 | 03/10/2026 | Per MoSPI Copyright Policy page (read 03/10/2026): website material may be reproduced accurately; NSO/MoSPI-owned datasets classed Category A under th |
| mospi_aidis_theme_dashboard_capture_2026-10-03.txt | https://www.mospi.gov.in/themes/product/70-- | 1695 | 03/10/2026 | Per MoSPI Copyright Policy page (read 03/10/2026): website material may be reproduced accurately; NSO/MoSPI-owned datasets classed Category A under th |
| KI_70_18.2_19dec14.pdf | https://www.mospi.gov.in/sites/default/files/publication_reports/KI_70_18.2_19dec14.pdf | 3199398 | 03/10/2026 | Per MoSPI Copyright Policy page (read 03/10/2026): website material may be reproduced accurately; NSO/MoSPI-owned datasets classed Category A under th |
| 500_final.pdf | https://mospi.gov.in/sites/default/files/publication_reports/500_final.pdf | 4596092 | 03/10/2026 | Per MoSPI Copyright Policy page (read 03/10/2026): website material may be reproduced accurately; NSO/MoSPI-owned datasets classed Category A under th |
Loaded (4 rows, AIDIS 2019 = NSS 77th round, survey Jan-Dec 2019, reference date for assets and debt 30/06/2018): `total_assets` mean per household rural Rs 15,92,379 (1592379) on `IN_RURAL_ALL`, urban Rs 27,17,081 (2717081) on `IN_URBAN_ALL` (press note 10/09/2021 p.2, all households); `debt_to_asset_ratio` rural 3.8% and urban 4.4% (MoSPI AIDIS portal table, manual capture, one decimal; consistent with press-note AOD/AVA: 59,748/1,592,379 = 3.75%, 1,20,336/27,17,081 = 4.43%).
Refused: the seed's `liquid_asset_share` (average financial assets / total assets): AIDIS financial assets include provident funds and insurance, which are not liquid, so the figure does not belong to that metric.
Not obtained: NSS Report No. 588 (main report) could not be located on mospi.gov.in, so 2019 rupee values by asset type are missing (only whole-percent shares exist from the press note). Earlier rounds NSS 70th (2013, reference 30/06/2012) and 59th (2003, reference 30/06/2002) are extracted and not loadable together with 2019 (section 12). Comparability: the 70th report lists definition changes from the 59th (valuation of land and buildings, durables dropped); 70th vs 77th comparability is unverified without Report 588.
NEEDS_MANUAL_CHECK: urban incidence of indebtedness 22.4% (press note) vs 22.0% (portal card), `D9-00087`; the press-note value is recorded OK and the portal value flagged.
Seed comparison: assets 1,592,379 and 2,717,081 match the sourced figures; seed `liquid_asset_share` 4.6 and 9.3 are not carried over.

## 11. Dataset 10 - India EPF/EPS; dataset 12 - AU ASFA

### Dataset 10 (READY_WITH_CAVEATS, 1 row)
**BLOCKED source**: `epfindia.gov.in` redirects to `epfo.gov.in`; curl and WebFetch got HTTP 403 and the browser pane got a CloudFront block page. Each was tried once and not circumvented. The EPFO scheme pages, FAQs and the Pension Manual PDF were therefore NOT obtained. Evidence is PIB (Press Information Bureau) releases and labour.gov.in copies of them: official restatements (Parliament replies, Cabinet decisions), not scheme text. PIB's copyright page permits free accurate reproduction with source acknowledgement.
Files:
| File | URL | Bytes | Retrieved | Licence / reuse (paraphrased) |
|---|---|---|---|---|
| pib_2310973_wage_ceiling_minister_briefing.html | https://www.pib.gov.in/PressReleasePage.aspx?PRID=2310973&reg=3&lang=1 | 107171 | 03/10/2026 | Government of India (PIB / Ministry of Labour) public press material; see NOTES.md for the site's published copyright/reuse policy (reuse with acknowl |
| pib_1813167_employees_pension_scheme.html | https://www.pib.gov.in/PressReleaseIframePage.aspx?PRID=1813167&reg=48&lang=2 | 89723 | 03/10/2026 | Government of India (PIB / Ministry of Labour) public press material; see NOTES.md for the site's published copyright/reuse policy (reuse with acknowl |
| pib_2313829_epfo_berhampore_wage_ceiling.html | https://www.pib.gov.in/PressReleasePage.aspx?PRID=2313829&reg=48&lang=2 | 73596 | 03/10/2026 | Government of India (PIB / Ministry of Labour) public press material; see NOTES.md for the site's published copyright/reuse policy (reuse with acknowl |
| pib_124740_employees_pension_scheme.html | https://www.pib.gov.in/newsite/PrintRelease.aspx?relid=124740&reg=48&lang=2 | 156888 | 03/10/2026 | Government of India (PIB / Ministry of Labour) public press material; see NOTES.md for the site's published copyright/reuse policy (reuse with acknowl |
| pib_2311548_cabinet_raises_epf_wage_ceiling.html | https://www.pib.gov.in/PressReleasePage.aspx?PRID=2311548&lang=2&reg=48 | 92164 | 03/10/2026 | Government of India (PIB / Ministry of Labour / India Code) public material; see NOTES.md for the site's published copyright/reuse policy. |
| pib_2147929_minimum_pension.html | https://www.pib.gov.in/PressReleasePage.aspx?PRID=2147929 | 77724 | 03/10/2026 | Government of India (PIB / Ministry of Labour) public press material; see NOTES.md for the site's published copyright/reuse policy (reuse with acknowl |
| pib_78512_pension_under_pf_schemes.html | https://www.pib.gov.in/newsite/PrintRelease.aspx?relid=78512&reg=48&lang=2 | 11696 | 03/10/2026 | Government of India (PIB / Ministry of Labour / India Code) public material; see NOTES.md for the site's published copyright/reuse policy. |
| pib_2109829_benefits_eps95.html | https://www.pib.gov.in/PressReleasePage.aspx?PRID=2109829&reg=48&lang=2 | 105414 | 03/10/2026 | Government of India (PIB / Ministry of Labour) public press material; see NOTES.md for the site's published copyright/reuse policy (reuse with acknowl |
| pib_2029381_eps_withdrawal_amendment.html | https://www.pib.gov.in/PressReleaseIframePage.aspx?PRID=2029381&reg=48&lang=2 | 96908 | 03/10/2026 | Government of India (PIB / Ministry of Labour) public press material; see NOTES.md for the site's published copyright/reuse policy (reuse with acknowl |
| pib_2002649_eps_pension_increase.html | https://www.pib.gov.in/PressReleasePage.aspx?PRID=2002649 | 80198 | 03/10/2026 | Government of India (PIB / Ministry of Labour) public press material; see NOTES.md for the site's published copyright/reuse policy (reuse with acknowl |
| pib_119902_min_pension_1000_perpetuity.html | https://www.pib.gov.in/newsite/PrintRelease.aspx?relid=119902&reg=3&lang=2 | 67937 | 03/10/2026 | Government of India (PIB / Ministry of Labour) public press material; see NOTES.md for the site's published copyright/reuse policy (reuse with acknowl |
Facts recorded (28 rows, 3 NEEDS_MANUAL_CHECK): statutory wage ceiling Rs 25,000 per month from 17/09/2026 (Cabinet decision; PIB release 16/09/2026), Rs 15,000 from 01/09/2014, Rs 6,500 before; employee 12%; employer 12% split 8.33% to EPS and 3.67% to the EPF account; Central Government 1.16% (on wages up to the ceiling); pension at 58, early pension from 50, 10 years of service; pension formula divisor 70; pensionable salary averaged over 60 months (12 before); minimum pension Rs 1,000 from 01/09/2014 (notification dated 19/08/2014); children's Rs 250 and orphans' Rs 750; withdrawal-benefit minimum service removed from 14/06/2024. Not found: any G.S.R. number for the 2014 amendments, EDLI and administration charges, the final court outcome on the 2014 amendments (Kerala High Court set them aside on 12/10/2018 per PIB; Supreme Court matter was pending).
NEEDS_MANUAL_CHECK: EPS pensionable ceiling Rs 25,000 and maximum employer EPS contribution Rs 2,083 from 17/09/2026 (regional PIB briefing only); withdrawal minimum service 0 months (an interpretation of "no minimum"). I confirmed the Rs 25,000 EPF ceiling headline in the saved Ministry of Labour PIB page (2311548).
Loaded (1 row): `retirement_contribution_rate` rate 24 = 12% + 12%, derived, of BASIC WAGES up to the ceiling (not of net or total household income), dated 17/09/2026 because the sources give no start date for the rates. **Today's rules were not applied retroactively**: no historical row is loaded.
Everything else (ceilings, ages, minimum pension, history) is in `extracts/10_*` only: the table can hold one `rate` per metric and cohort.
Seed comparison: 24.0 matches; the seed's citation names EPFO as publisher while the evidence here is PIB (proposed source correction, section 15).

### Dataset 12 (READY_WITH_CAVEATS, 4 target ranges)
**Copyright**: ASFA's PDFs say no reproduction in any form without prior written permission beyond Copyright Act fair dealing. The figures (dollar amounts) are loaded with attribution; whether redistributing them in the product needs ASFA's permission is a PO decision (D7). ASFA's site is behind a Cloudflare challenge: curl and WebFetch got 403; the browser pane (ordinary visitor) worked. **The ASFA PDFs are not on disk**: the register rows hold URL, byte size and sha256 computed in the browser; the figures were read with pdf.js in the browser and keyed/validated (48 weekly/annual pairs satisfy annual = weekly x 52.2 within a dollar). They were therefore not re-read by me from the PDF bytes.
Files:
| File | URL | Bytes | Retrieved | Licence / reuse (paraphrased) |
|---|---|---|---|---|
| asfa_June2026-RS-Tables_V3.pdf | https://www.superannuation.asn.au/wp-content/uploads/2026/09/June2026-RS-Tables_V3.pdf | 226265 | 03/10/2026 | ASFA states the material is copyright (c) ASFA; apart from fair dealing under the Copyright Act, reproduction or transmission in any form needs ASFA's |
| asfa_March2026-RS-Tables.pdf | https://www.superannuation.asn.au/wp-content/uploads/2026/06/March2026-RS-Tables.pdf | 224021 | 03/10/2026 | ASFA states the material is copyright (c) ASFA; apart from fair dealing under the Copyright Act, reproduction or transmission in any form needs ASFA's |
| asfa_ASFA_Retirement_Standard_Budgets_Dec-25_quarter.pdf | https://www.superannuation.asn.au/wp-content/uploads/2026/02/ASFA_Retirement_Standard_Budgets_Dec-25_quarter.p | 194352 | 03/10/2026 | ASFA states the material is copyright (c) ASFA; apart from fair dealing under the Copyright Act, reproduction or transmission in any form needs ASFA's |
| asfa_ASFA_Retirement_Standard_Budgets_Sept-25_quarter.pdf | https://www.superannuation.asn.au/wp-content/uploads/2025/12/ASFA_Retirement_Standard_Budgets_Sept-25_quarter. | 203797 | 03/10/2026 | ASFA states the material is copyright (c) ASFA; apart from fair dealing under the Copyright Act, reproduction or transmission in any form needs ASFA's |
| asfa_ASFA_Retirement_Standard_Budgets_Dec-24_quarter.pdf | https://www.superannuation.asn.au/wp-content/uploads/2025/03/ASFA_Retirement_Standard_Budgets_Dec-24_quarter.p | 234730 | 03/10/2026 | ASFA states the material is copyright (c) ASFA; apart from fair dealing under the Copyright Act, reproduction or transmission in any form needs ASFA's |
| asfa_summary_uploads2026-06_260223-ASFA-Retirement_Standard-Summary.pdf | https://www.superannuation.asn.au/wp-content/uploads/2026/06/260223-ASFA-Retirement_Standard-Summary.pdf | 284721 | 03/10/2026 | ASFA states the material is copyright (c) ASFA; apart from fair dealing under the Copyright Act, reproduction or transmission in any form needs ASFA's |
| asfa_summary_uploads2026-02_260223-ASFA-Retirement_Standard-Summary.pdf | https://www.superannuation.asn.au/wp-content/uploads/2026/02/260223-ASFA-Retirement_Standard-Summary.pdf | 276703 | 03/10/2026 | ASFA states the material is copyright (c) ASFA; apart from fair dealing under the Copyright Act, reproduction or transmission in any form needs ASFA's |
| asfa_ASFA-Retirement_Standard-Summary-2023.pdf | https://www.superannuation.asn.au/wp-content/uploads/2025/03/ASFA-Retirement_Standard-Summary-2023.pdf | 133482 | 03/10/2026 | ASFA states the material is copyright (c) ASFA; apart from fair dealing under the Copyright Act, reproduction or transmission in any form needs ASFA's |
| asfa_retirement_standard_webpage_2026-10-03.txt | https://www.superannuation.asn.au/consumers/retirement-standard/ | not stored | 03/10/2026 | ASFA states the material is copyright (c) ASFA; apart from fair dealing under the Copyright Act, reproduction or transmission in any form needs ASFA's |
Quarters obtained: June 2026 (current), March 2026, December 2025, September 2025, December 2024; **not obtained**: June 2025, March 2025 and anything before December 2024 (no official URL located; none guessed). The December 2024 file has no renter tables (added June 2025). The historical releases are examples, not a complete archive.
Loaded (4 target ranges, lump sum needed at 67, revised February 2026, homeowner): single modest $110,000, single comfortable $630,000, couple modest $120,000, couple comfortable $730,000 on `retirement_balance` (household types `single` and `couple_no_kids`, tiers 2 and 4, source `ASFA_STANDARD_2026`, model_version `asfa-2026`). Bound convention follows the existing seed: the modest band is 0 to the lump sum (the 0 is structural), the comfortable band starts at the lump sum with no upper bound. `effective_from` 01/02/2026: ASFA says only "revised February 2026", the first of the month is used because the column needs a date.
Not loaded: renter lump sums (single $340,000, couple $385,000; target ranges have no tenure dimension), weekly/annual budgets and section totals for five quarters (no metric), previous 2023 lump sums ($595,000/$690,000/$100,000/$100,000; history not loadable), age pension figures, assumptions beyond those quoted. Two ASFA typos are noted in the worker notes and were not used (June 2026 over-85 single modest "Health insurance" $41.07; modest couple "Total leisure" $189.95 vs $189.85).
Seed comparison: all four seeded lump sums match the sourced February 2026 figures.

## 12. Why history is extracted but not loaded

`loadPeerBenchmark` and `loadHealthyRange` keep one row per `(metric, cohort, statistic)` or per tier, ignore dataset status, `effective_to` and observation period, and the database has no unique key. A second release of the same figure would make the Twin's value undetermined. Therefore every file loads the LATEST release only, `checkNoDuplicateKeys` enforces one row per key, and history is delivered in `extracts/` (and is loadable the day the consumer filter P3 is approved - see the schema document). Releases available per dataset: ABS HIW survey years 2003-04 to 2019-20; ATO 2012-13 to 2023-24; ABS Finance and Wealth quarterly 1988 to June 2026; AIDIS 1992/2003/2013/2019 (2003, 2013, 2019 obtained); HCES 2011-12, 2022-23, 2023-24 (+ earlier rounds as reproduced); ASFA five quarters; APRA and EPFO as above.

## 13. Tests (offline)

`tests/unit/planningBenchmarksFirstLoad.test.ts` (35 tests): real route handlers and real migration-0011 DDL on a PGlite replica; the registry replayed from migrations 0012 and 0023 without any seed figures (12 datasets, 67 metrics, 0 values); column contracts; units; provenance; observation periods exist in the register; non-derived values equal the published figure exactly (with pure unit multipliers); derived values recomputed; one row per key; bands not recoded; target ranges; DTI not backfilled; NEEDS_MANUAL_CHECK rows excluded; drafts excluded; the builder and console runner exercised end to end (dry run writes nothing, real run writes the payload, a second run is refused). Named negative controls (each proven to fail): interpolated year, DTI backfill (three dates), 15-24 relabelled 18-24, altered published figure, $-thousand without x1000, nudged derived value, ASFA band edited, duplicate key, currency labelled as percentage, retrieval date removed, draft worksheet.

## 14. Independent re-reads (me, from the downloaded source files)

ABS 2019-20: Table 2.1 H13 = 1042, H16 = 36.9, H17 = 113.4, H23 = 1447.8, H24 = 2257.7; Table 2.4 G21 = 502.5, G23 = 694.4, G28 = 1245.2; Table 7.2 G10 = 579.2; Table 10.2 B9 = 83.8, C9 = 353.8, B10 = 34.6, J10 = 579.2; Table 10.1 B12 = 1700, C12 = 2465, B19 = 1536; HIW table 3.4 AB15 = 0.18; ATO sheet '12' J211 = 182781, K211 = 63339. APRA: 6x, 20%, 01/02/2026, all ADIs re-read on the APRA page. PIB 2311548 headline "Cabinet Raises EPF Wage Ceiling to Rs 25,000" read in the saved page. Not independently re-read: ASFA PDFs (not stored), AIDIS and HCES PDF tables (parsed from text layers by the worker), PIB gazette text.

## 15. Proposed source-row corrections (NOT applied; the existing `PUT /api/admin/benchmarks/sources/[id]` can edit these fields)

| Source (seed) | Field | Seed value | Evidence from this load |
|---|---|---|---|
| ABS_SIH_2019_20 and ABS_SIH_AGE_2019_20 | publication_date | 28/06/2022 | workbooks and release page: released 28/04/2022 (hidden page field 25/05/2022) |
| APRA_MACROPRUDENTIAL_2026 | publication_date | 01/02/2026 | notice published 27/11/2025; 01/02/2026 is the effective date |
| ATO_SUPER_2023_24 | publication_date | 01/04/2025 | data.gov.au resources last modified 12/06/2026 to 25/06/2026 (ATO publication date not captured) |
| AIDIS_2019 | publication_date | 01/09/2021 | press note dated 10/09/2021 |
| MOSPI_HCES_2023_24 | publication_date | 25/06/2024 | factsheet 27/12/2024; press note 30/01/2025 |
| EPFO_CONTRIBUTION_STRUCTURE | publisher / citation | EPFO | evidence is PIB / Ministry of Labour; EPFO pages were blocked; reference date 01/01/2026 in the seed is not an effective date |
| ASFA_STANDARD_2026 | licence_type | empty | ASFA copyright: permission needed beyond fair dealing |

## 16. Decisions needed from the PO (summary; full list in the schema document and runbook)

D1 route to load (console runner vs build the Admin bulk import); D2 history (needs consumer change P3); D3 ABS 15-24 vs app 18-24; D4 new metric definitions (P4) for per-capita consumption, share of indebted households, rule parameters; D5 treat the seed figures as superseded; D6 per-individual ATO super on a household metric, and whether to keep the median row; D7 ASFA redistribution permission; D8 approve or replace the two drafts (datasets 1 and 11); D9 apply the source-row corrections in section 15.

## 17. Per-dataset counts

| No | Extracted rows | OK | NEEDS_MANUAL_CHECK | Imported (values / cohorts / target ranges) |
|---|---|---|---|---|
| 1 | 0 (worksheet 198 keys) | - | - | 0 |
| 2 | 3,089 | 3,089 | 0 | 2 / 0 / 0 |
| 3 | 2,988 | 2,988 | 0 | 6 / 0 / 0 |
| 4 | 821 | 821 | 0 | 28 / 1 / 0 |
| 5 | 9 | 7 | 2 | 1 / 0 / 0 |
| 6 | 7,722 | 7,722 | 0 | 2 / 0 / 0 |
| 7 | 16,986 | 16,986 | 0 | 1 / 0 / 0 |
| 8 | 1,051 | 1,051 | 0 | 0 |
| 9 | 787 | 786 | 1 | 4 / 0 / 0 |
| 10 | 28 | 25 | 3 | 1 / 0 / 0 |
| 11 | 0 (draft 196 bands) | - | - | 0 |
| 12 | 373 | 373 | 0 | 0 / 0 / 4 |

NEEDS_MANUAL_CHECK list (6): dataset 5 `W2-016994` (period of the "8 per cent" investor share), `W2-016995` (definition and date of 155-180% household indebtedness); dataset 9 `D9-00087` (22.0% vs 22.4%); dataset 10 `D10-000004`, `D10-000005`, `D10-000021` (see section 11). None is imported.
