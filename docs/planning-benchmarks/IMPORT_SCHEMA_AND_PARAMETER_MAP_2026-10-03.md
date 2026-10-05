# Planning Benchmarks - import schema and parameter map

Date of inspection: 03/10/2026. Base: `origin/main` `bf2e101`. Branch: `feat/planning-benchmarks-first-load-20261003`.
Evidence label for everything below: **read from the repository code and migrations; replayed on an isolated in-memory PGlite database**. Nothing here was checked against DEV or production (no database was read or written).

Admin Architecture Standard (`docs/admin/FHIP_ADMIN_ARCHITECTURE_STANDARD.md` v1.0) was read in full before this work. This task adds **no Admin route, page, capability or RPC** and changes no Admin code. Capabilities affected: none (documentation, offline tooling, tests, CSV files). Standard clauses relevant to the *existing* surface and cited below: s2 (single `requireAdmin()` Super Admin gate, no separately named capability), s4 (four-layer enforcement - the existing routes enforce route/API only), s13 (fail-closed), s14 (no scope expansion - the proposals below are described, not built). No exception under s16 is requested.

---

## 1. What "the existing Admin import" actually is (important)

There are **two different "benchmark" surfaces** in Admin. Only the first is the one the PO named.

| | Planning Benchmarks (`/admin/benchmarks`) | Market Index Data (`/admin/investment-intelligence/market-index-data`) |
|---|---|---|
| Tables | `benchmark_sources`, `benchmark_datasets`, `benchmark_metric_definitions`, `benchmark_cohorts`, `benchmark_values`, `benchmark_target_ranges`, `benchmark_update_runs` (migration 0011, `0125`) | `ii_benchmark_*` (BENCH1, 0232-0241, 0251) |
| Purpose | peer / statutory / FHIP planning figures the Financial Twin compares a household with | dated index LEVEL series (NIFTY, S&P ...) for investment performance |
| Import | **no file upload.** JSON POST to the API routes only. The Admin screen has read-only tabs plus Validate / Activate / Retire (datasets) and Approve / Suspend / Reinstate (sources). | CSV/XLSX upload with three templates (`single_date_value`, `multi_key_date_value`, `provider_nse_tri_export`): `date,value` only |
| Can hold cohorts, bands, units, observation periods? | cohorts and bands yes (see below) | **no** - date/value pairs only |

So "upload the first load through the Admin import" has no literal meaning for Planning Benchmarks today: the Admin UI cannot import rows at all. The routes that insert rows exist (`POST /api/admin/benchmarks/{sources,datasets,cohorts,values,target-ranges}`) but no screen calls them (`AdminBenchmarksClient.tsx` only does GET plus the lifecycle actions). The Market Index Data upload cannot carry these datasets. **Decision for the PO (D1)** - see section 7. The files in `first_load/` are therefore prepared in the exact column shape of the existing POST bodies, with an offline builder and a console runner that call only the existing routes; no new route is added.

## 2. The existing POST contract, route by route

All five insert routes: `requireAdmin()` (Super Admin = a row in `admin_users`, plus country-confirmation gate), service-role `adminClient()`, errors mapped through `safeDbError` (422 for CHECK / NOT NULL / bad input, 409 unique, 422 FK). There is **no update and no delete route** for values, cohorts, target ranges or datasets (sources have a metadata `PUT` and the atomic status RPC `admin_transition_benchmark_source`, 0125).

| Route | Route-level validation (in the handler) | Everything else is database-enforced |
|---|---|---|
| `POST sources` | requires `source_name, source_type, publisher, source_title, citation_text`; forces `status='draft'`, `created_by=caller` | `source_type` in (official, industry, internal, licensed); `country_code` FK to `countries`; `quality_rating` in (high, medium, low); `status` set |
| `POST datasets` | requires `benchmark_source_id, dataset_name, version, benchmark_class`; forces `data_status='draft'` | `benchmark_class` in (observed_market, regulatory_statutory, fhip_planning, platform_peer); `evidence_level` in (official_statistical, regulatory, research_informed, platform_derived); **`unique (dataset_name, version)`**; no PUT: a dataset row cannot be edited once created |
| `POST cohorts` | requires `cohort_code, cohort_description, cohort_tier`; body inserted verbatim | `cohort_code` UNIQUE; `cohort_tier` 1-5; `urban_rural` in (urban, rural, metro, regional); other dimensions are free text |
| `POST values` | `rows[]` (or one object); each needs `dataset_id, metric_definition_id, statistic_type`; whole array inserted in ONE statement (atomic) | `statistic_type` in (mean, median, p10, p20, p25, p50, p75, p80, p90, target_min, target_max, threshold, rate, share); `value_numeric numeric(18,4)`; `original_currency char(3)`; no unique key; FK to dataset / cohort / metric |
| `POST target-ranges` | requires `metric_definition_id, band_label, band_tier`; body verbatim | `band_tier` 1-4; `direction` in (higher_better, lower_better, target_range); `lower_bound/upper_bound numeric(18,4)`; no unique key |

The body is inserted **verbatim**: any extra key (for example a provenance column) makes PostgREST reject the row. This is why the files carry provenance in `x_`-prefixed columns that the builder strips.

### 2.1 Columns of `benchmark_values` (what a value row can hold)

`dataset_id`, `cohort_id` (null = country-wide), `metric_definition_id`, `statistic_type`, `value_numeric`, `value_text`, `unit`, `original_currency`, `base_date`, `is_derived`, `derivation_method`, `confidence_score numeric(5,2)`, `effective_from date default current_date`, `effective_to`, `version int default 1`.

**What it cannot hold:** an observation-period START, a release name, a source file/table/cell, a retrieval date, a price basis, or a population label. The only date columns are `base_date` (used as the as-at / reference date), `effective_from` / `effective_to` (when the figure applies inside FHIP) and `dataset.source_period` (free text, one per dataset, not editable after creation). The source's period and publication date live on `benchmark_sources`. Handling used in the files: `base_date` = reference date (or period end), `effective_from` = release date, `value_text` carries a compact provenance string (release, observation period, file, table and cell) because the live Twin never reads `value_text`, and the full provenance is in `PROVENANCE_REGISTER.csv/.md` and the `extracts/` files. This is a disclosed use of `value_text`, not a schema feature.

### 2.2 Metric definitions, units and the closed parameter list

A value or a target range can only attach to one of the **67 seeded `benchmark_metric_definitions`** (migration 0012; mirrored in `lib/engines/twin/metricCatalogue.ts`). **No route creates or edits a metric definition** and the Admin API does not even list them. Units are the closed set currency / percentage / months / ratio / count / years / days, and each metric has exactly one unit; the files require `unit == the metric's unit` (check `checkUnits`). Percent figures are stored as percentage points (56.2, not 0.562), following the existing seed.

Consequence: **any published measure that has no one of these 67 codes is unrepresentable** (for example mean super balance by sex, share of wealth held by the top quintile, per-capita monthly consumption, wage ceiling in rupees). Those figures are extracted in full to `extracts/` but are not importable (section 5).

### 2.3 Dimensions (`benchmark_cohorts`)

A cohort holds: `country_code`, `region_code`, `urban_rural`, `age_band`, `income_band`, `household_type`, `life_stage`, `housing_tenure`, `employment_type`, `dependant_band`, `financial_dna_code`, `cross_border_flag`, `cohort_tier`, `sample_size`, `cohort_description`. There is **no sex dimension, no state column other than `region_code`, no per-cohort observation period, no income-definition field**. A cohort belongs to one dataset (`dataset_id`) but any dataset's values may reference it.

How the live Twin uses them (`lib/services/twinCohortMatching.ts`): the household's own band codes (`AGE_18_24 ... AGE_75_PLUS`, `taxonomy.ts`) are matched with exact equality against `age_band`, `household_type`, `life_stage`, `dependant_band`, `urban_rural`. A cohort whose `age_band` is the SOURCE's band (for example the ABS band `15-24`) will never equal `AGE_18_24`. The files preserve the source's band edges (rule: no recoding); the consequence is described in section 7 (D3).

### 2.4 Effective dating, versioning, approval

- `benchmark_sources.status` and `benchmark_datasets.data_status`: draft -> under_review -> approved -> active -> superseded / suspended / archived. Sources move through the atomic audited RPC (Approve / Suspend / Reinstate in the UI). Datasets are activated by `POST datasets/[id]/activate`, which runs `validateDatasetForActivation`: the source must be approved or active and have a citation and a period; the dataset needs `source_period`, `geography_level`, `statistic_coverage`; for `observed_market` and `regulatory_statutory` classes at least one `benchmark_values` row must exist. **For class `fhip_planning` (datasets 1, 11, 12) no value or target-range check exists at all**, so an empty `fhip_planning` dataset validates and activates.
- Audit log (`benchmark_update_runs`): written on activate, retire, source transitions. **A values / cohorts / target-ranges insert writes no audit row.** The import is unaudited by the application; the console runner therefore writes its own log file (created ids + rollback SQL).
- Versioning: `unique (dataset_name, version)` on datasets; `benchmark_values.version` and `effective_from/to` exist but nothing enforces or reads them.

### 2.5 Two consumer behaviours that constrain what may be loaded (found in `lib/services/twinBenchmarkRetrieval.ts`)

1. `loadPeerBenchmark` selects `benchmark_values` by `(metric_definition_id, cohort_id)` only. It does **not** filter on dataset status, `effective_to`, dataset version or observation period, and it keeps ONE row per `statistic_type` (a `Map` set, last row wins, unspecified order). Therefore: (a) values sit live for the Twin as soon as they are inserted, whatever the dataset's `data_status`; (b) two rows with the same `(metric, cohort, statistic)` - for example the 2019-20 and 2017-18 releases of the same figure - make the figure the Twin shows undetermined. **Historical releases must not be loaded into these tables with the current consumer.** The files load the latest release only (`checkNoDuplicateKeys` enforces one row per key across all files); history is delivered as extraction files and as a not-importable set (D2).
2. `loadHealthyRange` (target ranges) has the same property for bands: no effective-date or version filter, and `healthyBandFor` picks the first match for a tier. A second ASFA quarter for the same household type and tier is not safe to load either.

Smallest changes (described only, not built): add `.is('effective_to', null)` and a join filter on `benchmark_datasets.data_status = 'active'` to both queries, and an `effective_from <= today` predicate; make `(dataset_id, cohort_id, metric_definition_id, statistic_type, effective_from)` unique by migration. Either change touches the live Twin and a migration, so it needs PO approval and its own certification; it is **not** done here.

### 2.6 What the import has no way to do

- No bulk or file upload for these tables; no Admin screen calls the insert routes (section 1).
- No metric creation (Admin API cannot list or create `benchmark_metric_definitions`); the metric ids needed to build a body come from one read-only SQL query (`scripts/planning-benchmarks/export_metric_ids.sql`).
- No UPDATE or DELETE of values, cohorts, target ranges or datasets. Rollback is therefore SQL, generated by the runner from the ids it created (no application rollback exists).
- `GET values` is limited to 200 rows and `GET target-ranges` to 300 (newest first / by tier), and the screen does not filter by dataset: verify by `?dataset_id=` or SQL, not by looking at the tab.
- No idempotency: no unique key on values or target ranges, so a second run duplicates every row. The runner refuses to load a dataset that already has values.

---

## 3. Registered datasets and the parameters the app expects

The 12 datasets are registered by migrations 0012 (11 datasets) and 0023 (dataset 1). The same migrations also contain **seed figures** for several of them (listed in the last column). The PO reports the figures as empty on DEV; if the seed ran, loading these files would duplicate rows. The runner pre-flight blocks a dataset that already has values, and the runbook starts with a read-only count query. Whether DEV holds the seed figures was **not verified** (no DB access).

| No | Registered dataset (v1.0) | Class | Source row it cites | Parameters the app expects (metric / statistic / cohort) | Seed figures in migrations |
|---|---|---|---|---|---|
| 1 | FHIP dependant-band household benchmark model | fhip_planning | FHIP_PLANNING_V1 | 11 metrics x 18 cohorts = **198 keys**, statistic `mean`, `is_derived=true`: essential_expense_ratio, housing_cost_ratio, discretionary_expense_ratio, fixed_commitment_ratio, total_expense_ratio, savings_rate, expense_growth_12m, monthly_surplus, surplus_margin, emergency_fund_months, income_interruption_coverage x cohorts `{AU_YOUNG_FAMILY, AU_ESTABLISHED_FAMILY, IN_URBAN_YOUNG_FAMILY, IN_URBAN_ESTABLISHED_FAMILY, IN_RURAL_YOUNG_FAMILY, IN_RURAL_ESTABLISHED_FAMILY}` x dependant band `{1 (_1DEP), 2 (base), 3+ (_3PLUSDEP)}` | 198 values (0023) |
| 2 | AU household asset composition | observed_market | ABS_SIH_2019_20 | `property_concentration` / `mean` / country-wide; the other assets_networth metrics (`total_assets`, `liquid_asset_share`, `productive_asset_ratio`, `depreciating_asset_ratio`, `investable_assets_ratio`) are the only places a composition could land | 1 (property 56.2) |
| 3 | AU household wealth distribution | observed_market | ABS_SIH_2019_20 | `net_worth` / `median`, `mean`, `p10..p90` as published / country-wide (9 life-stage cohorts exist but no value is seeded) | 4 (median, mean, p20, p80) |
| 4 | AU net worth and income by age band | observed_market | ABS_SIH_AGE_2019_20 | `net_worth` `mean`/`median` and `gross_household_income` per age cohort `AU_AGE_18_24 ... AU_AGE_75_PLUS` | 14 |
| 5 | AU high-DTI mortgage threshold | regulatory_statutory | APRA_MACROPRUDENTIAL_2026 | `debt_to_income` / `threshold` / country-wide | 1 (6.0, effective 01/02/2026) |
| 6 | AU average superannuation balance | observed_market | ATO_SUPER_2023_24 | `retirement_balance` / `mean` / country-wide | 1 (183,000) |
| 7 | AU household debt context | observed_market | ABS_SIH_2019_20 | declared coverage "share of indebted households"; **no metric code can hold it**; closest are `debt_to_asset_ratio`, `debt_to_income`, `debt_service_ratio` (different definitions - see section 5) | none |
| 8 | India household consumption expenditure (rural/urban) | observed_market | MOSPI_HCES_2023_24 | **none, deliberately** (0012 section 5e): no metric is per-capita monthly consumption | none |
| 9 | India household assets and debt (rural/urban) | observed_market | AIDIS_2019 | `total_assets`, `liquid_asset_share` / `mean` / cohorts `IN_URBAN_ALL`, `IN_RURAL_ALL` | 4 |
| 10 | India EPF/EPS contribution structure | regulatory_statutory | EPFO_CONTRIBUTION_STRUCTURE | `retirement_contribution_rate` / `rate` / country-wide | 1 (24.0) |
| 11 | FHIP Planning Benchmarks v1.0 | fhip_planning | FHIP_PLANNING_V1 | **196 target-range bands** (`benchmark_target_ranges`), tiers 1-4, 48 metrics (0012 sections 7 and 8.6) | 196 |
| 12 | AU ASFA retirement standard | fhip_planning | ASFA_STANDARD_2026 | `retirement_balance` target ranges, household_type `single` / `couple_no_kids`, band tiers 2 (modest) and 4 (comfortable) | 4 ranges |

### 3.1 Required keys for the importable shapes

`values.csv` (one row = one `benchmark_values` row):

| Column group | Columns |
|---|---|
| natural keys (resolved to ids) | `dataset_name`, `dataset_version`, `cohort_code` (blank = country-wide), `metric_code` |
| database columns (sent) | `statistic_type, value_numeric, value_text, unit, original_currency, base_date, is_derived, derivation_method, confidence_score, effective_from, effective_to, version` |
| provenance (file only, never sent) | `x_obs_id, x_release, x_obs_period_start, x_obs_period_end, x_reference_date, x_source_file, x_source_locator, x_retrieval_date` |

`cohorts.csv`: `dataset_name, dataset_version` + every `benchmark_cohorts` column + `x_` provenance. `target_ranges.csv`: `metric_code, source_name` + every `benchmark_target_ranges` column + `x_` provenance. `sources.csv` / `datasets.csv`: only when a new source or new dataset version is needed.

Dates in these machine columns are ISO `yyyy-mm-dd` (the database format). Everything written for people (this document, the register, the runbook) is day-first.

---

Additional provenance column used by the files: `x_unit_multiplier` (1, 1000 or 1000000) records a pure unit conversion such as the ABS $'000 to dollars; it is not sent to the API and the value is not marked derived.

## 4. Per-dataset handling (summary; the outcome per dataset is in `first_load/PROVENANCE_REGISTER.md`)

Outcome in one line each: 1 draft worksheet only; 2 two values (total assets, derived property share); 3 six values (net worth mean, median, P10, P20, P80, P90); 4 28 values + 1 cohort (ABS bands, weekly income x52 derived); 5 one value (6x, 01/02/2026); 6 two values (per-individual ATO mean and median); 7 one value (median debt-to-asset, households with debt); 8 nothing importable (no per-capita metric); 9 four values; 10 one value (24% of basic wages); 11 draft of 196 bands; 12 four ASFA target ranges.

See section 5 for the shapes that cannot be held and section 6 for the proposals. The final status of each dataset (READY_TO_IMPORT / READY_WITH_CAVEATS / DRAFT_NEEDS_PO_APPROVAL / BLOCKED) is the table at the top of `PROVENANCE_REGISTER.md`.

## 5. Shapes the existing import cannot represent without distortion (STOP list)

These are stated once here; the register repeats the specifics per dataset.

1. **Anything with no metric code** (section 2.2): flagged `NOT_IMPORTABLE_NO_METRIC` per measure in the register; data kept in `extracts/`.
2. **Sex, state, income-definition, population-coverage, price-basis dimensions**: no column. Rows are not flattened into a sibling dimension; they stay in `extracts/` only.
3. **More than one observation period or release of the same figure** (consumer behaviour 2.5.1): only the latest release is importable; earlier releases are `HISTORY_NOT_LOADABLE`.
4. **Multi-parameter rule sets** (dataset 10: employee rate, employer split, ceilings, ages, minimum pension): the table can hold one `rate` row per `(metric, cohort)`. Only the single combined statutory rate fits (as seeded); the rest is extraction only.
5. **Per-capita vs household** (dataset 8): no metric. The 0012 header's own warning applies: a per-person monthly figure must not be loaded as a household figure.
6. **Aggregate national-accounts ratios vs a household's own ratio** (dataset 7): different population and definition; see register for any mapping that was refused.

## 6. Smallest proposed changes (described only; no migration applied, nothing built)

| # | Change | Why | Size |
|---|---|---|---|
| P1 | Admin-side bulk import for Planning Benchmarks (one POST that accepts natural keys and runs inside one transaction with an audit row), under a named capability | the import has no screen, no audit row, no id-free input, no rollback | new route + RPC + capability; Admin Standard s2/s4/s6/s7 apply; needs PO approval |
| P2 | `GET /api/admin/benchmarks/metric-definitions` (read-only, `requireAdmin`) | the Admin API cannot list metric ids | ~15 lines, but it is a new Admin route (tests per s4) - not built |
| P3 | Consumer filter: `data_status='active'`, `effective_to is null`, `effective_from <= today` in `loadPeerBenchmark` / `loadHealthyRange` | makes history and drafts loadable safely | small code change in the live Twin path; needs its own tests |
| P4 | New metric definitions for per-capita consumption, mean super balance by age band, share of indebted households, wage-ceiling parameters, etc. | unlocks datasets 7, 8, parts of 2, 3, 6, 10 | one forward-only migration (data insert) |
| P5 | A rules table for statutory parameter sets (dataset 10) | multi-parameter, dated rules do not fit one `rate` | new table |

## 7. Decisions for the Product Owner

- **D1** How should the first load reach DEV? (a) the console runner against the existing routes (provided, no code change); (b) build P1; (c) the PO applies the generated payload through SQL. The runner is offline-tested against the real route handlers on a PGlite replica, **not** against a running server.
- **D2** History. Approve P3 (and then history can be loaded as dataset versions) or accept latest-only.
- **D3** Age bands. The ABS bands are preserved as published. Where an ABS band edge differs from the app's band (for example `15-24` vs the app's `18-24`), an age-banded household in the app's band finds no exact cohort and falls through to the country-wide row. Approve an explicit, disclosed mapping or leave it.
- **D4** New metric definitions (P4) for the unrepresentable measures.
- **D5** Whether the repo's existing seed figures (0012, 0023) should be treated as superseded by the sourced figures (the register compares them figure by figure where both exist).
