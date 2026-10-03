# Planning Benchmarks first load - PO runbook (DEV first)

Evidence label: the files, builder and console runner are **offline-verified** on an in-memory replica of the benchmark tables (real Admin route handlers, real migration DDL). They have **not** been run against DEV, a running server or production. Read `first_load/PROVENANCE_REGISTER.md` (status table, caveats) and `IMPORT_SCHEMA_AND_PARAMETER_MAP_2026-10-03.md` first.

## What gets loaded

45 `benchmark_values` rows (datasets 2, 3, 4, 5, 6, 7, 9, 10), 4 `benchmark_target_ranges` rows (dataset 12, ASFA), 1 new `benchmark_cohorts` row (`AU_AGE_15_24`). Datasets 1 and 11 are DRAFT files and are never loaded by this procedure. Dataset 8 has nothing importable.

**Important behaviours of the live app (read before you load):**
1. The Financial Twin reads `benchmark_values` and `benchmark_target_ranges` directly. It does not check the dataset's `data_status`, so **rows are live for users in that environment the moment they are inserted**, before any Approve / Activate click. That is why DEV first.
2. The import writes **no audit row**. The runner downloads its own log and rollback SQL; keep them.
3. There is no unique key: running the load twice duplicates everything. The runner refuses a dataset that already has values.
4. No UPDATE/DELETE exists in the Admin API for these tables. Rollback is SQL (generated for you).

## Step 0 - read-only state check (SQL editor, DEV)

```sql
-- value rows per registered dataset (expect 0 everywhere if the figures are truly empty)
select d.dataset_name, d.version, d.data_status, count(v.id) as value_rows
from benchmark_datasets d left join benchmark_values v on v.dataset_id = d.id
group by 1,2,3 order by 1;

select count(*) as target_range_rows from benchmark_target_ranges;

-- the cohorts the value rows reference must exist (expect 8 rows)
select cohort_code, age_band from benchmark_cohorts
where cohort_code in ('AU_AGE_25_34','AU_AGE_35_44','AU_AGE_45_54','AU_AGE_55_64','AU_AGE_65_74','AU_AGE_75_PLUS','IN_RURAL_ALL','IN_URBAN_ALL');
```

If `value_rows` is not 0 for a dataset, migrations 0012/0023 seeded figures there. Do **not** load that dataset (the runner will also refuse). Decide with the PO whether the seed is superseded (register section 15, decision D5) and clear it by SQL first.

## Step 1 - export the metric ids (read-only)

Run `scripts/planning-benchmarks/export_metric_ids.sql` in the DEV SQL editor and save the single JSON cell as `metric_ids.json`.

## Step 2 - build the payload (offline, on your machine)

```
node scripts/planning-benchmarks/build_payloads.mjs --ids metric_ids.json --out first_load_payload.json
```

It prints the row counts (expect values 45, target ranges 4, cohorts 1, sources 0, datasets 0) and names the draft files it skipped. It fails loudly on any unknown metric.

## Step 3 - dry run (DEV Admin, signed in as the administrator)

Open `/admin/benchmarks` on DEV. In the browser DevTools console paste the contents of `scripts/planning-benchmarks/import_via_admin_api.console.js`, then:

```js
const payload = await pbPickPayload();      // choose first_load_payload.json
await pbRunImport(payload);                 // DRY RUN: reads state, prints the plan, writes nothing
```

It must print `plan: ... values=45, target ranges=4` and `DRY RUN complete: pre-flight clean`. Any `BLOCKED:` line means stop.

## Step 4 - load

```js
await pbRunImport(payload, { dryRun: false });
```

It creates the cohort, then the 45 values (one atomic request per 100 rows), then the 4 target ranges, stops at the first failure, and downloads `planning_benchmarks_first_load_log_*.json` and `planning_benchmarks_first_load_rollback_*.sql`. **Keep both files.**

## Step 5 - verify (SQL, DEV)

```sql
select d.dataset_name, count(v.id) as value_rows
from benchmark_datasets d left join benchmark_values v on v.dataset_id = d.id
group by 1 order by 1;
-- expect: asset composition 2, wealth distribution 6, net worth and income by age 28, high-DTI 1,
--         average super 2, household debt context 1, India assets and debt 4, EPF/EPS 1, all others 0

select m.metric_code, v.statistic_type, c.cohort_code, v.value_numeric, v.unit, v.base_date, v.effective_from, v.is_derived
from benchmark_values v
join benchmark_metric_definitions m on m.id = v.metric_definition_id
left join benchmark_cohorts c on c.id = v.cohort_id
join benchmark_datasets d on d.id = v.dataset_id
where d.dataset_name = 'AU high-DTI mortgage threshold';
-- expect one row: debt_to_income, threshold, 6.0000, ratio, 2026-02-01, 2026-02-01, false

select household_type, band_label, band_tier, lower_bound, upper_bound, model_version, effective_from
from benchmark_target_ranges t join benchmark_metric_definitions m on m.id = t.metric_definition_id
where m.metric_code = 'retirement_balance' order by household_type, band_tier;
-- expect 4 rows: couple_no_kids modest 0..120000, comfortable 730000..; single modest 0..110000, comfortable 630000..
```

In the screen: Observed values tab shows only the latest 200 rows with no dataset filter; use SQL or `GET /api/admin/benchmarks/values?dataset_id=<id>`.
Spot-check three values against the source before going further: net worth median 579,200 (ABS Table 7.2 G10), DTI threshold 6 effective 01/02/2026 (APRA letter), average super mean 182,781 (ATO Chart 12 J211).

## Step 6 - governance clicks (PO decision, per dataset, in the Admin screen)

Sources: the registered sources are already `active` (seeded). If any source shows draft, Approve it. Datasets: the 12 are registered as `active` by the seed; use **Validate** on each loaded dataset (it requires a source period, a citation and at least one value for observed/regulatory classes) and record the outcome. Source-row corrections (register section 15) are optional and go through the existing source PUT.

## Rollback

Run the downloaded `planning_benchmarks_first_load_rollback_*.sql` in the DEV SQL editor. It deletes only the ids this run created (target ranges, values, cohorts, in that order). If the console run stopped part way, the same file covers what was created. Nothing else in the Admin has an undo.

## Production

Only after DEV is verified and the open decisions are answered. Repeat Steps 0-6 against production with a fresh `metric_ids.json` (ids differ per environment). Do not reuse a payload built from DEV ids.

## Not covered by this runbook

History (needs consumer change P3), datasets 1 and 11 (need your approval of the drafts), dataset 8 (needs new metric definitions, P4), a new Admin screen for import (P1). See the schema document, sections 6 and 7.
