# Planning Benchmarks: production first load - PO runbook

Written 07/10/2026 for the Product Owner. Branch `feat/pb-production-first-load-20261007`. Nothing in this runbook has been run against production: every SQL block below was executed on an isolated copy of the database (PGlite, the real migrations 0001 to 0278 plus the seed) by a test, and every file was checked against DEV with read-only reads.

This replaces the old browser-console runner (`PO_RUNBOOK_2026-10-03.md`). Do not use the console runner on production any more.

## What you are loading

Nine files, in `docs/planning-benchmarks/production_first_load/`. One file loads one dataset and one kind of data, as the Upload screen requires. `MANIFEST.csv` lists each file with its row count and SHA-256.

| Upload order | File | Kind of data to pick on the screen | Dataset | Rows |
|---|---|---|---|---|
| 1 | `01_cohorts_au_net_worth_income_by_age.csv` | Cohorts | AU net worth and income by age band 1.0 | 1 |
| 2 | `02_values_au_household_asset_composition.csv` | Observed values | AU household asset composition 1.0 | 2 |
| 3 | `03_values_au_household_wealth_distribution.csv` | Observed values | AU household wealth distribution 1.0 | 6 |
| 4 | `04_values_au_net_worth_income_by_age.csv` | Observed values | AU net worth and income by age band 1.0 | 28 |
| 5 | `05_values_au_high_dti_mortgage_threshold.csv` | Observed values | AU high-DTI mortgage threshold 1.0 | 1 |
| 6 | `06_values_au_average_super_balance.csv` | Observed values | AU average superannuation balance 1.0 | 2 |
| 7 | `07_values_india_household_assets_debt_rural_urban.csv` | Observed values | India household assets and debt (rural/urban) 1.0 | 4 |
| 8 | `08_values_india_epf_eps_contribution_structure.csv` | Observed values | India EPF/EPS contribution structure 1.0 | 1 |
| 9 | `09_target_ranges_au_asfa_retirement_standard.csv` | Planning target ranges | AU ASFA retirement standard 1.0 | 4 |

Totals: **44 observed values, 4 planning target ranges, 1 cohort.** The earlier plan said 45 values; the 45th is dataset 7 (AU household debt context), which is a superseded dataset and is closed to upload, so it is deliberately not in this load.

**Not loaded, on purpose:** the FHIP dependant-band model (draft 1) and the FHIP Planning Benchmarks v1.0 draft (11), because you have not approved the drafts; AU household debt context (7), closed; India household consumption (8), nothing importable. Do not upload anything for them.

Upload a file exactly as it is. Do not open it in Excel and save it (Excel can change dates and numbers). If anything needs to change, send me the message and I regenerate the files.

## Read this first: three things that will look odd

1. **Files 05 and 09 are expected to say "Same as live" for every row.** The database already holds the same figure (DTI 6, the four ASFA bands). There is nothing new to publish. Discard those two uploads, or activate them (harmless, it only leaves an audit entry). Either is correct.
2. **The Financial Twin will start preferring the median over the mean** for the age bands and for average super (the Twin picks the median first, then the mean). That follows from adding the median rows you approved in the register (decision D6). The figures it shows for those people will therefore change.
3. **`property_concentration`: the approved figure is stored with statistic `share`, but the seed row that is already live uses `mean`.** The upload leaves the seed row (56.2) live and adds the sourced row (55.7661) beside it. The Twin reads the `mean` first, so it will keep showing 56.2 and not use the new one. This is decision A in the report: say if you want the file changed to `mean` so the sourced figure replaces the seed.

## Part A. Read-only pre-check on production (before anything else)

Open the **production** Supabase project (not `vqycarelcoijzwlpkpcz`, which is DEV: check the project reference in the browser address bar). SQL editor. Every block below only reads. Paste each result back to me.

Production may differ from DEV. The files name each dataset by exact name and version, so they must match what production shows. If a dataset name or version differs, **do not edit the files by hand**. Send me the result of A2 and I regenerate the files for production's versions (`--retarget`).

### A1. The upload feature and the mapping are installed

<!-- sql:a1 -->
```sql
select
  (select count(*) = 3 from information_schema.tables where table_schema = 'public' and table_name in ('benchmark_upload_batches', 'benchmark_upload_rows', 'benchmark_upload_events')) as upload_tables_ok,
  (select count(*) = 2 from information_schema.tables where table_schema = 'public' and table_name in ('benchmark_dataset_metrics', 'benchmark_dataset_metric_events')) as mapping_tables_ok,
  (select count(*) = 2 from information_schema.columns where table_schema = 'public' and table_name = 'admin_users' and column_name in ('can_upload_planning_benchmarks', 'can_activate_planning_benchmarks')) as capability_columns_ok,
  (select count(*) = 4 from information_schema.routines where routine_schema = 'public' and routine_name in ('stage_planning_benchmark_upload', 'get_planning_benchmark_upload', 'activate_planning_benchmark_upload', 'discard_planning_benchmark_upload')) as upload_functions_ok,
  (select position('ub.kind = ''target_ranges''' in pg_get_functiondef('public.pb_removed_band_ids(uuid)'::regprocedure)) > 0) as migration_0278_ok,
  (select count(*) from public.benchmark_dataset_metrics) as mapping_pairs;
```

Expected: the first five columns `true`, and `mapping_pairs` = **71**.
Stop and send me if: any column is `false`, or `mapping_pairs` is not 71 (a different count means the mapping on production differs from DEV).

### A2. The datasets, their versions and statuses, and the live figures each holds

<!-- sql:a2 -->
```sql
select d.dataset_name, d.version, d.data_status, d.benchmark_class, s.source_name, s.status as source_status,
       (select count(*) from public.benchmark_values v where v.dataset_id = d.id and (v.effective_to is null or v.effective_to > current_date)) as live_values,
       (select count(*) from public.benchmark_dataset_metrics x where x.dataset_id = d.id) as mapped_pairs
  from public.benchmark_datasets d
  left join public.benchmark_sources s on s.id = d.benchmark_source_id
 order by d.dataset_name, d.version;
```

Expected (this is what DEV and the migration-seeded database show; the numbers in `live_values` are the seed figures):

| dataset_name | version | data_status | source_name (status) | live_values | mapped_pairs |
|---|---|---|---|---|---|
| AU ASFA retirement standard | 1.0 | active | ASFA_STANDARD_2026 (active) | 0 | 1 |
| AU average superannuation balance | 1.0 | active | ATO_SUPER_2023_24 (active) | 1 | 1 |
| AU high-DTI mortgage threshold | 1.0 | active | APRA_MACROPRUDENTIAL_2026 (active) | 1 | 1 |
| AU household asset composition | 1.0 | active | ABS_SIH_2019_20 (active) | 1 | 2 |
| AU household debt context | 1.0 | superseded (DEV) or active | ABS_SIH_2019_20 (active) | 0 | 1 |
| AU household wealth distribution | 1.0 | active | ABS_SIH_2019_20 (active) | 4 | 1 |
| AU net worth and income by age band | 1.0 | active | ABS_SIH_AGE_2019_20 (active) | 14 | 2 |
| FHIP dependant-band household benchmark model | 1.0 | active | FHIP_PLANNING_V1 (active) | 198 | 11 |
| FHIP Planning Benchmarks v1.0 | 1.0 | active | FHIP_PLANNING_V1 (active) | 0 | 48 |
| India EPF/EPS contribution structure | 1.0 | active | EPFO_CONTRIBUTION_STRUCTURE (active) | 1 | 1 |
| India household assets and debt (rural/urban) | 1.0 | active | AIDIS_2019 (active) | 4 | 2 |
| India household consumption expenditure (rural/urban) | 1.0 | draft (DEV) or active | MOSPI_HCES_2023_24 (active) | 0 | 0 |

The statuses of the two datasets that no file targets (AU household debt context, India household consumption) can differ: DEV shows `superseded` and `draft`, a database straight from the migrations shows `active`. That is fine, nothing is uploaded to them. Every dataset a file targets must be `active`.

Stop and send me if: a dataset the files name is missing or has a different name or version; any dataset the files target is `suspended`, `archived` or `superseded`; a source is not `approved` or `active` (Activate refuses it); `live_values` differs from the table (someone has loaded or edited figures: the previews below would then differ from what I rehearsed).

### A3. Every dataset and metric pair the files need is mapped (11 pairs, all must be `true`)

<!-- sql:a3 -->
```sql
with needed(dataset_name, metric_code, kind) as (values
  ('AU household asset composition', 'total_assets', 'values'),
  ('AU household asset composition', 'property_concentration', 'values'),
  ('AU household wealth distribution', 'net_worth', 'values'),
  ('AU net worth and income by age band', 'net_worth', 'values'),
  ('AU net worth and income by age band', 'gross_household_income', 'values'),
  ('AU high-DTI mortgage threshold', 'debt_to_income', 'values'),
  ('AU average superannuation balance', 'retirement_balance', 'values'),
  ('India household assets and debt (rural/urban)', 'total_assets', 'values'),
  ('India household assets and debt (rural/urban)', 'debt_to_asset_ratio', 'values'),
  ('India EPF/EPS contribution structure', 'retirement_contribution_rate', 'values'),
  ('AU ASFA retirement standard', 'retirement_balance', 'target_ranges'))
select n.dataset_name, n.metric_code, n.kind,
       exists (
         select 1
           from public.benchmark_dataset_metrics x
           join public.benchmark_datasets d on d.id = x.dataset_id and d.dataset_name = n.dataset_name
           join public.benchmark_metric_definitions m on m.id = x.metric_definition_id and m.metric_code = n.metric_code
          where (n.kind = 'values' and x.applies_to_values) or (n.kind = 'target_ranges' and x.applies_to_target_ranges)
       ) as mapped
  from needed n
 order by n.dataset_name, n.metric_code;
```

Expected: 11 rows, `mapped` = `true` on every row. Stop and send me if any is `false`: a pair that is not mapped makes the upload refuse that row, and mapping is your decision, not mine (I do not edit the mapping).

### A4. The cohorts the value rows refer to (9 must exist, the new one must not)

<!-- sql:a4 -->
```sql
with needed(cohort_code) as (values
  ('AU_AGE_25_34'), ('AU_AGE_35_44'), ('AU_AGE_45_54'), ('AU_AGE_55_64'), ('AU_AGE_65_74'), ('AU_AGE_75_PLUS'),
  ('IN_RURAL_ALL'), ('IN_URBAN_ALL'), ('AU_AGE_15_24'))
select n.cohort_code, c.id is not null as exists_now, c.age_band, c.cohort_tier, d.dataset_name
  from needed n
  left join public.benchmark_cohorts c on c.cohort_code = n.cohort_code
  left join public.benchmark_datasets d on d.id = c.dataset_id
 order by n.cohort_code;
```

Expected: `exists_now` = `true` for the eight seeded cohorts and `false` for `AU_AGE_15_24` (file 1 creates it). Stop and send me if one of the eight is missing (the values for that cohort would be refused and I must add it), or if `AU_AGE_15_24` already exists (then file 1 will say "Same as live" or "Conflict", and I need to see its details).

### A5. The live figures the files will touch (compare with the expected previews in Part D)

<!-- sql:a5 -->
```sql
select d.dataset_name, coalesce(c.cohort_code, '(country-wide)') as cohort, m.metric_code, v.statistic_type, v.value_numeric, v.unit, v.base_date, v.effective_from, v.effective_to, v.version
  from public.benchmark_values v
  join public.benchmark_datasets d on d.id = v.dataset_id
  join public.benchmark_metric_definitions m on m.id = v.metric_definition_id
  left join public.benchmark_cohorts c on c.id = v.cohort_id
 where d.dataset_name in ('AU household asset composition', 'AU household wealth distribution', 'AU net worth and income by age band', 'AU high-DTI mortgage threshold',
                          'AU average superannuation balance', 'India household assets and debt (rural/urban)', 'India EPF/EPS contribution structure')
 order by d.dataset_name, c.cohort_code nulls first, m.metric_code, v.statistic_type;
```

Expected: **26 rows**, none with an `effective_to`. They are the seed figures: asset composition 1 (`property_concentration` mean 56.2); wealth distribution 4 (`net_worth` mean 1,040,000, median 579,200, p20 113,400, p80 1,400,000); age bands 14 (mean `net_worth` and mean `gross_household_income` for `AU_AGE_18_24`, `AU_AGE_25_34`, `AU_AGE_35_44`, `AU_AGE_45_54`, `AU_AGE_55_64`, `AU_AGE_65_74`, `AU_AGE_75_PLUS`); DTI 1 (`debt_to_income` threshold 6); super 1 (`retirement_balance` mean 183,000); India assets 4 (`total_assets` 1,592,379 rural and 2,717,081 urban, `liquid_asset_share` 4.6 and 9.3); EPF 1 (`retirement_contribution_rate` rate 24).

### A6. Who holds the two permissions, and what has been staged before

<!-- sql:a6 -->
```sql
select u.email, a.can_upload_planning_benchmarks as can_upload, a.can_activate_planning_benchmarks as can_activate
  from public.admin_users a
  join auth.users u on u.id = a.user_id
 where a.can_upload_planning_benchmarks or a.can_activate_planning_benchmarks
 order by u.email;
```

<!-- sql:a7 -->
```sql
select
  (select count(*) from public.benchmark_upload_batches) as batches_staged_so_far,
  (select count(*) from public.benchmark_values) as all_value_rows,
  (select count(*) from public.benchmark_values where effective_to is not null) as end_dated_value_rows,
  (select count(*) from public.benchmark_target_ranges where effective_to is null or effective_to > current_date) as live_bands,
  (select count(*) from public.benchmark_target_ranges t join public.benchmark_metric_definitions m on m.id = t.metric_definition_id
     join public.benchmark_sources s on s.id = t.benchmark_source_id
    where m.metric_code = 'retirement_balance' and s.source_name = 'ASFA_STANDARD_2026' and (t.effective_to is null or t.effective_to > current_date)) as live_asfa_bands,
  (select count(*) from public.benchmark_cohorts) as cohorts;
```

Expected: A6 returns no row before you grant anything (if it returns people, check they are the people you intend). A7: `batches_staged_so_far` 0, `all_value_rows` 224, `end_dated_value_rows` 0, `live_bands` 200, `live_asfa_bands` 4, `cohorts` 39. Stop and send me if `end_dated_value_rows` is not 0 or `live_asfa_bands` is not 4.

Also check that the production app is on `main` e829a8b or later (the Twin filter that ignores end-dated figures must be live before the first Activate that replaces anything; it is part of that build).

## Part B. Back up the live figures (before any Activate)

Run each block, then use the SQL editor's **Download CSV** on the result. Keep the three files with today's date in the name, for example `backup_values_07-10-2026.csv`. The backups are your way back to exactly what was live.

<!-- sql:b1 -->
```sql
select v.*, d.dataset_name, d.version as dataset_version, m.metric_code, c.cohort_code
  from public.benchmark_values v
  join public.benchmark_datasets d on d.id = v.dataset_id
  join public.benchmark_metric_definitions m on m.id = v.metric_definition_id
  left join public.benchmark_cohorts c on c.id = v.cohort_id
 order by d.dataset_name, c.cohort_code nulls first, m.metric_code, v.statistic_type, v.version;
```

<!-- sql:b2 -->
```sql
select t.*, m.metric_code, s.source_name
  from public.benchmark_target_ranges t
  join public.benchmark_metric_definitions m on m.id = t.metric_definition_id
  left join public.benchmark_sources s on s.id = t.benchmark_source_id
 order by m.metric_code, t.country_code nulls first, t.household_type nulls first, t.band_tier;
```

<!-- sql:b3 -->
```sql
select c.*, d.dataset_name, d.version as dataset_version
  from public.benchmark_cohorts c
  join public.benchmark_datasets d on d.id = c.dataset_id
 order by c.cohort_code;
```

Expected row counts: values 224 (the editor may show 1,000 at most; 224 is below that), target ranges 200, cohorts 39. If a count is higher than 1,000 or lower than expected, stop and send me.

## Part C. Give the two permissions to two different people

Recommended (decision U1): one person who stages (upload), a different named person who activates. Both must already be Super Admins (have a row in `admin_users`). Replace the two placeholder emails with the real ones, run each statement, and check that it returns exactly one row. If it returns no row, that person is not an admin user yet and nothing was granted.

<!-- sql:c1 -->
```sql
update public.admin_users
   set can_upload_planning_benchmarks = true
 where user_id = (select id from auth.users where lower(email) = lower('UPLOADER.EMAIL@EXAMPLE.COM'))
returning user_id, can_upload_planning_benchmarks;
```

<!-- sql:c2 -->
```sql
update public.admin_users
   set can_activate_planning_benchmarks = true
 where user_id = (select id from auth.users where lower(email) = lower('ACTIVATOR.EMAIL@EXAMPLE.COM'))
returning user_id, can_activate_planning_benchmarks;
```

Run A6 again; it must list exactly those two people, each with one `true`.

**Single operator fallback.** If only one person is available, give that one person both permissions (run both statements with the same email). The screen then shows a tick box when that person activates what they staged: "I staged this upload myself and I am also activating it. This is recorded on the upload." What it means: the person must tick it before Activate works; the upload is then recorded as self-activated (shown in the Upload history as "self-activated" and kept in the append-only event log). It does not block anything and it does not make anyone else review the file; it only makes the lack of a second reviewer visible afterwards. Prefer two people.

When the load is finished you may switch the permissions off again (your choice):

<!-- sql:c3 -->
```sql
update public.admin_users
   set can_upload_planning_benchmarks = false, can_activate_planning_benchmarks = false
 where user_id in (select id from auth.users where lower(email) in (lower('UPLOADER.EMAIL@EXAMPLE.COM'), lower('ACTIVATOR.EMAIL@EXAMPLE.COM')))
returning user_id;
```

## Part D. The load, file by file

Where: Admin, Benchmarks, **Upload** tab. For each file: the staging person picks the **Kind of data** from the table in "What you are loading", chooses the file, presses **Check and stage the file**. The activating person opens the staged upload from **Upload history** (button **Preview**) and reads it.

Rules that keep this safe:
- **One file at a time.** Stage, preview, activate (or discard), then go to the next. Do not stage several and activate later: a later activation changes the live figures that an earlier preview was compared with, and the system then refuses the older one as stale (you would just stage it again).
- Order matters: file 1 (cohort) must be **activated** before file 4 can be staged, because file 4 refers to the new cohort. Staging file 4 first is refused with "The cohort AU_AGE_15_24 is not a registered cohort".
- Each file must say **0 warnings** and the preview must say "Every check passed. Nothing is live yet." A "Conflicts" count above 0 or any blocker means do not activate: Discard and send me the screen.
- The preview shows four counts (New, Replaced, Same as live, Conflicts) and **Bands removed**. For every values file and the cohort file, **Bands removed must be 0**. Only a planning target ranges file can remove bands, and file 9 must also show 0.
- "Replaced" means: a live figure for the same metric, cohort and statistic is replaced because the number (or its currency, unit or as-at date) differs. The old figure is kept as history with an end date; it is never deleted.

What each preview should say, on a production database in the expected state of Part A (rehearsed on the real migrations):

| Order | File | New | Replaced | Same as live | Conflicts | Bands removed | What it does |
|---|---|---|---|---|---|---|---|
| 1 | Cohorts: AU_AGE_15_24 | 1 | 0 | 0 | 0 | 0 | Adds the cohort. **Activate.** |
| 2 | Asset composition | 2 | 0 | 0 | 0 | 0 | Adds `total_assets` 1,245,200 and `property_concentration` (share) 55.7661. The seed `property_concentration` (mean 56.2) stays live. **Activate.** |
| 3 | Wealth distribution | 2 | 2 | 2 | 0 | 0 | New: p10 36,900 and p90 2,257,700. Replaced: mean 1,040,000 by 1,042,000; p80 1,400,000 by 1,447,800. Same: median 579,200 and p20 113,400. **Activate.** |
| 4 | Age bands | 16 | 10 | 2 | 0 | 0 | New: all 4 rows of `AU_AGE_15_24` and every median (12). Replaced: the mean net worth and mean income of 25-34, 35-44, 45-54, 55-64 and 65-74 (10). Same: 75 and over mean net worth 1,167,000 and mean income 54,340. The two seed rows of `AU_AGE_18_24` are not touched and stay live. **Activate.** |
| 5 | DTI threshold | 0 | 0 | 1 | 0 | 0 | Nothing to publish. Discard or activate. |
| 6 | Average super | 1 | 1 | 0 | 0 | 0 | New: median 63,339. Replaced: mean 183,000 by 182,781. **Activate.** |
| 7 | India assets and debt | 2 | 0 | 2 | 0 | 0 | New: `debt_to_asset_ratio` 3.8 (rural) and 4.4 (urban). Same: the two `total_assets`. The seed `liquid_asset_share` rows stay live. **Activate.** |
| 8 | India EPF/EPS | 0 | 1 | 0 | 0 | 0 | "Replaces" the seed 24 with the sourced 24: the number is the same, the as-at date and provenance are the sourced ones (17/09/2026, PIB). Both sides of the preview row show 24. **Activate.** |
| 9 | ASFA target ranges | 0 | 0 | 4 | 0 | 0 | Nothing to publish (the four bands are already live). Discard or activate. |

After activation of everything (rehearsal result): 37 new figures added, 14 earlier figures end-dated and kept as history, 1 cohort added, no band changed.

**When to Discard instead of Activate:** the counts differ from the table (for example "Replaced" is bigger than expected, or "Conflicts" is not 0); a warning appears; the preview shows a number you do not recognise; or you simply have a doubt. Discarding is always safe (see Part F). Send me the preview (a screenshot or the counts) and the A2 and A5 results.

Per-file confirmation text you will see when you press Activate: "Activate this upload? ... the figures in <file> will go live for every FHIP user now. N will be added, N existing figure(s) will be replaced (kept as history), N are the same and left alone ... To change them afterwards you upload a corrected file." Press **Activate and make live** only if those numbers match the table above. The screen then says "Activated. The figures are now live for every FHIP user and the change is recorded in the Update / audit log tab."

## Part E. Verify after the last file

Run each block on production and compare with the expectation. If you did not activate files 5 and 9 the results are the same.

### E1. Live figures per dataset

<!-- sql:e1 -->
```sql
select d.dataset_name, count(v.id) as live_values
  from public.benchmark_datasets d
  left join public.benchmark_values v on v.dataset_id = d.id and (v.effective_to is null or v.effective_to > current_date)
 group by d.dataset_name
 order by d.dataset_name;
```

Expected (if A2 matched): AU ASFA retirement standard 0, AU average superannuation balance **2**, AU high-DTI mortgage threshold **1**, AU household asset composition **3**, AU household debt context 0, AU household wealth distribution **6**, AU net worth and income by age band **30**, FHIP dependant-band household benchmark model 198, FHIP Planning Benchmarks v1.0 0, India EPF/EPS contribution structure **1**, India household assets and debt **6**, India household consumption 0. (The ASFA bands are bands, not values.)

### E2. Row totals, history and cohorts

<!-- sql:e2 -->
```sql
select
  (select count(*) from public.benchmark_values) as all_value_rows,
  (select count(*) from public.benchmark_values where effective_to is not null) as end_dated_value_rows,
  (select count(*) from public.benchmark_values where effective_to is null or effective_to > current_date) as live_value_rows,
  (select count(*) from public.benchmark_target_ranges where effective_to is null or effective_to > current_date) as live_bands,
  (select count(*) from public.benchmark_cohorts) as cohorts,
  (select count(*) from public.benchmark_cohorts where cohort_code = 'AU_AGE_15_24' and age_band = 'AGE_15_24') as new_cohort_present;
```

Expected: `all_value_rows` 261 (224 + 37), `end_dated_value_rows` 14, `live_value_rows` 247, `live_bands` 200, `cohorts` 40, `new_cohort_present` 1.

### E3. The replaced figures are kept as history (14 rows, end-dated today)

<!-- sql:e3 -->
```sql
select d.dataset_name, coalesce(c.cohort_code, '(country-wide)') as cohort, m.metric_code, v.statistic_type,
       v.value_numeric as old_value, v.effective_to as ended_on, v.version as old_version,
       (select n.value_numeric from public.benchmark_values n
         where n.dataset_id = v.dataset_id and n.metric_definition_id = v.metric_definition_id and n.statistic_type = v.statistic_type
           and n.cohort_id is not distinct from v.cohort_id and n.effective_to is null) as new_value
  from public.benchmark_values v
  join public.benchmark_datasets d on d.id = v.dataset_id
  join public.benchmark_metric_definitions m on m.id = v.metric_definition_id
  left join public.benchmark_cohorts c on c.id = v.cohort_id
 where v.effective_to is not null
 order by d.dataset_name, c.cohort_code nulls first, m.metric_code, v.statistic_type;
```

Expected: 14 rows: wealth mean (1,040,000 to 1,042,000) and p80 (1,400,000 to 1,447,800); the ten age-band means; super mean (183,000 to 182,781); EPF rate (24 to 24). Every row has a `new_value`.

### E4. Audit rows (who staged, who activated, what changed)

<!-- sql:e4 -->
```sql
select b.staged_at, b.file_name, b.kind, b.dataset_name, b.status, b.row_count, b.counts, b.self_activated,
       us.email as staged_by, ua.email as activated_by, b.activated_at
  from public.benchmark_upload_batches b
  left join auth.users us on us.id = b.staged_by
  left join auth.users ua on ua.id = b.activated_by
 order by b.staged_at;
```

<!-- sql:e5 -->
```sql
select r.import_date, d.dataset_name, r.event_type, r.rows_imported, r.approval_status,
       r.validation_results ->> 'upload_batch_id' as upload_batch_id, r.validation_results ->> 'rows_end_dated' as rows_end_dated
  from public.benchmark_update_runs r
  join public.benchmark_datasets d on d.id = r.dataset_id
 where r.event_type = 'DATASET_IMPORT' and r.validation_results ? 'upload_batch_id'
 order by r.import_date;
```

<!-- sql:e6 -->
```sql
select e.created_at, e.event_type, b.file_name, e.detail ->> 'self_activated' as self_activated
  from public.benchmark_upload_events e
  join public.benchmark_upload_batches b on b.id = e.batch_id
 order by e.created_at;
```

Expected: one batch per file you activated, status `activated`, `self_activated` false (two-person flow), one `DATASET_IMPORT` row per activated batch in E5 (`rows_imported` equals the "New plus Replaced" of that file), and a `staged` and an `activated` event per batch in E6. The same rows appear in the Admin "Update / audit log" tab.

### E5. The three spot checks against the publishers

<!-- sql:e7 -->
```sql
select * from (
  select 'Net worth median 579,200 (ABS Table 7.2 G10)' as check_name,
         (select v.value_numeric from public.benchmark_values v
            join public.benchmark_datasets d on d.id = v.dataset_id and d.dataset_name = 'AU household wealth distribution'
            join public.benchmark_metric_definitions m on m.id = v.metric_definition_id and m.metric_code = 'net_worth'
           where v.statistic_type = 'median' and v.cohort_id is null and (v.effective_to is null or v.effective_to > current_date)) as live_value,
         579200::numeric as expected, null::date as effective_from
  union all
  select 'DTI threshold 6, effective 01/02/2026 (APRA)',
         (select v.value_numeric from public.benchmark_values v
            join public.benchmark_datasets d on d.id = v.dataset_id and d.dataset_name = 'AU high-DTI mortgage threshold'
            join public.benchmark_metric_definitions m on m.id = v.metric_definition_id and m.metric_code = 'debt_to_income'
           where v.statistic_type = 'threshold' and (v.effective_to is null or v.effective_to > current_date)),
         6::numeric,
         (select v.effective_from from public.benchmark_values v
            join public.benchmark_datasets d on d.id = v.dataset_id and d.dataset_name = 'AU high-DTI mortgage threshold'
            join public.benchmark_metric_definitions m on m.id = v.metric_definition_id and m.metric_code = 'debt_to_income'
           where v.statistic_type = 'threshold' and (v.effective_to is null or v.effective_to > current_date))
  union all
  select 'Average super mean 182,781 (ATO Chart 12 J211)',
         (select v.value_numeric from public.benchmark_values v
            join public.benchmark_datasets d on d.id = v.dataset_id and d.dataset_name = 'AU average superannuation balance'
            join public.benchmark_metric_definitions m on m.id = v.metric_definition_id and m.metric_code = 'retirement_balance'
           where v.statistic_type = 'mean' and (v.effective_to is null or v.effective_to > current_date)),
         182781::numeric, null::date
) t;
```

Expected: `live_value` equals `expected` on each row, and the DTI row shows `effective_from` 2026-02-01 (the SQL editor prints dates year first; it is 01/02/2026). Then check the same three figures by eye on the Admin Observed values tab (it shows the latest 200 rows with no dataset filter, so use the SQL result if a figure is not visible there).

### E6. Never two live figures for the same key (must return no rows)

<!-- sql:e8 -->
```sql
select d.dataset_name, coalesce(c.cohort_code, '(country-wide)') as cohort, m.metric_code, v.statistic_type, count(*) as live_rows
  from public.benchmark_values v
  join public.benchmark_datasets d on d.id = v.dataset_id
  join public.benchmark_metric_definitions m on m.id = v.metric_definition_id
  left join public.benchmark_cohorts c on c.id = v.cohort_id
 where v.effective_to is null or v.effective_to > current_date
 group by d.dataset_name, c.cohort_code, m.metric_code, v.statistic_type
having count(*) > 1;
```

Expected: no rows. If a row appears, stop and send it to me before anyone relies on the figures.

## Part F. Rollback and correction

**Before Activate (nothing is live yet).** A staged upload is only a preview. Press **Discard this upload** (optionally write a reason). Nothing was ever live, no live figure changes, the discard is recorded in the event log. A staged upload also expires by itself after 14 days (it can no longer be activated; discard it). To retry, stage the file again. Staging the identical file while a staged copy exists returns that copy; after a discard you can stage it again.

**After Activate there is no delete.** Replaced figures are kept as history with an end date, so nothing is lost. There are two ways to correct:

1. **The safe path (preferred): upload a corrected file.** A new upload that carries the right figures supersedes the wrong ones in the same way (the wrong ones are end-dated and kept as history). If you want the old seed figure back, use the backup from Part B to prepare it as a file; I can do that for you.
2. **The documented SQL (only with your approval, one batch at a time, newest first).** It takes the batch's new figures out of service (end-dates them, never deletes) and restores the figures that batch replaced. It is for observed values batches. Cohorts are not removed (an unused cohort does nothing). It does not apply to target ranges: if file 9 ever replaced bands, ask me. Find the batch id with E4 (or the Upload history), put it in both places, run it, and keep the output.

<!-- sql:f1 -->
```sql
begin;
with b as (
  select id, dataset_id, activated_at
    from public.benchmark_upload_batches
   where id = 'PASTE-BATCH-ID-HERE'::uuid and status = 'activated' and kind = 'values'
), new_rows as (
  update public.benchmark_values v
     set effective_to = current_date
    from b
   where v.dataset_id = b.dataset_id and v.created_at = b.activated_at and (v.effective_to is null or v.effective_to > current_date)
  returning v.id
), old_rows as (
  update public.benchmark_values v
     set effective_to = null
   where v.id in (select unnest(r.live_ids) from public.benchmark_upload_rows r
                   where r.batch_id = 'PASTE-BATCH-ID-HERE'::uuid and r.classification = 'changed')
  returning v.id
)
select (select count(*) from new_rows) as new_figures_taken_out_of_service, (select count(*) from old_rows) as earlier_figures_restored;
commit;
```

Expected output for, say, file 6: 2 and 1. If either number surprises you, run `rollback;` instead of `commit;` (or do not run the last line) and send me the output. After a run, repeat E1 and E2.

## Part G. What NOT to do

- Do not activate a file you have not previewed, or a preview whose counts differ from Part D without asking me first.
- Do not load the two drafts (the FHIP dependant-band worksheet and FHIP Planning Benchmarks v1.0). They are never uploaded without your explicit approval of the drafts, and no file for them exists in this folder.
- Do not upload anything for AU household debt context (superseded) or India household consumption (nothing importable).
- Do not edit a file in Excel or by hand. If a name, version or date has to change, I regenerate the files.
- Do not stage several files and activate them later (stale previews are refused).
- Do not use the old browser-console runner on production.
- Do not map or unmap a dataset and metric pair during the load.
- Do not run Part F's SQL without telling me first.

## If production shows other dataset versions

Send me A2. I run `npx tsx scripts/planning-benchmarks/buildProductionFirstLoad.ts --retarget "<dataset name>=<version>" --out <folder>`; the manifest of that folder records the change and every file is re-validated before you get it. Names are matched exactly and an unknown name stops the build.
