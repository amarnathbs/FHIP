-- C3 proves the cleanup left nothing behind. READ ONLY. Every value must be 0 and ok true.

select check_name, remaining, remaining = 0 as ok
from (
  select 1 as n, 'synthetic posts' as check_name, (select count(*) from public.resource_posts where starts_with(slug, 'zz-bulkverify-')) as remaining
  union all select 2, 'synthetic sources', (select count(*) from public.resource_sources where starts_with(source_name, 'ZZ BULKVERIFY'))
  union all select 3, 'synthetic import runs', (select count(*) from public.resource_content_import_runs where starts_with(file_name, 'ZZ_BULKVERIFY'))
  union all select 4, 'staged rows of any run that no longer exists', (select count(*) from public.resource_content_import_rows r where not exists (select 1 from public.resource_content_import_runs x where x.id = r.import_run_id))
  union all select 5, 'audit rows that name a synthetic title', (select count(*) from public.resource_audit_log where starts_with(coalesce(after_state ->> 'title', ''), 'ZZ BULKVERIFY'))
  union all select 6, 'category, tag or source links that point at a post that no longer exists', (select (select count(*) from public.resource_post_categories c where not exists (select 1 from public.resource_posts p where p.id = c.post_id)) + (select count(*) from public.resource_post_tags t where not exists (select 1 from public.resource_posts p where p.id = t.post_id)) + (select count(*) from public.resource_post_sources s where not exists (select 1 from public.resource_posts p where p.id = s.post_id)))
) c
order by n;
