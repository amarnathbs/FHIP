-- Check after 0262 (read only). Expect ONE row and every value true.
select
  to_regclass('public.nav2_correction_events') is not null as events_table_ok,
  (select count(*) = 1 from pg_trigger where tgrelid = 'public.ii_reference_corrections'::regclass and not tgisinternal and tgname = 'trg_nav2_capture_reference_correction') as price_correction_hook_ok,
  (select count(*) = 1 from pg_trigger where tgrelid = 'public.ii_risk_free_corrections'::regclass and not tgisinternal and tgname = 'trg_nav2_capture_risk_free_correction') as risk_free_correction_hook_ok,
  (select count(*) = 2 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('nav2_monitoring_snapshot', 'nav2_monitor_cell')) as monitoring_functions_ok,
  not has_function_privilege('anon', 'public.nav2_monitoring_snapshot()', 'execute') as monitoring_not_open_to_anon,
  (select count(*) = 0 from public.nav2_correction_events) as no_events_yet;
