-- STEP 1 of 2. Look first. This changes nothing.
-- Lists the empty placeholder drafts that the old create on open flow left behind.
-- A row is listed only when ALL of these hold:
--   the title is one of the system placeholder titles,
--   it is still a draft or idea and was never published,
--   nobody ever saved it again after it was created,
--   it has no excerpt, no primary category, no saved versions, no links,
--   it is not a video record.
select p.id, p.title, p.content_type, p.status, p.created_at
from public.resource_posts p
where p.title in ('Untitled Article', 'Untitled Guide', 'Untitled FHIP Explainer', 'Untitled Glossary Term', 'Untitled Money Update', 'Untitled Money Update Template')
  and p.content_type <> 'video'
  and p.status in ('idea', 'draft')
  and p.published_at is null
  and p.created_at = p.updated_at
  and (p.excerpt is null or btrim(p.excerpt) = '')
  and p.primary_category_id is null
  and not exists (select 1 from public.resource_post_versions v where v.post_id = p.id)
  and not exists (select 1 from public.resource_post_categories c where c.post_id = p.id)
  and not exists (select 1 from public.resource_post_tags t where t.post_id = p.id)
  and not exists (select 1 from public.resource_related_content r where r.source_post_id = p.id or r.related_post_id = p.id)
  and not exists (select 1 from public.resource_context_links x where x.resource_post_id = p.id)
  and not exists (select 1 from public.resource_workflow_history h where h.post_id = p.id and h.to_status in ('published', 'scheduled'))
order by p.created_at;
