-- 0224 -- AIE-1 / Approved Upload -> Canonical programme, FINAL PRODUCTION
-- CLOSURE mission (PO dispatch, 2026-09-28): closes R20's two RE-CONFIRMED
-- residual provenance-forging paths (docs/financial-data-hub/
-- FINAL_COMPLETION_REPORT.md, commit 62b0120, "Stage 3 FINAL live-proof
-- pass"). Both were deliberately re-proven live on the truly final merged
-- branch and left open for a PO decision; this migration is that fix.
--
-- SCOPE. Additive/hardening only. No table is created, no column is
-- dropped, no existing legitimate write path changes shape. Both fixes are
-- `create or replace function`, each a strict superset of its predecessor's
-- behaviour for every call that was already legitimate.
--
-- ============================================================================
-- A. R20(b) -- fdh10_persist_liability_statement accepts ANY of the caller's
--    own queued documents, regardless of document class.
--
--    RE-CONFIRMED LIVE (Stage 3 FINAL pass, 2026-09-27): an ordinary,
--    unprocessed bank-CSV upload (fdh_statement_uploads.document_type =
--    'bank_statement') was successfully repurposed into a fabricated
--    $499,999.99 loan-payoff statement, via a direct call to this
--    SECURITY INVOKER RPC (granted to `authenticated`, per 0208's own grant)
--    with a hand-built p_statement payload -- no parser, no document content,
--    ever behind the numbers.
--
--    FIX. This function's whole authority rests on "the caller owns this
--    document" (0208's existing `where id = p_statement_upload_id and
--    user_id = v_user`); it never checked that the document's OWN declared
--    class is one this evidence type may legitimately come from. Predecessor:
--    0208 (the only prior definition). Strict superset: every call this
--    function already accepted from the real liability-statement processing
--    pipeline (lib/financial-data-hub/services/
--    liabilityStatementProcessingService.ts) uploads through the credit-card
--    or loan-statement document classes only (FDH10_ARCHITECTURE.md), so the
--    added check changes nothing for any legitimate caller; it only refuses
--    a document class the real pipeline never produces here.
--
--    DISCLOSED LIMIT (not closed by this file, same residual the report
--    named): this remains SECURITY INVOKER and still trusts every NUMBER in
--    p_statement/p_activities at face value for a document of the RIGHT
--    class -- i.e. a user's own genuine credit-card or loan statement upload
--    can still, in principle, be persisted with hand-edited figures rather
--    than the parser's real output, because the true parsed-extraction
--    record is not compared against the RPC's input here. Moving this to a
--    service-role path that itself re-derives the statement from the durable
--    parsed-extraction record (rather than trusting the caller's payload) is
--    the complete fix and remains a follow-up item (see the closure register,
--    R20-B row) -- out of reach in this pass without either (a) building a
--    second, SQL-side reimplementation of the deterministic parser/
--    reconciliation logic (the mission's binding architecture explicitly
--    forbids a second parser/canonical-writer gateway), or (b) restructuring
--    the persist call to run under the service role from the trusted server
--    route, which changes the calling contract and needs its own live-DEV
--    proof before being called closed. This file closes the DOCUMENT-CLASS
--    confusion exploit specifically and named, live, twice (SR-01's sibling)
--    -- not every theoretical forging path against the user's own matching
--    document.
-- ============================================================================
create or replace function public.fdh10_persist_liability_statement(
  p_statement_upload_id uuid,
  p_statement jsonb,
  p_activities jsonb
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_status text;
  v_document_type text;
  v_expected_document_type text;
  v_statement_type text;
  v_existing uuid;
  v_statement_id uuid;
  v_activity_count int;
begin
  if v_user is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED', 'error', 'not authenticated');
  end if;
  if p_statement_upload_id is null or p_statement is null or jsonb_typeof(p_statement) <> 'object' then
    return jsonb_build_object('ok', false, 'code', 'INVALID_PAYLOAD', 'error', 'statement payload must be an object');
  end if;
  if p_activities is null or jsonb_typeof(p_activities) <> 'array' then
    return jsonb_build_object('ok', false, 'code', 'INVALID_PAYLOAD', 'error', 'activities payload must be an array');
  end if;
  if p_statement ? 'extraction_warnings' and jsonb_typeof(p_statement -> 'extraction_warnings') <> 'array' then
    return jsonb_build_object('ok', false, 'code', 'INVALID_PAYLOAD', 'error', 'extraction_warnings must be an array');
  end if;

  -- Serialise concurrent persists for the same document for the rest of this
  -- transaction, so the existence check below cannot race (the unique index
  -- is the backstop).
  perform pg_advisory_xact_lock(hashtextextended('fdh10_persist_liability_statement:' || p_statement_upload_id::text, 0));

  select processing_status, document_type into v_status, v_document_type
  from fdh_statement_uploads
  where id = p_statement_upload_id and user_id = v_user;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'DOCUMENT_NOT_FOUND', 'error', 'document not found');
  end if;
  if v_status <> 'queued' then
    return jsonb_build_object('ok', false, 'code', 'INVALID_STATE', 'error', 'cannot persist while the document is ' || v_status);
  end if;

  -- NEW (0224, R20-B): the document's own declared class must be the one
  -- liability evidence may legitimately come from, and it must match the
  -- specific statement_type being persisted (a credit-card document cannot
  -- become a 'loan' statement or vice versa). Closes the disclosed live
  -- exploit: repurposing an unrelated (e.g. plain bank-statement) upload
  -- into fabricated liability evidence.
  v_statement_type := p_statement ->> 'statement_type';
  v_expected_document_type := case v_statement_type
    when 'credit_card' then 'credit_card_statement'
    when 'loan' then 'loan_statement'
    else null
  end;
  if v_expected_document_type is null then
    return jsonb_build_object('ok', false, 'code', 'INVALID_PAYLOAD', 'error', 'statement_type must be credit_card or loan');
  end if;
  if v_document_type is distinct from v_expected_document_type then
    return jsonb_build_object(
      'ok', false, 'code', 'DOCUMENT_TYPE_MISMATCH',
      'error', 'This document is not a ' || v_expected_document_type || '; liability evidence was refused.',
      'document_type', v_document_type, 'expected_document_type', v_expected_document_type
    );
  end if;

  select id into v_existing
  from fdh_liability_statements
  where statement_upload_id = p_statement_upload_id and user_id = v_user
  limit 1;
  if v_existing is not null then
    return jsonb_build_object('ok', false, 'code', 'EVIDENCE_EXISTS', 'error', 'statement evidence already exists for this document', 'statement_id', v_existing);
  end if;

  -- Closed column list: approval, review-workflow, ledger, duplicate and
  -- correction-provenance columns cannot be set through this function.
  insert into fdh_liability_statements (
    user_id, statement_upload_id, statement_type, facility_type, country_code, currency_code,
    institution_name, masked_identifier,
    statement_period_start, statement_period_end, statement_date, due_date,
    opening_balance, closing_balance, credit_limit, minimum_payment,
    opening_principal, closing_principal, interest_rate,
    purchases_total, cash_advances_total, interest_total, fees_total, payments_total,
    refunds_total, adjustments_total, drawdowns_total, capitalised_total, principal_repayments_total,
    reconciliation_status, reconciliation_variance,
    parser_name, parser_version, extraction_confidence, review_status,
    extraction_warnings
  )
  select
    v_user, p_statement_upload_id, s.statement_type, s.facility_type, s.country_code, s.currency_code,
    s.institution_name, s.masked_identifier,
    s.statement_period_start, s.statement_period_end, s.statement_date, s.due_date,
    s.opening_balance, s.closing_balance, s.credit_limit, s.minimum_payment,
    s.opening_principal, s.closing_principal, s.interest_rate,
    s.purchases_total, s.cash_advances_total, s.interest_total, s.fees_total, s.payments_total,
    s.refunds_total, s.adjustments_total, s.drawdowns_total, s.capitalised_total, s.principal_repayments_total,
    coalesce(s.reconciliation_status, 'insufficient_data'), s.reconciliation_variance,
    s.parser_name, s.parser_version, s.extraction_confidence, coalesce(s.review_status, 'not_required'),
    coalesce(p_statement -> 'extraction_warnings', '[]'::jsonb)
  from jsonb_populate_record(null::fdh_liability_statements, p_statement) s
  returning id into v_statement_id;

  insert into fdh_liability_statement_activities (
    user_id, statement_id, activity_type, activity_date, amount, currency_code,
    description_raw, merchant_raw, principal_component, interest_component, fee_component,
    linked_transaction_id, bank_match_status, review_status, source_row_number,
    gst_amount_raw, bank_match_candidate_ids
  )
  select
    v_user, v_statement_id, a.activity_type, a.activity_date, a.amount, a.currency_code,
    a.description_raw, a.merchant_raw, a.principal_component, a.interest_component, a.fee_component,
    a.linked_transaction_id, coalesce(a.bank_match_status, 'not_attempted'), coalesce(a.review_status, 'not_required'),
    a.source_row_number,
    a.gst_amount_raw, a.bank_match_candidate_ids
  from jsonb_populate_recordset(null::fdh_liability_statement_activities, p_activities) a;
  get diagnostics v_activity_count = row_count;

  -- Two legal edges of 0076's transition guard, never the illegal direct
  -- `queued -> extracted` jump.
  update fdh_statement_uploads
  set processing_status = 'processing'
  where id = p_statement_upload_id and user_id = v_user;
  update fdh_statement_uploads
  set processing_status = 'extracted', error_code = null, processing_completed_at = now()
  where id = p_statement_upload_id and user_id = v_user;

  return jsonb_build_object('ok', true, 'statement_id', v_statement_id, 'activity_count', v_activity_count);
end;
$$;

revoke all on function public.fdh10_persist_liability_statement(uuid, jsonb, jsonb) from public;
revoke all on function public.fdh10_persist_liability_statement(uuid, jsonb, jsonb) from anon;
grant execute on function public.fdh10_persist_liability_statement(uuid, jsonb, jsonb) to authenticated, service_role;


-- ============================================================================
-- B. R20(a) -- WP-15 "update your planned expenses from your actual
--    spending" apply RPC trusts the proposal's proposed amount at face
--    value, with no re-derivation from real evidence.
--
--    RE-CONFIRMED LIVE (Stage 3 FINAL pass, 2026-09-27): a hand-crafted
--    fhip_import_proposals/fhip_import_proposal_fields row (target_domain
--    'expense', source_kind 'bank_statement', proposed amount 999999.99/
--    month) with NO real transaction behind it was successfully applied via
--    fdh15_apply_expense_proposals.
--
--    WHY DIRECT INSERT ITSELF IS NOT THE PART CLOSED HERE. 0091 Part D
--    deliberately kept ordinary authenticated INSERT open on
--    fhip_import_proposals/fhip_import_proposal_fields ("a freshly generated
--    proposal is inert... creating one is not the defect this part closes"):
--    a proposal has zero canonical effect until Applied. The authority this
--    programme relies on for every other WP-15/FDH-9/FDH-10 domain lives at
--    APPLY, inside the SECURITY DEFINER function -- and this is the one
--    place that authority was missing a check.
--
--    FIX. fdh15_apply_one_expense_proposal (0214, the only prior
--    definition) now refuses to apply an 'amount' field for a
--    target_domain='expense'/source_kind='bank_statement' proposal unless
--    the user has at least one of their own APPROVED bank-derived expense
--    transaction inside the proposal's own source window, and the proposed
--    monthly figure does not exceed the user's TOTAL real approved expense
--    spend across that whole window.
--
--    WHY THE CEILING IS SAFE FOR EVERY LEGITIMATE PROPOSAL (no new
--    false refusals). The real generator (lib/import-bridge/
--    populationProposals.ts) always proposes a MONTHLY figure (frequency is
--    hard-coded 'monthly' for this source_kind) equal to the trailing
--    covered-month average of ONE canonical category's real spending. A
--    single category's monthly average, over a window of >= 1 covered
--    month, can never exceed the user's TOTAL real approved expense spend
--    across the same window -- so this bound is mathematically incapable of
--    rejecting a genuinely-generated proposal, only a fabricated one with
--    materially more (or zero) evidence than the user's real spending
--    supports.
--
--    DISCLOSED LIMIT (not a full re-derivation, by design). This is a
--    bound/existence check, not a reimplementation of the TS engine's
--    category mapping, FX conversion, coverage-window or refund-netting
--    logic in SQL -- doing that here would itself be the "second,
--    independent... downstream calculation source" the mission's binding
--    architecture explicitly forbids (lib/import-bridge/
--    expenseCategoryMapping.ts is a static TS table with no DB mirror, and
--    duplicating it into SQL would create exactly that drift risk). It
--    therefore does not detect a forged amount that happens to fall inside
--    the user's real total window spend (e.g. relabelling $50 of real
--    "other" spending as a $50 "groceries" suggestion) -- only a materially
--    evidence-free or evidence-exceeding one, which is what was reported and
--    reproduced live. It also compares same-currency evidence only
--    (fdh_transactions.currency_original = the proposal's currency_code);
--    a multi-currency household could see a legitimate proposal refused if
--    its matching real evidence is booked in a different original currency
--    to the planned item -- a false REFUSAL (safe direction: it blocks a
--    write rather than permitting a possibly-forged one) rather than a false
--    acceptance. Flagged as a follow-up in the closure register (R20-A row),
--    not closed by this file.
-- ============================================================================
create or replace function fdh15_apply_one_expense_proposal(
  p_uid uuid,
  p_proposal_id uuid,
  p_decision text,
  p_selected_fields text[]
) returns jsonb as $$
declare
  v_proposal record;
  v_row record;
  v_allowed constant text[] := array[
    'expense_name', 'master_item_key', 'expense_category', 'amount', 'frequency',
    'currency_code', 'is_essential', 'is_active', 'superseded_by_bank_import'
  ];
  v_kinds constant jsonb := jsonb_build_object(
    'expense_name', 'text', 'master_item_key', 'text', 'expense_category', 'enum', 'amount', 'money',
    'frequency', 'enum', 'currency_code', 'enum', 'is_essential', 'bool', 'is_active', 'bool',
    'superseded_by_bank_import', 'bool'
  );
  v_selected text[];
  v_forbidden text[];
  v_known text[];
  v_field record;
  v_live_text text;
  v_master_key text;
  v_set_parts text[] := array[]::text[];
  v_cols text[] := array[]::text[];
  v_vals text[] := array[]::text[];
  v_applied_fields text[] := array[]::text[];
  v_previous jsonb := '{}'::jsonb;
  v_new jsonb := '{}'::jsonb;
  v_target_id uuid;
  v_application_id uuid;
  v_kind text;
  v_lit text;
  -- NEW (0224, R20-A):
  v_proposed_amount numeric;
  v_evidence_total numeric;
  v_evidence_count int;
begin
  if p_decision is null or p_decision not in ('add_new', 'update_existing', 'apply_selected_fields', 'keep_existing') then
    return jsonb_build_object('ok', false, 'code', 'INVALID_APPLY_MODE', 'error', 'Unrecognised decision.', 'proposal_id', p_proposal_id);
  end if;

  select * into v_proposal from fhip_import_proposals where id = p_proposal_id for update;
  if not found or v_proposal.user_id <> p_uid then
    return jsonb_build_object('ok', false, 'code', 'PROPOSAL_NOT_FOUND', 'error', 'That suggestion could not be found.', 'proposal_id', p_proposal_id);
  end if;
  if v_proposal.target_domain <> 'expense' or v_proposal.source_kind <> 'bank_statement' then
    return jsonb_build_object('ok', false, 'code', 'PROPOSAL_NOT_ACTIONABLE', 'error', 'That suggestion is not a planned-expense update.', 'proposal_id', p_proposal_id);
  end if;

  if p_decision = 'keep_existing' then
    if v_proposal.status <> 'ready' then
      return jsonb_build_object('ok', false, 'code', 'PROPOSAL_NOT_ACTIONABLE', 'error', 'That suggestion is no longer open.', 'proposal_id', p_proposal_id);
    end if;
    perform set_config('fhip.import_bridge_internal_write', 'true', true);
    update fhip_import_proposals set status = 'dismissed', dismissed_at = now() where id = p_proposal_id;
    perform set_config('fhip.import_bridge_internal_write', 'false', true);
    return jsonb_build_object('ok', true, 'outcome', 'kept_existing', 'proposal_id', p_proposal_id);
  end if;

  if v_proposal.status <> 'ready' then
    return jsonb_build_object(
      'ok', false,
      'code', case when v_proposal.status = 'applied' then 'ALREADY_APPLIED' else 'PROPOSAL_NOT_ACTIONABLE' end,
      'error', case when v_proposal.status = 'applied' then 'This suggestion has already been applied to your planned expenses.' else 'That suggestion is no longer open.' end,
      'proposal_id', p_proposal_id);
  end if;
  if p_decision = 'add_new' and v_proposal.target_entity_id is not null then
    return jsonb_build_object('ok', false, 'code', 'INVALID_APPLY_MODE', 'error', 'This planned expense already exists; update it instead.', 'proposal_id', p_proposal_id);
  end if;
  if p_decision <> 'add_new' and v_proposal.target_entity_id is null then
    return jsonb_build_object('ok', false, 'code', 'INVALID_APPLY_MODE', 'error', 'There is no existing planned expense to update.', 'proposal_id', p_proposal_id);
  end if;

  if p_selected_fields is null or array_length(p_selected_fields, 1) is null then
    select array_agg(field_name) into v_selected from fhip_import_proposal_fields where proposal_id = p_proposal_id;
  else
    v_selected := p_selected_fields;
  end if;
  if v_selected is null then v_selected := array[]::text[]; end if;

  select array_agg(f) into v_forbidden from unnest(v_selected) f where not (f = any(v_allowed));
  if v_forbidden is not null and array_length(v_forbidden, 1) > 0 then
    return jsonb_build_object('ok', false, 'code', 'FORBIDDEN_FIELD', 'error', 'One or more selected fields cannot be changed by an import.', 'fields', to_jsonb(v_forbidden), 'proposal_id', p_proposal_id);
  end if;
  select array_agg(field_name) into v_known from fhip_import_proposal_fields where proposal_id = p_proposal_id;
  if v_known is null then v_known := array[]::text[]; end if;
  select array_agg(f) into v_forbidden from unnest(v_selected) f where not (f = any(v_known));
  if v_forbidden is not null and array_length(v_forbidden, 1) > 0 then
    return jsonb_build_object('ok', false, 'code', 'FORBIDDEN_FIELD', 'error', 'One or more selected fields are not part of this suggestion.', 'fields', to_jsonb(v_forbidden), 'proposal_id', p_proposal_id);
  end if;
  if array_length(v_selected, 1) is null then
    return jsonb_build_object('ok', false, 'code', 'NO_FIELDS_SELECTED', 'error', 'Choose at least one detail to apply.', 'proposal_id', p_proposal_id);
  end if;

  -- NEW (0224, R20-A): an 'amount' field on this domain/source_kind must be
  -- backed by real evidence. See file header for the exact bound and why it
  -- cannot reject a genuinely-generated proposal.
  if 'amount' = any(v_selected) then
    select pf.proposed_value::numeric into v_proposed_amount
      from fhip_import_proposal_fields pf
     where pf.proposal_id = p_proposal_id and pf.field_name = 'amount';

    select coalesce(sum(t.amount_original), 0), count(*)
      into v_evidence_total, v_evidence_count
      from fdh_transactions t
     where t.user_id = p_uid
       and t.approval_status = 'approved'
       and t.economic_transaction_type = 'expense'
       and t.currency_original = v_proposal.currency_code
       and v_proposal.source_window_from is not null
       and v_proposal.source_window_to is not null
       and t.transaction_date >= v_proposal.source_window_from
       and t.transaction_date <= v_proposal.source_window_to;

    if v_proposed_amount is null or v_evidence_count = 0 or v_evidence_total <= 0 then
      return jsonb_build_object('ok', false, 'code', 'NO_SUPPORTING_TRANSACTIONS', 'error', 'No approved bank transactions support this suggested amount, so it was not applied.', 'field', 'amount', 'proposal_id', p_proposal_id);
    end if;
    if v_proposed_amount > v_evidence_total then
      return jsonb_build_object('ok', false, 'code', 'PROVENANCE_UNVERIFIED', 'error', 'The suggested amount exceeds your real approved spending for that period and was not applied.', 'field', 'amount', 'proposal_id', p_proposal_id);
    end if;
  end if;

  if p_decision = 'add_new' then
    if not ('expense_name' = any(v_selected)) or not ('master_item_key' = any(v_selected)) or not ('amount' = any(v_selected))
       or not ('frequency' = any(v_selected)) or not ('currency_code' = any(v_selected)) then
      return jsonb_build_object('ok', false, 'code', 'DOMAIN_VALIDATION_FAILED', 'error', 'A new planned expense needs a name, an item, an amount, a frequency and a currency.', 'proposal_id', p_proposal_id);
    end if;
    select proposed_value into v_master_key from fhip_import_proposal_fields where proposal_id = p_proposal_id and field_name = 'master_item_key';
    -- Stale-safe add: a row for this item appeared since the suggestion was
    -- prepared (typed by the user, or an earlier batch). (user_id,
    -- master_item_key) is unique, inactive rows included.
    if exists (select 1 from expense_items where user_id = p_uid and master_item_key = v_master_key) then
      return jsonb_build_object('ok', false, 'code', 'STALE_PROPOSAL', 'error', 'You already have this planned expense now, so the suggestion to add it was not applied. Refresh the suggestions.', 'field', 'master_item_key', 'proposal_id', p_proposal_id);
    end if;
  else
    select * into v_row from expense_items where id = v_proposal.target_entity_id and user_id = p_uid for update;
    if not found then
      return jsonb_build_object('ok', false, 'code', 'TARGET_NOT_FOUND', 'error', 'The planned expense this suggestion refers to could not be found.', 'proposal_id', p_proposal_id);
    end if;
    if v_row.owner = 'smsf' then
      return jsonb_build_object('ok', false, 'code', 'STALE_PROPOSAL', 'error', 'That planned expense now belongs to your SMSF, so household spending was not applied to it.', 'field', 'owner', 'proposal_id', p_proposal_id);
    end if;
    for v_field in
      select pf.field_name, pf.value_kind, pf.existing_value from fhip_import_proposal_fields pf
      where pf.proposal_id = p_proposal_id and pf.field_name = any(v_selected)
    loop
      v_live_text := case v_field.field_name
        when 'expense_name'              then nullif(trim(both from coalesce(v_row.expense_name, '')), '')
        when 'master_item_key'           then nullif(trim(both from coalesce(v_row.master_item_key, '')), '')
        when 'expense_category'          then nullif(trim(both from coalesce(v_row.expense_category, '')), '')
        when 'amount'                    then case when v_row.amount is null then null else round(v_row.amount, 2)::text end
        when 'frequency'                 then nullif(trim(both from coalesce(v_row.frequency, '')), '')
        when 'currency_code'             then nullif(trim(both from coalesce(v_row.currency_code::text, '')), '')
        when 'is_essential'              then case when v_row.is_essential then 'true' else 'false' end
        when 'is_active'                 then case when v_row.is_active is false then 'false' else 'true' end
        when 'superseded_by_bank_import' then case when coalesce(v_row.superseded_by_bank_import, false) then 'true' else 'false' end
        else null
      end;
      if v_live_text is distinct from v_field.existing_value then
        return jsonb_build_object('ok', false, 'code', 'STALE_PROPOSAL',
          'error', 'Your planned expense changed after this suggestion was prepared, so it was not applied. Refresh the suggestions.',
          'field', v_field.field_name, 'existing', v_field.existing_value, 'current', v_live_text, 'proposal_id', p_proposal_id);
      end if;
      v_previous := v_previous || jsonb_build_object(v_field.field_name, v_field.existing_value);
    end loop;
  end if;

  for v_field in
    select pf.field_name, pf.proposed_value from fhip_import_proposal_fields pf
    where pf.proposal_id = p_proposal_id and pf.field_name = any(v_selected)
  loop
    v_kind := v_kinds ->> v_field.field_name;
    if v_field.proposed_value is null then
      v_lit := 'NULL';
    elsif v_kind = 'money' then
      v_lit := format('%L::numeric', v_field.proposed_value);
    elsif v_kind = 'bool' then
      v_lit := format('%L::boolean', v_field.proposed_value);
    else
      v_lit := format('%L', v_field.proposed_value);
    end if;
    v_set_parts := array_append(v_set_parts, format('%I = %s', v_field.field_name, v_lit));
    v_cols := array_append(v_cols, quote_ident(v_field.field_name));
    v_vals := array_append(v_vals, v_lit);
    v_new := v_new || jsonb_build_object(v_field.field_name, v_field.proposed_value);
    v_applied_fields := array_append(v_applied_fields, v_field.field_name);
    if p_decision = 'add_new' then
      v_previous := v_previous || jsonb_build_object(v_field.field_name, null);
    end if;
  end loop;

  perform set_config('fhip.import_bridge_internal_write', 'true', true);
  update fhip_import_proposals set status = 'applied', applied_at = now() where id = p_proposal_id and status = 'ready';
  if not found then
    perform set_config('fhip.import_bridge_internal_write', 'false', true);
    return jsonb_build_object('ok', false, 'code', 'ALREADY_APPLIED', 'error', 'This suggestion has already been applied to your planned expenses.', 'proposal_id', p_proposal_id);
  end if;

  if p_decision = 'add_new' then
    execute format('insert into expense_items (user_id, owner, is_active, %s) values (%L::uuid, %L, true, %s) returning id',
      array_to_string(v_cols, ', '), p_uid, 'self', array_to_string(v_vals, ', ')) into v_target_id;
  else
    v_target_id := v_proposal.target_entity_id;
    execute format('update expense_items set %s, updated_at = now() where id = %L::uuid and user_id = %L::uuid',
      array_to_string(v_set_parts, ', '), v_target_id, p_uid);
  end if;

  insert into fhip_import_applications (
    user_id, proposal_id, target_domain, target_entity_id, apply_mode,
    applied_fields, previous_values, new_values, source_statement_upload_id, applied_by
  ) values (
    p_uid, p_proposal_id, 'expense', v_target_id, p_decision,
    to_jsonb(v_applied_fields), v_previous, v_new, v_proposal.source_statement_upload_id, p_uid
  ) returning id into v_application_id;

  update expense_items
    set source_type = 'bank_statement_average', last_import_application_id = v_application_id, last_imported_at = now()
    where id = v_target_id and user_id = p_uid;

  perform set_config('fhip.import_bridge_internal_write', 'false', true);
  return jsonb_build_object('ok', true, 'outcome', 'applied', 'apply_mode', p_decision, 'proposal_id', p_proposal_id,
    'target_entity_id', v_target_id, 'application_id', v_application_id, 'applied_fields', to_jsonb(v_applied_fields));
end;
$$ language plpgsql security definer set search_path = public;

revoke all on function fdh15_apply_one_expense_proposal(uuid, uuid, text, text[]) from public;
revoke all on function fdh15_apply_one_expense_proposal(uuid, uuid, text, text[]) from anon, authenticated;

-- fdh15_apply_expense_proposals (the only public entry point, unchanged by
-- this file) already calls fdh15_apply_one_expense_proposal per decision, so
-- both new checks above apply automatically to every batch call.

-- IDEMPOTENT: both blocks are `create or replace function`; grants/revokes
-- are unconditional and safe to re-run.
-- MIGRATION NUMBER: 0224, the next free number after 0223 (NAV1) on
-- origin/main HEAD 62b0120, checked 2026-09-28 across every remote branch
-- (git ls-tree of every origin/* ref) for any 0224+ collision: none found.
-- DEPENDS ON 0207-0214 and 0218 (all present on origin/main HEAD; verified by
-- file inspection, not yet independently re-confirmed against DEV's live
-- schema_migrations ledger in this pass -- see the closure register).
