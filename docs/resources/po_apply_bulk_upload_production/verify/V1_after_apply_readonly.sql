-- V1 check after the synthetic upload has been applied. READ ONLY.
-- Lists every synthetic draft (slug starts with zz-bulkverify-) with the facts that matter. Every ok must be true and
-- the first column must show one row per synthetic file you applied (normally 2: one Article, one Money Update).

select
  p.content_type,
  p.slug,
  p.status,
  p.visibility,
  p.is_indexable,
  p.published_at is null as never_published,
  jsonb_array_length(p.content_blocks) as blocks,
  (select count(*) from public.resource_post_sources s where s.post_id = p.id) as linked_sources,
  (select count(*) from public.resource_audit_log a where a.entity_id = p.id and a.metadata ->> 'created_via' = 'bulk_import') as bulk_import_audit_rows,
  (p.status = 'draft' and p.visibility = 'private' and not p.is_indexable and p.published_at is null and jsonb_array_length(p.content_blocks) > 0) as ok
from public.resource_posts p
where starts_with(p.slug, 'zz-bulkverify-')
order by p.content_type, p.slug;

-- Second result: the import history for the synthetic files. status must be applied and created_post_count must equal the rows.
select
  r.content_type,
  r.file_name,
  r.status,
  r.row_count,
  r.created_post_count,
  (r.status = 'applied' and r.created_post_count = r.row_count) as ok
from public.resource_content_import_runs r
where starts_with(r.file_name, 'ZZ_BULKVERIFY')
order by r.created_at;

-- Third result: nothing that is not synthetic was created by the upload in the last 2 days (must be 0 rows).
select a.entity_id, a.action, a.created_at
from public.resource_audit_log a
where a.metadata ->> 'created_via' = 'bulk_import'
  and a.created_at > now() - interval '2 days'
  and not exists (select 1 from public.resource_posts p where p.id = a.entity_id and starts_with(p.slug, 'zz-bulkverify-'))
order by a.created_at;
