# Planning Benchmarks upload: how to apply migration 0275 on DEV (Product Owner step)

Written 06/10/2026 for finding F5 ("there is no upload option"). Design and trade-offs: `docs/planning-benchmarks/UPLOAD_DESIGN.md`. How often to refresh each dataset and whether a feed exists: `docs/planning-benchmarks/REFRESH_CADENCE_AND_FEEDS.md`.

**Evidence label:** the SQL was replayed on an isolated in-memory Postgres (PGlite) together with the whole migration ledger, and every rule was exercised there (41 passing checks, see the report). It has **not** been applied to DEV or production. Nothing in the app can use the upload until you apply it.

## What it does, in plain words

- Adds a place where an uploaded benchmark file waits ("staging") so it can be checked and previewed. **Nothing in staging is shown to any user.**
- Adds two permissions for administrators, both **off for everyone** until you switch them on:
  - Upload (stage a file, see the preview, discard your own file)
  - Activate (make a staged file live, discard any staged file)
- Adds the four database functions the screen calls. Activating a file is all or nothing: it end-dates the figures it replaces (it never deletes them, because past Twin results point at them) and adds the new ones.
- Changes no existing figure and no existing table except adding two on/off columns to `admin_users`. It loads no data and activates nothing.

## Before you start

1. Project: Supabase **DEV** (`vqycarelcoijzwlpkpcz`). Do not run this on production yet.
2. The code on the branch `fix/po-review-resources-data-20261006` is what uses it. Applying the SQL first is harmless: the Upload tab only appears for a person who has been given a permission.

## Apply (Supabase SQL editor)

The file is long, so it is also split into three parts that you paste one at a time, in order. Each part can be run on its own and can be run twice safely.

1. Open `parts/0275a.sql`, paste all of it, press Run. Expect "Success. No rows returned".
2. Open `parts/0275b.sql`, paste, Run.
3. Open `parts/0275c.sql`, paste, Run.

(Or paste `supabase/migrations/0275_planning_benchmark_staged_upload.sql` in one go. If the editor complains, use the parts.)

## Check it worked

Run this; it must return one row with all three values `true`:

```sql
select
  (select count(*) = 3 from information_schema.tables where table_schema = 'public' and table_name in ('benchmark_upload_batches', 'benchmark_upload_rows', 'benchmark_upload_events')) as tables_ok,
  (select count(*) = 2 from information_schema.columns where table_schema = 'public' and table_name = 'admin_users' and column_name in ('can_upload_planning_benchmarks', 'can_activate_planning_benchmarks')) as columns_ok,
  (select count(*) = 4 from information_schema.routines where routine_schema = 'public' and routine_name in ('stage_planning_benchmark_upload', 'get_planning_benchmark_upload', 'activate_planning_benchmark_upload', 'discard_planning_benchmark_upload')) as functions_ok;
```

## Then switch the permissions on (your decision, U1 in the design)

Run for each person you choose (replace the email). Recommended: upload for the person who prepares the files, activate for a different person. One person may hold both; the screen then asks them to tick a self-activation box, which is recorded.

```sql
update public.admin_users set can_upload_planning_benchmarks = true where user_id = (select id from auth.users where email = 'person@example.com');
update public.admin_users set can_activate_planning_benchmarks = true where user_id = (select id from auth.users where email = 'other.person@example.com');
```

## After it is applied

Tell the team. Live DEV certification of the upload (stage a file, preview, activate, check the Twin, browser checks) can then run. Until then the upload is "code-complete, unit-tested and PGlite-verified" only.

## One change in the live Twin path (decision U2)

The branch also adds one filter to the two Twin queries that read benchmark figures (`lib/services/twinBenchmarkRetrieval.ts`): a figure whose end date has passed is no longer served. Today no figure has an end date, so nothing changes until the first Activate replaces a figure. Without this filter an end-dated figure would still be served next to its replacement. Deploy this code **before** the first Activate that replaces anything.

## Roll back

Only if nothing has been activated yet (after an Activate, figures have been end-dated and new ones added; ask before rolling back then):

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

(Helper functions named `pb_...` and `is_planning_benchmark_...` can stay; they do nothing without the tables.)
