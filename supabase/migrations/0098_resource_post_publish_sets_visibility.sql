-- Resources publish workflow fix: transition_resource_post_status() never
-- set `visibility` on any transition, including 'published'. resource_posts
-- .visibility defaults to 'private' at creation (migration 0049 line 487)
-- and the public-facing predicate (lib/resources/public/visibility.ts's
-- applyPublicPostVisibility(), mirrored exactly inside
-- public.search_resource_posts()) requires visibility in ('public',
-- 'unlisted'). Result: a post correctly transitioned all the way to
-- status='published' with published_at set was STILL invisible to every
-- public listing/search/detail query, because visibility was still stuck at
-- its creation-time 'private' default.
--
-- Found live in production 2026-08-28: a real article
-- ("Understanding Savings, Debt and Liquidity Ratios Together",
-- 885e430e-6efe-4363-85bc-0e0edb09d902) reached status='published' with a
-- real published_at timestamp via this exact function, and still returned
-- zero results from the public search page. Confirmed via direct query
-- (status=published, visibility=private, published_at set) and via reading
-- this function's own UPDATE clause (never references visibility at all).
-- At the time of this fix, this was the ONLY resource_posts row with
-- status='published' in production (confirmed via a grouped count query),
-- so the blast radius was one row, manually corrected already
-- (`update resource_posts set visibility = 'public' where id = '885e430e-
-- 6efe-4363-85bc-0e0edb09d902'`) ahead of this migration landing.
--
-- FIX: re-declare the function (CREATE OR REPLACE, same signature, same
-- security/permission logic, unchanged in every other respect) so that
-- transitioning to 'published' also promotes visibility from its 'private'
-- default to 'public'. Deliberately conditioned on visibility = 'private'
-- (not an unconditional overwrite) so that if a future workflow ever sets
-- visibility = 'unlisted' by deliberate choice before publishing, that
-- choice survives the publish transition rather than being silently
-- promoted to fully public. No other transition target is touched — the
-- Product Owner's own instruction was to use the existing publish action
-- to make the status public, not introduce a new state or a separate
-- visibility-setting step.

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
    -- THE FIX: promote visibility from its creation-time 'private' default
    -- to 'public' the moment a post is actually published, so it stops
    -- being invisible to the public predicate this function was always
    -- meant to satisfy. Conditioned on visibility = 'private' so a
    -- deliberately-set 'unlisted' value (if ever introduced) is preserved,
    -- not silently overwritten.
    visibility = case when p_to_status = 'published' and visibility = 'private' then 'public' else visibility end,
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
revoke all on function public.transition_resource_post_status(uuid, text, text, text) from public;
grant execute on function public.transition_resource_post_status(uuid, text, text, text) to authenticated, service_role;
