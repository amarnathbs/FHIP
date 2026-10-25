-- P4 (read only). Which version of the upload function does this database hold? Run on production before 0294 and again after it.
-- has_same_file_confirmation: the function holds the branch that applies a later confirmed-through date when the same file is sent again (it ships in migration 0260 part d). Expect true on production. If it is false, that is the explanation of 19-10-2026 and 0294 repairs it.
-- new_version: the function is the 0294 version. Expect false before 0294 and true after it.
-- confirm_function: the new confirmation function exists. Expect false before 0294 and true after it.
select
  (select position('re-submitted file' in pg_get_functiondef(p.oid)) > 0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'commit_risk_free_upload') as has_same_file_confirmation,
  (select position('risk_free_today' in pg_get_functiondef(p.oid)) > 0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'commit_risk_free_upload') as new_version,
  (to_regprocedure('public.confirm_risk_free_verified_through(text, date, text)') is not null) as confirm_function;
