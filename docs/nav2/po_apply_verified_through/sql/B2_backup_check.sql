-- B2 (read only). Check of B1. Expect ONE row: both saved counts equal the live counts and nobody but the service role can read a copy.
select
  (select count(*) from public.nav2_backup_20261019_rf_series) as series_saved,
  (select count(*) from public.ii_risk_free_series) as series_now,
  (select count(*) from public.nav2_backup_20261019_rf_state_log) as state_log_saved,
  (select count(*) from public.ii_risk_free_series_state_log) as state_log_now,
  (select count(*) = 0 from information_schema.role_table_grants where table_schema = 'public' and left(table_name, 23) = 'nav2_backup_20261019_rf' and grantee in ('anon', 'authenticated')) as copies_locked_to_service_role;
