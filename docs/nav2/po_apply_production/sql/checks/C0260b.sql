-- Check after 0260 part b (read only). Expect ONE row and every value true.
select
  to_regclass('public.ii_risk_free_observations') is not null as observations_table_ok,
  (select count(*) >= 2 from pg_trigger where tgrelid = 'public.ii_risk_free_observations'::regclass and not tgisinternal) as observation_guards_ok,
  (select count(*) >= 2 from pg_trigger where tgrelid = 'public.ii_risk_free_batches'::regclass and not tgisinternal) as batch_guards_ok,
  (select count(*) = 2 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('ii_risk_free_append_only', 'ii_risk_free_obs_guard')) as guard_functions_ok,
  (select count(*) = 0 from public.ii_risk_free_observations) as no_rows_yet;
