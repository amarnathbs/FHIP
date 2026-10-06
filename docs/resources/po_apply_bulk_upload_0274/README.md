# Resources Bulk Upload: third database step for DEV (0274, faster apply)

0272 and 0273 are applied on DEV. DEV measurements showed that a 500 row apply needs 5 to 9 seconds of database time while the API login role allows 8 seconds per call (this applies to the server's own calls too, because the API connects through that login role). This step makes the create step lighter. **DEV only.** Not for production until you ask for the production step.

File: `supabase/migrations/0274_resource_content_bulk_import_faster_apply.sql` (one file, one function, safe to run twice; editor-safe like 0272 and 0273).

## What it changes, in plain language

It replaces the private create-all-or-nothing logic (the one both apply functions share) with a lighter version. Nothing else changes: no table, no constraint, no permission, and the two public functions are not touched.

1. **No per-row update first.** The server now gives every staged row its post id when it stages the file, so the database no longer updates every row before creating the drafts. (A file staged before this change still works: the missing ids are filled in.)
2. **No automatic "version 1" snapshot per draft.** Until now every imported draft also got a first revision record. That record is not part of the upload requirements and cost about a quarter of the time. The first time someone saves an imported draft by hand it still gets version 1, exactly like a hand-made draft (the editor numbers versions after the highest existing one). Workflow and review do not read versions.
3. **The result reports `db_ms`**, the database time of the call, so the timing can be measured.

Every safety rule is unchanged: only people allowed to bulk upload, only the person who uploaded the file, private drafts only, nothing published, all rows or none, the same file cannot be applied twice, a changed slug stops the whole thing.

## Steps

1. Open the **DEV** Supabase project; the address bar must show project reference `vqycarelcoijzwlpkpcz` (never `twwpnltizhtjxhamyoxt`).
2. SQL Editor, new query: copy all of `supabase/migrations/0274_resource_content_bulk_import_faster_apply.sql`, paste, **Run**. Expected: `Success. No rows returned`. On any error stop and paste the full error text and line number back.
3. Check (new query):

```
select p.proname, p.prosecdef, position('resource_post_versions' in pg_get_functiondef(p.oid)) as mentions_versions, position('db_ms' in pg_get_functiondef(p.oid)) as has_db_ms from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private' and p.proname = 'apply_resource_content_import_core';
```

Expected: one row, `prosecdef` true, `mentions_versions` 0, `has_db_ms` greater than 0.

## What to paste back

"0274 applied on DEV" and the one result row (text or screenshot), or the full error. I then run the repeated 500 row timing runs on DEV.

## If you need to undo it

Re-run `docs/resources/po_apply_bulk_upload_0273/parts/0273a.sql` (it restores the previous private logic). Created drafts are ordinary Resources and are not affected.

## Migration number

`0274` follows `0273` (applied on DEV). Free on `origin/main` and on every local branch and worktree on 06-10-2026 (highest allocated elsewhere: `0271`). Re-check at merge.
