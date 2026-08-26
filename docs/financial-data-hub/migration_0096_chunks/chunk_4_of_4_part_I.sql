-- PART I — THE ATOMIC LIABILITY APPLY RPC (spec sections 53-58). Mirrors
-- `fdh9_apply_income_proposal` exactly in structure and guarantees (row lock,
-- compare-and-swap, staleness gate, typed allow-listed columns only, single
-- atomic transaction) — a SEPARATE, narrow, typed function per spec section
-- 53's explicit instruction ("do NOT implement an arbitrary dynamic
-- table_name/column_name/SQL-from-client-data RPC — use a typed liability
-- adapter/typed authoritative handler"), not a generalisation of the income
-- function into a dynamic-table dispatcher.
-- ---------------------------------------------------------------------------
create or replace function fdh10_apply_liability_proposal(
  p_proposal_id uuid,
  p_decision text,
  p_selected_fields text[] default null
) returns jsonb as $$
declare
  v_uid uuid;
  v_proposal record;
  v_liability record;
  v_allowed constant text[] := array[
    'liability_name','debt_type','lender','currency_code','country_code',
    'balance','interest_rate','monthly_repayment','credit_limit',
    'masked_identifier','minimum_payment','due_date'
  ];
  v_kinds constant jsonb := jsonb_build_object(
    'liability_name','text','debt_type','enum','lender','text','currency_code','enum',
    'country_code','enum','balance','money','interest_rate','money',
    'monthly_repayment','money','credit_limit','money','masked_identifier','text',
    'minimum_payment','money','due_date','text'
  );
  v_selected text[];
  v_forbidden text[];
  v_known text[];
  v_field record;
  v_live_text text;
  v_set_parts text[] := array[]::text[];
  v_cols text[] := array[]::text[];
  v_vals text[] := array[]::text[];
  v_applied_fields text[] := array[]::text[];
  v_previous jsonb := '{}'::jsonb;
  v_new jsonb := '{}'::jsonb;
  v_target_id uuid;
  v_application_id uuid;
  v_kind text;
begin
  v_uid := auth.uid();
  if v_uid is null then
    raise exception 'fdh10_apply_liability_proposal: authentication required';
  end if;
  if p_decision not in ('add_new','update_existing','apply_selected_fields','keep_existing') then
    return jsonb_build_object('ok', false, 'code', 'INVALID_APPLY_MODE', 'error', 'Unrecognised decision.');
  end if;

  select * into v_proposal from fhip_import_proposals where id = p_proposal_id for update;
  if not found or v_proposal.user_id <> v_uid then
    return jsonb_build_object('ok', false, 'code', 'PROPOSAL_NOT_FOUND', 'error', 'That import proposal could not be found.');
  end if;
  if v_proposal.target_domain <> 'liability' then
    return jsonb_build_object('ok', false, 'code', 'PROPOSAL_NOT_ACTIONABLE', 'error', 'That proposal is for a part of your data this function does not handle.');
  end if;

  if p_decision = 'keep_existing' then
    if v_proposal.status <> 'ready' then
      return jsonb_build_object('ok', false, 'code', 'PROPOSAL_NOT_ACTIONABLE', 'error', 'That proposal is no longer open.');
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
      'error', case when v_proposal.status = 'applied'
        then 'This proposal has already been applied to your liabilities.'
        else 'That proposal is no longer open.' end
    );
  end if;
  if p_decision <> 'add_new' and v_proposal.target_entity_id is null then
    return jsonb_build_object('ok', false, 'code', 'INVALID_APPLY_MODE', 'error', 'There is no existing liability to update.');
  end if;

  if p_decision = 'update_existing' and (p_selected_fields is null or array_length(p_selected_fields, 1) is null) then
    select array_agg(field_name) into v_selected from fhip_import_proposal_fields where proposal_id = p_proposal_id;
  else
    v_selected := coalesce(p_selected_fields, array[]::text[]);
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
    return jsonb_build_object('ok', false, 'code', 'FORBIDDEN_FIELD', 'error', 'One or more selected fields are not part of this proposal.', 'fields', to_jsonb(v_forbidden));
  end if;
  if array_length(v_selected, 1) is null or array_length(v_selected, 1) = 0 then
    return jsonb_build_object('ok', false, 'code', 'NO_FIELDS_SELECTED', 'error', 'Choose at least one detail to apply.');
  end if;

  if p_decision = 'add_new' then
    if not ('liability_name' = any(v_selected)) or not ('debt_type' = any(v_selected))
       or not ('balance' = any(v_selected)) or not ('currency_code' = any(v_selected)) then
      return jsonb_build_object('ok', false, 'code', 'DOMAIN_VALIDATION_FAILED', 'error', 'A new liability needs a name, a type, a balance and a currency.');
    end if;
  end if;

  if p_decision <> 'add_new' then
    select * into v_liability from liabilities where id = v_proposal.target_entity_id and user_id = v_uid for update;
    if not found then
      return jsonb_build_object('ok', false, 'code', 'TARGET_NOT_FOUND', 'error', 'The liability this proposal refers to could not be found.');
    end if;

    for v_field in
      select pf.field_name, pf.value_kind, pf.existing_value
      from fhip_import_proposal_fields pf
      where pf.proposal_id = p_proposal_id and pf.field_name = any(v_selected)
    loop
      v_live_text := case v_field.field_name
        when 'liability_name'     then v_liability.liability_name
        when 'debt_type'          then v_liability.debt_type
        when 'lender'             then v_liability.lender
        when 'currency_code'      then v_liability.currency_code
        when 'country_code'       then v_liability.country_code
        when 'masked_identifier'  then v_liability.masked_identifier
        when 'due_date'           then case when v_liability.due_date is null then null else v_liability.due_date::text end
        when 'balance'            then case when v_liability.balance is null then null else round(v_liability.balance, 2)::text end
        when 'interest_rate'      then case when v_liability.interest_rate is null then null else round(v_liability.interest_rate, 2)::text end
        when 'monthly_repayment'  then case when v_liability.monthly_repayment is null then null else round(v_liability.monthly_repayment, 2)::text end
        when 'credit_limit'       then case when v_liability.credit_limit is null then null else round(v_liability.credit_limit, 2)::text end
        when 'minimum_payment'    then case when v_liability.minimum_payment is null then null else round(v_liability.minimum_payment, 2)::text end
        else null
      end;
      if v_field.value_kind in ('text', 'enum') then
        v_live_text := nullif(trim(both from coalesce(v_live_text, '')), '');
      end if;
      if v_live_text is distinct from v_field.existing_value then
        return jsonb_build_object(
          'ok', false, 'code', 'STALE_PROPOSAL',
          'error', 'Your liability details changed after this proposal was prepared, so it was not applied.',
          'field', v_field.field_name, 'existing', v_field.existing_value, 'current', v_live_text
        );
      end if;
      v_previous := v_previous || jsonb_build_object(v_field.field_name, v_field.existing_value);
    end loop;
  end if;

  for v_field in
    select pf.field_name, pf.value_kind, pf.proposed_value
    from fhip_import_proposal_fields pf
    where pf.proposal_id = p_proposal_id and pf.field_name = any(v_selected)
  loop
    v_kind := v_kinds ->> v_field.field_name;
    if v_field.proposed_value is null then
      v_set_parts := array_append(v_set_parts, format('%I = NULL', v_field.field_name));
      v_cols := array_append(v_cols, v_field.field_name);
      v_vals := array_append(v_vals, 'NULL');
    elsif v_kind = 'money' then
      v_set_parts := array_append(v_set_parts, format('%I = %L::numeric', v_field.field_name, v_field.proposed_value));
      v_cols := array_append(v_cols, v_field.field_name);
      v_vals := array_append(v_vals, format('%L::numeric', v_field.proposed_value));
    elsif v_field.field_name = 'due_date' then
      v_set_parts := array_append(v_set_parts, format('%I = %L::date', v_field.field_name, v_field.proposed_value));
      v_cols := array_append(v_cols, v_field.field_name);
      v_vals := array_append(v_vals, format('%L::date', v_field.proposed_value));
    else
      v_set_parts := array_append(v_set_parts, format('%I = %L', v_field.field_name, v_field.proposed_value));
      v_cols := array_append(v_cols, v_field.field_name);
      v_vals := array_append(v_vals, format('%L', v_field.proposed_value));
    end if;
    v_new := v_new || jsonb_build_object(v_field.field_name, v_field.proposed_value);
    v_applied_fields := array_append(v_applied_fields, v_field.field_name);
    if p_decision = 'add_new' then
      v_previous := v_previous || jsonb_build_object(v_field.field_name, null);
    end if;
  end loop;

  perform set_config('fhip.import_bridge_internal_write', 'true', true);
  update fhip_import_proposals set status = 'applied', applied_at = now()
    where id = p_proposal_id and status = 'ready';
  if not found then
    perform set_config('fhip.import_bridge_internal_write', 'false', true);
    return jsonb_build_object('ok', false, 'code', 'ALREADY_APPLIED', 'error', 'This proposal has already been applied to your liabilities.');
  end if;

  if p_decision = 'add_new' then
    v_cols := array_prepend('last_imported_at', array_prepend('source_type', array_prepend('is_active', array_prepend('owner', array_prepend('user_id', v_cols)))));
    v_vals := array_prepend('now()', array_prepend(format('%L', 'liability_statement_import'), array_prepend('true', array_prepend(format('%L', 'self'), array_prepend(format('%L::uuid', v_uid), v_vals)))));
    execute format('insert into liabilities (%s) values (%s) returning id', array_to_string(v_cols, ', '), array_to_string(v_vals, ', ')) into v_target_id;
  else
    v_target_id := v_proposal.target_entity_id;
    execute format('update liabilities set %s, updated_at = now() where id = %L::uuid and user_id = %L::uuid', array_to_string(v_set_parts, ', '), v_target_id, v_uid);
  end if;

  insert into fhip_import_applications (
    user_id, proposal_id, target_domain, target_entity_id, apply_mode,
    applied_fields, previous_values, new_values, source_liability_statement_id, applied_by
  ) values (
    v_uid, p_proposal_id, 'liability', v_target_id, p_decision,
    to_jsonb(v_applied_fields), v_previous, v_new, v_proposal.source_liability_statement_id, v_uid
  ) returning id into v_application_id;

  update liabilities
    set source_type = 'liability_statement_import', last_import_application_id = v_application_id, last_imported_at = now()
    where id = v_target_id and user_id = v_uid;

  perform set_config('fhip.import_bridge_internal_write', 'false', true);

  return jsonb_build_object(
    'ok', true, 'outcome', 'applied', 'apply_mode', p_decision,
    'target_entity_id', v_target_id, 'application_id', v_application_id,
    'applied_fields', to_jsonb(v_applied_fields)
  );
end;
$$ language plpgsql security definer set search_path = public;

revoke all on function fdh10_apply_liability_proposal(uuid, text, text[]) from public;
grant execute on function fdh10_apply_liability_proposal(uuid, text, text[]) to authenticated, service_role;
