-- ---------------------------------------------------------------------------
-- PART C starts here: the atomic apply function. Safe to run twice.
--
-- apply_resource_content_import(run id) creates every row of one staged upload as a PRIVATE DRAFT in one
-- database transaction: all rows or none. If anything fails, no post, no category link, no tag link, no source
-- and no source link is left behind, and the run is not marked applied.
--
-- What the caller cannot choose: the actor is always the signed-in person (auth.uid), the content type is
-- always the one stored on the run, status is always draft, visibility is always private, is_indexable is
-- always false. None of these is taken out of the staged data.
--
-- Who may call it: a signed-in person who holds the bulk import capability AND uploaded this run.
-- Two simultaneous calls for the same run have one effect: the second waits, then reports already applied.
-- A slug or external id that was taken after the preview stops the whole apply with STALE_PREVIEW.
-- ---------------------------------------------------------------------------

create or replace function public.apply_resource_content_import(p_run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_actor uuid := auth.uid();
  v_run public.resource_content_import_runs;
  v_n integer;
  v_created integer := 0;
  v_cname text;
  v_src record;
  v_source_id uuid;
  v_post_ids jsonb;
begin
  if v_actor is null then
    raise exception 'NOT_AUTHENTICATED: sign in required';
  end if;
  if not private.can_bulk_import_resource_content(v_actor) then
    raise exception 'FORBIDDEN: the bulk import capability is required';
  end if;

  select * into v_run
    from public.resource_content_import_runs
   where id = p_run_id
     for update;
  if not found then
    raise exception 'IMPORT_NOT_READY: this import was not found';
  end if;
  if v_run.uploaded_by is distinct from v_actor then
    raise exception 'FORBIDDEN: only the person who uploaded this file can apply it';
  end if;

  if v_run.status = 'applied' then
    return jsonb_build_object('ok', true, 'already_applied', true, 'run_id', v_run.id, 'created', v_run.created_post_count);
  end if;
  if v_run.status <> 'ready' or v_run.error_count > 0 or v_run.row_count < 1 then
    raise exception 'IMPORT_NOT_READY: this import is not ready to apply';
  end if;
  if v_run.expires_at < now() then
    raise exception 'IMPORT_NOT_READY: this preview has expired, upload the file again';
  end if;

  begin
    perform pg_advisory_xact_lock(hashtextextended(v_run.content_type || ':' || v_run.file_sha256, 0));
    if exists (
      select 1 from public.resource_content_import_runs o
       where o.content_type = v_run.content_type
         and o.file_sha256 = v_run.file_sha256
         and o.status = 'applied'
         and o.id <> v_run.id
    ) then
      raise exception 'FILE_ALREADY_APPLIED: this exact file was already applied';
    end if;

    select count(*) into v_n from public.resource_content_import_rows r where r.import_run_id = v_run.id;
    if v_n <> v_run.row_count then
      raise exception 'IMPORT_NOT_READY: the staged rows do not match the preview';
    end if;
    select count(*) into v_n
      from public.resource_content_import_rows r
     where r.import_run_id = v_run.id
       and (jsonb_array_length(r.validation_errors) > 0 or r.result_status <> 'staged');
    if v_n > 0 then
      raise exception 'IMPORT_NOT_READY: a row still has errors';
    end if;
    select count(*) into v_n
      from public.resource_content_import_rows r
     where r.import_run_id = v_run.id
       and (
         coalesce(btrim(r.normalized_payload->>'title'), '') = ''
         or coalesce(btrim(r.normalized_payload->>'excerpt'), '') = ''
         or coalesce(r.normalized_payload->>'slug', '') !~ '^[a-z0-9]+(-[a-z0-9]+)*$'
         or jsonb_typeof(r.normalized_payload->'content_blocks') is distinct from 'array'
         or coalesce(jsonb_array_length(r.normalized_payload->'content_blocks'), 0) < 1
       );
    if v_n > 0 then
      raise exception 'IMPORT_NOT_READY: a staged row is incomplete';
    end if;

    -- Stale preview: something the preview relied on changed after it was shown.
    select r.row_number into v_n
      from public.resource_content_import_rows r
      join public.resource_posts p on p.slug = r.normalized_payload->>'slug'
     where r.import_run_id = v_run.id
     order by r.row_number
     limit 1;
    if found then
      raise exception using message = 'STALE_PREVIEW: the slug in row ' || v_n::text || ' now exists';
    end if;
    select r.row_number into v_n
      from public.resource_content_import_rows r
      join public.resource_posts p
        on (p.content_id = nullif(r.normalized_payload->>'external_id', '')
            or p.id::text = lower(nullif(r.normalized_payload->>'external_id', '')))
     where r.import_run_id = v_run.id
     order by r.row_number
     limit 1;
    if found then
      raise exception using message = 'STALE_PREVIEW: the external id in row ' || v_n::text || ' now exists';
    end if;
    select r.row_number into v_n
      from public.resource_content_import_rows r
     where r.import_run_id = v_run.id
       and nullif(r.normalized_payload->>'primary_category_id', '') is not null
       and not exists (
         select 1 from public.resource_categories c
          where c.id = (r.normalized_payload->>'primary_category_id')::uuid and c.is_active
       )
     order by r.row_number
     limit 1;
    if found then
      raise exception using message = 'STALE_PREVIEW: the category in row ' || v_n::text || ' no longer exists';
    end if;
    select r.row_number into v_n
      from public.resource_content_import_rows r
     cross join lateral jsonb_array_elements_text(coalesce(r.normalized_payload->'tag_ids', '[]'::jsonb)) as t(value)
     where r.import_run_id = v_run.id
       and not exists (select 1 from public.resource_tags g where g.id = t.value::uuid and g.is_active)
     order by r.row_number
     limit 1;
    if found then
      raise exception using message = 'STALE_PREVIEW: a tag in row ' || v_n::text || ' no longer exists';
    end if;
    select r.row_number into v_n
      from public.resource_content_import_rows r
     where r.import_run_id = v_run.id
       and nullif(r.normalized_payload->>'author_id', '') is not null
       and not exists (
         select 1 from public.resource_authors a
          where a.id = (r.normalized_payload->>'author_id')::uuid and a.is_active
       )
     order by r.row_number
     limit 1;
    if found then
      raise exception using message = 'STALE_PREVIEW: the author in row ' || v_n::text || ' no longer exists';
    end if;
    select r.row_number into v_n
      from public.resource_content_import_rows r
     where r.import_run_id = v_run.id
       and (
         (nullif(r.normalized_payload->>'primary_cta_id', '') is not null
           and not exists (select 1 from public.resource_ctas c where c.id = (r.normalized_payload->>'primary_cta_id')::uuid and c.is_active))
         or
         (nullif(r.normalized_payload->>'secondary_cta_id', '') is not null
           and not exists (select 1 from public.resource_ctas c where c.id = (r.normalized_payload->>'secondary_cta_id')::uuid and c.is_active))
       )
     order by r.row_number
     limit 1;
    if found then
      raise exception using message = 'STALE_PREVIEW: a call to action in row ' || v_n::text || ' no longer exists';
    end if;

    update public.resource_content_import_rows
       set planned_post_id = gen_random_uuid()
     where import_run_id = v_run.id;

    insert into public.resource_posts (
      id, content_id, title, slug, excerpt, content_blocks, content_type, jurisdiction, difficulty,
      freshness_type, visibility, status, compliance_classification, primary_category_id, author_id,
      expires_at, next_review_at, seo_title, seo_description, is_indexable, primary_cta_id, secondary_cta_id,
      event_date, affected_audience, created_by, updated_by
    )
    select
      r.planned_post_id,
      nullif(r.normalized_payload->>'external_id', ''),
      btrim(r.normalized_payload->>'title'),
      r.normalized_payload->>'slug',
      btrim(r.normalized_payload->>'excerpt'),
      r.normalized_payload->'content_blocks',
      v_run.content_type,
      r.normalized_payload->>'jurisdiction',
      nullif(r.normalized_payload->>'difficulty', ''),
      case when v_run.content_type = 'money_update' then 'time_sensitive'
           else coalesce(nullif(r.normalized_payload->>'freshness_type', ''), 'evergreen') end,
      'private',
      'draft',
      r.normalized_payload->>'compliance_classification',
      nullif(r.normalized_payload->>'primary_category_id', '')::uuid,
      case when v_run.content_type = 'article' then nullif(r.normalized_payload->>'author_id', '')::uuid else null end,
      nullif(r.normalized_payload->>'expires_at', '')::timestamptz,
      nullif(r.normalized_payload->>'next_review_at', '')::timestamptz,
      nullif(r.normalized_payload->>'seo_title', ''),
      nullif(r.normalized_payload->>'seo_description', ''),
      false,
      nullif(r.normalized_payload->>'primary_cta_id', '')::uuid,
      nullif(r.normalized_payload->>'secondary_cta_id', '')::uuid,
      case when v_run.content_type = 'money_update' then nullif(r.normalized_payload->>'event_date', '')::date else null end,
      case when v_run.content_type = 'money_update' then nullif(r.normalized_payload->>'affected_audience', '') else null end,
      v_actor,
      v_actor
    from public.resource_content_import_rows r
    where r.import_run_id = v_run.id
    order by r.row_number;

    insert into public.resource_post_categories (post_id, category_id, is_primary)
    select r.planned_post_id, (r.normalized_payload->>'primary_category_id')::uuid, true
      from public.resource_content_import_rows r
     where r.import_run_id = v_run.id
       and nullif(r.normalized_payload->>'primary_category_id', '') is not null;

    insert into public.resource_post_tags (post_id, tag_id)
    select distinct r.planned_post_id, t.value::uuid
      from public.resource_content_import_rows r
     cross join lateral jsonb_array_elements_text(coalesce(r.normalized_payload->'tag_ids', '[]'::jsonb)) as t(value)
     where r.import_run_id = v_run.id;

    -- Sources: reuse an existing source only on an exact match of name, link and document title. Otherwise create it
    -- here, in the same transaction, so a failed apply leaves no orphan source behind.
    for v_src in
      select distinct on (s.value->>'source_name', nullif(s.value->>'url', ''), nullif(s.value->>'document_title', ''))
             s.value->>'source_name' as source_name,
             nullif(s.value->>'document_title', '') as document_title,
             nullif(s.value->>'url', '') as url,
             nullif(s.value->>'source_type', '') as source_type,
             nullif(s.value->>'publication_date', '')::date as publication_date,
             coalesce((s.value->>'is_public')::boolean, true) as is_public
        from public.resource_content_import_rows r
       cross join lateral jsonb_array_elements(coalesce(r.normalized_payload->'sources', '[]'::jsonb)) as s(value)
       where r.import_run_id = v_run.id
       order by s.value->>'source_name', nullif(s.value->>'url', ''), nullif(s.value->>'document_title', ''), r.row_number
    loop
      v_source_id := null;
      select x.id into v_source_id
        from public.resource_sources x
       where x.source_name = v_src.source_name
         and x.url is not distinct from v_src.url
         and x.document_title is not distinct from v_src.document_title
       order by x.created_at, x.id
       limit 1;
      if v_source_id is null then
        insert into public.resource_sources (source_name, document_title, url, source_type, publication_date, is_public, created_by)
        values (v_src.source_name, v_src.document_title, v_src.url, v_src.source_type, v_src.publication_date, v_src.is_public, v_actor)
        returning id into v_source_id;
      end if;
      insert into public.resource_post_sources (post_id, source_id, sort_order)
      select r.planned_post_id, v_source_id, (s.ord - 1)::integer
        from public.resource_content_import_rows r
       cross join lateral jsonb_array_elements(coalesce(r.normalized_payload->'sources', '[]'::jsonb)) with ordinality as s(value, ord)
       where r.import_run_id = v_run.id
         and s.value->>'source_name' = v_src.source_name
         and nullif(s.value->>'url', '') is not distinct from v_src.url
         and nullif(s.value->>'document_title', '') is not distinct from v_src.document_title
      on conflict (post_id, source_id) do nothing;
    end loop;

    insert into public.resource_post_versions (post_id, version_number, snapshot, change_summary, created_by)
    select
      r.planned_post_id,
      1,
      jsonb_build_object(
        'title', btrim(r.normalized_payload->>'title'),
        'slug', r.normalized_payload->>'slug',
        'excerpt', btrim(r.normalized_payload->>'excerpt'),
        'content_type', v_run.content_type,
        'content_blocks', r.normalized_payload->'content_blocks',
        'jurisdiction', r.normalized_payload->>'jurisdiction',
        'difficulty', nullif(r.normalized_payload->>'difficulty', ''),
        'freshness_type', case when v_run.content_type = 'money_update' then 'time_sensitive'
                               else coalesce(nullif(r.normalized_payload->>'freshness_type', ''), 'evergreen') end,
        'visibility', 'private',
        'compliance_classification', r.normalized_payload->>'compliance_classification',
        'primary_category_id', nullif(r.normalized_payload->>'primary_category_id', ''),
        'category_ids', '[]'::jsonb,
        'tag_ids', coalesce(r.normalized_payload->'tag_ids', '[]'::jsonb),
        'author_id', case when v_run.content_type = 'article' then nullif(r.normalized_payload->>'author_id', '') else null end,
        'reviewer_id', null,
        'compliance_reviewer_id', null,
        'seo_title', nullif(r.normalized_payload->>'seo_title', ''),
        'seo_description', nullif(r.normalized_payload->>'seo_description', ''),
        'canonical_url', null,
        'is_indexable', false,
        'primary_cta_id', nullif(r.normalized_payload->>'primary_cta_id', ''),
        'secondary_cta_id', nullif(r.normalized_payload->>'secondary_cta_id', '')
      ),
      'Created by bulk upload',
      v_actor
    from public.resource_content_import_rows r
    where r.import_run_id = v_run.id;

    insert into public.resource_audit_log (entity_type, entity_id, action, actor_user_id, before_state, after_state, metadata)
    select
      'resource_post',
      r.planned_post_id,
      'created',
      v_actor,
      null,
      jsonb_build_object('title', btrim(r.normalized_payload->>'title'), 'status', 'draft', 'visibility', 'private', 'content_type', v_run.content_type),
      jsonb_build_object(
        'created_via', 'bulk_import',
        'import_run_id', v_run.id,
        'import_row_number', r.row_number,
        'external_id', nullif(r.normalized_payload->>'external_id', '')
      )
    from public.resource_content_import_rows r
    where r.import_run_id = v_run.id;

    update public.resource_content_import_rows
       set result_post_id = planned_post_id,
           result_status = 'created',
           normalized_payload = '{}'::jsonb
     where import_run_id = v_run.id;
    get diagnostics v_created = row_count;

    select coalesce(jsonb_agg(r.result_post_id order by r.row_number), '[]'::jsonb) into v_post_ids
      from public.resource_content_import_rows r
     where r.import_run_id = v_run.id;

    update public.resource_content_import_runs
       set status = 'applied',
           applied_at = now(),
           created_post_count = v_created,
           failure_code = null,
           failure_message_safe = null
     where id = v_run.id;

    insert into public.resource_audit_log (entity_type, entity_id, action, actor_user_id, before_state, after_state, metadata)
    values (
      'resource_content_import_run',
      v_run.id,
      'applied',
      v_actor,
      null,
      jsonb_build_object('status', 'applied', 'created', v_created),
      jsonb_build_object(
        'content_type', v_run.content_type,
        'file_name', v_run.file_name,
        'file_sha256', v_run.file_sha256,
        'template_version', v_run.template_version,
        'row_count', v_run.row_count
      )
    );

    return jsonb_build_object('ok', true, 'already_applied', false, 'run_id', v_run.id, 'created', v_created, 'post_ids', v_post_ids);
  exception
    when unique_violation then
      get stacked diagnostics v_cname = constraint_name;
      if v_cname = 'uq_rcir_applied_file' then
        raise exception 'FILE_ALREADY_APPLIED: this exact file was already applied';
      end if;
      raise exception 'STALE_PREVIEW: a slug or external id was taken after the preview';
    when foreign_key_violation then
      raise exception 'STALE_PREVIEW: a record the preview relied on no longer exists';
    when others then
      if sqlstate = 'P0001' then
        raise;
      end if;
      raise exception using message = 'APPLY_FAILED: the database refused the import (code ' || sqlstate || ')';
  end;
end;
$fn$;

revoke all on function public.apply_resource_content_import(uuid) from public, anon;
grant execute on function public.apply_resource_content_import(uuid) to authenticated, service_role;

comment on function public.apply_resource_content_import(uuid) is 'Atomic apply of one staged bulk upload run. Creates private drafts only, in one transaction. The actor, content type, status, visibility and indexable flag are never taken out of the staged data.';
