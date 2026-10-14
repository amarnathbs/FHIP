-- STEP 2 of 2. Removes exactly the rows that step 1 lists, and records each removal in the audit log.
-- Run step 1 first and check the list. Nothing is removed unless the same rules match at the moment this runs.
-- The result shows two numbers: removed and audited. They must be equal.
with doomed as (
  select p.id
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
),
removed as (
  delete from public.resource_posts rp
  using doomed d
  where rp.id = d.id
    and rp.status in ('idea', 'draft')
    and rp.published_at is null
  returning rp.id, rp.title, rp.content_type, rp.status
),
audited as (
  insert into public.resource_audit_log (entity_type, entity_id, action, actor_user_id, before_state, metadata)
  select 'resource_post', r.id, 'RESOURCE_DRAFT_DELETED', null,
         jsonb_build_object('title', r.title, 'content_type', r.content_type, 'status', r.status),
         jsonb_build_object('reason', 'f3_untitled_draft_cleanup_sql', 'environment', 'PRODUCTION')
  from removed r
  returning 1
)
select (select count(*) from removed) as removed, (select count(*) from audited) as audited;
