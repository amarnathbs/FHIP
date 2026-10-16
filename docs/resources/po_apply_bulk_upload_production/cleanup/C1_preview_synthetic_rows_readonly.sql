-- C1 shows EXACTLY what the cleanup (C2) would remove. READ ONLY. Run it first and read every line.
-- The marker is the same on everything the synthetic verification creates: post slugs start with zz-bulkverify-,
-- source names start with ZZ BULKVERIFY, and the uploaded file names start with ZZ_BULKVERIFY.
-- Real content never matches these three markers. If any row below looks like real content, STOP and send this result back.

select 'post' as kind, p.content_type as detail, p.slug as name, p.status || ' / ' || p.visibility as state, p.created_at
from public.resource_posts p
where starts_with(p.slug, 'zz-bulkverify-')
union all
select 'source', s.source_type, s.source_name, (select count(*)::text from public.resource_post_sources l where l.source_id = s.id) || ' link(s)', s.created_at
from public.resource_sources s
where starts_with(s.source_name, 'ZZ BULKVERIFY')
union all
select 'import run', r.content_type, r.file_name, r.status || ' / ' || r.row_count::text || ' row(s)', r.created_at
from public.resource_content_import_runs r
where starts_with(r.file_name, 'ZZ_BULKVERIFY')
order by 1, 5;

-- Counts C2 will insist on (post count must equal the number you set at the top of C2):
select
  (select count(*) from public.resource_posts where starts_with(slug, 'zz-bulkverify-')) as synthetic_posts,
  (select count(*) from public.resource_sources where starts_with(source_name, 'ZZ BULKVERIFY')) as synthetic_sources,
  (select count(*) from public.resource_content_import_runs where starts_with(file_name, 'ZZ_BULKVERIFY')) as synthetic_import_runs,
  (select count(*) from public.resource_post_sources l join public.resource_sources s on s.id = l.source_id where starts_with(s.source_name, 'ZZ BULKVERIFY') and not exists (select 1 from public.resource_posts p where p.id = l.post_id and starts_with(p.slug, 'zz-bulkverify-'))) as synthetic_sources_used_by_real_posts_must_be_0;
