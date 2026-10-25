# WP-C rollback notes

Read these before running anything. The three migrations only add, so a rollback is only needed if something is wrong, and it is safest before real data is entered in the new tables.

- 0297: drop the triggers `trg_business_entities_mode_rule`, `trg_business_entity_assets_mode_rule`, `trg_business_entity_liabilities_mode_rule`, `trg_business_entity_assets_audit`, `trg_business_entity_liabilities_audit`, `trg_smsf_holdings_audit`, `trg_smsf_liabilities_audit`, then the functions `business_entity_switch_mode`, `business_entity_derived_net`, `business_entity_mode_rule_violations`, `business_entities_mode_rule`, `business_entity_lines_mode_rule`, `entity_line_audit`, then the added columns. A retired line (is_active false) must be made active again first, otherwise it stays hidden.
- 0296: drop the triggers on `entity_income_items` and `entity_expense_items`, the functions `smsf_entity_move_personal_cash_flow`, `entity_income_type_for`, `entity_item_scope_rule`, `entity_income_rent_rule`, `entity_item_audit`, then the tables `entity_income_items`, `entity_expense_items`, `entity_change_log`. Export them first if they hold rows. A personal row that was moved to the fund has been retired (is_active false): set it active again to restore it.
- 0295: drop the trigger `trg_smsf_liabilities_holding_link`, the function `smsf_liability_holding_link_rule` and the six added columns on `smsf_liabilities`.

The copies made by `01_backup.sql` are named `backup_wpc_20261021_*`. Drop them once the change is accepted.
