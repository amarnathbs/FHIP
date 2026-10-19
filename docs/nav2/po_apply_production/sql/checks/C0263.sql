-- Check after 0263 (read only). Expect ONE row and every value true.
select
  to_regclass('public.ii_risk_free_refresh_attempts') is not null as attempts_table_ok,
  (select count(*) = 0 from public.ii_risk_free_refresh_attempts) as no_attempts_yet,
  has_function_privilege('authenticated', 'public.nav2_refresh_attempt_summary()', 'execute') as summary_callable_by_signed_in,
  not has_function_privilege('anon', 'public.nav2_refresh_attempt_summary()', 'execute') as summary_not_open_to_anon;
