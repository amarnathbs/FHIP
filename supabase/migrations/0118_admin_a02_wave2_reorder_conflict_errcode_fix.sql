-- =============================================================================
-- Admin A0.2 Wave 2 — reorder conflict SQLSTATE fix (hotfix on 0116)
--
-- Same hotfix pattern as 0111 (MCC-14 cascade fix), 0113/0114 (FDH-12 RPC
-- fixes): 0116 has ALREADY BEEN APPLIED TO DEV, so this is a NEW forward-only
-- migration rather than an edit to 0116's own file. It changes nothing but
-- the SQLSTATE/response-shape of one existing conflict-detection branch
-- inside public.admin_reorder_related_content. No schema change, no data
-- change, no grant change, no capability change. CREATE OR REPLACE only, safe
-- to re-run.
--
-- -----------------------------------------------------------------------------
-- BACKGROUND — Product Owner ruling of 2026-08-31
-- -----------------------------------------------------------------------------
-- docs/admin/FHIP_A02_Wave2_Residual_Gate_Investigation_Report.md ran the
-- three (really four, see below) invalid-payload negative controls that hit
-- 0116's `40001` conflict branch live against real DEV: 13 independent
-- attempts across two sessions (a full-harness run AND three isolated,
-- zero-concurrency rounds) and NONE of the 13 ever delivered the intended
-- SQLSTATE 40001 response to a real client. Instead: 11/13 timed out at a
-- strikingly consistent ~125.2 seconds with `error.code: undefined`, and 2/13
-- came back fast with a spurious 42501 for a correctly-provisioned actor. The
-- RPC's own logic is sound — PGlite-certified, and the identical locking
-- mechanism succeeds in milliseconds under valid payloads in the same live
-- runs — so the correlation is specifically with the branch that must raise
-- SQLSTATE 40001.
--
-- 40001 is PostgreSQL's own `serialization_failure` — Class 40 ("Transaction
-- Rollback"), the class a driver, connection pooler or managed gateway is
-- most likely to treat as automatically retryable. No retry logic was found
-- anywhere in this application's own code (lib/supabase/server.ts, the
-- harness's own client construction, the vendored @supabase/postgrest-js), so
-- if something in the stack IS retrying or holding the request open pending a
-- retry window, it is Supabase's managed infrastructure, not this codebase.
-- The Product Owner ruled: revise the conflict contract away from 40001 to a
-- code that is clearly outside the 40xxx serialization/transaction-rollback
-- family, so nothing in the stack has any conventional reason to treat it as
-- retryable or to hold the connection open.
--
-- -----------------------------------------------------------------------------
-- THE FIX
-- -----------------------------------------------------------------------------
-- SQLSTATE 40001 -> SQLSTATE 55000 (`object_not_in_prerequisite_state`,
-- Class 55) on the two RAISE statements that detect a stale/incomplete link
-- set (the "N of M supplied ids are not current links" case and the
-- "supplied count does not match existing count" case). 55000 is:
--   * a REAL, standard PostgreSQL SQLSTATE (not an invented ad-hoc code) —
--     Class 55 "Object Not In Prerequisite State" is precisely what this is:
--     the caller's understanding of the row set's state (which links exist,
--     in what order) is no longer current;
--   * NOT in the 40xxx family — no conventional serialization/rollback retry
--     semantics attach to it;
--   * ALREADY THE ESTABLISHED CONVENTION IN THIS EXACT CODEBASE for
--     analogous "the object is not in the state this operation requires"
--     conflicts: 0084_geo_jurisdiction_smsf.sql and
--     0090_smsf_current_balance_integrity_guard.sql both raise 55000 for "fund
--     is already in detailed mode" / "already in summary mode" state
--     conflicts. This fix follows that precedent rather than inventing a new
--     one.
--
-- Nothing else changes. Same messages (still safe, still administrator-
-- facing, still stripped of the function-name prefix by
-- lib/resources/discovery/relatedAdmin.ts's cleanRpcMessage()). Same
-- HTTP-facing contract: lib/resources/discovery/relatedAdmin.ts's
-- REORDER_ERROR_KINDS map is updated (application code, not this migration)
-- to key 'conflict' off '55000' instead of '40001', so
-- app/api/admin/resources/related/reorder/route.ts's external 409 response
-- shape is completely unchanged — only the internal SQLSTATE moving between
-- the database and that mapping table is different. No API consumer can
-- observe a difference. If 40001 were ever seen again (it shouldn't be — the
-- RPC no longer raises it) it now falls through to the generic 'error' kind
-- rather than being silently treated as a deliberate conflict, which is the
-- conservative fail-safe direction to err in.
--
-- Grants, ownership, search_path, SECURITY DEFINER posture, the
-- authentication guard, the capability recheck, the payload-shape
-- validation, the advisory lock, the row locks, the completeness check
-- itself (still comparing counts the same way), the single-statement write
-- and the read-back-from-table return contract are ALL byte-for-byte
-- unchanged. CREATE OR REPLACE FUNCTION preserves the existing ACL
-- (grant/revoke state) automatically in PostgreSQL when the signature is
-- unchanged, so the grant statements are deliberately NOT repeated here —
-- repeating them would risk this migration being mistaken for touching the
-- authorization model, which it does not. private.can_manage_discovery(),
-- public.transition_resource_post_status() and every other object from 0116
-- are untouched by this file.
--
-- Forward-only. Idempotent: CREATE OR REPLACE FUNCTION with an unchanged
-- signature; safe to re-run.
-- =============================================================================

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
  -- The actor of record. Taken ONLY from the verified session — there is no
  -- parameter that could supply it, by design.
  v_actor uuid := auth.uid();
  v_supplied int;
  v_distinct int;
  v_existing int;
  v_matched int;
  v_result jsonb;
begin
  -- --- authentication: fail closed -----------------------------------------
  -- Explicit, not implicit. A null actor must terminate the function here,
  -- rather than flow into a capability check where `null` would merely
  -- evaluate to a falsy result somewhere downstream. In practice PostgREST
  -- cannot reach this branch for an `authenticated`-granted function (an
  -- unauthenticated request is executed as `anon`, which holds no EXECUTE),
  -- but the guard is in the function BODY so the function is safe even when
  -- invoked outside the normal request path.
  if v_actor is null then
    raise exception 'admin_reorder_related_content: not authenticated.'
      using errcode = '42501';
  end if;

  -- --- authorisation: independent capability recheck -----------------------
  -- Pattern A. This does NOT trust the API route's canManageDiscovery()
  -- check (which remains, as defence in depth) and does NOT trust anything
  -- in the request payload. It reads the canonical role tables —
  -- public.admin_users and public.resource_user_roles — through the same
  -- private.* predicates that back this module's RLS policies, so the
  -- database itself is the authority. An Author, Compliance Reviewer,
  -- Publisher, Analyst or role-less authenticated user is refused here even
  -- if they reach the RPC directly, bypassing every route.
  --
  -- 42501 (insufficient_privilege) is deliberate: it is the same SQLSTATE a
  -- missing EXECUTE grant would raise, so the server maps both to one
  -- HTTP 403 and the client learns nothing about which of the two applied.
  if not private.can_manage_discovery(v_actor) then
    raise exception 'admin_reorder_related_content: you do not have permission to manage Related Content.'
      using errcode = '42501';
  end if;

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
  --
  -- ===================== WAVE 2 HOTFIX (migration 0118) ====================
  -- SQLSTATE changed 40001 -> 55000. See the migration header above for the
  -- full rationale (live-DEV evidence, class-40 retry ambiguity, and the
  -- 0084/0090 precedent for 55000 in this exact codebase). The message text,
  -- the detection logic and every other branch are unchanged.
  if v_matched <> v_supplied then
    raise exception 'admin_reorder_related_content: the related items have changed since this list was loaded (% of % supplied ids are not current links of this Resource).',
      v_supplied - v_matched, v_supplied
      using errcode = '55000';
  end if;

  -- A payload that omits an existing link would strand that link at its old
  -- position and break contiguity, so a partial reorder is rejected rather
  -- than half-applied.
  if v_existing <> v_supplied then
    raise exception 'admin_reorder_related_content: the related items have changed since this list was loaded (% supplied, % currently linked).',
      v_supplied, v_existing
      using errcode = '55000';
  end if;
  -- =================== END WAVE 2 HOTFIX (migration 0118) ==================

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

comment on function public.admin_reorder_related_content(uuid, uuid[]) is
  'Admin A0.2 Wave 2 (Scope A). Atomically reorders the Related Content links of ONE source Resource. '
  'INVARIANT: the payload is the COMPLETE ordered set of that source''s existing links — every link exactly once, '
  'no foreign or unknown ids — and the resulting sort_order values are zero-based, unique and contiguous (0..n-1). '
  'Never creates, deletes or relinks a relationship; it only permutes sort_order. Succeeds completely or changes nothing. '
  'Concurrent reorders of the same source are serialised by a transaction-scoped advisory lock plus row locks, so the '
  'committed state is always one complete ordering, never a blend. '
  'SECURITY: privileged-RPC Pattern A (caller-context). Called with the administrator''s own authenticated session; '
  'EXECUTE granted to authenticated only (revoked from public, anon and service_role); the actor is auth.uid() and can '
  'never be supplied by a caller; a null auth.uid() fails closed; and the function independently rechecks '
  'private.can_manage_discovery(auth.uid()) against the canonical role tables, so an unauthorised role is refused here '
  'even if it bypasses the API route. The route''s own canManageDiscovery() check remains as defence in depth. '
  'Errors: SQLSTATE 42501 = not authenticated or not permitted, 22023 = invalid payload, '
  'P0002 = source Resource not found, 55000 = the link set changed since the client loaded it (refresh and retry) — '
  'changed from 40001 by migration 0118 (Class 40 serialization_failure risked being treated as retryable by a layer '
  'in the stack; 55000 object_not_in_prerequisite_state is outside that family and matches this codebase''s own '
  'precedent in 0084/0090 for the same kind of state-conflict error). '
  'Replaces the previous non-atomic Promise.all of independent UPDATEs in lib/resources/discovery/relatedAdmin.ts.';
