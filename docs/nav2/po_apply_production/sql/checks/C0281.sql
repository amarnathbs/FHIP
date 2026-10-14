-- Check after 0281 (read only). Expect ONE row and every value true.
select
  exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'nav2_fund_analytics_reports' and column_name = 'idempotency_key' and is_nullable = 'YES') as key_column_ok,
  exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'nav2_fund_analytics_reports' and column_name = 'request_fingerprint' and is_nullable = 'YES') as fingerprint_column_ok,
  (select count(*) = 1 from pg_indexes where schemaname = 'public' and indexname = 'uidx_nav2_reports_user_idempotency') as unique_index_ok,
  (select count(*) = 1 from pg_constraint where conname = 'nav2_reports_idempotency_shape' and conrelid = 'public.nav2_fund_analytics_reports'::regclass) as shape_constraint_ok,
  (select count(*) = 1 from pg_trigger where tgname = 'trg_nav2_reports_immutable' and not tgisinternal) as immutability_trigger_still_there;
