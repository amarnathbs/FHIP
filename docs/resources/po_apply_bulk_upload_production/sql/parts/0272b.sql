-- ---------------------------------------------------------------------------
-- PART B starts here: the existing-content lookup and the staging clean-up. Safe to run twice.
--
-- resource_content_import_lookup answers one question for a whole file at once (no query per row): which of
-- these slugs, external ids and source links already exist. It returns names and ids only, and only to a
-- person who holds the bulk import capability.
--
-- purge_expired_resource_content_import_staging removes the staged rows of runs that were never applied
-- and are older than their expiry (seven days). The run record itself stays as history. Service role only.
-- ---------------------------------------------------------------------------

create or replace function public.resource_content_import_lookup(
  p_slugs text[],
  p_content_ids text[],
  p_source_urls text[]
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_actor uuid := auth.uid();
  v_slugs jsonb;
  v_content_ids jsonb;
  v_post_ids jsonb;
  v_sources jsonb;
begin
  if v_actor is null then
    raise exception 'NOT_AUTHENTICATED: sign in required';
  end if;
  if not private.can_bulk_import_resource_content(v_actor) then
    raise exception 'FORBIDDEN: the bulk import capability is required';
  end if;
  if coalesce(cardinality(p_slugs), 0) > 1000 or coalesce(cardinality(p_content_ids), 0) > 1000 or coalesce(cardinality(p_source_urls), 0) > 2000 then
    raise exception 'FORBIDDEN: too many keys in one lookup';
  end if;

  select coalesce(jsonb_agg(p.slug), '[]'::jsonb) into v_slugs
    from public.resource_posts p
   where p.slug = any(coalesce(p_slugs, array[]::text[]));

  select coalesce(jsonb_agg(p.content_id), '[]'::jsonb) into v_content_ids
    from public.resource_posts p
   where p.content_id = any(coalesce(p_content_ids, array[]::text[]));

  select coalesce(jsonb_agg(p.id::text), '[]'::jsonb) into v_post_ids
    from public.resource_posts p
   where p.id::text = any(coalesce(p_content_ids, array[]::text[]));

  select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'source_name', s.source_name, 'document_title', s.document_title, 'url', s.url)), '[]'::jsonb) into v_sources
    from public.resource_sources s
   where s.url = any(coalesce(p_source_urls, array[]::text[]));

  return jsonb_build_object('slugs', v_slugs, 'content_ids', v_content_ids, 'post_ids', v_post_ids, 'sources', v_sources);
end;
$fn$;

revoke all on function public.resource_content_import_lookup(text[], text[], text[]) from public, anon;
grant execute on function public.resource_content_import_lookup(text[], text[], text[]) to authenticated, service_role;

create or replace function public.purge_expired_resource_content_import_staging()
returns integer
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_runs integer := 0;
begin
  delete from public.resource_content_import_rows
   where import_run_id in (
     select r.id
       from public.resource_content_import_runs r
      where r.status in ('ready', 'has_errors', 'failed', 'stale')
        and r.expires_at < now()
   );

  update public.resource_content_import_runs
     set status = 'expired'
   where status in ('ready', 'has_errors', 'failed', 'stale')
     and expires_at < now();
  get diagnostics v_runs = row_count;
  return v_runs;
end;
$fn$;

revoke all on function public.purge_expired_resource_content_import_staging() from public, anon, authenticated;
grant execute on function public.purge_expired_resource_content_import_staging() to service_role;
