# Resources Bulk Upload (Articles + Money Updates): PRODUCTION hand-over pack

Prepared 15-10-2026. **Nothing in this folder has been run on production.** I (the agent) have no production access and looked for none. Everything below was replayed on an isolated in-memory Postgres (PGlite) that holds the whole current migration ledger without 0272 to 0274, which is the state production is expected to be in. The live behaviour was proven on DEV (see `../RESOURCE_BULK_UPLOAD_CERTIFICATION.md`).

**Evidence labels used here:** PGlite-verified (real Postgres, copy of the repository ledger), DEV-verified (real DEV database and DEV server), UNVERIFIED (cannot be known from the repository: production's own data, size, speed). Nothing in this pack is PRODUCTION-VERIFIED until you run it and paste the results back.

## 1. The idea in one paragraph

Three small migrations, in order, add **only new things**: two holding tables for uploaded rows, five functions and their permissions. They change no existing table, column, constraint, policy or function (proof: section 3). The application code that shows the Bulk Upload screens is deployed by your push afterwards. Until then the database objects sit unused. Nothing is created in Resources until a person with the right to bulk upload uploads a file, looks at the preview and presses the confirmation button; everything created is a **private draft**, never published, scheduled or approved. After the migrations and the push you run the **synthetic verification**: one clearly marked fake Article and one clearly marked fake Money Update, then an exact cleanup of just those.

## 2. The order

| # | Step | Files | Writes data? | Point of no return? |
|---|---|---|---|---|
| 0 | Confirm the project is **production** (address bar must NOT show `vqycarelcoijzwlpkpcz`, that is DEV) | | no | no |
| 1 | Read-only precheck | `checks/P0_precheck_readonly.sql` | no | no |
| 2 | Migration 0272, then its check | `sql/parts/0272a.sql`, `0272b.sql`, `0272c.sql` (or the whole `sql/0272_...sql`), then `checks/P1_after_0272.sql` | new objects only | no (R1 removes them) |
| 3 | Migration 0273, then its check | `sql/parts/0273a.sql`, `0273b.sql` (or the whole file), then `checks/P2_after_0273.sql` | new objects only | no |
| 4 | Migration 0274, then its check | `sql/0274_...sql` (one paste), then `checks/P3_after_0274.sql` | replaces one new function | no |
| 5 | Push the code (yours, see the end of the final report: the exact command) and wait for Amplify to show Deployed | | | no (redeploy the previous build) |
| 6 | Manual backup before the first synthetic upload, then its check | `backup/B1_...sql`, `backup/B2_backup_check_readonly.sql` | copies only | no |
| 7 | Synthetic verification (section 5) | `synthetic/*.csv`, `verify/V1_after_apply_readonly.sql` | **yes** (2 fake drafts) | no |
| 8 | Cleanup of just those rows | `cleanup/C1_...`, `C2_...`, `C3_...` and `B2` again | **yes** (deletes only the fake rows) | the fake rows only |
| 9 | Optional: drop the backup copies | `backup/B3_drop_backups.sql` | drops copies | no |

Run each SQL file by pasting it into the Supabase SQL editor and pressing Run. Every file is editor-safe (a test lints each one). Migration files can be run twice safely. Read-only files say READ ONLY on their first line.

**Why migrations before the push:** the screens degrade gracefully while the tables are missing (DEV-verified: the pages open and the history says it could not be loaded), but there is no reason to run that way. Run steps 1 to 4 first, then push.

**If a part fails:** stop, copy the whole error text and the line number it mentions, send it back. Nothing is left half done that matters; every part can be run again. If the editor itself seems to be the problem use the parts files.

## 3. Proof that the migrations are additive (no backup of existing tables is needed for steps 2 to 4)

| What 0272 / 0273 / 0274 do | Evidence |
|---|---|
| `create table if not exists` for `resource_content_import_runs` and `resource_content_import_rows` (new, empty) | the files; `P1` row 10 shows both empty |
| `create or replace function` for six functions, all new names | the files; `P1`, `P2`, `P3` |
| `alter table ... enable row level security`, `revoke`, `grant`, `comment on` **on the two new tables and new functions only** | the files |
| One foreign key from the new rows table to `resource_posts(id)` (`on delete set null`) | it is a constraint **on the new table**; it needs a momentary lock on `resource_posts` while it is added to an empty table and changes no row, column, constraint or policy of `resource_posts` (PGlite-verified: `P1` rows 11 to 13 equal `P0` rows 43 to 45) |
| No `alter table` on any existing table, no `drop`, no `insert`/`update`/`delete` on existing data | `tests/unit/resourcesBulkImportMigration.test.ts` and `resourcesBulkImportProductionPack.test.ts` |

So the PO rule "manual backup of the exact affected tables before any data-changing step" first bites at **step 7**, the synthetic upload, which inserts into six existing tables (and step 8, which deletes the fake rows from them). That is why the backup is taken at step 6, not before the migrations. If you prefer a backup before the migrations anyway, run B1 early; it is harmless.

The six tables the synthetic upload writes to, and the exact rows it adds: `resource_posts` (2), `resource_post_categories` (2), `resource_sources` (2: `ZZ BULKVERIFY Source A` and `ZZ BULKVERIFY Source M`), `resource_post_sources` (2), `resource_audit_log` (4 to 6: one per draft, one per import, plus anything you do when you open and save a draft), `resource_post_tags` (0, the fake files name no tag).

## 4. Before you start: what P0 tells you

Run `checks/P0_precheck_readonly.sql`. Send me the whole result (it is a table of about 47 rows). I need it before you apply anything, for two reasons:

1. **Section A and B (must all be ok):** the Resources tables, the 26 columns the apply writes, the unique key the apply relies on, the two helper functions the capability uses, and the role model (`editor` and `resource_admin` are allowed role values). If any is red, the database differs from what the migrations were written against: stop.
2. **Section C (must all be false):** nothing of this release is applied yet. If any is true, a step was already done: stop and tell me which.
3. **Section D (facts):** database size, table sizes, row counts, how many people hold each Resources role, and **row 42: how many people will see the Bulk Upload option on Create Resource** (the SQL still labels the row "menu entry"; since the PO decision of 16-10-2026 there is no sidebar group) once the code is live (Super Admins, Resource Admins and Editors; Authors, Compliance Reviewers, Publishers and Analysts do not). Check that list is who you want. Row 35 shows the audit table size: if it is above about 200 MB tell me before B1 (the database is over its plan size and a large copy could hurt).
4. Row 46 lists real category slugs. The two fake files name the category `financial-health`. If that slug is not in the list, open both CSV files in a text editor and replace `financial-health` with a slug that is (or run `npx tsx scripts/resources_bulk_upload_make_synthetic_prod_files.ts --category <slug>` and use the files it writes). A wrong category only makes the preview refuse the file (`UNKNOWN_PRIMARY_CATEGORY`), nothing is created.

## 5. The synthetic verification (step 7), click by click

Use a real production login that holds Super Admin, Resource Admin or Editor. **Never use the real India inflation workbook here.** Dates on every screen are day first (dd-mm-yyyy for India, dd/mm/yyyy for Australia); the CSV files keep the year first because that is the template contract.

1. Resources, **Create Resource**, then the **Bulk Upload** section (PO decision 16-10-2026: Bulk Upload lives inside Create Resource; no separate sidebar group; also reachable with the Upload buttons on All Content and on Money Updates). The chooser asks "What would you like to upload?".
2. **Templates:** download the Article template as XLSX and as CSV, and the Money Update template as XLSX and as CSV (four files). Open one XLSX: sheets `Instructions`, `Article_Upload` (or `Money_Update_Upload`), `Lookup_Values` (your real categories, tags, authors and calls to action), `Example`.
3. **Article:** Upload Articles, choose `synthetic/ZZ_BULKVERIFY_Article_1_row.csv`, preview. Expected: 1 row ready, 0 errors; open the row to see the quick answer, three takeaways, a heading, a paragraph, two bullets, an example, the financial-health section, and the source. Press **Create 1 Article as a private Draft**. Expected result: "1 Article created, 0 failed" and the nothing-published sentence.
4. **Open the draft** from the result screen. It opens in the normal Article editor. Check the body shows as normal blocks, **Sources** shows `ZZ BULKVERIFY Source A`, make a one-word edit to the paragraph, press **Save Changes**, reload: the edit is still there. (Do not move it through any workflow step.)
5. **Money Update:** repeat with `synthetic/ZZ_BULKVERIFY_Money_Update_1_row.csv` (Upload Updates). It opens in the normal Money Update editor with the five sections and the source.
6. **Public hidden proof** (in a private/incognito window, signed out), each must show "not found" or simply not list the item:
   - `https://app.financialhealthplatform.com/resources/zz-bulkverify-article-1` and `.../resources/zz-bulkverify-money-update-1` (expect the not-found page);
   - `https://app.financialhealthplatform.com/resources` and `.../resources/money-updates` (neither fake item listed);
   - `https://app.financialhealthplatform.com/resources/search?q=ZZ+BULKVERIFY` (no result);
   - `https://app.financialhealthplatform.com/sitemap.xml` (use the browser's find: `zz-bulkverify` must not appear).
7. **Same file again:** upload the Article CSV a second time. Expected: the preview or the apply refuses with "This exact file was already applied. Nothing was created." (`FILE_ALREADY_APPLIED`). Skip if you prefer.
8. **A wrong file:** upload the Article CSV after changing the first cell of the header (`template_version`) to anything else. Expected: a plain refusal, nothing staged for apply. Skip if you prefer.
9. SQL `verify/V1_after_apply_readonly.sql`: first result 2 rows (one article, one money_update) with `status draft`, `visibility private`, `is_indexable false`, `never_published true`, `ok true`; second result 2 rows with `status applied`; third result 0 rows. Paste all three back.
10. Screenshot (or paste) what the Bulk Upload history shows (File, Type, Rows, Result, with day-first dates).

**Capacity proof (optional, separate, ask first):** the certification's open condition 1 asks for 250 row files on production to measure the database time (`dbMs`) of an apply, because production has the same 8 second per-call limit but a different data volume. Make the files with `npx tsx scripts/resources_bulk_upload_make_synthetic_prod_files.ts --rows 250`, upload and apply one at a time, read `dbMs` from the result screen or the server log, then run the cleanup with `expected_posts` set to the number of rows you applied. Do it only after the 2 row verification passed and its cleanup is done. Do **not** raise the limit above 250 without that evidence.

## 6. Cleanup (step 8)

1. `cleanup/C1_preview_synthetic_rows_readonly.sql`: read every row. Expected: 2 posts, 2 sources, 2 import runs, and the last number 0. If anything looks like real content, stop and send it back.
2. `cleanup/C2_cleanup_synthetic_rows.sql`: it deletes only rows with the three synthetic markers, in one transaction, and **refuses with `CLEANUP_STOPPED` (deleting nothing)** if the post count is not exactly the number on the line marked `EDIT` (default 2), if a fake post is anything other than a private never-published draft, or if a real post uses a fake source. Expected message: `CLEANUP_DONE: posts 2, import runs 2, sources 2, audit rows N`.
3. `cleanup/C3_zero_residue_check_readonly.sql`: every row 0 and ok true.
4. `backup/B2_backup_check_readonly.sql`: equal counts again (unless real people worked in Resources in between, in which case a difference is expected and you read it instead of trusting it).

The fake audit rows are removed by the cleanup because they describe fake rows only. If you would rather keep every audit row as a matter of policy, tell me: the cleanup then leaves the audit rows and C3 row 5 will show a non-zero number by design.

## 7. Rollback and stop

| Situation | File | Effect |
|---|---|---|
| Stop uploads immediately (keep everything) | `rollback/R2_disable_apply_only.sql` | nobody can create drafts from an upload; previews still work. **Both** the signed-in function and the server twin are revoked: revoking only one does not stop it (negative control in the test) |
| Switch them back on | `rollback/R3_enable_apply_again.sql` | |
| Remove the feature's database objects entirely | `rollback/R1_remove_bulk_upload_database_objects.sql` | drops the two staging tables and the six functions; touches no existing table; drafts already created stay |
| Redeploy the previous build | Amplify | the screens disappear; database objects stay unused |
| A real row was removed by mistake | `rollback/R4_restore_deleted_rows_from_backup.sql` | re-adds rows the B1 backup holds and the live table lacks; changes no live row |

## 8. Known limits (stated honestly)

- **Per-file limit 250 rows**, the single constant `IMPORT_LIMITS.maxRows`. DEV worst case was 2.1 s of database time at 250 rows (limit 8 s). Production is UNVERIFIED until the optional capacity proof.
- A file that needs more than 8 seconds of database time on production would be refused with the plain message "Nothing was created. This file is too large to apply in one go right now." and could be retried or split.
- The SQL editor on the Supabase dashboard mis-parses some words inside comments and strings. That is why none of these files uses a percent sign, or the words into/from/join followed by a name inside a comment or a quoted string.
- **Production has no managed backups.** B1 copies are in the `private` schema (not served by the API, row level security on, all API privileges revoked) and use extra database space. Drop them with B3 when finished.
- The deployment itself is yours. This pack does not push anything.
