-- Check after 0260 part c (read only). Expect ONE row and every value true.
-- The six new risk free tables are the series, batches, observations, review items, corrections and series state log.
select
  (select count(*) = 6 from information_schema.tables where table_schema = 'public' and table_name in ('ii_risk_free_series', 'ii_risk_free_batches', 'ii_risk_free_observations', 'ii_risk_free_review_items', 'ii_risk_free_corrections', 'ii_risk_free_series_state_log')) as six_new_tables_ok,
  (select count(*) >= 1 from pg_trigger where tgrelid = 'public.ii_risk_free_corrections'::regclass and not tgisinternal) as corrections_ledger_guard_ok,
  (select count(*) >= 1 from pg_trigger where tgrelid = 'public.ii_risk_free_series_state_log'::regclass and not tgisinternal) as state_log_guard_ok,
  (select count(*) = 6 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname in ('ii_risk_free_series', 'ii_risk_free_batches', 'ii_risk_free_observations', 'ii_risk_free_review_items', 'ii_risk_free_corrections', 'ii_risk_free_series_state_log') and c.relrowsecurity) as row_level_security_on_all_six;
