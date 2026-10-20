-- P1x (read only). Step 1b. Lists every object of this release that already exists, one row each, so the answer can be compared with the partial state of 17-10-2026.
-- Expected on 17-10-2026 (parts a, b and c of 0260 only), and nothing else:
--   6 tables ii_risk_free_series, ii_risk_free_batches, ii_risk_free_observations, ii_risk_free_review_items, ii_risk_free_corrections, ii_risk_free_series_state_log
--   2 columns of admin_users: can_upload_risk_free_data, can_switch_risk_free_series
--   4 functions is_risk_free_data_admin, is_risk_free_series_switch_admin, ii_risk_free_append_only, ii_risk_free_obs_guard
select 'table' as kind, table_name::text as name from information_schema.tables where table_schema = 'public' and (left(table_name, 5) = 'nav2_' or left(table_name, 13) = 'ii_risk_free_')
union all
select 'column', column_name::text from information_schema.columns where table_schema = 'public' and table_name = 'admin_users' and column_name in ('can_upload_risk_free_data', 'can_switch_risk_free_series')
union all
select 'function', proname::text from pg_proc where pronamespace = 'public'::regnamespace and (left(proname, 5) = 'nav2_' or position('risk_free' in proname) > 0)
union all
select 'switch row', job_key::text from public.ii_reference_job_control where left(job_key, 5) = 'nav2_'
order by 1, 2;
