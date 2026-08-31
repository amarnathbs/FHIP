-- FDH-15 Bridge / Governance Certification — GENUINE DEFECT FIX (FDH15-DEF-001).
--
-- FOUND: fresh live-DEV negative control (spec sections 30, 81, 120, 197 —
-- same-tenant target/member forgery). Reproduced live against the real
-- fdh9_apply_income_proposal() RPC (authenticated JWT, not service-role): a
-- payslip-sourced proposal whose target_entity_id was set to a Spouse-owned
-- income_sources row (same tenant) APPLIED successfully and overwrote the
-- Spouse's income amount from the Self payslip's evidence.
--
-- ROOT CAUSE. fdh_payroll_events carries no household-member/owner column at
-- all (unlike fdh_retirement_statements.retirement_member_id, fixed for
-- Retirement in migration 0119 / FDH15-DEF-002), so there is no independent
-- evidence-side signal the RPC could cross-check a target against in
-- general. However, the SAME migration's own add_new path (line ~1338)
-- already hard-codes every payslip-sourced new income row to
-- `owner = 'self'` — i.e. this product has no path today for a payslip to
-- represent Spouse-attributed income at all. That makes the fix genuinely
-- "smallest scope, no schema change": for a payslip-sourced proposal
-- (source_kind = 'payslip'), update_existing/apply_selected_fields may only
-- ever legitimately target a self-owned row, exactly mirroring what add_new
-- already hard-codes for a NEW row.
--
-- Companion fix (already in the tree, prior commit): generateIncomeProposal()
-- in lib/import-bridge/incomeProposalService.ts narrows its own matching
-- candidate pool to owner = 'self', so this mismatch should never even be
-- proposed through the certified UI generation path. This migration closes
-- the same gap at the authoritative RPC layer too — defense-in-depth,
-- independent of whether the caller filtered correctly, per this project's
-- own standing doctrine (repository rule 10 / spec sections 164, 215-217).
--
-- FIX (smallest correct fix, no schema change, idempotent
-- create-or-replace): for update_existing / apply_selected_fields on a
-- payslip-sourced proposal, refuse with a new 'MEMBER_MISMATCH' error code
-- if the target income_sources row's owner is not 'self'. add_new and every
-- other source_kind are unaffected.
--
-- CERTIFIED: PGlite replay (fresh, from empty, whole chain) + a new negative
-- control in tests/unit/fdh15IncomeMemberMismatchGuard.test.ts. NOT YET
-- applied to hosted DEV — per standing rule 1, handed to the Product Owner
-- for manual application via the Supabase Dashboard SQL editor. The live
-- exploit reproduced above remains live-exploitable on DEV until that
-- manual step happens; disclosed honestly, not asserted fixed live, per
-- standing rule 4.

create or replace function fdh9_apply_income_proposal(
  p_proposal_id uuid,
  p_decision text,
  p_selected_fields text[] default null
) returns jsonb as $$
declare
  v_uid uuid;
  v_proposal record;
  v_income record;
  v_allowed constant text[] := array['source_name','employer_name','income_type','amount','net_amount','frequency','currency_code','is_taxable'];
  v_kinds constant jsonb := jsonb_build_object(
    'source_name','text','employer_name','text','income_type','enum','amount','money',
    'net_amount','money','frequency','enum','currency_code','enum','is_taxable','bool'
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
    raise exception 'fdh9_apply_income_proposal: authentication required';
  end if;
  if p_decision not in ('add_new','update_existing','apply_selected_fields','keep_existing') then
    return jsonb_build_object('ok', false, 'code', 'INVALID_APPLY_MODE', 'error', 'Unrecognised decision.');
  end if;

  select * into v_proposal from fhip_import_proposals where id = p_proposal_id for update;
  if not found or v_proposal.user_id <> v_uid then
    return jsonb_build_object('ok', false, 'code', 'PROPOSAL_NOT_FOUND', 'error', 'That import proposal could not be found.');
  end if;
  if v_proposal.target_domain <> 'income' then
    return jsonb_build_object('ok', false, 'code', 'PROPOSAL_NOT_ACTIONABLE', 'error', 'That proposal is for a part of your data this function does not yet handle.');
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
        then 'This proposal has already been applied to your income.'
        else 'That proposal is no longer open.' end
    );
  end if;
  if p_decision <> 'add_new' and v_proposal.target_entity_id is null then
    return jsonb_build_object('ok', false, 'code', 'INVALID_APPLY_MODE', 'error', 'There is no existing entry to update.');
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
    if not ('source_name' = any(v_selected)) or not ('amount' = any(v_selected)) or not ('frequency' = any(v_selected)) then
      return jsonb_build_object('ok', false, 'code', 'DOMAIN_VALIDATION_FAILED', 'error', 'A new income entry needs a name, a gross amount and a frequency.');
    end if;
  end if;

  if p_decision <> 'add_new' then
    select * into v_income from income_sources where id = v_proposal.target_entity_id and user_id = v_uid for update;
    if not found then
      return jsonb_build_object('ok', false, 'code', 'TARGET_NOT_FOUND', 'error', 'The income entry this proposal refers to could not be found.');
    end if;

    -- MEMBER/OWNER BOUNDARY (spec sections 30, 81, 120, 197; FDH15-DEF-001
    -- fix). Every payslip-sourced income row this bridge can ever create is
    -- hard-coded owner = 'self' (see the add_new branch below, unchanged) —
    -- so a payslip-sourced proposal updating an EXISTING row that is not
    -- self-owned can never be legitimate. Checked here regardless of how the
    -- target_entity_id was set, independent of proposal-generation-time
    -- matching (defense-in-depth, spec sections 164, 215-217).
    if v_proposal.source_kind = 'payslip' and v_income.owner is distinct from 'self' then
      return jsonb_build_object('ok', false, 'code', 'MEMBER_MISMATCH',
        'error', 'This payslip is for a different household member than the income entry you are updating.');
    end if;

    for v_field in
      select pf.field_name, pf.value_kind, pf.existing_value
      from fhip_import_proposal_fields pf
      where pf.proposal_id = p_proposal_id and pf.field_name = any(v_selected)
    loop
      v_live_text := case v_field.field_name
        when 'source_name'    then v_income.source_name
        when 'employer_name'  then v_income.employer_name
        when 'income_type'    then v_income.income_type
        when 'frequency'      then v_income.frequency
        when 'currency_code'  then v_income.currency_code
        when 'amount'         then case when v_income.amount is null then null else round(v_income.amount, 2)::text end
        when 'net_amount'     then case when v_income.net_amount is null then null else round(v_income.net_amount, 2)::text end
        when 'is_taxable'     then case when v_income.is_taxable is null then null when v_income.is_taxable then 'true' else 'false' end
        else null
      end;
      if v_field.value_kind in ('text', 'enum') then
        v_live_text := nullif(trim(both from coalesce(v_live_text, '')), '');
      end if;
      if v_live_text is distinct from v_field.existing_value then
        return jsonb_build_object(
          'ok', false, 'code', 'STALE_PROPOSAL',
          'error', 'Your income details changed after this proposal was prepared, so it was not applied.',
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
    return jsonb_build_object('ok', false, 'code', 'ALREADY_APPLIED', 'error', 'This proposal has already been applied to your income.');
  end if;

  if p_decision = 'add_new' then
    v_cols := array_prepend('last_imported_at', array_prepend('source_type', array_prepend('is_active', array_prepend('owner', array_prepend('user_id', v_cols)))));
    v_vals := array_prepend('now()', array_prepend(format('%L', 'payslip_import'), array_prepend('true', array_prepend(format('%L', 'self'), array_prepend(format('%L::uuid', v_uid), v_vals)))));
    execute format('insert into income_sources (%s) values (%s) returning id', array_to_string(v_cols, ', '), array_to_string(v_vals, ', ')) into v_target_id;
  else
    v_target_id := v_proposal.target_entity_id;
    execute format('update income_sources set %s, updated_at = now() where id = %L::uuid and user_id = %L::uuid', array_to_string(v_set_parts, ', '), v_target_id, v_uid);
  end if;

  insert into fhip_import_applications (
    user_id, proposal_id, target_domain, target_entity_id, apply_mode,
    applied_fields, previous_values, new_values, source_payroll_event_id, applied_by
  ) values (
    v_uid, p_proposal_id, 'income', v_target_id, p_decision,
    to_jsonb(v_applied_fields), v_previous, v_new, v_proposal.source_payroll_event_id, v_uid
  ) returning id into v_application_id;

  update income_sources
    set source_type = 'payslip_import',
        last_import_application_id = v_application_id,
        last_imported_at = now()
    where id = v_target_id and user_id = v_uid;

  perform set_config('fhip.import_bridge_internal_write', 'false', true);

  return jsonb_build_object(
    'ok', true, 'outcome', 'applied', 'apply_mode', p_decision,
    'target_entity_id', v_target_id, 'application_id', v_application_id,
    'applied_fields', to_jsonb(v_applied_fields)
  );
end;
$$ language plpgsql security definer set search_path = public;

revoke all on function fdh9_apply_income_proposal(uuid, text, text[]) from public;
grant execute on function fdh9_apply_income_proposal(uuid, text, text[]) to authenticated, service_role;

comment on function fdh9_apply_income_proposal(uuid, text, text[]) is
  'The ONLY path from payslip evidence to canonical Income. Writes at most the eight columns in its v_allowed array, on exactly one income_sources row. FDH-15 (migration 0120): a payslip-sourced update_existing/apply_selected_fields may only target a self-owned row (MEMBER_MISMATCH otherwise) — closing FDH15-DEF-001 (Self/Spouse cross-target), symmetric with the Retirement fix in migration 0119.';
