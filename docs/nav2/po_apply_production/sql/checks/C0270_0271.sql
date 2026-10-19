-- Check after 0270 and 0271 (read only). Expect ONE row and every value true.
-- 0271 is the final form of the monitoring function: it reads the price table row estimate, never an exact count of the whole price table.
select
  position('reltuples' in pg_get_functiondef('public.nav2_monitoring_snapshot()'::regprocedure)) > 0 as monitoring_uses_the_row_estimate,
  not has_function_privilege('anon', 'public.nav2_monitoring_snapshot()', 'execute') as monitoring_not_open_to_anon,
  has_function_privilege('authenticated', 'public.nav2_monitoring_snapshot()', 'execute') as monitoring_callable_by_signed_in;
