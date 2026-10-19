-- Check after 0260 part a (read only). Expect ONE row and every value true.
select
  (select count(*) = 2 from information_schema.columns where table_schema = 'public' and table_name = 'admin_users' and column_name in ('can_upload_risk_free_data', 'can_switch_risk_free_series')) as capability_columns_ok,
  (select count(*) = 0 from public.admin_users where can_upload_risk_free_data or can_switch_risk_free_series) as nobody_holds_them_yet,
  (select count(*) = 2 from public.ii_risk_free_series) as two_series_ok,
  (select count(*) = 2 from public.ii_risk_free_series where enabled and terms_review_status = 'po_accepted_2026-10-03') as series_seeded_enabled_with_accepted_terms,
  to_regclass('public.ii_risk_free_batches') is not null as batches_table_ok,
  (select count(*) = 2 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('is_risk_free_data_admin', 'is_risk_free_series_switch_admin')) as predicate_functions_ok,
  not has_function_privilege('anon', 'public.is_risk_free_data_admin()', 'execute') as predicate_not_open_to_anon;
