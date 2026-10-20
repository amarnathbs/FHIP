-- 00 (read only). Which NAV2 pieces are on this database, and the state of the switches. Expect ONE row.
-- Run it FIRST, before anything else, and again at the very end.
-- Expected on DEV before this pack: tables 12, admin columns 2, functions 16 (17 once 0282 is applied), 0281 false, 0282 false, all four NAV2 switches listed.
select
  (select count(*) from information_schema.tables where table_schema = 'public' and table_name in ('ii_risk_free_series', 'ii_risk_free_batches', 'ii_risk_free_observations', 'ii_risk_free_review_items', 'ii_risk_free_corrections', 'ii_risk_free_series_state_log', 'ii_risk_free_refresh_attempts', 'nav2_fund_analytics_reports', 'nav2_report_nav_dependencies', 'nav2_result_cache', 'nav2_report_render_tokens', 'nav2_correction_events')) as nav2_tables_of_12,
  (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'admin_users' and column_name in ('can_upload_risk_free_data', 'can_switch_risk_free_series')) as admin_columns_of_2,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = any (array['is_risk_free_data_admin', 'is_risk_free_series_switch_admin', 'commit_risk_free_upload', 'record_risk_free_refresh_results', 'resolve_risk_free_review_item', 'correct_risk_free_observation', 'set_risk_free_series_state', 'ii_risk_free_append_only', 'ii_risk_free_obs_guard', 'nav2_reports_immutable', 'nav2_capture_reference_correction', 'nav2_capture_risk_free_correction', 'nav2_monitor_cell', 'nav2_monitoring_snapshot', 'nav2_refresh_attempt_summary', 'nav2_viewer_has_premium', 'nav2_ambiguity_case_summary'])) as nav2_functions_of_17,
  exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'nav2_fund_analytics_reports' and column_name = 'idempotency_key') as migration_0281_applied,
  to_regprocedure('public.nav2_ambiguity_case_summary()') is not null as migration_0282_applied,
  (select string_agg(j.job_key || '=' || j.enabled::text, ', ' order by j.job_key) from public.ii_reference_job_control j where left(j.job_key, 5) = 'nav2_' or j.job_key = 'pc6_selective_historical_hydration') as switches,
  (select count(*) from public.ii_risk_free_observations) as risk_free_observations,
  (select count(*) from public.nav2_fund_analytics_reports) as reports,
  (select count(*) from public.nav2_result_cache) as cache_entries,
  (select count(*) from public.nav2_correction_events) as correction_events,
  (select count(*) from public.nav2_correction_events where processed_at is null) as correction_events_unprocessed;
