# Planning Benchmarks: how to apply migration 0277 (dataset to metric mapping) on DEV (Product Owner step)

Written 07/10/2026. Why: the database let any open dataset accept any registered metric, so an upload could put a metric into a dataset it does not belong to. You approved adding the mapping ("yes, add the metric mapping"). Design: `docs/planning-benchmarks/UPLOAD_DESIGN.md` section 14. The 71 pairs it seeds, with the evidence for each: `docs/planning-benchmarks/DATASET_METRIC_MAPPING.md`.

**Evidence label:** the SQL was replayed on an isolated in-memory Postgres (PGlite) together with the whole migration ledger and every rule was exercised there (22 database checks, 5 of them negative controls). It has **not** been applied to DEV or production.

## What it does, in plain words

- Adds a list of "which metrics each dataset may receive", for each kind of file (observed values, planning target ranges, or both), and fills it with 71 pairs taken from what DEV already holds and from the first-load files.
- From then on a file that puts a metric into a dataset it is not listed for is refused: in the check on screen (with the allowed metrics named), when the rows are staged, and again when the upload is activated.
- Adds a small section on the Upload tab where a person with the **existing Activate permission** can add or remove a metric for a dataset. Every change needs a reason and a confirmation and is recorded. Live figures are never deleted.
- Changes no existing figure, no existing table and no permission. It creates no new permission. It loads nothing and activates nothing.
- If you do **not** apply it, nothing breaks: the screen then says "mapping not installed yet" and uploads behave as before.

## Before you start

1. Project: Supabase **DEV**. Check the project reference is `vqycarelcoijzwlpkpcz` (it is in the browser address bar of the Supabase dashboard, and under Project Settings, General). **If it is anything else, stop.** Do not run this on production yet.
2. Migration `0275` (staged upload) must already be applied on DEV (it was applied there earlier). If it is missing, the file stops with a clear message and changes nothing.
3. Do not re-run `0275` after this one. `0275` redefines one function that `0277` makes stricter. If you ever do, run `0277` again (it is safe to run twice).

## Apply (Supabase SQL editor)

The whole file is `supabase/migrations/0277_planning_benchmark_dataset_metric_mapping.sql`. It is long, so it is also split into three parts. Paste them **one at a time, in order**. Each part can be run on its own and can be run twice safely.

1. Open `docs/planning-benchmarks/po_apply_mapping/parts/0277a.sql`, paste all of it, press Run. Expect "Success. No rows returned".
2. Open `parts/0277b.sql`, paste, Run. Same result.
3. Open `parts/0277c.sql`, paste, Run. Same result.

(Or paste the whole migration file in one go. If the editor complains, use the three parts.)

## Check it worked

Run this. It must return **one row** with every column `true`, and `seeded_pairs` must be **71**:

```sql
select
  (select count(*) = 2 from information_schema.tables where table_schema = 'public' and table_name in ('benchmark_dataset_metrics', 'benchmark_dataset_metric_events')) as tables_ok,
  (select count(*) = 2 from information_schema.routines where routine_schema = 'public' and routine_name in ('set_planning_benchmark_dataset_metric', 'remove_planning_benchmark_dataset_metric')) as functions_ok,
  (select count(*) = 1 from pg_trigger where tgname = 'trg_benchmark_upload_rows_dataset_metric' and not tgisinternal) as trigger_ok,
  (select count(*) from public.benchmark_dataset_metrics) as seeded_pairs,
  (select count(*) = 0 from information_schema.role_table_grants where table_schema = 'public' and table_name in ('benchmark_dataset_metrics', 'benchmark_dataset_metric_events') and grantee in ('anon', 'authenticated') and privilege_type <> 'SELECT') as no_api_write_ok;
```

Then run this second query. It lists the pairs per dataset. Expected counts: FHIP dependant-band household benchmark model 11, AU household asset composition 2, AU household wealth distribution 1, AU net worth and income by age band 2, AU high-DTI mortgage threshold 1, AU average superannuation balance 1, AU household debt context 1, India household assets and debt (rural/urban) 2, India EPF/EPS contribution structure 1, FHIP Planning Benchmarks v1.0 48, AU ASFA retirement standard 1. **India household consumption expenditure (rural/urban) has no row on purpose** (it needs your decision, see the mapping document section 4).

```sql
select d.dataset_name, count(*) as pairs,
       count(*) filter (where x.applies_to_values) as for_values,
       count(*) filter (where x.applies_to_target_ranges) as for_target_ranges
  from public.benchmark_dataset_metrics x
  join public.benchmark_datasets d on d.id = x.dataset_id
 group by d.dataset_name
 order by d.dataset_name;
```

If `seeded_pairs` is below 71, a dataset name on DEV differs from the one in the mapping document. Do not fix it by hand: paste the result back and I will correct the seed.

## Then check it on the screen (after the branch is deployed to DEV, a later step)

I will do the DEV verification after you confirm the SQL ran. Nothing needs the app to be deployed for the SQL itself.

## What to paste back to me

1. The one row from the first check query (all five columns).
2. The table from the second query (dataset, pairs, for_values, for_target_ranges).
3. Any error text, exactly as shown, if a part did not run.

## Maintaining the mapping afterwards

Use the Upload tab, section "Dataset metric mapping" (it needs the Activate permission to change; anyone who can see the tab can read it). The two database functions behind it check which person is signed in, so they cannot be run from the SQL editor, which has no signed-in person. To change the seeded list for everyone at once, send me the change and I will make it a new migration.

## Undo (roll back)

Safe at any time. It removes the mapping, its history and the checks, and puts back the earlier readiness function. No figure is touched.

1. Open `docs/planning-benchmarks/po_apply_mapping/rollback.sql`, paste all of it, press Run. Expect "Success. No rows returned".
2. Check: `select to_regclass('public.benchmark_dataset_metrics');` must return an empty value.

After the rollback, uploads behave as they did before `0277`. You can apply `0277` again later.
