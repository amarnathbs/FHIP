-- B2 check that the manual backup matches the live tables right now. READ ONLY. Every ok must be true.
-- Run it straight after B1 and before the first synthetic upload. After the verification and the cleanup, run it again
-- and the numbers must be equal again (the cleanup puts the live tables back to the same row counts).

select check_name, live_rows, backup_rows, coalesce(live_rows = backup_rows, false) as ok
from (
  select 1 as n, 'resource_posts' as check_name, (select count(*) from public.resource_posts) as live_rows, (select count(*) from private.bkp_bulkupload_resource_posts) as backup_rows
  union all select 2, 'resource_post_categories', (select count(*) from public.resource_post_categories), (select count(*) from private.bkp_bulkupload_resource_post_categories)
  union all select 3, 'resource_post_tags', (select count(*) from public.resource_post_tags), (select count(*) from private.bkp_bulkupload_resource_post_tags)
  union all select 4, 'resource_sources', (select count(*) from public.resource_sources), (select count(*) from private.bkp_bulkupload_resource_sources)
  union all select 5, 'resource_post_sources', (select count(*) from public.resource_post_sources), (select count(*) from private.bkp_bulkupload_resource_post_sources)
  union all select 6, 'resource_audit_log', (select count(*) from public.resource_audit_log), (select count(*) from private.bkp_bulkupload_resource_audit_log)
) c
order by n;
