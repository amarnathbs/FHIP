-- =============================================================================
-- 0218 -- Approved Upload -> Canonical programme, stage-3 SECURITY / DATA-
-- INTEGRITY REVIEW fixes (range D certifier). Additive hardening only.
-- =============================================================================
--
-- Every gap below was reproduced LIVE on DEV (vqycarelcoijzwlpkpcz) through
-- PostgREST as an ordinary authenticated fixture user on 2026-09-27, then
-- re-proved in PGlite before/after this file
-- (scripts/canonical_0218_pglite_verification.mjs).
--
--   A. SR-01 -- forged card/loan evidence reaches the approved ledger.
--      0096's "insert own" policies accept ANY column on INSERT, and the
--      0096/0208/0209 authoritative-write triggers are BEFORE UPDATE only.
--      Live: a user INSERTed an fdh_liability_statements row already
--      approval_status='approved' (no document: statement_upload_id NULL) and
--      a 777.77 PURCHASE activity, hand-made a liability proposal and called
--      fdh10_apply_liability_proposal -> an APPROVED 'expense' fdh_transactions
--      row of 777.77 that no parser ever produced (fdh_transactions is
--      "engine-authoritative": its own r7 guard refuses exactly this insert).
--      Also live: a statement inserted with ledger_status='applied',
--      user_corrected_fields set, and an activity with ledger_disposition
--      preset. WP-12 (0213) and WP-13 (0211) closed this class for their
--      evidence tables; WP-11 did not. The legitimate writer is the INVOKER
--      fdh10_persist_liability_statement (0208), which never sets any of the
--      columns guarded here and always names a document, so this guard
--      changes nothing for it. An authenticated INSERT may no longer:
--        statements: set approval / ledger / correction / liability-link /
--          duplicate-link state, or omit the document (statement_upload_id);
--        activities: set ledger_* state, or join a statement that is already
--          approved (a line added after approval would reach the next Apply
--          unseen by the review).
--      Every SECURITY DEFINER path (approve, correct, apply, ledger) runs
--      under fhip.import_bridge_internal_write and is exempt, as in 0209.
--      RESIDUAL (disclosed, PO decision): fdh10_persist_liability_statement
--      is SECURITY INVOKER and granted to authenticated, so a user who calls
--      it directly (with their own queued document) still chooses every
--      evidence NUMBER; closing that needs the persist to move to the service
--      role. Before this file the same user needed no document at all.
--
--   B. SR-02 -- fdh_transaction_allocations had no same-tenant check (since
--      0047): the FOREIGN KEY proves the parent exists, not that it is the
--      caller's, and 0212's guard is SECURITY INVOKER so it cannot see a
--      foreign parent. Live: user A inserted a split line (user_id = A) on
--      user B's transaction; B's own "save split" then failed with 422
--      'duplicate key value violates unique constraint uq_fdh_allocation_
--      sequence' (the key is global) -- a cross-tenant write and a denial of
--      service B cannot even see (RLS hides A's row). A SECURITY DEFINER
--      same-tenant trigger now refuses it for every role (the FDH1-F1
--      pattern). PRE-CHECK: refuses to apply while any cross-tenant
--      allocation exists (query and remedy below).
--
--   C. SR-03 -- fdh15_apply_asset_proposal (0214) re-derives the balance
--      NUMBER from the approved statement but not its CURRENCY. Live: a
--      hand-made proposal carrying the exact AUD closing balance 10400 with
--      currency_code 'INR' was applied -> an INR 10,400 cash asset stamped
--      source_type 'bank_statement_import' on an AUD account. Reachable
--      without forging too: "update existing" on a manual asset in another
--      currency with the currency tick cleared. The resulting asset currency
--      must now equal the statement's (else CURRENCY_MISMATCH, no write).
--      Predecessor: 0214 PART G (the only definition); the body below is 0214's
--      verbatim plus the one marked block.
--
--   D. SR-04 -- 0214 revoked the two WP-15 entry points from PUBLIC only.
--      Supabase grants EXECUTE on new public functions to anon explicitly
--      (default privileges), so anon still reached the function bodies (live:
--      HTTP 400 "authentication required" from inside the function, where
--      every 0209-0212 RPC answers 401 "permission denied"). Revoked from anon.
--
-- NOT TOUCHED: every shared CHECK (no error_code / event_type added), every
-- RLS policy, every other function. No row is rewritten.
-- IDEMPOTENT: drop trigger if exists + create, create or replace, revoke.
-- DEPENDS ON 0207-0214 (applied to DEV 2026-09-27).
-- MIGRATION NUMBER: 0218 assigned to the range-D security certifier; every
-- remote ref scanned for 0215-0219 on 2026-09-27: none.

-- ============================================================================
-- A. Liability evidence: authoritative INSERT (authenticated role only).
-- ============================================================================
create or replace function fdh10_liability_statements_assert_authoritative_insert() returns trigger as $$
begin
  if coalesce(current_setting('fhip.import_bridge_internal_write', true), 'false') = 'true' then
    return new;
  end if;
  if coalesce(auth.role(), '') not in ('authenticated', 'anon') then
    return new;
  end if;
  if new.statement_upload_id is null
     or new.approval_status is distinct from 'pending'
     or new.approved_at is not null
     or new.approved_by is not null
     or new.liability_id is not null
     or new.duplicate_of_statement_id is not null
     or new.ledger_status is distinct from 'not_applied'
     or new.ledger_applied_at is not null
     or new.ledger_rejected_reason is not null
     or coalesce(cardinality(new.user_corrected_fields), 0) <> 0
     or new.last_corrected_at is not null
     or new.last_corrected_by is not null
  then
    raise exception 'fdh_liability_statements: approval, ledger, correction and link state are system-authoritative; statement evidence is created from a document by the statement persist only'
      using errcode = '42501';
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists trg_fdh_liability_statements_authoritative_insert_0218 on fdh_liability_statements;
create trigger trg_fdh_liability_statements_authoritative_insert_0218
  before insert on fdh_liability_statements
  for each row execute function fdh10_liability_statements_assert_authoritative_insert();

create or replace function fdh10_liability_activities_assert_authoritative_insert() returns trigger as $$
declare
  v_parent_approval text;
begin
  if coalesce(current_setting('fhip.import_bridge_internal_write', true), 'false') = 'true' then
    return new;
  end if;
  if coalesce(auth.role(), '') not in ('authenticated', 'anon') then
    return new;
  end if;
  if new.ledger_transaction_id is not null
     or new.ledger_disposition is not null
     or new.ledger_duplicate_of_transaction_id is not null
  then
    raise exception 'fdh_liability_statement_activities: ledger state is system-authoritative'
      using errcode = '42501';
  end if;
  select approval_status into v_parent_approval from fdh_liability_statements where id = new.statement_id;
  if v_parent_approval is distinct from 'pending' then
    raise exception 'fdh_liability_statement_activities: lines can only be added to a statement that is still awaiting review'
      using errcode = '42501';
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists trg_fdh_liability_activities_authoritative_insert_0218 on fdh_liability_statement_activities;
create trigger trg_fdh_liability_activities_authoritative_insert_0218
  before insert on fdh_liability_statement_activities
  for each row execute function fdh10_liability_activities_assert_authoritative_insert();

-- ============================================================================
-- B. Split lines: same tenant as their transaction (every role).
-- ============================================================================
-- Read-only list of what blocks this section (none expected; each row is by
-- definition a forged cross-tenant write). PO remedy, as the service role:
--   delete from fdh_transaction_allocations a using fdh_transactions t
--    where t.id = a.transaction_id and t.user_id <> a.user_id;
do $$
declare
  v_bad int;
begin
  select count(*) into v_bad
    from fdh_transaction_allocations a join fdh_transactions t on t.id = a.transaction_id
   where t.user_id <> a.user_id;
  if v_bad > 0 then
    raise exception '0218 PRE-CHECK FAILED: % fdh_transaction_allocations row(s) belong to a different user than their transaction; see this file''s section B for the query and the PO remedy. Nothing was applied.', v_bad;
  end if;
end $$;

create or replace function fdh8_assert_allocation_same_tenant() returns trigger as $$
declare
  v_owner uuid;
begin
  select user_id into v_owner from fdh_transactions where id = new.transaction_id;
  if v_owner is null then
    raise exception 'fdh_transaction_allocations: transaction % does not exist', new.transaction_id using errcode = '23503';
  end if;
  if v_owner <> new.user_id then
    raise exception 'fdh_transaction_allocations: cross-tenant reference -- transaction % belongs to a different user', new.transaction_id
      using errcode = '42501';
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists trg_fdh_allocations_same_tenant_0218 on fdh_transaction_allocations;
create trigger trg_fdh_allocations_same_tenant_0218
  before insert or update of user_id, transaction_id on fdh_transaction_allocations
  for each row execute function fdh8_assert_allocation_same_tenant();

-- ============================================================================
-- C. fdh15_apply_asset_proposal: the balance's CURRENCY is re-derived too.
-- ============================================================================
create or replace function fdh15_apply_asset_proposal(
  p_proposal_id uuid,
  p_decision text,
  p_selected_fields text[] default null
) returns jsonb as $$
declare
  v_uid uuid;
  v_proposal record;
  v_stmt record;
  v_account record;
  v_asset record;
  v_balance numeric;
  v_newer boolean;
  v_allowed constant text[] := array['asset_name', 'asset_class', 'current_value', 'currency_code', 'valuation_date', 'owner'];
  v_kinds constant jsonb := jsonb_build_object(
    'asset_name', 'text', 'asset_class', 'enum', 'current_value', 'money', 'currency_code', 'enum', 'valuation_date', 'date', 'owner', 'enum');
  v_selected text[];
  v_forbidden text[];
  v_known text[];
  v_field record;
  v_live_text text;
  v_proposed_value text;
  v_proposed_class text;
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
  v_final_currency text;  -- 0218
begin
  v_uid := auth.uid();
  if v_uid is null then
    raise exception 'fdh15_apply_asset_proposal: authentication required';
  end if;
  if p_decision is null or p_decision not in ('add_new', 'update_existing', 'apply_selected_fields', 'keep_existing') then
    return jsonb_build_object('ok', false, 'code', 'INVALID_APPLY_MODE', 'error', 'Unrecognised decision.');
  end if;

  select * into v_proposal from fhip_import_proposals where id = p_proposal_id for update;
  if not found or v_proposal.user_id <> v_uid then
    return jsonb_build_object('ok', false, 'code', 'PROPOSAL_NOT_FOUND', 'error', 'That suggestion could not be found.');
  end if;
  if v_proposal.target_domain <> 'asset' or v_proposal.source_kind <> 'bank_statement' or v_proposal.source_statement_upload_id is null then
    return jsonb_build_object('ok', false, 'code', 'PROPOSAL_NOT_ACTIONABLE', 'error', 'That suggestion is not a bank-balance update.');
  end if;

  if p_decision = 'keep_existing' then
    if v_proposal.status <> 'ready' then
      return jsonb_build_object('ok', false, 'code', 'PROPOSAL_NOT_ACTIONABLE', 'error', 'That suggestion is no longer open.');
    end if;
    perform set_config('fhip.import_bridge_internal_write', 'true', true);
    update fhip_import_proposals set status = 'dismissed', dismissed_at = now() where id = p_proposal_id;
    perform set_config('fhip.import_bridge_internal_write', 'false', true);
    return jsonb_build_object('ok', true, 'outcome', 'kept_existing');
  end if;

  if v_proposal.status <> 'ready' then
    return jsonb_build_object(
      'ok', false,
      'code', case when v_proposal.status = 'applied' then 'ALREADY_APPLIED' else 'PROPOSAL_NOT_ACTIONABLE' end,
      'error', case when v_proposal.status = 'applied' then 'This balance has already been added to your assets.' else 'That suggestion is no longer open.' end);
  end if;
  if p_decision <> 'add_new' and v_proposal.target_entity_id is null then
    return jsonb_build_object('ok', false, 'code', 'INVALID_APPLY_MODE', 'error', 'There is no existing asset to update.');
  end if;

  -- The evidence: an approved statement of the caller's, on an ordinary bank account.
  select * into v_stmt from fdh_statement_uploads
    where id = v_proposal.source_statement_upload_id and user_id = v_uid and processing_status = 'approved';
  if not found or v_stmt.financial_account_id is null then
    return jsonb_build_object('ok', false, 'code', 'PROPOSAL_NOT_ACTIONABLE', 'error', 'The statement behind this balance is no longer approved.');
  end if;
  select * into v_account from fdh_financial_accounts where id = v_stmt.financial_account_id and user_id = v_uid;
  if not found or v_account.account_type in ('credit_card', 'home_loan', 'personal_loan', 'vehicle_loan', 'investment_property_loan', 'other_term_loan', 'line_of_credit', 'overdraft')
     or v_account.liability_id is not null then
    return jsonb_build_object('ok', false, 'code', 'PROPOSAL_NOT_ACTIONABLE', 'error', 'Only an ordinary bank account balance can be added as a cash asset.');
  end if;
  select rr.reported_closing_balance into v_balance from fdh_reconciliation_results rr
    where rr.statement_upload_id = v_stmt.id and rr.user_id = v_uid and rr.reported_closing_balance is not null
    order by rr.created_at desc nulls last limit 1;
  if v_balance is null then
    return jsonb_build_object('ok', false, 'code', 'PROPOSAL_NOT_ACTIONABLE', 'error', 'That statement has no closing balance.');
  end if;
  select exists (
    select 1 from fdh_statement_uploads s
    where s.user_id = v_uid and s.financial_account_id = v_stmt.financial_account_id and s.processing_status = 'approved' and s.id <> v_stmt.id
      and coalesce(s.statement_period_end, s.approved_at::date) > coalesce(v_stmt.statement_period_end, v_stmt.approved_at::date)
      and exists (select 1 from fdh_reconciliation_results r where r.statement_upload_id = s.id and r.user_id = v_uid and r.reported_closing_balance is not null)
  ) into v_newer;
  if v_newer then
    return jsonb_build_object('ok', false, 'code', 'STALE_PROPOSAL', 'error', 'A newer statement for this account has been approved. Refresh the suggestion.', 'field', 'current_value');
  end if;
  select proposed_value into v_proposed_value from fhip_import_proposal_fields where proposal_id = p_proposal_id and field_name = 'current_value';
  if v_proposed_value is null or round(v_proposed_value::numeric, 2) <> round(v_balance, 2) then
    return jsonb_build_object('ok', false, 'code', 'FORBIDDEN_FIELD', 'error', 'This balance does not match the approved statement.', 'fields', to_jsonb(array['current_value']));
  end if;
  if v_balance < 0 then
    return jsonb_build_object('ok', false, 'code', 'DOMAIN_VALIDATION_FAILED', 'error', 'An overdrawn balance is not an asset.');
  end if;

  if p_selected_fields is null or array_length(p_selected_fields, 1) is null then
    select array_agg(field_name) into v_selected from fhip_import_proposal_fields where proposal_id = p_proposal_id;
  else
    v_selected := p_selected_fields;
  end if;
  if v_selected is null then v_selected := array[]::text[]; end if;
  select array_agg(f) into v_forbidden from unnest(v_selected) f where not (f = any(v_allowed));
  if v_forbidden is not null and array_length(v_forbidden, 1) > 0 then
    return jsonb_build_object('ok', false, 'code', 'FORBIDDEN_FIELD', 'error', 'One or more selected fields cannot be changed by an import.', 'fields', to_jsonb(v_forbidden));
  end if;
  select array_agg(field_name) into v_known from fhip_import_proposal_fields where proposal_id = p_proposal_id;
  if v_known is null then v_known := array[]::text[]; end if;
  select array_agg(f) into v_forbidden from unnest(v_selected) f where not (f = any(v_known));
  if v_forbidden is not null and array_length(v_forbidden, 1) > 0 then
    return jsonb_build_object('ok', false, 'code', 'FORBIDDEN_FIELD', 'error', 'One or more selected fields are not part of this suggestion.', 'fields', to_jsonb(v_forbidden));
  end if;
  if not ('current_value' = any(v_selected)) then
    return jsonb_build_object('ok', false, 'code', 'NO_FIELDS_SELECTED', 'error', 'The balance itself must be applied.');
  end if;

  if p_decision = 'add_new' then
    if not ('asset_name' = any(v_selected)) or not ('asset_class' = any(v_selected)) or not ('currency_code' = any(v_selected)) then
      return jsonb_build_object('ok', false, 'code', 'DOMAIN_VALIDATION_FAILED', 'error', 'A new cash asset needs a name, the cash class, a balance and a currency.');
    end if;
    select proposed_value into v_proposed_class from fhip_import_proposal_fields where proposal_id = p_proposal_id and field_name = 'asset_class';
    if v_proposed_class is distinct from 'cash' then
      return jsonb_build_object('ok', false, 'code', 'DOMAIN_VALIDATION_FAILED', 'error', 'A bank balance can only be added as a cash asset.');
    end if;
    if exists (select 1 from assets where user_id = v_uid and source_financial_account_id = v_stmt.financial_account_id and is_active is true) then
      return jsonb_build_object('ok', false, 'code', 'STALE_PROPOSAL', 'error', 'This account already has an asset in your Net Worth. Refresh the suggestion to update it instead.', 'field', 'source_financial_account_id');
    end if;
  else
    select * into v_asset from assets where id = v_proposal.target_entity_id and user_id = v_uid for update;
    if not found or v_asset.is_active is not true then
      return jsonb_build_object('ok', false, 'code', 'TARGET_NOT_FOUND', 'error', 'The asset this suggestion refers to could not be found.');
    end if;
    if v_asset.source_financial_account_id is not null and v_asset.source_financial_account_id <> v_stmt.financial_account_id then
      return jsonb_build_object('ok', false, 'code', 'STALE_PROPOSAL', 'error', 'That asset already carries a different bank account.', 'field', 'source_financial_account_id');
    end if;
    if exists (select 1 from assets where user_id = v_uid and source_financial_account_id = v_stmt.financial_account_id and is_active is true and id <> v_asset.id) then
      return jsonb_build_object('ok', false, 'code', 'STALE_PROPOSAL', 'error', 'Another asset already carries this account. Refresh the suggestion.', 'field', 'source_financial_account_id');
    end if;
    for v_field in
      select pf.field_name, pf.existing_value from fhip_import_proposal_fields pf
      where pf.proposal_id = p_proposal_id and pf.field_name = any(v_selected)
    loop
      v_live_text := case v_field.field_name
        when 'asset_name'     then nullif(trim(both from coalesce(v_asset.asset_name, '')), '')
        when 'asset_class'    then nullif(trim(both from coalesce(v_asset.asset_class, '')), '')
        when 'current_value'  then case when v_asset.current_value is null then null else round(v_asset.current_value, 2)::text end
        when 'currency_code'  then nullif(trim(both from coalesce(v_asset.currency_code::text, '')), '')
        when 'valuation_date' then case when v_asset.valuation_date is null then null else v_asset.valuation_date::text end
        when 'owner'          then nullif(trim(both from coalesce(v_asset.owner, '')), '')
        else null
      end;
      if v_live_text is distinct from v_field.existing_value then
        return jsonb_build_object('ok', false, 'code', 'STALE_PROPOSAL',
          'error', 'This asset changed after the suggestion was prepared, so it was not applied. Refresh the suggestion.',
          'field', v_field.field_name, 'existing', v_field.existing_value, 'current', v_live_text);
      end if;
      v_previous := v_previous || jsonb_build_object(v_field.field_name, v_field.existing_value);
    end loop;
  end if;

  -- 0218 (SR-03): the asset's resulting currency must be the statement's.
  -- The balance number was already re-derived above; its currency is part of
  -- the same fact (an AUD 10,400 closing balance is not INR 10,400).
  if 'currency_code' = any(v_selected) then
    select proposed_value into v_final_currency from fhip_import_proposal_fields where proposal_id = p_proposal_id and field_name = 'currency_code';
  elsif p_decision <> 'add_new' then
    v_final_currency := v_asset.currency_code::text;
  end if;
  if v_final_currency is distinct from coalesce(v_stmt.currency_code, v_account.currency_code)::text then
    return jsonb_build_object('ok', false, 'code', 'CURRENCY_MISMATCH',
      'error', format('This balance is in %s. It can only be added to an asset held in %s; amounts are never converted or added across currencies here.',
                      coalesce(v_stmt.currency_code, v_account.currency_code), coalesce(v_stmt.currency_code, v_account.currency_code)),
      'field', 'currency_code');
  end if;
  -- end 0218

  for v_field in
    select pf.field_name, pf.proposed_value from fhip_import_proposal_fields pf
    where pf.proposal_id = p_proposal_id and pf.field_name = any(v_selected)
  loop
    v_kind := v_kinds ->> v_field.field_name;
    if v_field.proposed_value is null then
      v_lit := 'NULL';
    elsif v_kind = 'money' then
      v_lit := format('%L::numeric', v_field.proposed_value);
    elsif v_kind = 'date' then
      v_lit := format('%L::date', v_field.proposed_value);
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
    return jsonb_build_object('ok', false, 'code', 'ALREADY_APPLIED', 'error', 'This balance has already been added to your assets.');
  end if;

  if p_decision = 'add_new' then
    if not ('owner' = any(v_selected)) then
      v_cols := array_append(v_cols, 'owner');
      v_vals := array_append(v_vals, quote_literal('self'));
    end if;
    execute format('insert into assets (user_id, is_active, %s) values (%L::uuid, true, %s) returning id',
      array_to_string(v_cols, ', '), v_uid, array_to_string(v_vals, ', ')) into v_target_id;
  else
    v_target_id := v_proposal.target_entity_id;
    execute format('update assets set %s, updated_at = now() where id = %L::uuid and user_id = %L::uuid',
      array_to_string(v_set_parts, ', '), v_target_id, v_uid);
  end if;

  insert into fhip_import_applications (
    user_id, proposal_id, target_domain, target_entity_id, apply_mode,
    applied_fields, previous_values, new_values, source_statement_upload_id, applied_by
  ) values (
    v_uid, p_proposal_id, 'asset', v_target_id, p_decision,
    to_jsonb(v_applied_fields), v_previous, v_new, v_stmt.id, v_uid
  ) returning id into v_application_id;

  update assets
    set source_type = 'bank_statement_import', source_financial_account_id = v_stmt.financial_account_id,
        last_import_application_id = v_application_id, last_imported_at = now()
    where id = v_target_id and user_id = v_uid;

  perform set_config('fhip.import_bridge_internal_write', 'false', true);
  return jsonb_build_object('ok', true, 'outcome', 'applied', 'apply_mode', p_decision,
    'target_entity_id', v_target_id, 'application_id', v_application_id, 'applied_fields', to_jsonb(v_applied_fields));
end;
$$ language plpgsql security definer set search_path = public;

revoke all on function fdh15_apply_asset_proposal(uuid, text, text[]) from public;
grant execute on function fdh15_apply_asset_proposal(uuid, text, text[]) to authenticated, service_role;

-- ============================================================================
-- D. No anonymous EXECUTE on the WP-15 entry points (0214 revoked PUBLIC only).
-- ============================================================================
revoke all on function fdh15_apply_asset_proposal(uuid, text, text[]) from anon;
revoke all on function fdh15_apply_expense_proposals(jsonb) from anon;
