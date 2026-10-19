-- Check after 0260 part d (read only). Expect ONE row and every value true.
select
  (select count(*) = 2 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('commit_risk_free_upload', 'record_risk_free_refresh_results')) as upload_and_refresh_functions_ok,
  has_function_privilege('authenticated', 'public.commit_risk_free_upload(text, text, text, jsonb, boolean, text, text, date)', 'execute') as signed_in_can_call_upload,
  not has_function_privilege('anon', 'public.commit_risk_free_upload(text, text, text, jsonb, boolean, text, text, date)', 'execute') as anon_cannot_call_upload,
  not has_function_privilege('authenticated', 'public.record_risk_free_refresh_results(text, jsonb, jsonb, date)', 'execute') as session_cannot_write_refresh,
  has_function_privilege('service_role', 'public.record_risk_free_refresh_results(text, jsonb, jsonb, date)', 'execute') as service_can_write_refresh;
