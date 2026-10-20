# Entity-level SMSF assets and liabilities: steps for the PO (DEV first, then production)

Everything here is SQL you paste into the Supabase SQL editor, one file at a time. Nothing is run for you. Production has NO managed backups, so the production pack makes its own copies first. Each file passes the repository's editor-safety lint (no dollar-quote pairs, no percent signs, nothing the editor misreads).

The loan amount is decided: **370,000** (the 365,000 on the old inactive personal row is stale). It is the default in `P2` and `P3`.

## A. DEV (rehearse everything first)

1. Apply the migration parts in this order, one file per paste, from `sql_parts/`:
   `0289_part1_liabilities_table`, `0289_part2_functions_and_triggers`, `0289_part3_create_fund`, `0290_part1_history_and_the_rule`, `0290_part2_switch_mode`, `0290_part3_undo_and_retire_typed_net`, `0290_part4_move_loan_and_adopt_rows`, `0290_part5_old_switches_and_grants`.
   Each part is safe to run again. If one fails, stop and send me the message.
2. Push the branch so DEV builds it (the two lines are in the report).
3. On DEV, use a test account that has no SMSF yet and run `dev_pack/D1_build_po_shape_for_rehearsal.sql` (it builds the PO shape: fund with assets 475,000 + 3,000 + 25,000, a typed net 138,000 left over, a duplicate Retirement row owned by the SMSF worth 133,000, personal figures netting to 874,441). Then run the production pack below against that account exactly as written (use the DEV login e-mail). Check the Dashboard: personal 874,441 and family 1,007,441.
4. In the SMSF section on DEV: add an asset and a liability, watch the net position change, switch to "Net value only" and back (preview first, then Confirm), use "Undo the last change", open "Mode history".

## B. Production (only after A is good)

In this order. Replace `PUT_YOUR_LOGIN_EMAIL_HERE` in each file (the only edit; in `P3` it is in the declare block).

1. `production_pack/P0_diagnose_before_and_after_READ_ONLY.sql`: read-only. Keep the output. Expect the fund row 503,000, "Other Retirement Assets" 133,000 owned by the SMSF, and "SMSF recorded twice".
2. Apply the migration parts from `sql_parts/` (same order as DEV).
3. `P1_backup_exact_rows.sql`: copies the exact SMSF rows into six private tables. It refuses to overwrite an earlier copy.
4. `P2_cutover_preview_READ_ONLY.sql`: read-only preview. Check: leftover typed net 138,000 and the duplicate 133,000 row are shown as "TO BE RETIRED"; the inactive 365,000 personal loan and the inactive Trust Assets row are "LEFT ALONE"; result net 503,000 - 370,000 = 133,000.
5. **Say go**, then `P3_cutover_apply.sql`: one transaction. It stops without changing anything if the data is not exactly as diagnosed (assets 503,000, one duplicate row of 133,000, no fund liabilities yet).
6. `P4_verify_READ_ONLY.sql`: expect itemised, typed net empty, assets 503,000, liabilities 370,000, net 133,000, Retirement row 133,000, no duplicate, no data-quality rows, two history rows.
7. Push the code (the lines are in the report) and let it deploy. Dashboard: personal 874,441, family 1,007,441.

Do the SQL BEFORE the deploy. If the new screens were live first, the family figure would read 1,377,441 until P3 ran (the fund would count at its 503,000 assets with no loan).

Rollback of the cutover only: `P9_rollback.sql` (restores the backed-up rows; the history rows stay).

## What changes for you on screen

- Retirement > SMSF: "How do you want to record this fund?" Itemised (recommended) or Net value only. Itemised shows Assets, Liabilities and a net position worked out for you (nothing to type). Net value only shows one value and no lines. Changing it shows the effect first, keeps what you had, and can be undone.
- A debt of the fund is added under the fund's Liabilities. A personal loan that was linked to the fund the earlier way has a "Move into the fund" button.
- Retirement and Liabilities pages show a note if the SMSF is recorded in more than one place.
