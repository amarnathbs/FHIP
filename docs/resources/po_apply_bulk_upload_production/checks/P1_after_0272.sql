-- P1 check after migration 0272. READ ONLY. Every ok must be true.
-- 0272 adds two staging tables, one helper function, one lookup function, one purge function and the full apply function.
-- It must not change any existing table: the three rows marked (compare with P0) must equal the numbers P0 showed in section D.

select section, check_name, actual, expected, coalesce(expected is null or actual = expected, false) as ok
from (
  select 1 as n, 'A' as section, 'both staging tables exist' as check_name, (select count(*)::text from information_schema.tables where table_schema = 'public' and table_name in ('resource_content_import_runs', 'resource_content_import_rows')) as actual, '2' as expected
  union all select 2, 'A', 'row level security is on for both staging tables', (select count(*)::text from pg_class where oid in ('public.resource_content_import_runs'::regclass, 'public.resource_content_import_rows'::regclass) and relrowsecurity), '2'
  union all select 3, 'A', 'the four functions exist and are security definer', (select count(*)::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace where p.prosecdef and ((n.nspname = 'public' and p.proname in ('apply_resource_content_import', 'resource_content_import_lookup', 'purge_expired_resource_content_import_staging')) or (n.nspname = 'private' and p.proname = 'can_bulk_import_resource_content'))), '4'
  union all select 4, 'A', 'the same file can never be applied twice (unique index uq_rcir_applied_file)', (select count(*)::text from pg_indexes where schemaname = 'public' and tablename = 'resource_content_import_runs' and indexname = 'uq_rcir_applied_file'), '1'
  union all select 5, 'B', 'nobody anonymous can run apply, lookup or purge', (select (not has_function_privilege('anon', 'public.apply_resource_content_import(uuid)', 'execute') and not has_function_privilege('anon', 'public.resource_content_import_lookup(text[], text[], text[])', 'execute') and not has_function_privilege('anon', 'public.purge_expired_resource_content_import_staging()', 'execute'))::text), 'true'
  union all select 6, 'B', 'a signed in person cannot run the purge', (not has_function_privilege('authenticated', 'public.purge_expired_resource_content_import_staging()', 'execute'))::text, 'true'
  union all select 7, 'B', 'a signed in person can run apply and lookup (the functions check the capability themselves)', (has_function_privilege('authenticated', 'public.apply_resource_content_import(uuid)', 'execute') and has_function_privilege('authenticated', 'public.resource_content_import_lookup(text[], text[], text[])', 'execute'))::text, 'true'
  union all select 8, 'B', 'no API role can write the staging tables (only the server role can)', (select count(*)::text from information_schema.role_table_grants where table_schema = 'public' and table_name in ('resource_content_import_runs', 'resource_content_import_rows') and grantee in ('anon', 'authenticated', 'PUBLIC') and privilege_type <> 'SELECT'), '0'
  union all select 9, 'B', 'anon has no read access to the staging tables either', (select count(*)::text from information_schema.role_table_grants where table_schema = 'public' and table_name in ('resource_content_import_runs', 'resource_content_import_rows') and grantee in ('anon', 'PUBLIC')), '0'
  union all select 10, 'B', 'the staging tables are empty (nothing has been uploaded yet)', (select ((select count(*) from public.resource_content_import_runs) + (select count(*) from public.resource_content_import_rows))::text), '0'
  union all select 11, 'C', 'resource_posts column count (compare with P0)', (select count(*)::text from information_schema.columns where table_schema = 'public' and table_name = 'resource_posts'), null
  union all select 12, 'C', 'resource_posts constraint count (compare with P0)', (select count(*)::text from pg_constraint where conrelid = 'public.resource_posts'::regclass), null
  union all select 13, 'C', 'resource_posts policy count (compare with P0)', (select count(*)::text from pg_policies where schemaname = 'public' and tablename = 'resource_posts'), null
) c
order by n;
