-- C2 removes ONLY the synthetic verification rows, all or nothing. Run C1 first.
-- It stops without deleting anything if the post count is not exactly the number set on the line marked EDIT,
-- if any synthetic post is not a private draft that was never published, or if a synthetic source is linked to any
-- real post. Everything it deletes is matched by the markers described in C1.
-- Normal run: two files applied (one Article, one Money Update), so the number stays 2.
-- If you also applied the 250 row capacity files, set the number to 2 plus the rows of those files and say so in your reply.

do $cleanup$
declare
  expected_posts integer := 2; -- EDIT: number of synthetic posts you expect to remove
  v_posts uuid[];
  v_runs uuid[];
  v_sources uuid[];
  v_bad integer;
  v_audit integer;
begin
  select coalesce(array_agg(id), '{}'::uuid[]) into v_posts
    from public.resource_posts
   where starts_with(slug, 'zz-bulkverify-');
  select coalesce(array_agg(id), '{}'::uuid[]) into v_runs
    from public.resource_content_import_runs
   where starts_with(file_name, 'ZZ_BULKVERIFY');
  select coalesce(array_agg(id), '{}'::uuid[]) into v_sources
    from public.resource_sources
   where starts_with(source_name, 'ZZ BULKVERIFY');

  if cardinality(v_posts) <> expected_posts then
    raise exception using message = 'CLEANUP_STOPPED: expected ' || expected_posts::text || ' synthetic posts but found ' || cardinality(v_posts)::text || '. Nothing was deleted.';
  end if;

  select count(*) into v_bad
    from public.resource_posts p
   where p.id = any(v_posts)
     and not (p.status = 'draft' and p.visibility = 'private' and not p.is_indexable and p.published_at is null);
  if v_bad > 0 then
    raise exception using message = 'CLEANUP_STOPPED: ' || v_bad::text || ' synthetic post(s) are not private drafts that were never published. Nothing was deleted.';
  end if;

  select count(*) into v_bad
    from public.resource_post_sources l
   where l.source_id = any(v_sources)
     and not (l.post_id = any(v_posts));
  if v_bad > 0 then
    raise exception using message = 'CLEANUP_STOPPED: ' || v_bad::text || ' link(s) connect a real post to a synthetic source. Nothing was deleted.';
  end if;

  delete from public.resource_audit_log
   where entity_id = any(v_posts) or entity_id = any(v_runs);
  get diagnostics v_audit = row_count;

  delete from public.resource_posts where id = any(v_posts);
  delete from public.resource_content_import_runs where id = any(v_runs);
  delete from public.resource_sources where id = any(v_sources);

  raise notice using message = 'CLEANUP_DONE: posts ' || cardinality(v_posts)::text || ', import runs ' || cardinality(v_runs)::text || ', sources ' || cardinality(v_sources)::text || ', audit rows ' || v_audit::text;
end
$cleanup$;
