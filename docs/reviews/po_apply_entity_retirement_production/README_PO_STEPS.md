# Entity + retirement release (R3): the production pack, in order

Release branch `release/entity-retirement-20261026` (current origin/main plus the DEV-certified entity and retirement work). Nothing in this folder has been run on production. Everything is pasted by you, one file at a time, in the PRODUCTION Supabase SQL editor (project twwpnltizhtjxhamyoxt: check the address bar every time).

## THE RULE: SQL FIRST, THEN CODE

Run every step below (A to C) BEFORE the code is pushed to main. The new screens read tables and functions that only exist after the SQL, and the cutover (step C) makes the SMSF figures right before the new screens go live. If the code went first, the family figure would read 1,377,441 until the cutover ran, and several screens would fail on a missing table. The old code keeps working against the new database (the old screens keep their data), so the gap between the SQL and the deploy is safe, keep it short.

## Which migrations are NEW on production, and which are not

| Migration | State on production | In this pack |
|---|---|---|
| 0294 (risk-free verified-through) | ALREADY APPLIED. Do not run it again. Step A checks it is there. | no |
| 0289 SMSF fund liabilities | NEW | `migrations/M_0289_part1..3` |
| 0290 either-or rule, switch, undo, history | NEW | `migrations/M_0290_part1..5` |
| 0295 SMSF liability fields and property link | NEW | `migrations/M_0295_...` |
| 0296 entity income, expenses, change log, move function | NEW | `migrations/M_0296_part1..3` |
| 0297 Company, Trust, HUF either-or rule and line detail | NEW | `migrations/M_0297_part1..3` |
| 0298 retirement declaration guard | NEW | `migrations/M_0298_...` |
| 0299 undo for Company, Trust, HUF switch | NEW | `migrations/M_0299_...` |
| 0304 retirement contributions ledger | NEW | `migrations/M_0304_...` (an editor-safe copy of the file, see below) |

Not in this release: 0286 (Module 11), 0292 and 0293 (property use), 0310 to 0313 (bank and statement jobs), and the legacy SMSF canonicalisation (R4, a later release). The retirement PDF route stays OFF in production: `AIE_RETIREMENT_PDF_ROUTE_ENABLED` is not set (it defaults to off) and nothing in this release changes that. Production uploads stay gated exactly as they are.

## Why the migrations are pasted as parts

Every paste file is at most 15 KB, passes the repository editor-safety lint (ASCII, no bare dollar quote, no percent sign, no semicolon or quote inside a comment, no hazard word) and is SAFE TO RUN TWICE. 0289 and 0290 are the same parts you used for the entity phase 1 pack. 0296 and 0297 are cut at their numbered sections. 0304 is a copy of the migration made editor-safe (the file itself uses a bare dollar quote and quotes in comments): the same table, constraints, index, trigger and policy (the policy keeps its name, it is built at run time). The test `tests/unit/entityRetirementProductionPackPglite.test.ts` proves the parts are exact slices and that the schema they build is identical, object for object, to the schema the migration files build.

## The order

| Step | File | What it does | You should see |
|---|---|---|---|
| A | `A_prerequisites_and_what_is_new_READ_ONLY.sql` | One select, changes nothing. | Every row marked "must be true" is true (including 0294). Every row starting NEW is false. If not, STOP and send the output. |
| A2 | `A2_data_shapes_READ_ONLY.sql` | One select, changes nothing. How many SMSF funds, entities, tagged rows and ticked declarations exist. | Keep the output. For the PO household: 1 fund carrying a typed net, 1 retirement row tagged SMSF besides the fund row. |
| B | `B_backup_all_touched_tables.sql` | Copies every table the migrations or the cutover touch into private `bk_er_20261026_*` tables. Keeps the FIRST copy, never overwrites. | Last query: live_rows equals copied_rows on every line. If the database refuses to create a table (size), STOP. Production has no managed backups, do not skip this. |
| M1 | `migrations/M_0289_part1` ... `M_0290_part5` (8 files, in `ORDER.txt` order) | Entity phase 1: fund liabilities, the either-or rule, switch, undo, history. | Each file runs without error. |
| V1 | `V1_verify_after_0289_0290_READ_ONLY.sql` | Read only. | Every row ok = true (12 rows). |
| M2 | `migrations/M_0295_...`, `M_0296_part1..3`, `M_0297_part1..3` (7 files) | SMSF liability fields, entity income and expenses and change log, Company, Trust, HUF rule. | Each file runs without error. |
| V2 | `V2_verify_after_0295_0296_0297_READ_ONLY.sql` | Read only. | Every row ok = true (13 rows). |
| M3 | `migrations/M_0298_...`, `M_0299_...`, `M_0304_...` (3 files) | Retirement declaration guard, entity Undo, contributions ledger. | Each file runs without error. |
| V3 | `V3_verify_after_0298_0299_0304_READ_ONLY.sql` | Read only. | Every row ok = true (10 rows). |
| A again | `A_prerequisites_and_what_is_new_READ_ONLY.sql` | Same file. | Every row starting NEW is now true. |
| C0..C4 | `cutover/` (see below) | The entity cutover for the PO household. | See below. |
| D | the code push (see the report: the main line) | Deploy. | Post-deploy checks. |

If a migration file fails, stop and send the message. Do not run the next one. Each file is safe to run again, so after a fix the same file can simply be run again.

## The entity cutover for the PO household (`cutover/`)

These are the phase 1 production files, unchanged (the test compares them byte for byte with the phase 1 copies) and proved against the FINAL schema (0289 to 0304) on the PO shape. Replace `PUT_YOUR_LOGIN_EMAIL_HERE` in each file (the only edit; in `P3` it is in the declare block). The loan amount is decided: 370,000 (the 365,000 on the old inactive personal row is stale).

1. `P0_diagnose_before_and_after_READ_ONLY.sql`: read only. Expect the fund row 503,000, "Other Retirement Assets" 133,000 owned by the SMSF, and "SMSF recorded twice".
2. `P1_backup_exact_rows.sql`: copies the exact SMSF rows into six private `zz_bk_20261017_*` tables (the rows P9 restores). It refuses to overwrite an earlier copy.
3. `P2_cutover_preview_READ_ONLY.sql`: read only. Check: the leftover typed net 138,000 and the duplicate 133,000 row are "TO BE RETIRED"; the INACTIVE 365,000 personal loan and the INACTIVE Trust Assets row are "LEFT ALONE"; result 503,000 - 370,000 = 133,000.
4. **Say go**, then `P3_cutover_apply.sql`: one transaction, GUARDED. It stops without changing anything if the data is not exactly as diagnosed (assets 503,000, exactly one duplicate row worth 133,000, no fund liabilities yet) or if it was already applied. It writes the loan as a liability OF THE FUND. It does not create a personal liability, and the new rule that refuses an SMSF owner on a personal liability does not apply to it (that rule lives in the personal Liabilities, Income and Expenses pages and their API, the cutover writes straight into the fund's own table).
5. `P4_verify_READ_ONLY.sql`: expect itemised, typed net empty, assets 503,000, liabilities 370,000, net 133,000, Retirement row 133,000, no duplicate, no data-quality rows, two history rows.

The new audit trail (migration 0296 and 0297) also records the cutover's writes in `entity_change_log`. That is expected and harmless.

`P9_rollback.sql` undoes only the cutover (restores the backed-up rows, the history rows stay).

## After the SQL: the code

The branch push (a branch, for a build you can look at first) and the later main line are in the report. The main line is ONLY for after every V file and P4 above have passed. Then `POST_DEPLOY_CHECKS.md`.

If anything is wrong: `ROLLBACK_SEQUENCE.md`.
