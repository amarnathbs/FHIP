-- B2 (read only). Check of B1. Expect ONE row: the three counts equal the live tables, the function text was captured, nobody but the service role can read a backup.
-- Paste the row back. Run it again after B1 if the counts differ (a difference only means rows were added since the copy).
select
  (select count(*) from public.nav2_backup_20261016_admin_users) as admin_rows_saved,
  (select count(*) from public.admin_users) as admin_rows_now,
  (select count(*) from public.nav2_backup_20261016_job_control) as switch_rows_saved,
  (select count(*) from public.ii_reference_job_control) as switch_rows_now,
  (select count(*) = 1 and bool_and(definition is not null) from public.nav2_backup_20261016_function_text) as function_text_saved,
  (select row_count from public.nav2_backup_20261016_corrections_size limit 1) as corrections_rows_saved,
  (select count(*) = 0 from information_schema.role_table_grants where table_schema = 'public' and left(table_name, 20) = 'nav2_backup_20261016' and grantee in ('anon', 'authenticated')) as backups_locked_to_service_role;
