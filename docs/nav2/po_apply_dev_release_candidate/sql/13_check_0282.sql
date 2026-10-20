-- Check after 0282 (read only). Expect ONE row and every value true.
select
  to_regprocedure('public.nav2_ambiguity_case_summary()') is not null as summary_function_ok,
  has_function_privilege('authenticated', 'public.nav2_ambiguity_case_summary()', 'execute') as signed_in_can_call,
  not has_function_privilege('anon', 'public.nav2_ambiguity_case_summary()', 'execute') as anon_cannot_call,
  (select prosecdef from pg_proc where oid = 'public.nav2_ambiguity_case_summary()'::regprocedure) as runs_with_definer_rights;
