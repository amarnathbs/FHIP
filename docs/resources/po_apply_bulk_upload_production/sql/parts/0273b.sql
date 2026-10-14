-- ---------------------------------------------------------------------------
-- PART B starts here: the two public callers of the apply logic. Safe to run twice.
--
-- apply_resource_content_import(run id) keeps its name and its behaviour for a signed in person: the actor is always the signed in
-- person (auth.uid), never anything the caller supplies. It now simply hands that identity to the private logic in part A.
--
-- apply_resource_content_import_as_actor(run id, actor id) is for the server only. EXECUTE is revoked for public, anon and
-- authenticated, so a browser (or any signed in person) cannot call it and cannot name an actor. The server calls it with the user
-- id it has just verified in the session, after it has checked the bulk import capability. The database still checks, inside the
-- private logic, that the named actor holds the capability and uploaded the run, so a wrong or forged actor can only ever act as
-- someone who is already allowed to apply that very run.
--
-- Neither function can change the forced values: content type of the run, status draft, visibility private, not indexable.
-- ---------------------------------------------------------------------------

create or replace function public.apply_resource_content_import(p_run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_actor uuid := auth.uid();
begin
  if v_actor is null then
    raise exception 'NOT_AUTHENTICATED: sign in required';
  end if;
  return private.apply_resource_content_import_core(p_run_id, v_actor);
end;
$fn$;

revoke all on function public.apply_resource_content_import(uuid) from public, anon;
grant execute on function public.apply_resource_content_import(uuid) to authenticated, service_role;

create or replace function public.apply_resource_content_import_as_actor(p_run_id uuid, p_actor uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if p_actor is null then
    raise exception 'NOT_AUTHENTICATED: an actor is required';
  end if;
  return private.apply_resource_content_import_core(p_run_id, p_actor);
end;
$fn$;

revoke all on function public.apply_resource_content_import_as_actor(uuid, uuid) from public, anon, authenticated;
grant execute on function public.apply_resource_content_import_as_actor(uuid, uuid) to service_role;

comment on function public.apply_resource_content_import_as_actor(uuid, uuid) is 'Server only twin of apply_resource_content_import. The actor is named by the trusted server, which has verified the session and the capability. The database re-checks capability and run ownership for that actor.';
