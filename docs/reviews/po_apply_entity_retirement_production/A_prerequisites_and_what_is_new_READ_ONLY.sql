-- A. PREREQUISITES AND WHAT IS NEW (READ ONLY). Run in the PRODUCTION Supabase SQL editor first. It is one select, it cannot change anything.
-- Read the result top to bottom. Columns: step, what is checked, what you should see, what it is.
--   group 1: the tables and functions the new migrations build on. Every one must be true.
--   group 2: migration 0294 (already applied on production before this release). Must be true.
--   group 3: the objects THIS release adds. Every one must be false BEFORE the release (it is NEW), true AFTER the SQL.
-- If group 1 or 2 shows a false, STOP and send the output, do not run any migration.

select * from (
  select 10 as ord, 'prerequisite table smsf_funds' as what, (to_regclass('public.smsf_funds') is not null) as value, 'must be true' as expected
  union all select 11, 'prerequisite table smsf_holdings', (to_regclass('public.smsf_holdings') is not null), 'must be true'
  union all select 12, 'prerequisite table smsf_fund_members', (to_regclass('public.smsf_fund_members') is not null), 'must be true'
  union all select 13, 'prerequisite table business_entities', (to_regclass('public.business_entities') is not null), 'must be true'
  union all select 14, 'prerequisite table business_entity_assets', (to_regclass('public.business_entity_assets') is not null), 'must be true'
  union all select 15, 'prerequisite table business_entity_liabilities', (to_regclass('public.business_entity_liabilities') is not null), 'must be true'
  union all select 16, 'prerequisite table retirement_accounts', (to_regclass('public.retirement_accounts') is not null), 'must be true'
  union all select 17, 'prerequisite table retirement_members', (to_regclass('public.retirement_members') is not null), 'must be true'
  union all select 18, 'prerequisite table fdh_payroll_events', (to_regclass('public.fdh_payroll_events') is not null), 'must be true'
  union all select 19, 'prerequisite table income_sources', (to_regclass('public.income_sources') is not null), 'must be true'
  union all select 20, 'prerequisite table expense_items', (to_regclass('public.expense_items') is not null), 'must be true'
  union all select 21, 'prerequisite table liabilities', (to_regclass('public.liabilities') is not null), 'must be true'
  union all select 22, 'prerequisite table property_liability_links', (to_regclass('public.property_liability_links') is not null), 'must be true'
  union all select 23, 'prerequisite table user_profiles', (to_regclass('public.user_profiles') is not null), 'must be true'
  union all select 24, 'prerequisite table user_financial_section_status', (to_regclass('public.user_financial_section_status') is not null), 'must be true'
  union all select 25, 'prerequisite table forecast_global_assumptions', (to_regclass('public.forecast_global_assumptions') is not null), 'must be true'
  union all select 26, 'prerequisite table countries', (to_regclass('public.countries') is not null), 'must be true'
  union all select 27, 'prerequisite table currencies', (to_regclass('public.currencies') is not null), 'must be true'
  union all select 28, 'prerequisite function smsf_compute_detailed_net_value (migration 0084)', (to_regprocedure('smsf_compute_detailed_net_value(uuid)') is not null), 'must be true'
  union all select 29, 'prerequisite function smsf_holdings_total_aud (migration 0084)', (to_regprocedure('smsf_holdings_total_aud(uuid)') is not null), 'must be true'
  union all select 30, 'prerequisite function smsf_linked_loans_total_aud (migration 0084)', (to_regprocedure('smsf_linked_loans_total_aud(uuid)') is not null), 'must be true'
  union all select 31, 'prerequisite function smsf_recompute_fund', (to_regprocedure('smsf_recompute_fund(uuid)') is not null), 'must be true'
  union all select 32, 'prerequisite column user_profiles.not_applicable_retirement', exists (select 1 from information_schema.columns where table_name = 'user_profiles' and column_name = 'not_applicable_retirement'), 'must be true'
  union all select 33, 'prerequisite column retirement_accounts.master_item_key', exists (select 1 from information_schema.columns where table_name = 'retirement_accounts' and column_name = 'master_item_key'), 'must be true'
  union all select 40, 'ALREADY APPLIED: migration 0294 function risk_free_today', (to_regprocedure('risk_free_today()') is not null), 'must be true (0294 is already on production)'
  union all select 41, 'ALREADY APPLIED: migration 0294 function confirm_risk_free_verified_through', (to_regprocedure('confirm_risk_free_verified_through(text,date,text)') is not null), 'must be true (0294 is already on production)'
  union all select 50, 'NEW 0289: table smsf_liabilities', (to_regclass('public.smsf_liabilities') is not null), 'false before the release'
  union all select 51, 'NEW 0290: table entity_figure_mode_log', (to_regclass('public.entity_figure_mode_log') is not null), 'false before the release'
  union all select 52, 'NEW 0290: function smsf_entity_switch_mode', exists (select 1 from pg_proc where proname = 'smsf_entity_switch_mode'), 'false before the release'
  union all select 53, 'NEW 0295: column smsf_liabilities.smsf_holding_id', exists (select 1 from information_schema.columns where table_name = 'smsf_liabilities' and column_name = 'smsf_holding_id'), 'false before the release'
  union all select 54, 'NEW 0296: table entity_income_items', (to_regclass('public.entity_income_items') is not null), 'false before the release'
  union all select 55, 'NEW 0296: table entity_change_log', (to_regclass('public.entity_change_log') is not null), 'false before the release'
  union all select 56, 'NEW 0297: column business_entity_assets.is_active', exists (select 1 from information_schema.columns where table_name = 'business_entity_assets' and column_name = 'is_active'), 'false before the release'
  union all select 57, 'NEW 0297: function business_entity_switch_mode', exists (select 1 from pg_proc where proname = 'business_entity_switch_mode'), 'false before the release'
  union all select 58, 'NEW 0298: function fhip_retirement_declaration_blockers', exists (select 1 from pg_proc where proname = 'fhip_retirement_declaration_blockers'), 'false before the release'
  union all select 59, 'NEW 0299: function business_entity_undo_last_switch', exists (select 1 from pg_proc where proname = 'business_entity_undo_last_switch'), 'false before the release'
  union all select 60, 'NEW 0304: table retirement_contributions', (to_regclass('public.retirement_contributions') is not null), 'false before the release'
) c
order by ord;
