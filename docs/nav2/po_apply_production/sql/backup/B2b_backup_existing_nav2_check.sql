-- B2b (read only). Check of B1b. Expect ONE row: every saved count equals the live count (a difference only means rows were added since the copy) and nobody but the service role can read a copy.
select
  (select count(*) from public.nav2_backup_20261016_rf_series) as series_saved,
  (select count(*) from public.ii_risk_free_series) as series_now,
  (select count(*) from public.nav2_backup_20261016_rf_batches) as batches_saved,
  (select count(*) from public.ii_risk_free_batches) as batches_now,
  (select count(*) from public.nav2_backup_20261016_rf_observations) as observations_saved,
  (select count(*) from public.ii_risk_free_observations) as observations_now,
  (select count(*) from public.nav2_backup_20261016_rf_review_items) as review_items_saved,
  (select count(*) from public.ii_risk_free_review_items) as review_items_now,
  (select count(*) from public.nav2_backup_20261016_rf_corrections) as corrections_saved,
  (select count(*) from public.ii_risk_free_corrections) as corrections_now,
  (select count(*) from public.nav2_backup_20261016_rf_state_log) as state_log_saved,
  (select count(*) from public.ii_risk_free_series_state_log) as state_log_now,
  (select count(*) = 0 from information_schema.role_table_grants where table_schema = 'public' and left(table_name, 23) = 'nav2_backup_20261016_rf' and grantee in ('anon', 'authenticated')) as copies_locked_to_service_role;
