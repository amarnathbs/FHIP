# WP-H3 PO pack: duplicate rows left by a replacement reprocess

Order (DEV first, then production). Production has no managed backups, so nothing is applied without pack 03.

1. Deploy the code release first. It makes a re-read of the same statement match its earlier rows (no new duplicates) and makes the unit reconciliation, cost value and benchmark window ignore retired rows. Without it, retiring a row does not repair the unit check.
2. Pack 01 (read only): every group of repeated lines, per account, with a side-by-side listing. `consistent_units` says which row's units agree with its own price.
3. Pack 02 (read only): for a row pack 01 did not report (for example the 2009 reversal of 1,000.00), shows whether an older row exists that it replaces.
4. Decide which row of each pair is the correct one from pack 01 and pack 04. Default is to retire the NEWER row; set `retire_which` to `older` in packs 03, 04 and 05 if the older rows are the wrongly read ones.
5. Pack 03 (backup): copies the exact rows and their links into two dated tables. Fails if they already exist.
6. Pack 04 (preview, read only): the pairs, and units and amount per position before and after.
7. Pack 05 (apply): one transaction with guards; sets `status = 'reversed'` on the chosen rows and writes one audit row each. Nothing is deleted.
8. In the app press Re-evaluate all positions, then run pack 06 (verify, read only).
9. Pack 07 (rollback): restores the exact statuses from the backup. Safe to run twice.

Edit the config values (email, time window, `retire_which`, `max_rows`) identically in packs 03, 04 and 05. The rows are chosen by rule, never by hand-typed ids, and `max_rows` (20) stops a mistaken window from touching more.
