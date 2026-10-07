-- Check after 0260 part e, the last part of 0260 (read only). Expect ONE row and every value true.
select
  (select count(*) = 3 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('resolve_risk_free_review_item', 'correct_risk_free_observation', 'set_risk_free_series_state')) as review_correct_switch_functions_ok,
  (select count(*) = 4 from public.ii_reference_job_control where job_key in ('nav2_risk_free_weekly_refresh', 'nav2_fund_analytics', 'nav2_trigger_planner', 'nav2_correction_worker')) as four_switch_rows_exist,
  (select count(*) = 4 from public.ii_reference_job_control where job_key in ('nav2_risk_free_weekly_refresh', 'nav2_fund_analytics', 'nav2_trigger_planner', 'nav2_correction_worker') and enabled = false) as all_four_switches_off,
  (select count(*) = 3 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('resolve_risk_free_review_item', 'correct_risk_free_observation', 'set_risk_free_series_state') and not has_function_privilege('anon', p.oid, 'execute')) as none_of_the_three_open_to_anon;
