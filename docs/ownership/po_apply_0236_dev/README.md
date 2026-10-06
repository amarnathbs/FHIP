# Owner-before-upload: DEV hand-over for the SQL editor (06-10-2026)

**Database: DEV only (project `vqycarelcoijzwlpkpcz`). Never production.** Before you paste anything, look at the address bar or the project name in the Supabase dashboard and confirm it says `vqycarelcoijzwlpkpcz`.

## 1. What Claude found on DEV today (read only, 06-10-2026)

- Migration 0236 is **already on DEV**. All 11 new columns exist, the allocation function works (8 of 8 test inputs behave correctly), the column comments match the migration word for word, and the foreign keys point to the right tables. So you are **not** applying it for the first time. Running it again below is the "safe to run twice" proof the spec asks for.
- What Claude cannot see from outside the SQL editor: the 13 constraints, the 2 triggers, the row security setting. File 01 shows them, so we can say "exact match" instead of guessing.
- The backfill has **not** been run. Today DEV has 6 bank documents and 4 India CAS documents. One of the 4 (created 05-10-2026) was chosen by a user on the new upload form and must stay untouched.
- Why one expected number is not zero: 2 of the 4 CAS documents already have a real household member recorded (relationship Self), so the backfill copies that real owner. It never turns a document with no recorded owner into Self.

## 2. The steps (run each file in the SQL editor, in this order)

Each file is a separate paste. Run one, look at the result, then go on. The editor only shows the result of the **last** statement of a file, which is why the counts are in their own read-only files.

| # | File | What it does | Expected result |
|---|---|---|---|
| 1 | `01_schema_inventory_BEFORE.sql` | Read only. Lists every object migration 0236 owns, and a fingerprint of the lot. | 12 column rows, 13 constraint rows, 2 trigger rows, 2 function rows, 4 foreign key rows, 3 row-security rows, and a last row `FINGERPRINT`. **Paste the whole grid back.** |
| 2 | `02_apply_0236_owner_before_upload_phase1.sql` | The migration itself, exactly as on `main`. It is built to be safe to run again. **Run it twice** (two separate runs). | "Success" both times, no red error. |
| 3 | `03_schema_inventory_AFTER.sql` | Same query as file 01. | **The FINGERPRINT row must be identical to step 1.** Same counts. **Paste the grid back.** |
| 4 | `04_preview_counts_readonly.sql` | Read only. What the backfill is about to do. | Bank documents: total 6, will copy 0, will be marked legacy_unset 6. India CAS: total 4, will copy 2, will be marked legacy_unset 1. **Paste back.** |
| 5 | `05_backfill_PREVIEW_as_shipped_ROLLBACK.sql` | The backfill exactly as shipped. It ends in ROLLBACK, so it changes nothing. | "Success. No rows returned". Then run file 04 again: the numbers must be **unchanged** (proof that nothing was saved). |

**STOP here if the numbers in step 4 differ from the expected ones, or if anything in step 3 differs from step 1. Paste what you see and do not continue.**

| # | File | What it does | Expected result |
|---|---|---|---|
| 6 | `06_backfill_COMMIT.sql` | The same script, with the last word changed from rollback to commit. **Run once only.** | "Success". |
| 7 | `07_state_after_backfill_readonly.sql` | Read only. Owner state of every document. | Bank documents: `legacy_unset`, role `(no role)`, 6. CAS: `backfill_from_document` / `self` 2, `legacy_unset` / `(no role)` 1, `user_selected` / `self` 1. No row says `unbackfilled`. **Paste back.** |
| 8 | `08_preview_counts_readonly_AGAIN.sql` | Same query as file 04, run after the commit. | Totals unchanged (6 and 4). Every "will copy" and "will be marked" line is **0**. A non-zero line is a defect. **Paste back.** |
| 9 | `09_backfill_PREVIEW_again_as_shipped_ROLLBACK.sql` | The shipped script once more. | "Success. No rows returned". Then file 08 again: still all zero. |
| 10 | `10_cron_sweep_jobs_state_readonly.sql` (optional) | Read only. Are any document sweep jobs scheduled on DEV? | Zero rows. Paste back whatever you get. |

## 3. What to paste back to Claude

1. The result grids of files 01, 03, 04, 07, 08 (and 10 if you ran it), as text. They contain no personal data (ids are cut to 8 characters).
2. **Any red error text** from any step, exactly as shown.
3. A one-line "done, steps 1 to 9" when you have finished.

Claude can read the document rows on DEV itself afterwards, so a screenshot is not needed for 07 and 08, but the grids for 01 and 03 can only come from you.

## 4. If the editor misbehaves

DEV incident of 05-10-2026: the editor sometimes reads the word after `into` inside a comment or a string as a table name (error 42P01 "relation ... does not exist"). The new read-only files (01, 03, 04, 07, 08, 10) are written to avoid that and are checked by a test. Files 02 and 05, 06, 09 are the shipped files, byte for byte, and are **not** reworded on purpose: the migration is already on DEV with this same text, so it is known to paste. If any of them fails with that kind of error, paste the error back and Claude will prepare an editor-safe copy proven identical in effect. Do not edit the SQL yourself.

## 5. What was proven before this hand-over (not on DEV)

`scripts/owner_before_upload_0236_handover_pack_pglite_verification.mjs`: a real PostgreSQL engine in memory, 35 checks, 0 failed. It proves, with files exactly as in this folder: 02 equals the migration on `main`, 05 and 09 equal the shipped backfill, 06 differs from 05 only in the last word; the fingerprint is the same after a second apply; the fingerprint **changes** when one constraint is dropped, when one trigger is dropped, or when a column type is changed (so a drifted DEV cannot look like an exact match); the counts in file 04 equal the shipped script's own preview; the backfill never gives a document with no owner the role Self; the user-selected row is byte for byte unchanged; a second commit run changes nothing.
The existing 55-check PGlite proof of the migration itself (`scripts/owner_before_upload_0236_pglite_verification.mjs`) also passes on the merged tree.

## 6. After you confirm

Claude reads DEV again (read only), checks the document rows against file 07, and then continues with the live certification (steps 6 to 38 of the 06-10-2026 spec) on a DEV copy of the app running the exact `main` code, using synthetic test users only. Nothing in production is touched, and production document upload stays off.
