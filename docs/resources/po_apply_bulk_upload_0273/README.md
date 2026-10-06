# Resources Bulk Upload: second database step for DEV (0273, large files)

0272 is already applied on DEV. This second step fixes one real problem found on DEV: creating the drafts for a **500 row** file needs 5 to 9 seconds of database time, and the database allows a signed in person only 8 seconds per call. The largest files could therefore fail (nothing was ever left half done: the whole thing rolled back). This step lets the **server** run the same create-all-or-nothing step without that limit.

It is **new functions only**: no table, no constraint and nothing in `resource_posts` changes. It is safe to run twice. **DEV only.** Do not run it on production until you have asked for the production step.

File: `supabase/migrations/0273_resource_content_bulk_import_apply_as_actor.sql`
The same SQL is split in `parts/0273a.sql` and `parts/0273b.sql` (run a then b) if the editor ever struggles with the whole file. It follows the same editor-safe rules as 0272.

## What it does, in plain language

1. Moves the existing create-all-or-nothing logic, unchanged, into a private function that is told who the person is.
2. The existing function everyone used (`apply_resource_content_import`) keeps its name and works exactly as before: it always uses the signed in person.
3. Adds a second function that **only the server can run** (nobody signed in, and no browser, can call it). The server tells it which person is applying, using the person it has already verified from their login and after checking they may bulk upload. The database **still checks again** that this person may bulk upload and that they are the one who uploaded this file. So the worst a wrong name could ever do is let someone apply their own upload.
4. Everything else is identical: private drafts only, nothing published, all rows or none, a changed slug stops the whole thing, the same file cannot be applied twice.

## Steps

1. Open the **DEV** Supabase project and check the project reference in the address bar: it must be `vqycarelcoijzwlpkpcz` (never `twwpnltizhtjxhamyoxt`).
2. SQL Editor, new query. Copy all of `supabase/migrations/0273_resource_content_bulk_import_apply_as_actor.sql`, paste, press **Run**.
   - Expected: `Success. No rows returned`.
   - If there is any error: do not run anything else. Paste the full error text and the line number back to me. (If it looks like an editor problem, run `parts/0273a.sql`, then `parts/0273b.sql`.)
3. Run these checks in a new query, one block at a time.

### Check 1: the three functions exist and are locked down

```
select n.nspname, p.proname, p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace where p.proname in ('apply_resource_content_import', 'apply_resource_content_import_as_actor', 'apply_resource_content_import_core') order by p.proname;
```

Expected: 3 rows (two in `public`, one in `private`), `prosecdef` true on every row.

### Check 2: nobody except the server can run the new functions

```
select has_function_privilege('anon', 'public.apply_resource_content_import_as_actor(uuid, uuid)', 'execute') as anon_twin, has_function_privilege('authenticated', 'public.apply_resource_content_import_as_actor(uuid, uuid)', 'execute') as signed_in_twin, has_function_privilege('authenticated', 'private.apply_resource_content_import_core(uuid, uuid)', 'execute') as signed_in_core, has_function_privilege('service_role', 'public.apply_resource_content_import_as_actor(uuid, uuid)', 'execute') as server_twin, has_function_privilege('authenticated', 'public.apply_resource_content_import(uuid)', 'execute') as signed_in_normal, has_function_privilege('anon', 'public.apply_resource_content_import(uuid)', 'execute') as anon_normal;
```

Expected: one row: `anon_twin` false, `signed_in_twin` false, `signed_in_core` false, `server_twin` **true**, `signed_in_normal` **true**, `anon_normal` false.

## What to paste back to me

"0273 applied on DEV" plus the results of checks 1 and 2 (text or screenshot), or the full error text if step 2 failed. I then re-run the 500 row Article and Money Update cases and the simultaneous-click test on DEV.

## If you need to undo it

To go back to exactly the 0272 behaviour, do these three in order:

1. Re-run `docs/resources/po_apply_bulk_upload/parts/0272c.sql` (restores the original full `apply_resource_content_import`).
2. Run `drop function if exists public.apply_resource_content_import_as_actor(uuid, uuid);`
3. Run `drop function if exists private.apply_resource_content_import_core(uuid, uuid);`

The app keeps working throughout (it falls back to the normal function when the server-only one is missing). Created drafts are ordinary Resources and are not affected.

## Migration number

`0273` follows `0272` (applied on DEV). It was free on `origin/main` and on every local branch and worktree on 06-10-2026 (highest allocated elsewhere: `0271`). Re-check at merge: the checker scripts cannot see unmerged branches.
