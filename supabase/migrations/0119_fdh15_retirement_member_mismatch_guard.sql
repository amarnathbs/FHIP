-- FDH-15 Bridge / Governance Certification — GENUINE DEFECT FIX (FDH15-DEF-002).
--
-- FOUND: fresh live-DEV negative control, spec section 30 ("Self / Spouse
-- Boundary ... Retirement proposals for Self must never silently update
-- Spouse and vice versa. Explicitly negative-test."). Reproduced live against
-- the real fdh12_apply_retirement_proposal() RPC (authenticated JWT, not
-- service-role): a proposal whose source_retirement_statement_id resolved to
-- the Self member, with target_entity_id manually repointed at the Spouse's
-- retirement_accounts row (same tenant), APPLIED successfully and overwrote
-- the Spouse's current_balance from the Self statement's evidence.
--
-- ROOT CAUSE. Migration 0112's fdh12_apply_retirement_proposal() computes
-- v_member_id (the household member the source statement resolved to) ONLY
-- AFTER the compare-and-swap claim (`update ... set status='applied' ...`),
-- and uses it ONLY on the add_new insert path (line ~1454-1458 of 0112) to
-- stamp a new account's retirement_member_id. The update_existing /
-- apply_selected_fields path never compares the statement's resolved member
-- against the TARGET account's own retirement_member_id before mutating it.
-- Proposal-generation-time matching (accountMatching.ts / retirementAdapter.ts)
-- already narrows candidates to the correct member, so this was not reachable
-- through the certified UI flow with correctly-generated proposals — but the
-- authoritative RPC itself provided no defense-in-depth guarantee, which is
-- exactly the boundary this project's own methodology requires (RLS proves
-- row ownership; the RPC/trigger layer must independently prove lifecycle and
-- target authority, never trust the caller to have filtered correctly).
--
-- FIX (smallest correct fix, no schema change): resolve v_member_id BEFORE
-- the target lookup (not after the claim), and — for update_existing /
-- apply_selected_fields only, and only when BOTH the source statement and the
-- target account carry a non-null retirement_member_id — require them to
-- match. Mismatch returns a new, dedicated 'MEMBER_MISMATCH' error code
-- (distinct from STALE_PROPOSAL/TARGET_NOT_FOUND, so the UI can show an
-- accurate message) and mutates nothing. add_new is unaffected: it already
-- stamps retirement_member_id from the statement, never from a target.
--
-- SCOPE. This migration is idempotent (`create or replace function`, no
-- table/column change). It touches ONLY fdh12_apply_retirement_proposal().
-- The analogous Income defect (FDH15-DEF-001: fdh_payroll_events carries no
-- household-member column at all, so there is no field to cross-check against
-- for that domain) is NOT fixed here — a comparable guard for Income would
-- require adding member attribution to the payslip evidence schema, which is
-- feature work, not a smallest-fix hotfix, and is disclosed instead as an
-- open P1 residual in FDH15_RESIDUAL_RISK_REGISTER.md /
-- FDH15_COMPLETION_REPORT.md for a dedicated near-term follow-up.
--
-- CERTIFIED: PGlite replay (fresh, from empty, whole chain) + a new negative
-- control in tests/unit/fdh15RetirementMemberMismatchGuard.test.ts. NOT YET
-- applied to hosted DEV — per standing rule 1, this file is handed to the
-- Product Owner for manual application via the Supabase Dashboard SQL editor.
-- The live exploit reproduced above remains live-exploitable on DEV until
-- that manual step happens; this is disclosed honestly, not asserted fixed
-- live, per standing rule 4.

create or replace function fdh12_apply_retirement_proposal(
  p_proposal_id uuid,
  p_decision text,
  p_selected_fields text[] default null
) returns jsonb as $$
declare
  v_uid uuid;
  v_proposal record;
  v_account record;
  v_is_smsf boolean;
  v_allowed constant text[] := array[
    'account_name', 'account_type', 'current_balance', 'currency_code',
    'country_code', 'owner', 'employer_contribution', 'personal_contribution',
    'contribution_frequency'
  ];
  v_kinds constant jsonb := jsonb_build_object(
    'account_name', 'text', 'account_type', 'enum', 'current_balance', 'money',
    'currency_code', 'enum', 'country_code', 'enum', 'owner', 'enum',
    'employer_contribution', 'money', 'personal_contribution', 'money',
    'contribution_frequency', 'enum'
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
  v_member_id uuid;
  v_kind text;
begin
  v_uid := auth.uid();
  if v_uid is null then
    raise exception 'fdh12_apply_retirement_proposal: authentication required';
  end if;
  if p_decision not in ('add_new', 'update_existing', 'apply_selected_fields', 'keep_existing') then
    return jsonb_build_object('ok', false, 'code', 'INVALID_APPLY_MODE', 'error', 'Unrecognised decision.');
  end if;

  select * into v_proposal from fhip_import_proposals where id = p_proposal_id for update;
  if not found or v_proposal.user_id <> v_uid then
    return jsonb_build_object('ok', false, 'code', 'PROPOSAL_NOT_FOUND', 'error', 'That import proposal could not be found.');
  end if;
  if v_proposal.target_domain <> 'retirement' then
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
        then 'This proposal has already been applied to your retirement accounts.'
        else 'That proposal is no longer open.' end
    );
  end if;
  if p_decision <> 'add_new' and v_proposal.target_entity_id is null then
    return jsonb_build_object('ok', false, 'code', 'INVALID_APPLY_MODE', 'error', 'There is no existing retirement account to update.');
  end if;

  if v_proposal.source_retirement_statement_id is not null then
    perform 1 from fdh_retirement_statements
      where id = v_proposal.source_retirement_statement_id
        and user_id = v_uid
        and approval_status = 'approved';
    if not found then
      return jsonb_build_object('ok', false, 'code', 'EVIDENCE_NOT_APPROVED',
        'error', 'Approve the statement evidence before applying it to your retirement accounts.');
    end if;

    -- Resolved EARLY now (moved up from after the compare-and-swap claim,
    -- spec section 30 / FDH15-DEF-002 fix) so it is available for the
    -- member-boundary check below, regardless of apply mode.
    select retirement_member_id into v_member_id from fdh_retirement_statements
      where id = v_proposal.source_retirement_statement_id and user_id = v_uid;
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
    if not ('account_name' = any(v_selected)) or not ('current_balance' = any(v_selected))
       or not ('currency_code' = any(v_selected)) then
      return jsonb_build_object('ok', false, 'code', 'DOMAIN_VALIDATION_FAILED', 'error', 'A new retirement account needs a name, a balance and a currency.');
    end if;
  end if;

  if p_decision <> 'add_new' then
    select * into v_account from retirement_accounts
      where id = v_proposal.target_entity_id and user_id = v_uid for update;
    if not found then
      return jsonb_build_object('ok', false, 'code', 'TARGET_NOT_FOUND', 'error', 'The retirement account this proposal refers to could not be found.');
    end if;

    -- MEMBER/OWNER BOUNDARY (spec section 30, 101; FDH15-DEF-002 fix). A
    -- statement resolved to one household member must never silently update
    -- a DIFFERENT member's account, even within the same tenant. Enforced
    -- here — independent of, and in addition to, proposal-generation-time
    -- matching — so the authoritative Apply RPC itself is the boundary, not
    -- merely the code that built the proposal.
    if v_member_id is not null and v_account.retirement_member_id is not null
       and v_member_id <> v_account.retirement_member_id then
      return jsonb_build_object('ok', false, 'code', 'MEMBER_MISMATCH',
        'error', 'This statement is for a different household member than the account you are updating.');
    end if;

    select (v_account.master_item_key = 'smsf')
           or exists (select 1 from smsf_funds sf where sf.retirement_account_id = v_account.id)
      into v_is_smsf;
    if v_is_smsf then
      return jsonb_build_object('ok', false, 'code', 'SMSF_ACCOUNT_NOT_IMPORTABLE',
        'error', 'This is a self-managed super fund. Update it in the SMSF section, which owns its balance.');
    end if;

    for v_field in
      select pf.field_name, pf.value_kind, pf.existing_value
      from fhip_import_proposal_fields pf
      where pf.proposal_id = p_proposal_id and pf.field_name = any(v_selected)
    loop
      v_live_text := case v_field.field_name
        when 'account_name'            then v_account.account_name
        when 'account_type'            then v_account.account_type
        when 'currency_code'           then v_account.currency_code
        when 'country_code'            then v_account.country_code
        when 'owner'                   then v_account.owner
        when 'contribution_frequency'  then v_account.contribution_frequency
        when 'current_balance'         then case when v_account.current_balance is null then null else round(v_account.current_balance, 2)::text end
        when 'employer_contribution'   then case when v_account.employer_contribution is null then null else round(v_account.employer_contribution, 2)::text end
        when 'personal_contribution'   then case when v_account.personal_contribution is null then null else round(v_account.personal_contribution, 2)::text end
        else null
      end;
      if v_field.value_kind in ('text', 'enum') then
        v_live_text := nullif(trim(both from coalesce(v_live_text, '')), '');
      end if;
      if v_live_text is distinct from v_field.existing_value then
        return jsonb_build_object(
          'ok', false, 'code', 'STALE_PROPOSAL',
          'error', 'Your retirement details changed after this proposal was prepared, so it was not applied.',
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
    return jsonb_build_object('ok', false, 'code', 'ALREADY_APPLIED', 'error', 'This proposal has already been applied to your retirement accounts.');
  end if;

  if p_decision = 'add_new' then
    v_cols := array_cat(array['user_id', 'is_active', 'source_type', 'last_imported_at', 'retirement_member_id'], v_cols);
    v_vals := array_cat(array[
      format('%L::uuid', v_uid), 'true', format('%L', 'retirement_statement_import'),
      'now()', case when v_member_id is null then 'NULL' else format('%L::uuid', v_member_id) end
    ], v_vals);
    execute format('insert into retirement_accounts (%s) values (%s) returning id',
      array_to_string(v_cols, ', '), array_to_string(v_vals, ', ')) into v_target_id;
  else
    v_target_id := v_proposal.target_entity_id;
    execute format('update retirement_accounts set %s, updated_at = now() where id = %L::uuid and user_id = %L::uuid',
      array_to_string(v_set_parts, ', '), v_target_id, v_uid);
  end if;

  insert into fhip_import_applications (
    user_id, proposal_id, target_domain, target_entity_id, apply_mode,
    applied_fields, previous_values, new_values, source_retirement_statement_id, applied_by
  ) values (
    v_uid, p_proposal_id, 'retirement', v_target_id, p_decision,
    to_jsonb(v_applied_fields), v_previous, v_new, v_proposal.source_retirement_statement_id, v_uid
  ) returning id into v_application_id;

  update retirement_accounts
    set source_type = 'retirement_statement_import',
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

revoke all on function fdh12_apply_retirement_proposal(uuid, text, text[]) from public;
grant execute on function fdh12_apply_retirement_proposal(uuid, text, text[]) to authenticated, service_role;

comment on function fdh12_apply_retirement_proposal(uuid, text, text[]) is
  'The ONLY path from retirement statement evidence to canonical Retirement. Writes at most the nine columns in its v_allowed array, on exactly one retirement_accounts row. Cannot write target_retirement_age (spec 61), cannot touch an SMSF row (spec 10), cannot post a statement activity anywhere (spec 60). FDH-15 (migration 0119): resolves the source statement''s household member BEFORE mutating an existing account and refuses the write with MEMBER_MISMATCH if it differs from the target account''s own member — closing FDH15-DEF-002 (Self/Spouse cross-target).';
