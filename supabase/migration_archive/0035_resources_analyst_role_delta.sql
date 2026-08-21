-- =============================================================================
-- Resources — R1.1 closure-pass delta: Analyst role reconciliation
-- =============================================================================
-- 0033_resources_foundation.sql was edited in place (still uncommitted, not
-- yet permanent history) to add the sixth Resources role, 'analyst', per
-- the R1.1 closure-pass brief's reconciliation against the approved R0-B
-- spec. This delta brings the already-applied DEV schema in sync with that
-- edit without re-running the full 928-line file. A fresh database applying
-- 0033 (as it now stands) + 0034 + this file gets the identical end state —
-- this file exists only because 0033 was already live in DEV before the
-- edit was made.

alter table resource_user_roles drop constraint resource_user_roles_role_check;
alter table resource_user_roles add constraint resource_user_roles_role_check
  check (role in ('resource_admin', 'author', 'editor', 'compliance_reviewer', 'publisher', 'analyst'));

-- Redefine is_resource_staff to explicitly exclude 'analyst' — Analyst must
-- not gain draft/workflow visibility merely because the role exists (R1.1
-- closure brief §5). Everywhere this function is already used by an RLS
-- policy or the transition RPC picks up the new definition automatically
-- (CREATE OR REPLACE, same signature, no re-grant needed).
create or replace function private.is_resource_staff(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.resource_user_roles r
    where r.user_id = p_user_id and r.is_active
      and r.role in ('resource_admin', 'author', 'editor', 'compliance_reviewer', 'publisher')
  ) or private.is_fhip_super_admin(p_user_id);
$$;

create or replace function private.is_resource_analyst(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.has_resource_role(p_user_id, 'analyst') or private.can_manage_resources(p_user_id);
$$;
revoke all on function private.is_resource_analyst(uuid) from public;
grant execute on function private.is_resource_analyst(uuid) to authenticated, service_role;

create or replace function public.transition_resource_post_status(
  p_post_id uuid,
  p_to_status text,
  p_reason text default null,
  p_notes text default null
)
returns resource_posts
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_post public.resource_posts;
  v_from_status text;
  v_can_editorial boolean;
  v_can_compliance boolean;
  v_can_publish boolean;
  v_can_manage boolean;
  v_actor_role text;
begin
  if v_actor is null then
    raise exception 'Not authenticated';
  end if;

  select * into v_post from public.resource_posts where id = p_post_id for update;
  if not found then
    raise exception 'Resource post % not found', p_post_id;
  end if;
  v_from_status := v_post.status;

  if p_to_status not in ('idea', 'draft', 'editorial_review', 'compliance_review', 'approved', 'scheduled', 'published', 'review_due', 'archived') then
    raise exception 'Invalid target status: %', p_to_status;
  end if;

  v_can_editorial := private.has_resource_role(v_actor, 'editor') or private.can_manage_resources(v_actor);
  v_can_compliance := private.has_resource_role(v_actor, 'compliance_reviewer') or private.can_manage_resources(v_actor);
  v_can_publish := private.can_publish_resource(v_actor);
  v_can_manage := private.can_manage_resources(v_actor);

  if p_to_status = 'draft' then
    if not (private.is_resource_staff(v_actor) and (v_post.created_by = v_actor or v_can_editorial)) then
      raise exception 'Not permitted to move this post to draft';
    end if;
  elsif p_to_status = 'editorial_review' then
    if not (private.is_resource_staff(v_actor) and (v_post.created_by = v_actor or v_can_editorial)) then
      raise exception 'Not permitted to submit this post for editorial review';
    end if;
  elsif p_to_status = 'compliance_review' then
    if not v_can_editorial then
      raise exception 'Only an Editor, Resource Administrator, or Super Admin may send content to compliance review';
    end if;
  elsif p_to_status = 'approved' then
    if v_post.compliance_classification = 'amber' then
      if not v_can_compliance then
        raise exception 'AMBER content requires Compliance Reviewer approval, not editorial approval alone';
      end if;
    else
      if not v_can_editorial then
        raise exception 'Only an Editor, Resource Administrator, or Super Admin may approve GREEN content';
      end if;
    end if;
  elsif p_to_status = 'scheduled' or p_to_status = 'published' then
    if v_post.compliance_classification = 'red' then
      raise exception 'RED content cannot be scheduled or published under the standard R1.1 workflow';
    end if;
    if v_post.compliance_classification = 'amber' and v_post.compliance_approved_by is null then
      raise exception 'AMBER content must have a recorded Compliance Reviewer approval before it can be scheduled or published';
    end if;
    if v_post.status <> 'approved' and v_from_status not in ('scheduled') then
      raise exception 'Only approved content may be scheduled or published (current status: %)', v_from_status;
    end if;
    if not v_can_publish then
      raise exception 'Only a Publisher, Resource Administrator, or Super Admin may schedule or publish';
    end if;
  elsif p_to_status = 'review_due' or p_to_status = 'archived' then
    if not (v_can_publish or v_can_manage) then
      raise exception 'Not permitted to change this post''s status';
    end if;
  elsif p_to_status = 'idea' then
    if not (private.is_resource_staff(v_actor) and (v_post.created_by = v_actor or v_can_manage)) then
      raise exception 'Not permitted to move this post back to idea';
    end if;
  end if;

  v_actor_role := case
    when private.is_fhip_super_admin(v_actor) then 'super_admin'
    when private.has_resource_role(v_actor, 'resource_admin') then 'resource_admin'
    when private.has_resource_role(v_actor, 'publisher') then 'publisher'
    when private.has_resource_role(v_actor, 'compliance_reviewer') then 'compliance_reviewer'
    when private.has_resource_role(v_actor, 'editor') then 'editor'
    when private.has_resource_role(v_actor, 'author') then 'author'
    when private.has_resource_role(v_actor, 'analyst') then 'analyst'
    else 'unknown'
  end;

  update public.resource_posts set
    status = p_to_status,
    editorial_approved_by = case when p_to_status = 'approved' and compliance_classification <> 'amber' then v_actor else editorial_approved_by end,
    editorial_approved_at = case when p_to_status = 'approved' and compliance_classification <> 'amber' then now() else editorial_approved_at end,
    compliance_approved_by = case when p_to_status = 'approved' and compliance_classification = 'amber' then v_actor else compliance_approved_by end,
    compliance_approved_at = case when p_to_status = 'approved' and compliance_classification = 'amber' then now() else compliance_approved_at end,
    published_at = case when p_to_status = 'published' and published_at is null then now() else published_at end,
    updated_by = v_actor,
    updated_at = now()
  where id = p_post_id
  returning * into v_post;

  insert into public.resource_workflow_history (post_id, from_status, to_status, actor_user_id, actor_role, action, reason, notes)
  values (p_post_id, v_from_status, p_to_status, v_actor, v_actor_role, 'status_transition', p_reason, p_notes);

  insert into public.resource_audit_log (entity_type, entity_id, action, actor_user_id, before_state, after_state, metadata)
  values ('resource_post', p_post_id, 'status_transition', v_actor,
    jsonb_build_object('status', v_from_status),
    jsonb_build_object('status', p_to_status),
    jsonb_build_object('reason', p_reason, 'notes', p_notes, 'actor_role', v_actor_role));

  return v_post;
end;
$$;
