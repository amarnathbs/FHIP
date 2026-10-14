-- Rollback of migration 0280 (edit a benchmark entitlement record). Safe to run twice.
--
-- What it does
--   1. Closes any open revision, so the earlier approve function can never approve one by mistake and leave two
--      approved records for one benchmark. The original records are not touched.
--   2. Removes the five functions that 0280 added.
--   3. Puts back the earlier approve function (three arguments) and the earlier revoke function.
-- What it keeps on purpose
--   The new columns, the checks and the unique indexes stay in place. They hold the history of which record was
--   replaced by which, they do no harm without the functions, and a record already superseded stays closed.
--   Run migration 0280 again at any time to get the edit option back.

update public.ii_benchmark_entitlements
   set status = 'revoked', revoked_by = created_by, revoked_at = now(), revoked_reason = 'Closed by the rollback of migration 0280'
 where supersedes_entitlement_id is not null and status = 'draft';

drop function if exists public.update_benchmark_entitlement_draft(uuid, jsonb, integer);
drop function if exists public.propose_benchmark_entitlement_revision(uuid, jsonb, text);
drop function if exists public.close_benchmark_entitlement_revision(uuid, text, text);
drop function if exists public.approve_benchmark_entitlement(uuid, text, boolean, integer);
drop function if exists public.ii_bm_entitlement_normalise(jsonb, uuid, uuid);
drop function if exists public.ii_bm_entitlement_editable(public.ii_benchmark_entitlements);

create or replace function public.approve_benchmark_entitlement(p_id uuid, p_note text, p_self_approval_ack boolean default false) returns void
language plpgsql security definer set search_path = public as $fn$
declare
  v_uid uuid := auth.uid();
  e public.ii_benchmark_entitlements;
begin
  if v_uid is null or not public.is_benchmark_entitlement_approver() then
    raise exception 'benchmark entitlement: approver capability required' using errcode = '42501';
  end if;
  select * into e from public.ii_benchmark_entitlements where id = p_id for update;
  if not found then raise exception 'benchmark entitlement: not found' using errcode = 'P0002'; end if;
  if e.status <> 'draft' then raise exception using errcode = '55000', message = 'benchmark entitlement: only a draft can be approved (is ' || e.status || ')'; end if;
  if e.created_by = v_uid and p_self_approval_ack is not true then
    raise exception 'benchmark entitlement: separation of duties - the proposer may approve only with an explicit self-approval acknowledgement' using errcode = '42501';
  end if;
  update public.ii_benchmark_entitlements
     set status = 'approved', approved_by = v_uid, approved_at = now(), self_approved = (e.created_by = v_uid)
   where id = p_id;
  perform public.ii_bm_log_event('entitlement_approved', 'ii_benchmark_entitlements', p_id, to_jsonb(e), jsonb_build_object('self_approved', e.created_by = v_uid), p_note);
end $fn$;
revoke all on function public.approve_benchmark_entitlement(uuid, text, boolean) from public, anon;
grant execute on function public.approve_benchmark_entitlement(uuid, text, boolean) to authenticated;

create or replace function public.revoke_benchmark_entitlement(p_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $fn$
declare
  v_uid uuid := auth.uid();
  e public.ii_benchmark_entitlements;
begin
  if v_uid is null or not public.is_benchmark_entitlement_approver() then
    raise exception 'benchmark entitlement: approver capability required' using errcode = '42501';
  end if;
  if p_reason is null or length(trim(p_reason)) < 10 then
    raise exception 'benchmark entitlement: a revocation reason of at least 10 characters is required' using errcode = '22023';
  end if;
  select * into e from public.ii_benchmark_entitlements where id = p_id for update;
  if not found then raise exception 'benchmark entitlement: not found' using errcode = 'P0002'; end if;
  if e.status = 'revoked' then return; end if;
  update public.ii_benchmark_entitlements set status = 'revoked', revoked_by = v_uid, revoked_at = now(), revoked_reason = trim(p_reason) where id = p_id;
  perform public.ii_bm_log_event('entitlement_revoked', 'ii_benchmark_entitlements', p_id, to_jsonb(e), null, p_reason);
end $fn$;
revoke all on function public.revoke_benchmark_entitlement(uuid, text) from public, anon;
grant execute on function public.revoke_benchmark_entitlement(uuid, text) to authenticated;
