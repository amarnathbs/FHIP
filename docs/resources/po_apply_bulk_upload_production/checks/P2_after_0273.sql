-- P2 check after migration 0273. READ ONLY. Every ok must be true.
-- 0273 adds the server only twin of the apply function and a private shared core. The normal signed in function keeps working.

select section, check_name, actual, expected, coalesce(expected is null or actual = expected, false) as ok
from (
  select 1 as n, 'A' as section, 'the three apply functions exist and are security definer' as check_name, (select count(*)::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace where p.prosecdef and ((n.nspname = 'public' and p.proname in ('apply_resource_content_import', 'apply_resource_content_import_as_actor')) or (n.nspname = 'private' and p.proname = 'apply_resource_content_import_core'))) as actual, '3' as expected
  union all select 2, 'B', 'nobody anonymous can run either public apply function', (not has_function_privilege('anon', 'public.apply_resource_content_import_as_actor(uuid, uuid)', 'execute') and not has_function_privilege('anon', 'public.apply_resource_content_import(uuid)', 'execute'))::text, 'true'
  union all select 3, 'B', 'a signed in person cannot run the server only twin', (not has_function_privilege('authenticated', 'public.apply_resource_content_import_as_actor(uuid, uuid)', 'execute'))::text, 'true'
  union all select 4, 'B', 'a signed in person cannot run the private core directly', (not has_function_privilege('authenticated', 'private.apply_resource_content_import_core(uuid, uuid)', 'execute'))::text, 'true'
  union all select 5, 'B', 'the server role can run the twin', has_function_privilege('service_role', 'public.apply_resource_content_import_as_actor(uuid, uuid)', 'execute')::text, 'true'
  union all select 6, 'B', 'a signed in person can still run the normal apply function', has_function_privilege('authenticated', 'public.apply_resource_content_import(uuid)', 'execute')::text, 'true'
  union all select 7, 'C', 'resource_posts column count (must equal P0)', (select count(*)::text from information_schema.columns where table_schema = 'public' and table_name = 'resource_posts'), null
  union all select 8, 'C', 'resource_posts constraint count (must equal P0)', (select count(*)::text from pg_constraint where conrelid = 'public.resource_posts'::regclass), null
) c
order by n;
