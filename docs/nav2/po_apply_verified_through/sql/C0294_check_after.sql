-- C0294 (read only). Check after migration 0294. Expect ONE row and every value true.
select
  (to_regprocedure('public.risk_free_today()') is not null) as india_day_function_ok,
  (to_regprocedure('public.confirm_risk_free_verified_through(text, date, text)') is not null) as confirm_function_ok,
  has_function_privilege('authenticated', 'public.confirm_risk_free_verified_through(text, date, text)', 'execute') as signed_in_can_call_confirm,
  not has_function_privilege('anon', 'public.confirm_risk_free_verified_through(text, date, text)', 'execute') as anon_cannot_call_confirm,
  (select prosecdef from pg_proc where oid = 'public.confirm_risk_free_verified_through(text, date, text)'::regprocedure) as confirm_runs_with_definer_rights,
  has_function_privilege('authenticated', 'public.commit_risk_free_upload(text, text, text, jsonb, boolean, text, text, date)', 'execute') as signed_in_can_call_upload,
  not has_function_privilege('anon', 'public.commit_risk_free_upload(text, text, text, jsonb, boolean, text, text, date)', 'execute') as anon_cannot_call_upload,
  (select position('risk_free_today' in pg_get_functiondef(p.oid)) > 0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'commit_risk_free_upload') as upload_function_is_new_version,
  (select count(*) = 2 from public.ii_risk_free_series) as both_series_still_there;
