-- V0268 check after migration 0268 (read only, safe to run any number of times)
-- Paste the whole file in the SQL editor and press Run. The column ok must say true on every row.

select check_name, actual, expected, coalesce(expected is null or actual = expected, false) as ok
from (
  select 1 as n, 'environment marker rows (at most one is allowed)' as check_name, (select count(*) from public.platform_deployment_environment)::text as actual, null as expected
  union all select 2, 'the marker table has at most one row', ((select count(*) from public.platform_deployment_environment) <= 1)::text, 'true'
  union all select 3, 'every marker value is an allowed value', (not exists (select 1 from public.platform_deployment_environment where environment not in ('production', 'development', 'staging')))::text, 'true'
  union all select 4, 'row level security is on for the marker table', (select relrowsecurity from pg_class where oid = 'public.platform_deployment_environment'::regclass)::text, 'true'
  union all select 5, 'signed-in users can read the marker table', has_table_privilege('authenticated', 'public.platform_deployment_environment', 'select')::text, 'false'
  union all select 6, 'visitors who are not signed in can write the marker table', has_table_privilege('anon', 'public.platform_deployment_environment', 'insert')::text, 'false'
  union all select 7, 'the one row only rule exists', (to_regclass('public.uq_platform_deployment_environment_single') is not null)::text, 'true'
  union all select 8, 'the allowed values rule exists', (select count(*) = 1 from pg_constraint where conname = 'platform_deployment_environment_value_check')::text, 'true'
  union all select 9, 'signed-in users can run the job verification function', has_function_privilege('authenticated', 'public.premium_cron_verify(text)', 'execute')::text, 'false'
) c
order by n;
