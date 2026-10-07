# Planning Benchmarks upload: PRODUCTION hand-over v2 (migrations 0275, then 0277, then 0278)

Written 07/10/2026. **This folder supersedes the earlier production hand-over for 0275 alone (`docs/planning-benchmarks/po_apply_upload_PRODUCTION/README.md`, and the DEV-only `po_apply_upload/README.md`).** Do not follow those for production: they stop after 0275, and 0275 alone has a defect (below) that 0278 fixes.

**Evidence label:** every file here was replayed on an isolated in-memory Postgres (PGlite) together with the whole migration ledger and exercised there. Not yet applied to production. 0275 is applied on DEV; 0277 and 0278 are not applied anywhere yet (DEV next, then here).

## The one rule: apply all three, in this order, before the first Activate

1. `0275` staged upload (tables, permissions, the four functions the screen calls)
2. `0277` dataset to metric mapping (refuses a metric that does not belong to its dataset, at staging and at Activate)
3. `0278` removed-bands fix (an observed values upload must not say that bands will be removed)

Why the order matters:

- `0277` re-emits one function of `0275` (`pb_dataset_readiness`) and adds a trigger. Re-running `0275` afterwards puts the old function back, so after any re-run of `0275` run `0277` again.
- `0278` re-emits a **different** function of `0275` (`pb_removed_band_ids`). It does not touch the `0277` readiness function and `0277` does not touch it. Re-running `0275` afterwards would put the defect back, so after any re-run of `0275` run `0278` again.
- Without `0278` the preview of a values upload shows "Bands removed" and lists target range bands, which is false (Activate does not retire them). The person approving would be shown a wrong statement. Without `0277` any open dataset accepts any metric.
- A batch staged before `0278` that carries the false count is refused at Activate as stale ("live benchmark data changed after this upload was staged"). Discard it and stage the file again. Nothing goes live on a wrong preview.
- **Do not press Activate for the first time until all three are applied and the check queries below are all true.** Giving the permissions (step 4) is separate and comes last.

## What is in this folder

| File | Content |
|---|---|
| `sql/0275_planning_benchmark_staged_upload.sql` | byte-identical to `supabase/migrations/0275_...sql` |
| `sql/0277_planning_benchmark_dataset_metric_mapping.sql` | byte-identical to `supabase/migrations/0277_...sql` |
| `sql/0278_planning_benchmark_removed_bands_target_ranges_only.sql` | byte-identical to `supabase/migrations/0278_...sql` (short, one statement, no parts needed) |
| `sql/parts/0275a.sql`, `0275b.sql`, `0275c.sql` | the 0275 file cut into three pastes (joined they equal the file) |
| `sql/parts/0277a.sql`, `0277b.sql`, `0277c.sql` | the 0277 file cut into three pastes (joined they equal the file) |
| `sql/rollback_0278.sql`, `sql/rollback_0277.sql` | undo scripts (section Undo) |

A test (`tests/unit/planningBenchmarkProductionHandoverV2.test.ts`) proves the copies are byte-identical to the migrations and that the parts join back to the files.

## Before you start

1. Supabase project: **production**. Confirm the project reference in the dashboard address bar is the production one and **not** `vqycarelcoijzwlpkpcz` (that is DEV). If you are unsure, stop and ask.
2. Run each step in the SQL editor, paste one file or part at a time, press Run, expect "Success. No rows returned". Every file can be run twice safely.
3. The code that uses these must be deployed **before the first Activate** that replaces anything (it adds one filter to the two Twin queries so a figure whose end date has passed is no longer served; today no figure has an end date, so nothing changes until the first Activate). Applying the SQL first is harmless.

## Step 1: 0275

Paste `sql/parts/0275a.sql`, then `0275b.sql`, then `0275c.sql` (or the whole `sql/0275_...sql`). Then run this. It must return one row with all three values `true`:

```sql
select
  (select count(*) = 3 from information_schema.tables where table_schema = 'public' and table_name in ('benchmark_upload_batches', 'benchmark_upload_rows', 'benchmark_upload_events')) as tables_ok,
  (select count(*) = 2 from information_schema.columns where table_schema = 'public' and table_name = 'admin_users' and column_name in ('can_upload_planning_benchmarks', 'can_activate_planning_benchmarks')) as columns_ok,
  (select count(*) = 4 from information_schema.routines where routine_schema = 'public' and routine_name in ('stage_planning_benchmark_upload', 'get_planning_benchmark_upload', 'activate_planning_benchmark_upload', 'discard_planning_benchmark_upload')) as functions_ok;
```

## Step 2: 0277

Paste `sql/parts/0277a.sql`, then `0277b.sql`, then `0277c.sql` (or the whole `sql/0277_...sql`). Then run this. It must return one row with every column `true`:

```sql
select
  (select count(*) = 2 from information_schema.tables where table_schema = 'public' and table_name in ('benchmark_dataset_metrics', 'benchmark_dataset_metric_events')) as tables_ok,
  (select count(*) = 2 from information_schema.routines where routine_schema = 'public' and routine_name in ('set_planning_benchmark_dataset_metric', 'remove_planning_benchmark_dataset_metric')) as functions_ok,
  (select count(*) = 1 from pg_trigger where tgname = 'trg_benchmark_upload_rows_dataset_metric' and not tgisinternal) as trigger_ok,
  (select count(*) = 0 from information_schema.role_table_grants where table_schema = 'public' and table_name in ('benchmark_dataset_metrics', 'benchmark_dataset_metric_events') and grantee in ('anon', 'authenticated') and privilege_type <> 'SELECT') as no_api_write_ok;
```

Then this, which lists the seeded pairs per dataset. On DEV the total is 71 (11 datasets, listed in `docs/planning-benchmarks/DATASET_METRIC_MAPPING.md`). **Production may hold fewer datasets than DEV; a dataset that does not exist there simply has no pairs and that is expected. Paste the result back; do not edit anything by hand.**

```sql
select d.dataset_name, count(*) as pairs,
       count(*) filter (where x.applies_to_values) as for_values,
       count(*) filter (where x.applies_to_target_ranges) as for_target_ranges
  from public.benchmark_dataset_metrics x
  join public.benchmark_datasets d on d.id = x.dataset_id
 group by d.dataset_name
 order by d.dataset_name;
```

## Step 3: 0278

Paste `sql/0278_planning_benchmark_removed_bands_target_ranges_only.sql` (it is short), Run. Then run this. It must return one row with all three values `true`:

```sql
select
  position('ub.kind = ''target_ranges''' in pg_get_functiondef('public.pb_removed_band_ids(uuid)'::regprocedure)) > 0 as kind_rule_ok,
  not has_function_privilege('anon', 'public.pb_removed_band_ids(uuid)', 'execute') as anon_blocked,
  not has_function_privilege('authenticated', 'public.pb_removed_band_ids(uuid)', 'execute') as authenticated_blocked;
```

And this, which proves the 0277 function was not disturbed (must return `true`):

```sql
select position('benchmark_dataset_metrics' in pg_get_functiondef('public.pb_dataset_readiness(uuid, uuid)'::regprocedure)) > 0 as readiness_still_has_mapping_rule;
```

## Step 4: switch the permissions on (your decision, last)

Only after steps 1 to 3 all passed. Recommended: upload for the person who prepares files, activate for a different person. One person may hold both; the screen then asks them to tick a self-activation box, which is recorded.

```sql
update public.admin_users set can_upload_planning_benchmarks = true where user_id = (select id from auth.users where email = 'person@example.com');
update public.admin_users set can_activate_planning_benchmarks = true where user_id = (select id from auth.users where email = 'other.person@example.com');
```

## What to paste back to me

1. The row from each check query (steps 1, 2, 3 and the readiness check).
2. The per-dataset table from step 2.
3. Any error text, exactly as shown, if a file or part did not run.

## Undo (roll back)

Only if nothing has been activated yet (after an Activate, figures have been end-dated and new ones added; ask before rolling back then). Undo in the **reverse** order:

1. `sql/rollback_0278.sql`: puts the 0275 function back (and with it the false "bands removed" statement). Needed only if 0278 itself must be undone.
2. `sql/rollback_0277.sql`: removes the mapping, its history and its checks and restores the 0275 readiness function.
3. Then the 0275 undo:

```sql
drop table if exists public.benchmark_upload_events;
drop table if exists public.benchmark_upload_rows;
drop table if exists public.benchmark_upload_batches;
drop function if exists public.stage_planning_benchmark_upload(jsonb);
drop function if exists public.get_planning_benchmark_upload(uuid);
drop function if exists public.activate_planning_benchmark_upload(uuid, jsonb);
drop function if exists public.discard_planning_benchmark_upload(uuid, text);
alter table public.admin_users drop column if exists can_upload_planning_benchmarks;
alter table public.admin_users drop column if exists can_activate_planning_benchmarks;
```

(Helper functions named `pb_...` and `is_planning_benchmark_...` can stay; they do nothing without the tables.) Figures are never touched by steps 1 and 2.
