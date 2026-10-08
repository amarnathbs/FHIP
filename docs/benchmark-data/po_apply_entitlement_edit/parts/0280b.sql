
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
