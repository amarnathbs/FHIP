# Resources Bulk Upload (Articles + Money Updates): database step for DEV

This is the one database change the bulk upload needs. It is **new tables and new functions only**. It changes nothing that exists today (no change to `resource_posts` or any other existing table, constraint, policy or function). It is safe to run twice. **Run it on DEV only.** Do not run it on production until you have certified the feature on DEV and asked for the production step.

File: `supabase/migrations/0272_resource_content_bulk_import.sql`

The same SQL is also split into three small parts in the `parts/` folder (`0272a.sql`, `0272b.sql`, `0272c.sql`) in case the Supabase editor ever struggles with the whole file. Run the whole file if you can. If the editor complains, run the three parts one after another, in order a, b, c, each as its own paste.

The file follows the editor-safe rules (plain ASCII, no semicolons or quotes inside comments, no "into / from / join" followed by a word inside a comment or a string). A test in the repository checks this every time.

## What it does, in plain language

1. Adds two holding tables. When someone uploads a spreadsheet, the checked rows wait there until the person confirms. The browser can never write to them; only the server can. Each person can read only their own uploads (Resource Admins and Super Admins can read all uploads for the history screen).
2. Adds one rule that says who may bulk upload: **Super Admin, Resource Admin and Editor only**. Authors, Compliance Reviewers, Publishers and Analysts cannot.
3. Adds a "create all or nothing" function. When the person confirms, it creates every row as a **private draft** in one go. If anything goes wrong, nothing is created at all. It can never publish, schedule or approve anything.
4. Adds a quick "does this already exist" lookup and a clean-up function that removes unconfirmed uploads after 7 days.

## Steps

1. Open the **DEV** Supabase project. Check the project reference in the browser address bar. It must be `vqycarelcoijzwlpkpcz`. If it shows `twwpnltizhtjxhamyoxt` that is production: stop.
2. Open **SQL Editor** and start a new query.
3. Open `supabase/migrations/0272_resource_content_bulk_import.sql`, copy all of it, paste it into the editor and press **Run**.
   - Expected result: `Success. No rows returned`.
   - If you see an error, do not run anything else. Copy the full error text and the line number it mentions and paste them back to me. (If the error looks like an editor problem, use the three parts instead: run `parts/0272a.sql`, then `parts/0272b.sql`, then `parts/0272c.sql`.)
4. Open a new query, paste the checks below, and run them one block at a time. Each block has its expected result.

### Check 1: the two tables exist

```
select table_name from information_schema.tables where table_schema = 'public' and table_name in ('resource_content_import_runs', 'resource_content_import_rows') order by table_name;
```

Expected: 2 rows, `resource_content_import_rows` and `resource_content_import_runs`.

### Check 2: the four functions exist and are locked down

```
select proname, prosecdef from pg_proc where proname in ('apply_resource_content_import', 'resource_content_import_lookup', 'purge_expired_resource_content_import_staging', 'can_bulk_import_resource_content') order by proname;
```

Expected: 4 rows, `prosecdef` true on every row.

### Check 3: row-level security is on for both tables

```
select relname, relrowsecurity from pg_class where relname in ('resource_content_import_runs', 'resource_content_import_rows') order by relname;
```

Expected: 2 rows, `relrowsecurity` true on both.

### Check 4: nobody anonymous can run the new functions

```
select has_function_privilege('anon', 'public.apply_resource_content_import(uuid)', 'execute') as anon_can_apply, has_function_privilege('anon', 'public.resource_content_import_lookup(text[], text[], text[])', 'execute') as anon_can_lookup, has_function_privilege('authenticated', 'public.purge_expired_resource_content_import_staging()', 'execute') as signed_in_can_purge;
```

Expected: one row with all three values `false`.

### Check 5: the same file can never be applied twice (database guarantee)

```
select indexname from pg_indexes where tablename = 'resource_content_import_runs' and indexname = 'uq_rcir_applied_file';
```

Expected: 1 row, `uq_rcir_applied_file`.

## What to paste back to me

Reply with: "0272 applied on DEV" and the results of checks 1 to 5 (a screenshot or the text is fine), or the full error text if step 3 failed. I then run the live DEV certification (real sign-in, real uploads, real browser).

## If you need to undo it

Nothing else depends on these objects until the feature is used. To remove them completely on DEV:

```
drop function if exists public.apply_resource_content_import(uuid);
drop function if exists public.resource_content_import_lookup(text[], text[], text[]);
drop function if exists public.purge_expired_resource_content_import_staging();
drop table if exists public.resource_content_import_rows;
drop table if exists public.resource_content_import_runs;
drop function if exists private.can_bulk_import_resource_content(uuid);
```

Dropping the tables removes only upload history and staged rows. Drafts that were already created stay (they are ordinary Resources).

## Migration number

`0272` was free on `origin/main` and on every local branch and worktree on 06-10-2026 (highest allocated anywhere: `0271`, held by the NAV2 branches; `0264` to `0268` by the promo hardening branch; `0253` by the look-through branch). The two checker scripts cannot see unmerged branches, so the number must be re-checked at merge time.
