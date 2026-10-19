-- Check after 0261 (read only). Expect ONE row and every value true.
select
  (select count(*) = 4 from information_schema.tables where table_schema = 'public' and table_name in ('nav2_fund_analytics_reports', 'nav2_report_nav_dependencies', 'nav2_result_cache', 'nav2_report_render_tokens')) as four_tables_ok,
  (select count(*) = 1 from pg_trigger where tgrelid = 'public.nav2_fund_analytics_reports'::regclass and not tgisinternal and tgname = 'trg_nav2_reports_immutable') as reports_cannot_be_edited,
  position('nav2_report_nav_dependencies' in pg_get_functiondef('public.pc6_nav_row_is_candidate(uuid, date, date)'::regprocedure)) > 0 as retention_function_knows_the_report_pin,
  (not has_function_privilege('authenticated', 'public.pc6_nav_row_is_candidate(uuid, date, date)', 'execute') and not has_function_privilege('anon', 'public.pc6_nav_row_is_candidate(uuid, date, date)', 'execute') and has_function_privilege('service_role', 'public.pc6_nav_row_is_candidate(uuid, date, date)', 'execute')) as retention_function_still_service_only,
  (select count(*) = 0 from public.nav2_fund_analytics_reports) as no_reports_yet,
  (select count(*) = 4 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname in ('nav2_fund_analytics_reports', 'nav2_report_nav_dependencies', 'nav2_result_cache', 'nav2_report_render_tokens') and c.relrowsecurity) as row_level_security_on_all_four;
