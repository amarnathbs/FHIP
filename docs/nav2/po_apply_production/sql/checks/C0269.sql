-- Check after 0269 (read only). Expect ONE row and every value true.
select
  (select count(*) = 1 from pg_policies where schemaname = 'public' and tablename = 'nav2_fund_analytics_reports' and policyname = 'own_read_nav2_fund_analytics_reports' and position('nav2_viewer_has_premium' in qual) > 0) as reports_policy_requires_premium,
  to_regprocedure('public.nav2_viewer_has_premium()') is not null as premium_function_ok,
  has_function_privilege('authenticated', 'public.nav2_viewer_has_premium()', 'execute') as signed_in_can_call,
  not has_function_privilege('anon', 'public.nav2_viewer_has_premium()', 'execute') as anon_cannot_call;
