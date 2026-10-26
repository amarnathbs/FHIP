# Rollback sequence (read before you start, run only if something is wrong)

The principle: undo in the REVERSE order of the release, and prefer the smallest undo. Most problems are solved by undoing the code alone, the SQL is additive and the old code keeps working against it.

## Level 1: the code is wrong, the data is fine (most likely)
Redeploy the previous main commit (the commit main pointed to before this release; the report names it). Nothing in the database needs to change: the new tables and functions are simply not used by the old code, and the old screens read the same data. Exceptions while the old code is live against the new database:
- the old SMSF mode-switch buttons (the old two-step functions) are refused by 0290 with a pointer to the new function, so the old SMSF switch screen shows an error. The data is not touched. Use Level 1 only briefly, or move to Level 2.
- the old family net worth reads the fund row and the SMSF-owned register rows. After the cutover the duplicate 133,000 row is archived, so the old code counts the fund once at its net, the family figure stays 1,007,441.

## Level 2: the cutover result is wrong
Run `cutover/P9_rollback.sql` (your e-mail in it). It puts the SMSF rows back exactly as `P1` copied them (typed net 138,000, duplicate row active, fund liability retired). The history rows stay (append-only). The dashboard shows the "SMSF recorded twice" note again until you decide. Leave the migrations in place.

## Level 3: a migration group must be undone (rare, only before real entity data is entered in the new tables, otherwise export them first)
Undo in this order. Each statement list is in the footer of the migration file as well.
1. 0304: drop trigger `trg_retirement_contributions_validate`, function `retirement_contributions_validate_destination`, table `retirement_contributions` (export it first if it holds rows).
2. 0299: drop function `business_entity_undo_last_switch(uuid, boolean)`.
3. 0298: drop triggers `trg_guard_retirement_declaration_profile` (on user_profiles) and `trg_guard_retirement_declaration_section` (on user_financial_section_status), then functions `fhip_guard_retirement_declaration_profile`, `fhip_guard_retirement_declaration_section`, `fhip_retirement_declaration_blockers`.
4. 0297: see `docs/reviews/po_apply_wp_c/90_rollback_notes.md` (triggers, functions, the added columns). A line retired with is_active false must be made active again first.
5. 0296: same notes (the move function, the audit triggers, the three tables). A personal row that was moved to the fund was retired (is_active false): set it active again.
6. 0295: same notes (one trigger, one function, six columns).
7. 0290 and 0289: NOT recommended. They replace `smsf_compute_detailed_net_value`, `smsf_create_fund`, `smsf_recompute_fund` and the two old switch functions. To go back, re-create those functions from migrations 0084, 0089, 0090 and 0137, drop the new triggers and the table `smsf_liabilities` and `entity_figure_mode_log`. Do this only with a developer present, and only after P9, because the fund liability would be lost.

## Restoring data from the copies
- `bk_er_20261026_*` (step B) hold the whole touched tables as they were before the migrations. Nothing in the migrations changes a row, so you should never need them, they exist because production has no managed backups.
- `zz_bk_20261017_*` (cutover P1) hold the exact SMSF rows P9 restores.
Drop both sets once the release is accepted.
