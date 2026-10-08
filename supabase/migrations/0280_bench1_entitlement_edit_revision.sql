-- 0280 -- Market Index Data: edit a benchmark entitlement record without creating a duplicate (PO request 08/10/2026).
--
-- WHY
--   Until now an entitlement record was frozen once approved. To change a right the administrator had to propose
--   a second record, which left two approved records for one benchmark (the rights of all approved records are
--   combined with OR). The Product Owner asked for an edit option so that no duplicate arises, and so that a
--   mistake is rectified and approved again.
--
-- WHAT THIS ADDS
--   1. A DRAFT can be edited in place by the person who proposed it. Every save is written to the audit trail.
--   2. An APPROVED record is edited by proposing ONE open REVISION linked to it. The revision starts as a copy,
--      needs a reason, and grants nothing until it is approved. The original keeps granting exactly as before
--      until that moment, so there is no gap in the rights.
--   3. Approving a revision, in ONE transaction, approves the revision and closes the original as superseded.
--      The original is kept (never deleted) and stays visible in the history.
--   4. A revision can be cancelled by its proposer or rejected by an approver. The original is untouched.
--   5. At most one open revision per record, enforced by a unique index.
--   6. An optional edit counter so that approving a record that was changed after it was opened is refused.
--
-- HOW A SUPERSEDED RECORD IS REPRESENTED (no shared check list is widened)
--   The status list of the table is not touched. A superseded original is stored with status revoked plus the
--   new superseded_at and superseded_by columns, and a new check makes it impossible to have superseded_at set
--   while the status is still approved. Every existing reader (the rights evaluator, the entitled actions
--   function, the series read policy, the publish gates and the application code) already ignores a revoked
--   record, so a superseded record can never grant a right, even to code written before this migration.
--
-- WHAT THIS DOES NOT DO
--   It drops and recreates no check constraint, widens no shared list, creates no capability, grants no right
--   and changes no existing record. Drafts are edited with the existing catalogue capability (the one that
--   proposes). Revisions are approved with the existing approver capability. The audit trail is the existing
--   append-only governance event log, which has no list of allowed event types, so there is nothing to widen.
--   One function is replaced with an extra optional argument (approve_benchmark_entitlement) and one is
--   replaced with the same arguments (revoke_benchmark_entitlement, which now also closes an open revision).
--
-- ROLLBACK: docs/benchmark-data/po_apply_entitlement_edit/rollback.sql. All statements here are safe to run twice.
--
-- HAND-RUN SAFETY: ASCII only, no bare dollar quote, no percent sign, no double quote, no semicolon or quote
-- inside a comment, no statement word followed by a name inside a comment or a string.

do $do$ begin
  if to_regclass('public.ii_benchmark_entitlements') is null
     or to_regclass('public.ii_benchmark_governance_events') is null
     or to_regprocedure('public.ii_bm_log_event(text,text,uuid,jsonb,jsonb,text)') is null
     or to_regprocedure('public.is_benchmark_catalogue_admin()') is null
     or to_regprocedure('public.is_benchmark_entitlement_approver()') is null then
    raise exception 'entitlement edit needs migration 0241 (benchmark data governance) to be applied first';
  end if;
end $do$;

-- ===========================================================================
-- 1. Columns, checks and indexes (additive)
-- ===========================================================================
alter table public.ii_benchmark_entitlements add column if not exists supersedes_entitlement_id uuid references public.ii_benchmark_entitlements (id);
alter table public.ii_benchmark_entitlements add column if not exists superseded_by uuid references public.ii_benchmark_entitlements (id);
alter table public.ii_benchmark_entitlements add column if not exists superseded_at timestamptz;
alter table public.ii_benchmark_entitlements add column if not exists revision_reason text;
alter table public.ii_benchmark_entitlements add column if not exists edit_count integer not null default 0;
alter table public.ii_benchmark_entitlements add column if not exists last_edited_at timestamptz;

comment on column public.ii_benchmark_entitlements.supersedes_entitlement_id is 'BENCH-1: set on a REVISION, the approved record it will replace once approved.';
comment on column public.ii_benchmark_entitlements.superseded_by is 'BENCH-1: set on an original once its revision was approved. A superseded record has status revoked and never grants a right.';
comment on column public.ii_benchmark_entitlements.superseded_at is 'BENCH-1: when the original was replaced by its approved revision.';
comment on column public.ii_benchmark_entitlements.revision_reason is 'BENCH-1: why a revision was proposed (at least 10 characters).';
comment on column public.ii_benchmark_entitlements.edit_count is 'BENCH-1: number of in-place edits of a draft. Approve can insist the approver saw the latest edit.';

do $do$ begin
  if not exists (select 1 from pg_constraint where conname = 'ii_benchmark_entitlements_superseded_pair' and conrelid = 'public.ii_benchmark_entitlements'::regclass) then
    alter table public.ii_benchmark_entitlements add constraint ii_benchmark_entitlements_superseded_pair
      check ((superseded_at is null) = (superseded_by is null));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'ii_benchmark_entitlements_superseded_is_closed' and conrelid = 'public.ii_benchmark_entitlements'::regclass) then
    alter table public.ii_benchmark_entitlements add constraint ii_benchmark_entitlements_superseded_is_closed
      check (superseded_at is null or status = 'revoked');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'ii_benchmark_entitlements_revision_reason' and conrelid = 'public.ii_benchmark_entitlements'::regclass) then
    alter table public.ii_benchmark_entitlements add constraint ii_benchmark_entitlements_revision_reason
      check (supersedes_entitlement_id is null or length(trim(coalesce(revision_reason, ''))) >= 10);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'ii_benchmark_entitlements_no_self_link' and conrelid = 'public.ii_benchmark_entitlements'::regclass) then
    alter table public.ii_benchmark_entitlements add constraint ii_benchmark_entitlements_no_self_link
      check (supersedes_entitlement_id is distinct from id and superseded_by is distinct from id);
  end if;
end $do$;

-- At most ONE open revision per record. A revision is open while it is a draft that points at its original.
create unique index if not exists uq_ii_benchmark_entitlements_one_open_revision
  on public.ii_benchmark_entitlements (supersedes_entitlement_id)
  where supersedes_entitlement_id is not null and status = 'draft';
-- A record is superseded by at most one revision.
create unique index if not exists uq_ii_benchmark_entitlements_superseded_by
  on public.ii_benchmark_entitlements (superseded_by)
  where superseded_by is not null;
create index if not exists idx_ii_benchmark_entitlements_supersedes
  on public.ii_benchmark_entitlements (supersedes_entitlement_id)
  where supersedes_entitlement_id is not null;

-- ===========================================================================
-- 2. Internal helpers (not callable by API roles)
-- ===========================================================================
-- The fields an administrator can edit, as one json value. Used for the audit before and after images
-- and to refuse a save that changes nothing. It never contains a person or a user id.
create or replace function public.ii_bm_entitlement_editable(e public.ii_benchmark_entitlements)
returns jsonb language sql stable set search_path = public as $fn$
  select jsonb_build_object(
    'benchmark_id', e.benchmark_id,
    'source_id', e.source_id,
    'entitlement_kind', e.entitlement_kind,
    'allow_manual_ingest', e.allow_manual_ingest,
    'allow_automation', e.allow_automation,
    'allow_storage', e.allow_storage,
    'allow_calculation', e.allow_calculation,
    'allow_customer_display', e.allow_customer_display,
    'allow_report_export', e.allow_report_export,
    'data_from', e.data_from,
    'data_to', e.data_to,
    'valid_from', e.valid_from,
    'valid_to', e.valid_to,
    'post_expiry_storage', e.post_expiry_storage,
    'post_expiry_calculation', e.post_expiry_calculation,
    'post_expiry_display', e.post_expiry_display,
    'evidence_reference', e.evidence_reference,
    'evidence_url', e.evidence_url,
    'evidence_document_date', e.evidence_document_date,
    'evidence_retrieved_at', e.evidence_retrieved_at,
    'attribution_text', e.attribution_text,
    'notes', e.notes);
$fn$;

-- The submitted fields as the same json shape, after the same catalogue checks the propose function makes.
-- p_fixed_benchmark is set for a revision, which keeps the benchmark of the record it replaces.
create or replace function public.ii_bm_entitlement_normalise(p jsonb, p_fixed_benchmark uuid, p_current_source uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $fn$
declare
  b public.ii_benchmarks;
  v_bid uuid;
begin
  v_bid := coalesce(p_fixed_benchmark, nullif(p ->> 'benchmark_id', '')::uuid);
  if p_fixed_benchmark is not null and nullif(p ->> 'benchmark_id', '') is not null and (p ->> 'benchmark_id')::uuid <> p_fixed_benchmark then
    raise exception using errcode = '22023', message = 'benchmark entitlement: a revision keeps the benchmark of the record it replaces. To cover another benchmark, propose a new record.';
  end if;
  select * into b from public.ii_benchmarks where id = v_bid;
  if not found then
    raise exception using errcode = '22023', message = 'benchmark entitlement: unknown benchmark';
  end if;
  if b.return_variant is null or b.currency_code is null then
    raise exception using errcode = '22023', message = 'benchmark entitlement: the catalogue row has no declared variant or currency. Complete the catalogue entry first.';
  end if;
  if (p ->> 'return_variant') is distinct from b.return_variant or (p ->> 'currency_code') is distinct from b.currency_code::text then
    raise exception using errcode = '22023', message = 'benchmark entitlement: the variant and currency must equal the catalogue row (' || b.return_variant || ' and ' || b.currency_code::text || ')';
  end if;
  return jsonb_build_object(
    'benchmark_id', b.id,
    'source_id', coalesce(nullif(p ->> 'source_id', '')::uuid, p_current_source),
    'entitlement_kind', p ->> 'entitlement_kind',
    'allow_manual_ingest', coalesce((p ->> 'allow_manual_ingest')::boolean, false),
    'allow_automation', coalesce((p ->> 'allow_automation')::boolean, false),
    'allow_storage', coalesce((p ->> 'allow_storage')::boolean, false),
    'allow_calculation', coalesce((p ->> 'allow_calculation')::boolean, false),
    'allow_customer_display', coalesce((p ->> 'allow_customer_display')::boolean, false),
    'allow_report_export', coalesce((p ->> 'allow_report_export')::boolean, false),
    'data_from', nullif(p ->> 'data_from', '')::date,
    'data_to', nullif(p ->> 'data_to', '')::date,
    'valid_from', (p ->> 'valid_from')::date,
    'valid_to', nullif(p ->> 'valid_to', '')::date,
    'post_expiry_storage', coalesce(p ->> 'post_expiry_storage', 'unknown'),
    'post_expiry_calculation', coalesce((p ->> 'post_expiry_calculation')::boolean, false),
    'post_expiry_display', coalesce((p ->> 'post_expiry_display')::boolean, false),
    'evidence_reference', p ->> 'evidence_reference',
    'evidence_url', nullif(p ->> 'evidence_url', ''),
    'evidence_document_date', nullif(p ->> 'evidence_document_date', '')::date,
    'evidence_retrieved_at', nullif(p ->> 'evidence_retrieved_at', '')::date,
    'attribution_text', nullif(p ->> 'attribution_text', ''),
    'notes', nullif(p ->> 'notes', ''));
end $fn$;

revoke all on function public.ii_bm_entitlement_editable(public.ii_benchmark_entitlements) from public, anon, authenticated;
revoke all on function public.ii_bm_entitlement_normalise(jsonb, uuid, uuid) from public, anon, authenticated;

-- ===========================================================================
-- 3. Edit a draft in place, and propose a revision of an approved record
-- ===========================================================================
-- Edit a DRAFT (a plain draft, or an open revision) in place. Only the person who proposed it, and only
-- while it is still a draft. Each save is audited with the fields before and after. A save that changes
-- nothing is refused. p_expected_edit_count, when given, must match the record, so a stale screen cannot overwrite.
create or replace function public.update_benchmark_entitlement_draft(p_id uuid, p jsonb, p_expected_edit_count integer default null)
returns integer language plpgsql security definer set search_path = public as $fn$
declare
  v_uid uuid := auth.uid();
  e public.ii_benchmark_entitlements;
  b public.ii_benchmarks;
  n jsonb;
  v_reason text;
  v_is_revision boolean;
  v_before jsonb;
  v_after jsonb;
begin
  if v_uid is null or not public.is_benchmark_catalogue_admin() then
    raise exception using errcode = '42501', message = 'benchmark entitlement: catalogue admin capability required';
  end if;
  select * into e from public.ii_benchmark_entitlements where id = p_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'benchmark entitlement: not found';
  end if;
  if e.status <> 'draft' then
    raise exception using errcode = '55000', message = 'benchmark entitlement: only a draft can be edited in place. To change an approved record, propose a revision.';
  end if;
  if e.created_by <> v_uid then
    raise exception using errcode = '42501', message = 'benchmark entitlement: only the person who proposed this draft can edit it';
  end if;
  if p_expected_edit_count is not null and p_expected_edit_count <> e.edit_count then
    raise exception using errcode = '40001', message = 'benchmark entitlement: this draft was changed after you opened it. Reload and try again.';
  end if;
  v_is_revision := e.supersedes_entitlement_id is not null;
  n := public.ii_bm_entitlement_normalise(p, case when v_is_revision then e.benchmark_id else null end, e.source_id);
  v_reason := e.revision_reason;
  if v_is_revision and nullif(trim(coalesce(p ->> 'revision_reason', '')), '') is not null then
    if length(trim(p ->> 'revision_reason')) < 10 then
      raise exception using errcode = '22023', message = 'benchmark entitlement: the reason for a revision must be at least 10 characters';
    end if;
    v_reason := trim(p ->> 'revision_reason');
  end if;
  if n = public.ii_bm_entitlement_editable(e) and v_reason is not distinct from e.revision_reason then
    raise exception using errcode = '22023', message = 'benchmark entitlement: nothing was changed';
  end if;
  select * into b from public.ii_benchmarks where id = (n ->> 'benchmark_id')::uuid;
  v_before := public.ii_bm_entitlement_editable(e);
  v_after := n;
  if v_is_revision then
    v_before := v_before || jsonb_build_object('revision_reason', e.revision_reason);
    v_after := v_after || jsonb_build_object('revision_reason', v_reason);
  end if;
  update public.ii_benchmark_entitlements set
    benchmark_id = b.id,
    source_id = (n ->> 'source_id')::uuid,
    entitlement_kind = n ->> 'entitlement_kind',
    return_variant = b.return_variant,
    currency_code = b.currency_code,
    allow_manual_ingest = (n ->> 'allow_manual_ingest')::boolean,
    allow_automation = (n ->> 'allow_automation')::boolean,
    allow_storage = (n ->> 'allow_storage')::boolean,
    allow_calculation = (n ->> 'allow_calculation')::boolean,
    allow_customer_display = (n ->> 'allow_customer_display')::boolean,
    allow_report_export = (n ->> 'allow_report_export')::boolean,
    data_from = (n ->> 'data_from')::date,
    data_to = (n ->> 'data_to')::date,
    valid_from = (n ->> 'valid_from')::date,
    valid_to = (n ->> 'valid_to')::date,
    post_expiry_storage = n ->> 'post_expiry_storage',
    post_expiry_calculation = (n ->> 'post_expiry_calculation')::boolean,
    post_expiry_display = (n ->> 'post_expiry_display')::boolean,
    evidence_reference = n ->> 'evidence_reference',
    evidence_url = n ->> 'evidence_url',
    evidence_document_date = (n ->> 'evidence_document_date')::date,
    evidence_retrieved_at = (n ->> 'evidence_retrieved_at')::date,
    attribution_text = n ->> 'attribution_text',
    notes = n ->> 'notes',
    revision_reason = v_reason,
    edit_count = e.edit_count + 1,
    last_edited_at = now()
  where id = p_id;
  perform public.ii_bm_log_event(
    case when v_is_revision then 'entitlement_revision_edited' else 'entitlement_draft_edited' end,
    'ii_benchmark_entitlements', p_id, v_before, v_after, null);
  return e.edit_count + 1;
end $fn$;

-- Propose ONE open revision of an APPROVED record. The original keeps granting until the revision is approved.
create or replace function public.propose_benchmark_entitlement_revision(p_original uuid, p jsonb, p_reason text)
returns uuid language plpgsql security definer set search_path = public as $fn$
declare
  v_uid uuid := auth.uid();
  o public.ii_benchmark_entitlements;
  b public.ii_benchmarks;
  n jsonb;
  v_id uuid;
begin
  if v_uid is null or not public.is_benchmark_catalogue_admin() then
    raise exception using errcode = '42501', message = 'benchmark entitlement: catalogue admin capability required';
  end if;
  if p_reason is null or length(trim(p_reason)) < 10 then
    raise exception using errcode = '22023', message = 'benchmark entitlement: the reason for a revision must be at least 10 characters';
  end if;
  select * into o from public.ii_benchmark_entitlements where id = p_original for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'benchmark entitlement: not found';
  end if;
  if o.status <> 'approved' then
    raise exception using errcode = '55000', message = 'benchmark entitlement: only an approved record can be revised. Edit a draft directly.';
  end if;
  if exists (select 1 from public.ii_benchmark_entitlements r where r.supersedes_entitlement_id = p_original and r.status = 'draft') then
    raise exception using errcode = '55000', message = 'benchmark entitlement: a revision of this record is already open. Edit it, or cancel it before proposing another.';
  end if;
  n := public.ii_bm_entitlement_normalise(p, o.benchmark_id, o.source_id);
  if n = public.ii_bm_entitlement_editable(o) then
    raise exception using errcode = '22023', message = 'benchmark entitlement: nothing was changed, so there is nothing to revise';
  end if;
  select * into b from public.ii_benchmarks where id = o.benchmark_id;
  insert into public.ii_benchmark_entitlements (
    benchmark_id, source_id, entitlement_kind, return_variant, currency_code,
    allow_manual_ingest, allow_automation, allow_storage, allow_calculation, allow_customer_display, allow_report_export,
    data_from, data_to, valid_from, valid_to, post_expiry_storage, post_expiry_calculation, post_expiry_display,
    evidence_reference, evidence_url, evidence_document_date, evidence_retrieved_at, attribution_text, notes,
    created_by, supersedes_entitlement_id, revision_reason)
  values (
    b.id, (n ->> 'source_id')::uuid, n ->> 'entitlement_kind', b.return_variant, b.currency_code,
    (n ->> 'allow_manual_ingest')::boolean, (n ->> 'allow_automation')::boolean, (n ->> 'allow_storage')::boolean,
    (n ->> 'allow_calculation')::boolean, (n ->> 'allow_customer_display')::boolean, (n ->> 'allow_report_export')::boolean,
    (n ->> 'data_from')::date, (n ->> 'data_to')::date, (n ->> 'valid_from')::date, (n ->> 'valid_to')::date,
    n ->> 'post_expiry_storage', (n ->> 'post_expiry_calculation')::boolean, (n ->> 'post_expiry_display')::boolean,
    n ->> 'evidence_reference', n ->> 'evidence_url', (n ->> 'evidence_document_date')::date, (n ->> 'evidence_retrieved_at')::date,
    n ->> 'attribution_text', n ->> 'notes',
    v_uid, p_original, trim(p_reason))
  returning id into v_id;
  perform public.ii_bm_log_event('entitlement_revision_proposed', 'ii_benchmark_entitlements', v_id,
    public.ii_bm_entitlement_editable(o), n || jsonb_build_object('revision_reason', trim(p_reason)), trim(p_reason));
  return v_id;
end $fn$;

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
