-- P3 check after migration 0274 (the lighter create step). READ ONLY. Every ok must be true.

select section, check_name, actual, expected, coalesce(expected is null or actual = expected, false) as ok
from (
  select 1 as n, 'A' as section, 'the private core exists and is security definer' as check_name, (select prosecdef::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private' and p.proname = 'apply_resource_content_import_core') as actual, 'true' as expected
  union all select 2, 'A', 'the core no longer writes a version row per draft (0274 behaviour)', (select (position('resource_post_versions' in pg_get_functiondef(p.oid)) = 0)::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private' and p.proname = 'apply_resource_content_import_core'), 'true'
  union all select 3, 'A', 'the core reports the database time (db_ms)', (select (position('db_ms' in pg_get_functiondef(p.oid)) > 0)::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private' and p.proname = 'apply_resource_content_import_core'), 'true'
  union all select 4, 'B', 'no API role can run the core directly', (not has_function_privilege('anon', 'private.apply_resource_content_import_core(uuid, uuid)', 'execute') and not has_function_privilege('authenticated', 'private.apply_resource_content_import_core(uuid, uuid)', 'execute'))::text, 'true'
  union all select 5, 'B', 'the two public apply functions are unchanged in who can run them (twin: server only, normal: signed in only)', (has_function_privilege('service_role', 'public.apply_resource_content_import_as_actor(uuid, uuid)', 'execute') and not has_function_privilege('authenticated', 'public.apply_resource_content_import_as_actor(uuid, uuid)', 'execute') and has_function_privilege('authenticated', 'public.apply_resource_content_import(uuid)', 'execute') and not has_function_privilege('anon', 'public.apply_resource_content_import(uuid)', 'execute'))::text, 'true'
  union all select 6, 'C', 'the staging tables are still empty', (select ((select count(*) from public.resource_content_import_runs) + (select count(*) from public.resource_content_import_rows))::text), '0'
) c
order by n;
