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
