
-- ===========================================================================
-- 4. Approve (now also approves a revision), revoke, cancel or reject a revision
-- ===========================================================================
-- Approve gains one optional argument, so the previous three-argument function is dropped first (a second
-- function with default arguments would make every named call ambiguous). The rollback file puts it back.
drop function if exists public.approve_benchmark_entitlement(uuid, text, boolean);

-- Approve a DRAFT, or approve a REVISION. Approving a revision is ONE transaction:
--   the revision becomes approved and the original becomes superseded (status revoked, superseded_at set).
-- The revision is approved first, so at no step inside the transaction does the benchmark have no approved record,
-- and no other session sees any step before the commit. Separation of duties is unchanged: the proposer approves
-- only with an explicit self-approval acknowledgement.
create or replace function public.approve_benchmark_entitlement(p_id uuid, p_note text, p_self_approval_ack boolean default false, p_expected_edit_count integer default null)
returns void language plpgsql security definer set search_path = public as $fn$
declare
  v_uid uuid := auth.uid();
  e public.ii_benchmark_entitlements;
  o public.ii_benchmark_entitlements;
  v_orig uuid;
begin
  if v_uid is null or not public.is_benchmark_entitlement_approver() then
    raise exception using errcode = '42501', message = 'benchmark entitlement: approver capability required';
  end if;
  select supersedes_entitlement_id into v_orig from public.ii_benchmark_entitlements where id = p_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'benchmark entitlement: not found';
  end if;
  -- Lock order is always the original first, then the revision, which is also the order the revoke function uses.
  if v_orig is not null then
    select * into o from public.ii_benchmark_entitlements where id = v_orig for update;
  end if;
  select * into e from public.ii_benchmark_entitlements where id = p_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'benchmark entitlement: not found';
  end if;
  if e.status <> 'draft' then
    raise exception using errcode = '55000', message = 'benchmark entitlement: only a draft can be approved (is ' || e.status || ')';
  end if;
  if p_expected_edit_count is not null and p_expected_edit_count <> e.edit_count then
    raise exception using errcode = '40001', message = 'benchmark entitlement: this record was changed after you opened it. Reload and review it again before approving.';
  end if;
  if e.created_by = v_uid and p_self_approval_ack is not true then
    raise exception using errcode = '42501', message = 'benchmark entitlement: separation of duties - the proposer may approve only with an explicit self-approval acknowledgement';
  end if;
  if v_orig is null then
    update public.ii_benchmark_entitlements
       set status = 'approved', approved_by = v_uid, approved_at = now(), self_approved = (e.created_by = v_uid)
     where id = p_id;
    perform public.ii_bm_log_event('entitlement_approved', 'ii_benchmark_entitlements', p_id, to_jsonb(e), jsonb_build_object('self_approved', e.created_by = v_uid), p_note);
    return;
  end if;
  if o.status <> 'approved' or o.superseded_at is not null then
    raise exception using errcode = '55000', message = 'benchmark entitlement: the record this revision would replace is no longer in force. Cancel this revision and propose a new record if one is still needed.';
  end if;
  update public.ii_benchmark_entitlements
     set status = 'approved', approved_by = v_uid, approved_at = now(), self_approved = (e.created_by = v_uid)
   where id = p_id;
  update public.ii_benchmark_entitlements
     set status = 'revoked', revoked_by = v_uid, revoked_at = now(),
         revoked_reason = 'Superseded by an approved revision', superseded_by = p_id, superseded_at = now()
   where id = v_orig;
  perform public.ii_bm_log_event('entitlement_revision_approved', 'ii_benchmark_entitlements', p_id,
    public.ii_bm_entitlement_editable(o),
    public.ii_bm_entitlement_editable(e) || jsonb_build_object('revision_reason', e.revision_reason, 'self_approved', e.created_by = v_uid), p_note);
  perform public.ii_bm_log_event('entitlement_superseded', 'ii_benchmark_entitlements', v_orig,
    public.ii_bm_entitlement_editable(o), jsonb_build_object('superseded_by', p_id), p_note);
end $fn$;

-- Revoke keeps its arguments and behaviour. New: an open revision of the revoked record is closed in the same
-- transaction, so a revoked licence cannot be brought back by approving a revision made earlier.
create or replace function public.revoke_benchmark_entitlement(p_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $fn$
declare
  v_uid uuid := auth.uid();
  e public.ii_benchmark_entitlements;
  r record;
begin
  if v_uid is null or not public.is_benchmark_entitlement_approver() then
    raise exception using errcode = '42501', message = 'benchmark entitlement: approver capability required';
  end if;
  if p_reason is null or length(trim(p_reason)) < 10 then
    raise exception using errcode = '22023', message = 'benchmark entitlement: a revocation reason of at least 10 characters is required';
  end if;
  select * into e from public.ii_benchmark_entitlements where id = p_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'benchmark entitlement: not found';
  end if;
  if e.status = 'revoked' then return; end if;
  update public.ii_benchmark_entitlements set status = 'revoked', revoked_by = v_uid, revoked_at = now(), revoked_reason = trim(p_reason) where id = p_id;
  perform public.ii_bm_log_event('entitlement_revoked', 'ii_benchmark_entitlements', p_id, to_jsonb(e), null, p_reason);
  for r in select id from public.ii_benchmark_entitlements where supersedes_entitlement_id = p_id and status = 'draft' for update loop
    update public.ii_benchmark_entitlements
       set status = 'revoked', revoked_by = v_uid, revoked_at = now(),
           revoked_reason = 'Closed because the record it would replace was revoked: ' || trim(p_reason)
     where id = r.id;
    perform public.ii_bm_log_event('entitlement_revision_closed', 'ii_benchmark_entitlements', r.id, null, null, 'The record this revision would replace was revoked');
  end loop;
end $fn$;

-- Cancel (by the person who proposed it) or reject (by an approver) an OPEN revision. The original is untouched.
create or replace function public.close_benchmark_entitlement_revision(p_id uuid, p_mode text, p_reason text) returns void
language plpgsql security definer set search_path = public as $fn$
declare
  v_uid uuid := auth.uid();
  e public.ii_benchmark_entitlements;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'benchmark entitlement: sign in required';
  end if;
  if p_mode is distinct from 'cancel' and p_mode is distinct from 'reject' then
    raise exception using errcode = '22023', message = 'benchmark entitlement: the mode must be cancel or reject';
  end if;
  if p_mode = 'reject' and not public.is_benchmark_entitlement_approver() then
    raise exception using errcode = '42501', message = 'benchmark entitlement: approver capability required to reject a revision';
  end if;
  if p_mode = 'cancel' and not public.is_benchmark_catalogue_admin() then
    raise exception using errcode = '42501', message = 'benchmark entitlement: catalogue admin capability required to cancel a revision';
  end if;
  if p_reason is null or length(trim(p_reason)) < 10 then
    raise exception using errcode = '22023', message = 'benchmark entitlement: a reason of at least 10 characters is required';
  end if;
  select * into e from public.ii_benchmark_entitlements where id = p_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'benchmark entitlement: not found';
  end if;
  if e.supersedes_entitlement_id is null or e.status <> 'draft' then
    raise exception using errcode = '55000', message = 'benchmark entitlement: only an open revision can be cancelled or rejected';
  end if;
  if p_mode = 'cancel' and e.created_by <> v_uid then
    raise exception using errcode = '42501', message = 'benchmark entitlement: only the person who proposed this revision can cancel it. An approver can reject it.';
  end if;
  update public.ii_benchmark_entitlements
     set status = 'revoked', revoked_by = v_uid, revoked_at = now(), revoked_reason = trim(p_reason)
   where id = p_id;
  perform public.ii_bm_log_event(case when p_mode = 'cancel' then 'entitlement_revision_cancelled' else 'entitlement_revision_rejected' end,
    'ii_benchmark_entitlements', p_id, public.ii_bm_entitlement_editable(e), null, trim(p_reason));
end $fn$;

-- ===========================================================================
-- 5. Grants (same pattern as the other entitlement functions)
-- ===========================================================================
revoke all on function public.update_benchmark_entitlement_draft(uuid, jsonb, integer) from public, anon;
grant execute on function public.update_benchmark_entitlement_draft(uuid, jsonb, integer) to authenticated;
revoke all on function public.propose_benchmark_entitlement_revision(uuid, jsonb, text) from public, anon;
grant execute on function public.propose_benchmark_entitlement_revision(uuid, jsonb, text) to authenticated;
revoke all on function public.approve_benchmark_entitlement(uuid, text, boolean, integer) from public, anon;
grant execute on function public.approve_benchmark_entitlement(uuid, text, boolean, integer) to authenticated;
revoke all on function public.revoke_benchmark_entitlement(uuid, text) from public, anon;
grant execute on function public.revoke_benchmark_entitlement(uuid, text) to authenticated;
revoke all on function public.close_benchmark_entitlement_revision(uuid, text, text) from public, anon;
grant execute on function public.close_benchmark_entitlement_revision(uuid, text, text) to authenticated;
