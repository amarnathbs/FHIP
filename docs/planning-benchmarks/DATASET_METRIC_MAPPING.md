# Planning Benchmarks: which metric belongs to which dataset (the mapping)

Prepared 07/10/2026 on branch `feat/pb-dataset-metric-mapping-20261007` (base `52253bb`). Not pushed. Migration `0277` is written, replayed on an isolated in-memory Postgres, and **not applied anywhere** (the Product Owner applies it on DEV, see `po_apply_mapping/README.md`).

This file is the reviewable list that the migration seeds. A test (`tests/unit/planningBenchmarkDatasetMetricMapping.test.ts`) reads this table and the migration's seed and fails if they differ in any row, any kind of file or any evidence text.

## 1. What the mapping is

Until now the database let any open dataset accept any registered metric (67 metrics, 12 datasets, 11 open), so an upload could put a metric into a dataset it does not belong to. The mapping records, per dataset, which metrics it may receive and for which kind of file:

- **values**: an observed values file (measured figures: a median, a mean, a threshold, a rate);
- **target ranges**: a planning target ranges file (bands such as critical, healthy, strong).

A row in an upload file is refused unless its metric is mapped to its dataset for its kind of file. Cohort files carry no metric and are not affected. Allowed statistic types are **not** constrained per pair: the evidence (section 5) shows the same metric carrying different statistics in different loads (`net_worth` holds mean, median, P20 and P80 on DEV), so a per-pair statistic list would be a guess.

## 2. How each pair was decided (evidence, not guesses)

Three sources, in this order of weight:

1. **DEV today** (read-only, host `vqycarelcoijzwlpkpcz`, 07/10/2026): the metrics each dataset already holds in `benchmark_values` (224 values in 8 datasets with figures), and the bands in `benchmark_target_ranges` (200 bands; they have no dataset column, so a band is tied to a dataset through its source: 4 bands cite the ASFA source, 196 cite no source and are the draft Planning Benchmarks v1.0 set).
2. **The first-load files** under `docs/planning-benchmarks/first_load/` (the PO-approved figures-to-datasets mapping) and `IMPORT_SCHEMA_AND_PARAMETER_MAP_2026-10-03.md` section 3 (the parameters each dataset expects) with the register `PROVENANCE_REGISTER.md` (which measures were refused).
3. **The dataset names and sources** (class, source row) to resolve doubt.

A pair is seeded only when at least one of 1 or 2 supports it and the register does not refuse it. Where the sources disagree, the pair is **not** seeded and is listed in section 4 for the Product Owner.

## 3. The seeded mapping (71 pairs, 11 datasets)

Kinds: `values` = observed values file, `target ranges` = planning target ranges file. `unit` is the unit the metric is defined in (it must still match on every uploaded value). Version is `1.0` for every dataset.

| dataset | version | metric_code | unit | kind | evidence |
|---|---|---|---|---|---|
| FHIP dependant-band household benchmark model | 1.0 | discretionary_expense_ratio | percentage | values | DEV holds 18 live values (6 cohorts x 3 dependant bands) and the schema map lists these 11 metrics |
| FHIP dependant-band household benchmark model | 1.0 | emergency_fund_months | months | values | DEV holds 18 live values (6 cohorts x 3 dependant bands) and the schema map lists these 11 metrics |
| FHIP dependant-band household benchmark model | 1.0 | essential_expense_ratio | percentage | values | DEV holds 18 live values (6 cohorts x 3 dependant bands) and the schema map lists these 11 metrics |
| FHIP dependant-band household benchmark model | 1.0 | expense_growth_12m | percentage | values | DEV holds 18 live values (6 cohorts x 3 dependant bands) and the schema map lists these 11 metrics |
| FHIP dependant-band household benchmark model | 1.0 | fixed_commitment_ratio | percentage | values | DEV holds 18 live values (6 cohorts x 3 dependant bands) and the schema map lists these 11 metrics |
| FHIP dependant-band household benchmark model | 1.0 | housing_cost_ratio | percentage | values | DEV holds 18 live values (6 cohorts x 3 dependant bands) and the schema map lists these 11 metrics |
| FHIP dependant-band household benchmark model | 1.0 | income_interruption_coverage | months | values | DEV holds 18 live values (6 cohorts x 3 dependant bands) and the schema map lists these 11 metrics |
| FHIP dependant-band household benchmark model | 1.0 | monthly_surplus | currency | values | DEV holds 18 live values (6 cohorts x 3 dependant bands) and the schema map lists these 11 metrics |
| FHIP dependant-band household benchmark model | 1.0 | savings_rate | percentage | values | DEV holds 18 live values (6 cohorts x 3 dependant bands) and the schema map lists these 11 metrics |
| FHIP dependant-band household benchmark model | 1.0 | surplus_margin | percentage | values | DEV holds 18 live values (6 cohorts x 3 dependant bands) and the schema map lists these 11 metrics |
| FHIP dependant-band household benchmark model | 1.0 | total_expense_ratio | percentage | values | DEV holds 18 live values (6 cohorts x 3 dependant bands) and the schema map lists these 11 metrics |
| AU household asset composition | 1.0 | property_concentration | percentage | values | DEV holds 1 live value and first-load file 02 carries it |
| AU household asset composition | 1.0 | total_assets | currency | values | first-load file 02 (ABS 2019-20 Table 2.4), not yet loaded on DEV |
| AU household wealth distribution | 1.0 | net_worth | currency | values | DEV holds 4 live values (median, mean, p20, p80) and first-load file 03 carries 6 |
| AU net worth and income by age band | 1.0 | gross_household_income | currency | values | DEV holds 7 live values per metric (one per age cohort) and first-load file 04 |
| AU net worth and income by age band | 1.0 | net_worth | currency | values | DEV holds 7 live values per metric (one per age cohort) and first-load file 04 |
| AU high-DTI mortgage threshold | 1.0 | debt_to_income | ratio | values | DEV holds 1 live value (threshold) and first-load file 05 |
| AU average superannuation balance | 1.0 | retirement_balance | currency | values | DEV holds 1 live value and first-load file 06 |
| AU household debt context | 1.0 | debt_to_asset_ratio | percentage | values | first-load file 07 only. The dataset is superseded, so it is closed to upload |
| India household assets and debt (rural/urban) | 1.0 | total_assets | currency | values | DEV holds 2 live values (urban, rural) and first-load file 09 |
| India household assets and debt (rural/urban) | 1.0 | debt_to_asset_ratio | percentage | values | first-load file 09 (2 rows), not yet loaded on DEV |
| India EPF/EPS contribution structure | 1.0 | retirement_contribution_rate | percentage | values | DEV holds 1 live value (rate) and first-load file 10 |
| FHIP Planning Benchmarks v1.0 | 1.0 | asset_class_diversification | count | target ranges | DEV holds 4 live bands (no source recorded) and draft file 11 carries them |
| FHIP Planning Benchmarks v1.0 | 1.0 | country_concentration | percentage | target ranges | DEV holds 4 live bands (no source recorded) and draft file 11 carries them |
| FHIP Planning Benchmarks v1.0 | 1.0 | credit_utilization | percentage | target ranges | DEV holds 4 live bands (no source recorded) and draft file 11 carries them |
| FHIP Planning Benchmarks v1.0 | 1.0 | currency_mismatch | percentage | target ranges | DEV holds 4 live bands (no source recorded) and draft file 11 carries them |
| FHIP Planning Benchmarks v1.0 | 1.0 | debt_service_ratio | percentage | target ranges | DEV holds 4 live bands (no source recorded) and draft file 11 carries them |
| FHIP Planning Benchmarks v1.0 | 1.0 | debt_to_income | ratio | target ranges | DEV holds 4 live bands (no source recorded) and draft file 11 carries them |
| FHIP Planning Benchmarks v1.0 | 1.0 | depreciating_asset_ratio | percentage | target ranges | DEV holds 4 live bands (no source recorded) and draft file 11 carries them |
| FHIP Planning Benchmarks v1.0 | 1.0 | discretionary_expense_ratio | percentage | target ranges | DEV holds 4 live bands (no source recorded) and draft file 11 carries them |
| FHIP Planning Benchmarks v1.0 | 1.0 | emergency_fund_months | months | target ranges | DEV holds 4 live bands (no source recorded) and draft file 11 carries them |
| FHIP Planning Benchmarks v1.0 | 1.0 | essential_expense_ratio | percentage | target ranges | DEV holds 4 live bands (no source recorded) and draft file 11 carries them |
| FHIP Planning Benchmarks v1.0 | 1.0 | fixed_commitment_ratio | percentage | target ranges | DEV holds 4 live bands (no source recorded) and draft file 11 carries them |
| FHIP Planning Benchmarks v1.0 | 1.0 | goal_allocation_burden | percentage | target ranges | DEV holds 4 live bands (no source recorded) and draft file 11 carries them |
| FHIP Planning Benchmarks v1.0 | 1.0 | goal_contribution_adequacy | percentage | target ranges | DEV holds 4 live bands (no source recorded) and draft file 11 carries them |
| FHIP Planning Benchmarks v1.0 | 1.0 | goal_progress | percentage | target ranges | DEV holds 4 live bands (no source recorded) and draft file 11 carries them |
| FHIP Planning Benchmarks v1.0 | 1.0 | high_interest_debt_share | percentage | target ranges | DEV holds 4 live bands (no source recorded) and draft file 11 carries them |
| FHIP Planning Benchmarks v1.0 | 1.0 | home_loan_lvr | percentage | target ranges | DEV holds 4 live bands (no source recorded) and draft file 11 carries them |
| FHIP Planning Benchmarks v1.0 | 1.0 | housing_cost_ratio | percentage | target ranges | DEV holds 4 live bands (no source recorded) and draft file 11 carries them |
| FHIP Planning Benchmarks v1.0 | 1.0 | immediate_liquidity_ratio | ratio | target ranges | DEV holds 4 live bands (no source recorded) and draft file 11 carries them |
| FHIP Planning Benchmarks v1.0 | 1.0 | income_concentration | percentage | target ranges | DEV holds 4 live bands (no source recorded) and draft file 11 carries them |
| FHIP Planning Benchmarks v1.0 | 1.0 | income_interruption_coverage | months | target ranges | DEV holds 4 live bands (no source recorded) and draft file 11 carries them |
| FHIP Planning Benchmarks v1.0 | 1.0 | income_protection_alignment | ratio | target ranges | DEV holds 4 live bands (no source recorded) and draft file 11 carries them |
| FHIP Planning Benchmarks v1.0 | 1.0 | investable_assets_ratio | percentage | target ranges | DEV holds 4 live bands (no source recorded) and draft file 11 carries them |
| FHIP Planning Benchmarks v1.0 | 1.0 | investment_contribution_rate | percentage | target ranges | DEV holds 4 live bands (no source recorded) and draft file 11 carries them |
| FHIP Planning Benchmarks v1.0 | 1.0 | largest_holding_concentration | percentage | target ranges | DEV holds 4 live bands (no source recorded) and draft file 11 carries them |
| FHIP Planning Benchmarks v1.0 | 1.0 | life_cover_adequacy | percentage | target ranges | DEV holds 4 live bands (no source recorded) and draft file 11 carries them |
| FHIP Planning Benchmarks v1.0 | 1.0 | liquid_asset_share | percentage | target ranges | DEV holds 4 live bands (no source recorded) and draft file 11 carries them |
| FHIP Planning Benchmarks v1.0 | 1.0 | major_asset_coverage | percentage | target ranges | DEV holds 4 live bands (no source recorded) and draft file 11 carries them |
| FHIP Planning Benchmarks v1.0 | 1.0 | near_liquid_coverage | months | target ranges | DEV holds 4 live bands (no source recorded) and draft file 11 carries them |
| FHIP Planning Benchmarks v1.0 | 1.0 | net_worth_growth_12m | percentage | target ranges | DEV holds 4 live bands (no source recorded) and draft file 11 carries them |
| FHIP Planning Benchmarks v1.0 | 1.0 | offshore_liquidity_access | days | target ranges | DEV holds 4 live bands (no source recorded) and draft file 11 carries them |
| FHIP Planning Benchmarks v1.0 | 1.0 | on_track_goal_percentage | percentage | target ranges | DEV holds 4 live bands (no source recorded) and draft file 11 carries them |
| FHIP Planning Benchmarks v1.0 | 1.0 | passive_income_ratio | percentage | target ranges | DEV holds 4 live bands (no source recorded) and draft file 11 carries them |
| FHIP Planning Benchmarks v1.0 | 1.0 | policy_completeness | percentage | target ranges | DEV holds 4 live bands (no source recorded) and draft file 11 carries them |
| FHIP Planning Benchmarks v1.0 | 1.0 | portfolio_cost_ratio | percentage | target ranges | DEV holds 4 live bands (no source recorded) and draft file 11 carries them |
| FHIP Planning Benchmarks v1.0 | 1.0 | positive_cashflow_consistency | percentage | target ranges | DEV holds 4 live bands (no source recorded) and draft file 11 carries them |
| FHIP Planning Benchmarks v1.0 | 1.0 | productive_asset_ratio | percentage | target ranges | DEV holds 4 live bands (no source recorded) and draft file 11 carries them |
| FHIP Planning Benchmarks v1.0 | 1.0 | projected_retirement_readiness | percentage | target ranges | DEV holds 4 live bands (no source recorded) and draft file 11 carries them |
| FHIP Planning Benchmarks v1.0 | 1.0 | property_concentration | percentage | target ranges | DEV holds 4 live bands (no source recorded) and draft file 11 carries them |
| FHIP Planning Benchmarks v1.0 | 1.0 | refinance_exposure_24m | percentage | target ranges | DEV holds 4 live bands (no source recorded) and draft file 11 carries them |
| FHIP Planning Benchmarks v1.0 | 1.0 | remittance_burden | percentage | target ranges | DEV holds 4 live bands (no source recorded) and draft file 11 carries them |
| FHIP Planning Benchmarks v1.0 | 1.0 | retirement_contribution_rate | percentage | target ranges | DEV holds 8 live bands (no source recorded) and draft file 11 carries them |
| FHIP Planning Benchmarks v1.0 | 1.0 | savings_rate | percentage | target ranges | DEV holds 4 live bands (no source recorded) and draft file 11 carries them |
| FHIP Planning Benchmarks v1.0 | 1.0 | speculative_asset_ratio | percentage | target ranges | DEV holds 4 live bands (no source recorded) and draft file 11 carries them |
| FHIP Planning Benchmarks v1.0 | 1.0 | surplus_margin | percentage | target ranges | DEV holds 4 live bands (no source recorded) and draft file 11 carries them |
| FHIP Planning Benchmarks v1.0 | 1.0 | total_expense_ratio | percentage | target ranges | DEV holds 4 live bands (no source recorded) and draft file 11 carries them |
| FHIP Planning Benchmarks v1.0 | 1.0 | tpd_cover_adequacy | percentage | target ranges | DEV holds 4 live bands (no source recorded) and draft file 11 carries them |
| FHIP Planning Benchmarks v1.0 | 1.0 | unsecured_debt_ratio | percentage | target ranges | DEV holds 4 live bands (no source recorded) and draft file 11 carries them |
| FHIP Planning Benchmarks v1.0 | 1.0 | variable_rate_exposure | percentage | target ranges | DEV holds 4 live bands (no source recorded) and draft file 11 carries them |
| AU ASFA retirement standard | 1.0 | retirement_balance | currency | target ranges | DEV holds 4 live bands cited to the ASFA source and first-load file 12 |

Per dataset, in plain terms:

| Dataset | Status on DEV | Class | Pairs | Kind |
|---|---|---|---|---|
| FHIP dependant-band household benchmark model | active | fhip_planning | 11 | values |
| AU household asset composition | active | observed_market | 2 | values |
| AU household wealth distribution | active | observed_market | 1 | values |
| AU net worth and income by age band | active | observed_market | 2 | values |
| AU high-DTI mortgage threshold | active | regulatory_statutory | 1 | values |
| AU average superannuation balance | active | observed_market | 1 | values |
| AU household debt context | superseded | observed_market | 1 | values |
| India household assets and debt (rural/urban) | active | observed_market | 2 | values |
| India EPF/EPS contribution structure | active | regulatory_statutory | 1 | values |
| FHIP Planning Benchmarks v1.0 | active | fhip_planning | 48 | target ranges |
| AU ASFA retirement standard | active | fhip_planning | 1 | target ranges |
| India household consumption expenditure (rural/urban) | draft | observed_market | 0 | none (needs PO input, section 4) |

## 4. Needs Product Owner input (not guessed, not seeded)

1. **India household consumption expenditure (rural/urban)** (draft, observed). No metric is seeded. The schema map (section 3, row 8, and the register) records that the only published measure is a per-person monthly amount and **no registered metric holds it** (proposal P4: new metric definitions). Until a metric exists and is mapped, an upload to this dataset is refused with a message saying no metric is mapped. Decision: register the metric (a migration) or leave the dataset empty.
2. **`liquid_asset_share` in India household assets and debt (rural/urban)**. DEV holds 2 live values for it (the migration 0012 seed figures), but the register (dataset 9) **refused** this pairing because financial assets are not liquid assets. The two sources disagree, so the pair is not seeded: a corrected or refreshed upload of `liquid_asset_share` into this dataset is refused until you decide. Decision: map it (the figures stay as they are) or retire the seed figures.
3. **`debt_to_asset_ratio` in AU household debt context.** Seeded on the register's evidence (dataset 7, one measure fits), but the dataset is **superseded**, so it is closed to upload regardless. Decision: only if you want a debt dataset reopened. Other candidates the schema map names for this dataset (`debt_to_income`, `debt_service_ratio`) are not seeded because their definitions differ (register dataset 7).
4. **Other asset-share metrics for AU household asset composition** (`liquid_asset_share`, `productive_asset_ratio`, `depreciating_asset_ratio`, `investable_assets_ratio`). The schema map lists them as "the only places a composition could land", but the register (dataset 2) refused them (ABS asset groups do not equal the metric definitions). Not seeded.
5. **Observed values for the two FHIP planning datasets.** FHIP Planning Benchmarks v1.0 is mapped for target ranges only (it holds no value on DEV), and the FHIP dependant-band model for values only. If either should also take the other kind of file, add it on the Upload tab (section 6).
6. **FHIP dependant-band household benchmark model**: the register calls its 198 values a **draft with no defined methodology**, yet DEV holds 198 live seed values (migration 0023). The mapping follows what DEV holds; whether those figures are approved is a separate decision (register dataset 1).
7. **Metrics mapped to no dataset (12 of 67):** `cross_border_retirement_coverage`, `currency_concentration`, `debt_at_retirement`, `geographic_diversification`, `income_growth_12m`, `liquid_net_worth`, `net_household_income`, `net_worth_to_income`, `premium_burden`, `priority_alignment`, `retirement_balance_to_income`, `retirement_funding_gap`. No DEV figure, no band and no first-load row uses them, so there is nothing to base a pairing on. They stay unreachable by an upload until someone maps them.

## 5. Evidence that statistic types are not constrained

From DEV (`benchmark_values`): `net_worth` carries mean, median, p20 and p80; `property_concentration` is `mean` on DEV but `share` in the first-load file; `debt_to_income` is `threshold`; `retirement_contribution_rate` is `rate`; every FHIP model metric is `mean`. The statistics differ by figure, not by metric, so the table has no statistic column. The closed list of 14 statistic types still applies to every row.

## 6. Maintaining the mapping

On the Upload tab, section "Dataset metric mapping" (design: `UPLOAD_DESIGN.md` section 14). A holder of the existing activate permission can add a metric, change the kinds of file, or remove a pair, each with a reason and a confirmation, each recorded in an append-only audit trail. A pair that still has live figures needs a stronger warning; live figures are never deleted. The exact SQL, if you prefer it, is in `po_apply_mapping/README.md`.
