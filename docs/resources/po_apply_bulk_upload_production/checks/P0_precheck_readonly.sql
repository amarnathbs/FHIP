-- P0 precheck for the Resources Bulk Upload release. READ ONLY. Safe to run on production any number of times.
-- Paste the whole file in the SQL editor and press Run. You get one row per check, in order.
-- Section A: the Resources tables, columns and functions the upload relies on exist (ok must be true on every A row).
-- Section B: the Resources role model is what the upload assumes (ok must be true on every B row).
-- Section C: nothing of this release is applied yet (every C row must show false, and ok true). If a C row shows true,
--            the step was already done: stop and send the result back before running anything else.
-- Section D: facts for the record (sizes and counts). They have no expected value, so ok is true. Copy them to your reply.
-- Section E: the highest migration objects of the neighbouring releases, so we know which database this is. Information only.
-- If any ok is false in section A, B or C: STOP. Do not apply anything. Send the result back.

select section, check_name, actual, expected, coalesce(expected is null or actual = expected, false) as ok
from (
  select 1 as n, 'A' as section, 'table resource_posts exists' as check_name, (to_regclass('public.resource_posts') is not null)::text as actual, 'true' as expected
  union all select 2, 'A', 'table resource_post_categories exists', (to_regclass('public.resource_post_categories') is not null)::text, 'true'
  union all select 3, 'A', 'table resource_post_tags exists', (to_regclass('public.resource_post_tags') is not null)::text, 'true'
  union all select 4, 'A', 'table resource_sources exists', (to_regclass('public.resource_sources') is not null)::text, 'true'
  union all select 5, 'A', 'table resource_post_sources exists', (to_regclass('public.resource_post_sources') is not null)::text, 'true'
  union all select 6, 'A', 'table resource_audit_log exists', (to_regclass('public.resource_audit_log') is not null)::text, 'true'
  union all select 7, 'A', 'table resource_categories, resource_tags, resource_authors, resource_ctas exist', (to_regclass('public.resource_categories') is not null and to_regclass('public.resource_tags') is not null and to_regclass('public.resource_authors') is not null and to_regclass('public.resource_ctas') is not null)::text, 'true'
  union all select 8, 'A', 'table resource_post_versions and resource_workflow_history exist', (to_regclass('public.resource_post_versions') is not null and to_regclass('public.resource_workflow_history') is not null)::text, 'true'
  union all select 9, 'A', 'resource_posts has all 26 columns the apply writes', (select count(*)::text from information_schema.columns where table_schema = 'public' and table_name = 'resource_posts' and column_name in ('id','content_id','title','slug','excerpt','content_blocks','content_type','jurisdiction','difficulty','freshness_type','visibility','status','compliance_classification','primary_category_id','author_id','expires_at','next_review_at','seo_title','seo_description','is_indexable','primary_cta_id','secondary_cta_id','event_date','affected_audience','created_by','updated_by')), '26'
  union all select 10, 'A', 'resource_post_categories has post_id, category_id, is_primary', (select count(*)::text from information_schema.columns where table_schema = 'public' and table_name = 'resource_post_categories' and column_name in ('post_id','category_id','is_primary')), '3'
  union all select 11, 'A', 'resource_post_tags has post_id, tag_id', (select count(*)::text from information_schema.columns where table_schema = 'public' and table_name = 'resource_post_tags' and column_name in ('post_id','tag_id')), '2'
  union all select 12, 'A', 'resource_sources has the 7 columns the apply writes', (select count(*)::text from information_schema.columns where table_schema = 'public' and table_name = 'resource_sources' and column_name in ('source_name','document_title','url','source_type','publication_date','is_public','created_by')), '7'
  union all select 13, 'A', 'resource_post_sources has post_id, source_id, sort_order', (select count(*)::text from information_schema.columns where table_schema = 'public' and table_name = 'resource_post_sources' and column_name in ('post_id','source_id','sort_order')), '3'
  union all select 14, 'A', 'resource_post_sources has a unique key on post_id and source_id (the apply relies on it)', (select count(*)::text from pg_constraint where conrelid = 'public.resource_post_sources'::regclass and contype in ('p','u') and array_length(conkey, 1) = 2), '1'
  union all select 15, 'A', 'resource_audit_log has the 7 columns the apply writes', (select count(*)::text from information_schema.columns where table_schema = 'public' and table_name = 'resource_audit_log' and column_name in ('entity_type','entity_id','action','actor_user_id','before_state','after_state','metadata')), '7'
  union all select 16, 'A', 'categories, tags, authors and ctas each have id and is_active', (select count(*)::text from information_schema.columns where table_schema = 'public' and table_name in ('resource_categories','resource_tags','resource_authors','resource_ctas') and column_name in ('id','is_active')), '8'
  union all select 17, 'A', 'resource_posts content_type check allows article and money_update', (select (count(*) > 0)::text from pg_constraint where conrelid = 'public.resource_posts'::regclass and contype = 'c' and position('money_update' in pg_get_constraintdef(oid)) > 0 and position('article' in pg_get_constraintdef(oid)) > 0), 'true'
  union all select 18, 'A', 'slug is unique on resource_posts (a duplicate slug must be refused by the database itself)', (select (count(*) > 0)::text from pg_index i where i.indrelid = 'public.resource_posts'::regclass and i.indisunique and i.indnatts = 1 and exists (select 1 from pg_attribute a where a.attrelid = i.indrelid and a.attnum = i.indkey[0] and a.attname = 'slug')), 'true'
  union all select 19, 'A', 'function private.is_fhip_super_admin(uuid) exists', (to_regprocedure('private.is_fhip_super_admin(uuid)') is not null)::text, 'true'
  union all select 20, 'A', 'function private.has_resource_role(uuid,text) exists', (to_regprocedure('private.has_resource_role(uuid,text)') is not null)::text, 'true'
  union all select 21, 'A', 'function private.can_manage_resources(uuid) exists (used by the delete-draft rule that main already has)', (to_regprocedure('private.can_manage_resources(uuid)') is not null)::text, 'true'
  union all select 22, 'B', 'resource_user_roles has user_id, role, is_active', (select count(*)::text from information_schema.columns where table_schema = 'public' and table_name = 'resource_user_roles' and column_name in ('user_id','role','is_active')), '3'
  union all select 23, 'B', 'the role check allows editor and resource_admin', (select (count(*) > 0)::text from pg_constraint where conrelid = 'public.resource_user_roles'::regclass and contype = 'c' and position('editor' in pg_get_constraintdef(oid)) > 0 and position('resource_admin' in pg_get_constraintdef(oid)) > 0), 'true'
  union all select 24, 'B', 'admin_users exists (the Super Admin list)', (to_regclass('public.admin_users') is not null)::text, 'true'
  union all select 25, 'C', 'staging table resource_content_import_runs exists (false before you apply)', (to_regclass('public.resource_content_import_runs') is not null)::text, 'false'
  union all select 26, 'C', 'staging table resource_content_import_rows exists (false before you apply)', (to_regclass('public.resource_content_import_rows') is not null)::text, 'false'
  union all select 27, 'C', 'function apply_resource_content_import exists (false before you apply)', (to_regprocedure('public.apply_resource_content_import(uuid)') is not null)::text, 'false'
  union all select 28, 'C', 'function apply_resource_content_import_as_actor exists (false before you apply)', (to_regprocedure('public.apply_resource_content_import_as_actor(uuid,uuid)') is not null)::text, 'false'
  union all select 29, 'C', 'function private.can_bulk_import_resource_content exists (false before you apply)', (to_regprocedure('private.can_bulk_import_resource_content(uuid)') is not null)::text, 'false'
  union all select 30, 'C', 'function private.apply_resource_content_import_core exists (false before you apply)', (to_regprocedure('private.apply_resource_content_import_core(uuid,uuid)') is not null)::text, 'false'
  union all select 31, 'D', 'database size', pg_size_pretty(pg_database_size(current_database())), null
  union all select 32, 'D', 'resource_posts rows', (select count(*)::text from public.resource_posts), null
  union all select 33, 'D', 'resource_posts size with indexes', pg_size_pretty(pg_total_relation_size('public.resource_posts')), null
  union all select 34, 'D', 'resource_audit_log rows', (select count(*)::text from public.resource_audit_log), null
  union all select 35, 'D', 'resource_audit_log size with indexes', pg_size_pretty(pg_total_relation_size('public.resource_audit_log')), null
  union all select 36, 'D', 'resource_sources rows', (select count(*)::text from public.resource_sources), null
  union all select 37, 'D', 'resource_post_versions rows', (select count(*)::text from public.resource_post_versions), null
  union all select 38, 'D', 'posts by type and status (article and money_update only)', (select coalesce(string_agg(content_type || '/' || status || '=' || c, ', ' order by content_type, status), 'none') from (select content_type, status, count(*)::text as c from public.resource_posts where content_type in ('article','money_update') group by content_type, status) g), null
  union all select 39, 'D', 'active categories, tags, authors, ctas', (select (select count(*) from public.resource_categories where is_active)::text || ', ' || (select count(*) from public.resource_tags where is_active)::text || ', ' || (select count(*) from public.resource_authors where is_active)::text || ', ' || (select count(*) from public.resource_ctas where is_active)::text), null
  union all select 40, 'D', 'people holding each active Resources role', (select coalesce(string_agg(role || '=' || c, ', ' order by role), 'none') from (select role, count(distinct user_id)::text as c from public.resource_user_roles where is_active group by role) r), null
  union all select 41, 'D', 'Super Admins (admin_users rows)', (select count(*)::text from public.admin_users), null
  union all select 42, 'D', 'people who WOULD get Bulk Upload (Super Admin, Resource Admin or Editor)', (select count(distinct u)::text from (select user_id as u from public.resource_user_roles where is_active and role in ('resource_admin','editor') union select user_id from public.admin_users) x), null
  union all select 43, 'D', 'resource_posts column count (P1 must show the same number)', (select count(*)::text from information_schema.columns where table_schema = 'public' and table_name = 'resource_posts'), null
  union all select 44, 'D', 'resource_posts constraint count (P1 must show the same number)', (select count(*)::text from pg_constraint where conrelid = 'public.resource_posts'::regclass), null
  union all select 45, 'D', 'resource_posts policy count (P1 must show the same number)', (select count(*)::text from pg_policies where schemaname = 'public' and tablename = 'resource_posts'), null
  union all select 46, 'D', 'first 15 active category slugs (the synthetic files need one that exists)', (select coalesce(string_agg(slug, ', ' order by slug), 'none') from (select slug from public.resource_categories where is_active order by slug limit 15) s), null
  union all select 47, 'E','highest-numbered neighbouring objects present (0275 staged upload tables, 0280 entitlement edit)', (select 'benchmark_upload_batches=' || (to_regclass('public.benchmark_upload_batches') is not null)::text || ', promo_codes=' || (to_regclass('public.promo_codes') is not null)::text), null
) c
order by n;
