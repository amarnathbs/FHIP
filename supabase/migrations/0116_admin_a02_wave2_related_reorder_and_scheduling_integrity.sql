-- =============================================================================
-- Admin A0.2 Wave 2 — Workflow & Ordering Integrity
--
-- Two independent, narrowly scoped defects, one forward-only migration.
--
-- -----------------------------------------------------------------------------
-- SCOPE A — Related Content reorder atomicity
-- -----------------------------------------------------------------------------
-- DEFECT (reproduced before this fix was written, see
-- scripts/admin_a02_wave2_certification.mjs SECTION 1): reordering the
-- Related Content of a Resource ran N *independent, separately committed*
-- UPDATE statements —
--
--   lib/resources/discovery/relatedAdmin.ts (pre-Wave-2):
--     await Promise.all(orderedIds.map((id, index) =>
--       supabase.from('resource_related_content')
--         .update({ sort_order: index })
--         .eq('id', id).eq('source_post_id', sourcePostId)))
--
-- — with no transaction, no set validation and no locking. Every one of
-- those UPDATEs is its own PostgREST request and its own autocommitted
-- transaction. If any of them fails (constraint violation, transient error,
-- dropped connection, or simply a row that no longer belongs to the source),
-- the ones that already committed STAY committed. The route then returns
-- HTTP 500 while the database has been left with a partially applied
-- ordering: duplicated positions, gaps, or a mixture of two orderings.
--
-- Additional latent hazards in the same code path, all closed here:
--   * a payload could omit rows (leaving them stranded at their old
--     position, colliding with a new one),
--   * a payload could name a row belonging to a DIFFERENT source (the
--     `.eq('source_post_id', ...)` made it a silent no-op rather than an
--     error, so the caller was told "success" for an ordering that was
--     never applied),
--   * a payload could repeat the same id twice (last write wins, leaving a
--     gap),
--   * two administrators reordering the same source could interleave their
--     individual UPDATEs and commit a blend of both orderings.
--
-- FIX: public.admin_reorder_related_content() — one SECURITY DEFINER
-- function, therefore one transaction. It validates the payload as a
-- COMPLETE ordered set for exactly one source, takes a per-source
-- transaction-scoped advisory lock plus row locks, applies every position in
-- a single UPDATE ... FROM unnest(...) WITH ORDINALITY statement, and
-- returns the committed ordering. It succeeds completely or changes nothing.
--
-- INVARIANT (the canonical reorder contract, Wave 2 §5.2):
--   A reorder request represents the complete ordered set of the existing
--   related-content links for ONE source Resource. Every existing link for
--   that source must appear exactly once; no link belonging to another
--   source may appear; the resulting positions are zero-based, unique and
--   contiguous (0..n-1). The operation never creates, deletes or relinks a
--   relationship — it only permutes `sort_order`.
--
-- DELIBERATELY NOT ADDED: a table-level `unique (source_post_id,
-- sort_order)` constraint. 22 of the 25 existing DEV sources already hold
-- duplicate positions (bulk-seeded rows all sitting at sort_order = 0), so
-- such a constraint would either fail to apply or force a silent mass
-- repair of real content. Wave 2 forbids silently repairing existing data
-- and forbids scope expansion. The invariant is therefore enforced *by the
-- operation* — any set this function reorders comes out unique and
-- contiguous — not retroactively across untouched historical rows.
--
-- -----------------------------------------------------------------------------
-- SCOPE B — Scheduling-validation alignment across all four content types
-- -----------------------------------------------------------------------------
-- DEFECT: the four Resources workflow routes (content, glossary,
-- money-updates, videos) all target the same shared workflow engine,
-- public.transition_resource_post_status(), but disagreed about scheduling:
--
--   * content       — rejected a transition to 'scheduled' with HTTP 422 and
--                     a friendly field error IF the CLIENT omitted a
--                     `scheduledAt` body property. That property was never
--                     persisted, never passed to the RPC and never compared
--                     against anything: sending `scheduledAt: "banana"`
--                     satisfied it completely.
--   * glossary      — no scheduling check whatsoever.
--   * money-updates — no scheduling check whatsoever.
--   * videos        — no scheduling check whatsoever.
--
-- The only real enforcement anywhere was the table CHECK constraint
-- `chk_resource_posts_scheduled_at` (status <> 'scheduled' or scheduled_at
-- is not null) from migration 0049. Reaching it produced a raw PostgreSQL
-- 23514 constraint-violation string, which lib/resources/workflow.ts then
-- surfaced to the client as HTTP **403** with the raw SQL text in the
-- message. So the same user action produced four different outcomes
-- depending only on which route was called, and one of them leaked internal
-- SQL detail under a misleading status code.
--
-- The RPC itself never examined `scheduled_at` at all, and in particular
-- never rejected a scheduled_at in the PAST.
--
-- FIX: the canonical scheduling invariant moves INTO the shared workflow
-- RPC, where it cannot be bypassed by any route, by a direct PostgREST RPC
-- call, or by a future fifth content type.
--
-- INVARIANT (the canonical scheduling rule, Wave 2 §6.3):
--   A transition to 'scheduled' fails unless the Resource already holds a
--   `scheduled_at` timestamptz strictly later than the database's own now().
--
-- Derived from existing authoritative behaviour, not invented:
--   * NOT NULL — already the intent of chk_resource_posts_scheduled_at
--     (migration 0049 documents it as "§22 Scheduled requires
--     scheduled_at"). This migration promotes that from a raw constraint
--     into a first-class, plain-English RPC rule so it is reachable with a
--     usable error instead of a leaked 23514.
--   * STRICTLY FUTURE — Wave 2 §6.3's stated default, adopted because no
--     pre-existing product logic says otherwise. A scheduled publication
--     time already in the past is meaningless for a scheduling feature.
--   * TIMESTAMPTZ / UTC — `resource_posts.scheduled_at` is already
--     `timestamptz` (0049 line 498); comparison is against database now(),
--     so client clock skew and client timezone are irrelevant and no
--     timezone is ever inferred from country or currency.
--   * NO MINIMUM LEAD TIME — nothing in the product defines one; inventing
--     one would be a new product rule, not an integrity fix.
--   * TRANSITIONING AWAY PRESERVES the timestamp — the existing RPC has
--     never cleared `scheduled_at` on any transition, and this migration
--     does not change that.
--   * IMMEDIATE PUBLISH IGNORES `scheduled_at` — the existing 'published'
--     branch has never consulted it, and this migration does not change
--     that. Only the transition TO 'scheduled' is gated.
--   * RESCHEDULE — the pre-existing from-status rule already permits
--     'scheduled' -> 'scheduled'; it now additionally requires the stored
--     timestamp to still be in the future, which is what makes a stale
--     re-schedule fail loudly instead of silently re-affirming a past date.
--
-- IMPORTANT CONTEXT, recorded so nobody mistakes this for a missing
-- feature: there is deliberately NO authenticated write path for
-- `scheduled_at` today. It is absent from the column-scoped UPDATE grant on
-- resource_posts (migration 0049) and absent from this RPC's parameters, and
-- components/resources/editor/WorkflowPanel.tsx documents the R1.3 decision
-- to defer the Schedule action entirely until a scheduled-publishing worker
-- exists. Wave 2 is an integrity wave: it makes the scheduling rule
-- consistent, non-bypassable and honestly reported across all four content
-- types. It does NOT open a write path for scheduled_at and does NOT build
-- the publishing worker — both would be new product scope.
--
-- This migration EXTENDS the canonical transition RPC (CREATE OR REPLACE,
-- identical signature). It does not replace it, does not fork it per content
-- type, does not move transition authority to the client, and does not
-- weaken any existing role check, column protection or audit behaviour. The
-- body below is migration 0098's body with the scheduling guard added and
-- nothing else altered.
--
-- Forward-only. Idempotent: both functions are CREATE OR REPLACE and the
-- migration may be re-run safely.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- SCOPE A: public.admin_reorder_related_content
-- -----------------------------------------------------------------------------
-- Security posture matches the established FHIP admin-RPC pattern set by
-- migrations 0107 / 0109 (Wave 1 / 1B):
--   * SECURITY DEFINER with a pinned `search_path = public` (never an
--     empty/mutable path), so an attacker cannot shadow a referenced object.
--   * Fixed SQL only. Every table and column name is a literal in this
--     function's text. No identifier is ever constructed from client input,
--     so there is no dynamic-SQL injection surface at all.
--   * EXECUTE revoked from public, anon and authenticated; granted ONLY to
--     service_role. It is therefore unreachable from a browser session key
--     and reachable only through the authorised Admin server route, which
--     performs its own canManageDiscovery() capability check first.
--   * The function trusts NO client-supplied role or identity — it takes no
--     actor parameter and makes no authorisation decision of its own,
--     precisely so it cannot become a privilege-escalation vector. Authority
--     lives in the server route; this function's job is integrity.
create or replace function public.admin_reorder_related_content(
  p_source_post_id uuid,
  p_ordered_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  -- Defensive upper bound. Nothing in the product defines a maximum number
  -- of related items; this cap exists purely so an oversized or malicious
  -- payload is rejected cheaply instead of being sorted and written.
  c_max_items constant int := 100;
  v_supplied int;
  v_distinct int;
  v_existing int;
  v_matched int;
  v_result jsonb;
begin
  -- --- payload shape -------------------------------------------------------
  if p_source_post_id is null then
    raise exception 'admin_reorder_related_content: a source Resource is required.'
      using errcode = '22023';
  end if;

  if p_ordered_ids is null then
    raise exception 'admin_reorder_related_content: an ordered list of related items is required.'
      using errcode = '22023';
  end if;

  if array_ndims(p_ordered_ids) is distinct from 1 then
    raise exception 'admin_reorder_related_content: the ordered list must be a flat array of relationship ids.'
      using errcode = '22023';
  end if;

  v_supplied := coalesce(array_length(p_ordered_ids, 1), 0);

  if v_supplied = 0 then
    raise exception 'admin_reorder_related_content: the ordered list must contain at least one relationship id.'
      using errcode = '22023';
  end if;

  if v_supplied > c_max_items then
    raise exception 'admin_reorder_related_content: too many related items in one request (% supplied, maximum %).',
      v_supplied, c_max_items
      using errcode = '22023';
  end if;

  if exists (select 1 from unnest(p_ordered_ids) as u(id) where u.id is null) then
    raise exception 'admin_reorder_related_content: the ordered list must not contain empty relationship ids.'
      using errcode = '22023';
  end if;

  select count(distinct u.id) into v_distinct from unnest(p_ordered_ids) as u(id);
  if v_distinct <> v_supplied then
    raise exception 'admin_reorder_related_content: the ordered list contains a duplicate relationship id.'
      using errcode = '22023';
  end if;

  -- --- the source must exist ----------------------------------------------
  if not exists (select 1 from public.resource_posts p where p.id = p_source_post_id) then
    raise exception 'admin_reorder_related_content: Resource % not found.', p_source_post_id
      using errcode = 'P0002';
  end if;

  -- --- serialise concurrent reorders of the SAME source --------------------
  -- Transaction-scoped advisory lock keyed on the source id. Two concurrent
  -- reorders of the same source are forced to run one after the other, so
  -- the committed result is always ONE complete ordering and never a blend
  -- of two. Reorders of DIFFERENT sources take different lock keys and do
  -- not block each other. The lock is released automatically at commit or
  -- rollback — there is no path that can leak it.
  perform pg_advisory_xact_lock(hashtextextended(p_source_post_id::text, 0));

  -- Row locks on the source's current link set. Combined with the advisory
  -- lock this pins the set for the remainder of this transaction, so the
  -- completeness check below cannot be invalidated between validating and
  -- writing.
  perform 1
    from public.resource_related_content rc
   where rc.source_post_id = p_source_post_id
   for update;

  -- --- completeness: the payload must be exactly the existing set ----------
  select count(*) into v_existing
    from public.resource_related_content rc
   where rc.source_post_id = p_source_post_id;

  select count(*) into v_matched
    from public.resource_related_content rc
   where rc.source_post_id = p_source_post_id
     and rc.id = any (p_ordered_ids);

  -- Any id that is not a live link of THIS source: unknown id, an id owned
  -- by another source, or a link deleted since the client last read. All
  -- three are the same class of error from the caller's point of view — the
  -- set they are ordering is not the set that exists — so they share one
  -- response and one remedy (refresh and try again).
  if v_matched <> v_supplied then
    raise exception 'admin_reorder_related_content: the related items have changed since this list was loaded (% of % supplied ids are not current links of this Resource).',
      v_supplied - v_matched, v_supplied
      using errcode = '40001';
  end if;

  -- A payload that omits an existing link would strand that link at its old
  -- position and break contiguity, so a partial reorder is rejected rather
  -- than half-applied.
  if v_existing <> v_supplied then
    raise exception 'admin_reorder_related_content: the related items have changed since this list was loaded (% supplied, % currently linked).',
      v_supplied, v_existing
      using errcode = '40001';
  end if;

  -- --- apply every position in ONE statement -------------------------------
  -- WITH ORDINALITY yields 1-based positions; sort_order is zero-based
  -- (matching addRelatedContent's max+1 append and the ascending read order
  -- in listRelatedContentForSource), hence `ord - 1`. Because this is a
  -- single statement inside a single function-level transaction, there is no
  -- intermediate state any other session can observe and nothing to roll
  -- back partially: it commits as one ordering or not at all.
  update public.resource_related_content rc
     set sort_order = t.ord - 1
    from (
      select u.id, u.ord
        from unnest(p_ordered_ids) with ordinality as u(id, ord)
    ) t
   where rc.id = t.id
     and rc.source_post_id = p_source_post_id;

  -- --- return the COMMITTED ordering ---------------------------------------
  -- Read back from the table rather than echoing the request, so the caller
  -- can only ever be shown an ordering that genuinely exists in the
  -- database.
  select jsonb_build_object(
           'source_post_id', p_source_post_id,
           'count', count(*),
           'ordered', coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'sort_order', x.sort_order) order by x.sort_order), '[]'::jsonb)
         )
    into v_result
    from (
      select rc.id, rc.sort_order
        from public.resource_related_content rc
       where rc.source_post_id = p_source_post_id
    ) x;

  return v_result;
end;
$$;

alter function public.admin_reorder_related_content(uuid, uuid[]) owner to postgres;

revoke all on function public.admin_reorder_related_content(uuid, uuid[]) from public;
revoke all on function public.admin_reorder_related_content(uuid, uuid[]) from anon;
revoke all on function public.admin_reorder_related_content(uuid, uuid[]) from authenticated;
grant execute on function public.admin_reorder_related_content(uuid, uuid[]) to service_role;

comment on function public.admin_reorder_related_content(uuid, uuid[]) is
  'Admin A0.2 Wave 2 (Scope A). Atomically reorders the Related Content links of ONE source Resource. '
  'INVARIANT: the payload is the COMPLETE ordered set of that source''s existing links — every link exactly once, '
  'no foreign or unknown ids — and the resulting sort_order values are zero-based, unique and contiguous (0..n-1). '
  'Never creates, deletes or relinks a relationship; it only permutes sort_order. Succeeds completely or changes nothing. '
  'Concurrent reorders of the same source are serialised by a transaction-scoped advisory lock plus row locks, so the '
  'committed state is always one complete ordering, never a blend. Errors: SQLSTATE 22023 = invalid payload, '
  'P0002 = source Resource not found, 40001 = the link set changed since the client loaded it (refresh and retry). '
  'Replaces the previous non-atomic Promise.all of independent UPDATEs in lib/resources/discovery/relatedAdmin.ts. '
  'EXECUTE is granted to service_role only; the caller''s authority is checked by the Admin server route via canManageDiscovery().';


-- -----------------------------------------------------------------------------
-- SCOPE B: public.transition_resource_post_status — scheduling guard
-- -----------------------------------------------------------------------------
-- CREATE OR REPLACE of migration 0098's function, byte-for-byte identical
-- apart from the clearly marked WAVE 2 block below. Same signature, same
-- SECURITY DEFINER posture, same `search_path = ''` (0098's choice, retained
-- deliberately — every reference in this body is already schema-qualified),
-- same role predicates, same column protections, same workflow-history and
-- audit-log writes, same grants.
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

    -- ======================= WAVE 2 (Scope B) ===========================
    -- The canonical, non-bypassable scheduling invariant. Deliberately
    -- placed AFTER the compliance and role checks so that an unauthorised
    -- actor still gets the permission error first and learns nothing about
    -- the post's scheduling state.
    --
    -- Applies to 'scheduled' ONLY. The immediate-publish path is untouched
    -- and continues to ignore scheduled_at entirely, exactly as before.
    --
    -- Compared against the DATABASE's now(), never a client-supplied
    -- timestamp, so client clock skew, client timezone and any
    -- daylight-saving ambiguity in a client-side local time are all
    -- irrelevant here: scheduled_at is timestamptz and is already an
    -- absolute instant by the time it reaches this row.
    --
    -- errcode 22023 (invalid_parameter_value) is what lets
    -- lib/resources/workflow.ts map these to a single canonical HTTP 422 +
    -- field reference, identically for all four content types, instead of
    -- the previous raw 23514 constraint text surfaced as a misleading 403.
    if p_to_status = 'scheduled' then
      if v_post.scheduled_at is null then
        raise exception 'A publish date and time is required before this content can be scheduled.'
          using errcode = '22023';
      end if;
      if v_post.scheduled_at <= now() then
        raise exception 'The scheduled publish date and time must be in the future.'
          using errcode = '22023';
      end if;
    end if;
    -- ===================== END WAVE 2 (Scope B) =========================

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
    -- Migration 0098's fix, preserved verbatim: promote visibility from its
    -- creation-time 'private' default to 'public' on publish.
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

comment on function public.transition_resource_post_status is
  'Canonical Resources workflow engine (R1.1, 0049; visibility-on-publish fix 0098; Wave 2 scheduling guard 0116). '
  'SCHEDULING INVARIANT (Wave 2, Scope B): a transition to ''scheduled'' fails unless the Resource already holds a '
  'scheduled_at timestamptz strictly later than database now(). Enforced here, in the database, so it is identical for '
  'all four Resources content types (General Content, Glossary, Money Updates, Videos) and cannot be bypassed by any '
  'API route or by a direct RPC call. Both scheduling rejections raise SQLSTATE 22023 so the server maps them to a '
  'single canonical HTTP 422 with a scheduled_at field reference. The immediate-publish path is unaffected and still '
  'ignores scheduled_at; no transition clears scheduled_at. Note that scheduled_at itself remains writable only by '
  'service_role (it is absent from the authenticated column grant and from this function''s parameters) — Wave 2 made '
  'the rule consistent and non-bypassable, it did not open a scheduling write path or add a publishing worker.';
