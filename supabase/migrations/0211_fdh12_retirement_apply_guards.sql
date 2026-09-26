-- 0211 -- FDH-12 Retirement: confirmation-respecting Apply, paired contribution
-- frequency, INSERT-forgery guards, and user-confirmed bank-leg
-- reclassification (Approved Upload -> Canonical programme, work package WP-13).
--
-- WHAT THIS FIXES (gap ids from APPROVED_UPLOAD_CANONICAL_DATA_FLOW_MATRIX.md):
--
--   GAP-RET-01 / X-01 (P1). The default "Update my existing retirement
--     account" decision sent p_selected_fields = NULL, and the 0112/0119 RPC
--     then selected EVERY proposal field -- including employer_contribution
--     and personal_contribution, which the adapter marks is_recommended =
--     false / requires_confirmation = true and the UI shows UNTICKED. A NULL
--     selection on update_existing now means "the recommended fields that do
--     not need confirmation", nothing more.
--
--   GAP-RET-02 / PO D-12 (P1). A statement PERIOD total was written into a
--     column every consumer reads as a RATE, with no frequency, so an annual
--     $12,000 SG total read as $12,000/month (~12x). The proposal now carries
--     an annualised amount + contribution_frequency = 'annually'; this RPC
--     refuses a contribution amount applied without its frequency, refuses a
--     frequency that is not a rate, and refuses a frequency change that would
--     silently re-mean an existing contribution the user did not also tick.
--
--   GAP-RET-09 (P2). The authoritative-write triggers were BEFORE UPDATE only,
--     while RLS grants "insert own" on all three evidence tables, so an
--     authenticated user could INSERT a statement already approval_status =
--     'approved' with any closing_balance and have it stamped
--     source_type = 'retirement_statement_import'. The only legitimate inserter
--     is the service-role processing service
--     (lib/financial-data-hub/services/retirementStatementProcessingService.ts
--     persistRetirementEvidence -- verified: every .insert on these tables in
--     the repository goes through createAdminClient()). A BEFORE INSERT
--     trigger now refuses the authenticated/anon roles on all three tables.
--     The "insert own" RLS policies are left in place deliberately: the
--     trigger is the single chokepoint, and 0112's policy set stays exactly as
--     tests/unit/fdh12Isolation.test.ts certifies it.
--
--   GAP-RET-05 (P2). extraction_warnings (added by 0207) joins the
--     authoritative column list of the statements UPDATE guard, so a user
--     cannot erase the parser's own record of what it skipped.
--
--   GAP-RET-07 (P2). A personal contribution (or withdrawal / pension payment)
--     matched to a bank leg was only LINKED, never reclassified, so the bank
--     debit stayed a household expense while the fund balance also rose.
--     fdh12_confirm_retirement_bank_leg() is the user's explicit confirmation:
--     it re-verifies the match (own rows, approved statement, direction,
--     currency, amount) and reclassifies the bank leg ONCE through the 0207
--     helper fdh_internal_reclassify_corroborated_leg(). Two new, system-owned
--     columns record the confirmation on the activity row.
--
-- PREDECESSORS (derived from the ledger, not assumed):
--   * fdh12_apply_retirement_proposal: 0112 PART I -> 0119 (FDH15-DEF-002).
--     0120 and 0207 do not touch it. The body below is 0119's, verbatim,
--     except for the four marked "0211" blocks. The SMSF refusal
--     (SMSF_ACCOUNT_NOT_IMPORTABLE, 0112:1362-1368), the MEMBER_MISMATCH guard
--     (0119), the v_allowed allow-list, the staleness loop, the
--     compare-and-swap claim and the provenance stamp are carried unchanged.
--   * fdh12_retirement_statements_assert_authoritative_write: 0112 PART F ->
--     0113 (GUC exemption). Carried verbatim + extraction_warnings.
--   * fdh12_retirement_activities_assert_authoritative_write: 0112 PART F
--     only. Carried verbatim + the GUC exemption (the 0113 pattern, needed so
--     the confirm RPC below can stamp its own columns) + the two new columns.
--   * fdh12_retirement_positions_assert_authoritative_write: untouched.
--
-- NO SHARED CHECK IS WIDENED. No new error_code, no new audit event_type
-- (the reclassification audits 'bank_leg_reclassified_by_import', added by
-- 0207). The only new constraint is on this migration's own new column.
--
-- IDEMPOTENT. add column if not exists, guarded add constraint, create or
-- replace function, drop trigger if exists + create trigger. A second apply is
-- a no-op; proven by scripts/fdh12_0211_pglite_verification.mjs.
--
-- DEPENDS ON 0207 (extraction_warnings column; fdh_internal_reclassify_
-- corroborated_leg). Apply 0207 first.

-- ============================================================================
-- A. Confirmation columns on the activity evidence (GAP-RET-07).
-- ============================================================================
alter table fdh_retirement_statement_activities
  add column if not exists bank_leg_confirmed_at timestamptz,
  add column if not exists bank_leg_confirmed_type text;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'fdh_retirement_statement_activities'::regclass and conname = 'chk_fdh_retirement_activities_bank_leg_confirmed_0211') then
    alter table fdh_retirement_statement_activities add constraint chk_fdh_retirement_activities_bank_leg_confirmed_0211
      check (
        (bank_leg_confirmed_at is null and bank_leg_confirmed_type is null)
        or (bank_leg_confirmed_at is not null and bank_leg_confirmed_type in ('transfer', 'income'))
      );
  end if;
end $$;

comment on column fdh_retirement_statement_activities.bank_leg_confirmed_at is
  'WP-13 (0211): when the user confirmed that the linked bank leg is this retirement movement. Written only by fdh12_confirm_retirement_bank_leg().';
comment on column fdh_retirement_statement_activities.bank_leg_confirmed_type is
  'WP-13 (0211): the economic type the linked bank leg was given on confirmation: transfer (personal contribution, withdrawal) or income (pension payment).';

-- ============================================================================
-- B. INSERT-forgery guard on the three evidence tables (GAP-RET-09).
-- ============================================================================
create or replace function fdh12_retirement_evidence_assert_authoritative_insert() returns trigger as $$
begin
  -- A SECURITY DEFINER FDH-12 function performing its own sanctioned write.
  if coalesce(current_setting('fhip.import_bridge_internal_write', true), 'false') = 'true' then
    return new;
  end if;
  if coalesce(auth.role(), '') in ('authenticated', 'anon') then
    raise exception '% is system-authoritative retirement statement evidence: rows may only be created by trusted server-side processing', tg_table_name;
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists trg_fdh_retirement_statements_authoritative_insert on fdh_retirement_statements;
create trigger trg_fdh_retirement_statements_authoritative_insert
  before insert on fdh_retirement_statements
  for each row execute function fdh12_retirement_evidence_assert_authoritative_insert();

drop trigger if exists trg_fdh_retirement_activities_authoritative_insert on fdh_retirement_statement_activities;
create trigger trg_fdh_retirement_activities_authoritative_insert
  before insert on fdh_retirement_statement_activities
  for each row execute function fdh12_retirement_evidence_assert_authoritative_insert();

drop trigger if exists trg_fdh_retirement_positions_authoritative_insert on fdh_retirement_statement_positions;
create trigger trg_fdh_retirement_positions_authoritative_insert
  before insert on fdh_retirement_statement_positions
  for each row execute function fdh12_retirement_evidence_assert_authoritative_insert();

-- ============================================================================
-- C. UPDATE guards: extraction_warnings (GAP-RET-05) and the new
--    confirmation columns (GAP-RET-07).
-- ============================================================================
create or replace function fdh12_retirement_statements_assert_authoritative_write() returns trigger as $$
begin
  if coalesce(current_setting('fhip.import_bridge_internal_write', true), 'false') = 'true' then
    return new;
  end if;
  if auth.role() <> 'authenticated' then
    return new;
  end if;
  if new.user_id is distinct from old.user_id
     or new.statement_upload_id is distinct from old.statement_upload_id
     or new.canonical_account_id is distinct from old.canonical_account_id
     or new.retirement_member_id is distinct from old.retirement_member_id
     or new.statement_type is distinct from old.statement_type
     or new.retirement_jurisdiction is distinct from old.retirement_jurisdiction
     or new.account_type is distinct from old.account_type
     or new.currency_code is distinct from old.currency_code
     or new.opening_balance is distinct from old.opening_balance
     or new.closing_balance is distinct from old.closing_balance
     or new.employer_contributions is distinct from old.employer_contributions
     or new.personal_contributions is distinct from old.personal_contributions
     or new.salary_sacrifice is distinct from old.salary_sacrifice
     or new.government_contributions is distinct from old.government_contributions
     or new.rollovers_in is distinct from old.rollovers_in
     or new.rollovers_out is distinct from old.rollovers_out
     or new.withdrawals is distinct from old.withdrawals
     or new.pension_payments is distinct from old.pension_payments
     or new.investment_earnings is distinct from old.investment_earnings
     or new.fees is distinct from old.fees
     or new.insurance_premiums is distinct from old.insurance_premiums
     or new.tax is distinct from old.tax
     or new.ytd_employer_contributions is distinct from old.ytd_employer_contributions
     or new.ytd_personal_contributions is distinct from old.ytd_personal_contributions
     or new.parser is distinct from old.parser
     or new.parser_version is distinct from old.parser_version
     or new.extraction_confidence is distinct from old.extraction_confidence
     or new.extraction_status is distinct from old.extraction_status
     or new.reconciliation_status is distinct from old.reconciliation_status
     or new.reconciliation_variance is distinct from old.reconciliation_variance
     or new.account_match_status is distinct from old.account_match_status
     or new.account_match_candidates is distinct from old.account_match_candidates
     or new.smsf_classification is distinct from old.smsf_classification
     or new.smsf_evidence is distinct from old.smsf_evidence
     or new.approval_status is distinct from old.approval_status
     or new.approved_at is distinct from old.approved_at
     or new.approved_by is distinct from old.approved_by
     or new.duplicate_of_statement_id is distinct from old.duplicate_of_statement_id
     -- 0211 (GAP-RET-05): the parser's record of what it skipped.
     or new.extraction_warnings is distinct from old.extraction_warnings
  then
    raise exception 'fdh_retirement_statements: this field is system-authoritative and may not be written directly by the authenticated role';
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create or replace function fdh12_retirement_activities_assert_authoritative_write() returns trigger as $$
begin
  -- 0211: a SECURITY DEFINER FDH-12 function performing its own sanctioned
  -- write (fdh12_confirm_retirement_bank_leg). The 0113 pattern.
  if coalesce(current_setting('fhip.import_bridge_internal_write', true), 'false') = 'true' then
    return new;
  end if;
  if auth.role() <> 'authenticated' then
    return new;
  end if;
  if new.user_id is distinct from old.user_id
     or new.statement_id is distinct from old.statement_id
     or new.activity_type is distinct from old.activity_type
     or new.amount is distinct from old.amount
     or new.currency_code is distinct from old.currency_code
     or new.activity_date is distinct from old.activity_date
     or new.effective_period_start is distinct from old.effective_period_start
     or new.effective_period_end is distinct from old.effective_period_end
     or new.employer_normalised is distinct from old.employer_normalised
     or new.is_summary_total is distinct from old.is_summary_total
     or new.is_year_to_date is distinct from old.is_year_to_date
     or new.payslip_match_status is distinct from old.payslip_match_status
     or new.matched_payroll_event_id is distinct from old.matched_payroll_event_id
     or new.payslip_match_variance is distinct from old.payslip_match_variance
     or new.payslip_match_candidates is distinct from old.payslip_match_candidates
     or new.bank_match_status is distinct from old.bank_match_status
     or new.linked_transaction_id is distinct from old.linked_transaction_id
     or new.bank_match_candidates is distinct from old.bank_match_candidates
     or new.rollover_counterpart_activity_id is distinct from old.rollover_counterpart_activity_id
     or new.rollover_match_status is distinct from old.rollover_match_status
     or new.activity_fingerprint is distinct from old.activity_fingerprint
     or new.duplicate_of_activity_id is distinct from old.duplicate_of_activity_id
     -- 0211 (GAP-RET-07)
     or new.bank_leg_confirmed_at is distinct from old.bank_leg_confirmed_at
     or new.bank_leg_confirmed_type is distinct from old.bank_leg_confirmed_type
  then
    raise exception 'fdh_retirement_statement_activities: this field is system-authoritative and may not be written directly by the authenticated role';
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

-- ============================================================================
-- D. fdh12_apply_retirement_proposal -- 0119 + the 0211 blocks.
-- ============================================================================
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
  v_rate_frequencies constant text[] := array['weekly', 'fortnightly', 'monthly', 'quarterly', 'annually'];
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
  v_frequency text;
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

    select retirement_member_id into v_member_id from fdh_retirement_statements
      where id = v_proposal.source_retirement_statement_id and user_id = v_uid;
  end if;

  -- 0211 (GAP-RET-01 / X-01): a NULL or empty selection on update_existing
  -- means "the fields the proposal RECOMMENDS and that need NO confirmation"
  -- -- exactly the boxes the review screen ticks by default. It used to mean
  -- every proposal field, which silently applied the confirmation-gated
  -- contribution amounts the user had left unticked.
  if p_decision = 'update_existing' and (p_selected_fields is null or array_length(p_selected_fields, 1) is null) then
    select array_agg(field_name) into v_selected from fhip_import_proposal_fields
      where proposal_id = p_proposal_id and is_recommended and not requires_confirmation;
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

  -- 0211 (GAP-RET-02 / D-12): a contribution AMOUNT is meaningless without
  -- how often it is paid -- every consumer reads it as a rate. Never apply one
  -- without the other, and never apply a frequency that is not a rate.
  if (('employer_contribution' = any(v_selected)) or ('personal_contribution' = any(v_selected)))
     and not ('contribution_frequency' = any(v_selected)) then
    return jsonb_build_object('ok', false, 'code', 'DOMAIN_VALIDATION_FAILED',
      'error', 'A contribution amount can only be applied together with how often it is paid. Tick the contribution frequency as well.',
      'field', 'contribution_frequency');
  end if;
  if 'contribution_frequency' = any(v_selected) then
    select proposed_value into v_frequency from fhip_import_proposal_fields
      where proposal_id = p_proposal_id and field_name = 'contribution_frequency';
    if v_frequency is null or not (v_frequency = any(v_rate_frequencies)) then
      return jsonb_build_object('ok', false, 'code', 'DOMAIN_VALIDATION_FAILED',
        'error', 'The contribution frequency on this statement is not a regular rate, so it cannot be applied.',
        'field', 'contribution_frequency');
    end if;
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

    -- MEMBER/OWNER BOUNDARY (0119, FDH15-DEF-002) -- carried unchanged.
    if v_member_id is not null and v_account.retirement_member_id is not null
       and v_member_id <> v_account.retirement_member_id then
      return jsonb_build_object('ok', false, 'code', 'MEMBER_MISMATCH',
        'error', 'This statement is for a different household member than the account you are updating.');
    end if;

    -- SMSF BOUNDARY (0112:1362-1368, kept in 0119) -- carried verbatim.
    select (v_account.master_item_key = 'smsf')
           or exists (select 1 from smsf_funds sf where sf.retirement_account_id = v_account.id)
      into v_is_smsf;
    if v_is_smsf then
      return jsonb_build_object('ok', false, 'code', 'SMSF_ACCOUNT_NOT_IMPORTABLE',
        'error', 'This is a self-managed super fund. Update it in the SMSF section, which owns its balance.');
    end if;

    -- 0211 (GAP-RET-02): contribution_frequency is shared by BOTH contribution
    -- columns. Changing it re-means any existing contribution the user did not
    -- also tick (a manual $1,000 monthly would silently become $1,000 a year).
    if 'contribution_frequency' = any(v_selected)
       and v_frequency is distinct from v_account.contribution_frequency then
      if coalesce(v_account.employer_contribution, 0) <> 0 and not ('employer_contribution' = any(v_selected)) then
        return jsonb_build_object('ok', false, 'code', 'DOMAIN_VALIDATION_FAILED',
          'error', 'Changing how often contributions are paid would change the meaning of your existing employer contribution. Tick the employer contribution as well so it is restated at the new frequency.',
          'field', 'employer_contribution');
      end if;
      if coalesce(v_account.personal_contribution, 0) <> 0 and not ('personal_contribution' = any(v_selected)) then
        return jsonb_build_object('ok', false, 'code', 'DOMAIN_VALIDATION_FAILED',
          'error', 'Changing how often contributions are paid would change the meaning of your existing personal contribution. Tick the personal contribution as well so it is restated at the new frequency.',
          'field', 'personal_contribution');
      end if;
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
-- 0211: also revoke the explicit anon grant Supabase's default privileges add
-- to every new function (0119 revoked PUBLIC only). Harmless before -- the body
-- raises without auth.uid() -- but an anonymous caller has no reason to reach it.
revoke all on function fdh12_apply_retirement_proposal(uuid, text, text[]) from anon;
grant execute on function fdh12_apply_retirement_proposal(uuid, text, text[]) to authenticated, service_role;

comment on function fdh12_apply_retirement_proposal(uuid, text, text[]) is
  'The ONLY path from retirement statement evidence to canonical Retirement. Writes at most the nine columns in its v_allowed array, on exactly one retirement_accounts row. Cannot write target_retirement_age, cannot touch an SMSF row, cannot post a statement activity anywhere. 0119: MEMBER_MISMATCH. 0211 (WP-13): a NULL selection on update_existing applies only recommended, confirmation-free fields; a contribution amount is refused without its frequency; a frequency change is refused if it would re-mean an existing contribution the user did not also tick.';

-- ============================================================================
-- E. fdh12_confirm_retirement_bank_leg -- the user's explicit confirmation
--    that a matched bank leg IS this retirement movement (GAP-RET-07).
--
--   PERSONAL_CONTRIBUTION (bank debit)  -> 'transfer'  (money moved into super;
--                                                        not household spending)
--   WITHDRAWAL            (bank credit) -> 'transfer'  (the member's own capital
--                                                        moved out of super)
--   PENSION_PAYMENT       (bank credit) -> 'income'    (the retiree's regular
--                                                        income stream, counted
--                                                        ONCE, via the bank leg)
--
-- Re-verifies everything the matcher decided, against live rows: own activity,
-- approved non-SMSF statement, a one-to-one 'matched' link, a real movement
-- (not a summary/YTD/duplicate line), the bank leg's direction, currency and
-- amount (within 0.01). Reclassifies through fdh_internal_reclassify_
-- corroborated_leg() -- which never overrides a leg the user categorised
-- themselves (user_override) and records the correction + audit event -- then
-- stamps the activity. Idempotent: a second call returns ALREADY_CONFIRMED.
-- ============================================================================
create or replace function fdh12_confirm_retirement_bank_leg(p_activity_id uuid) returns jsonb as $$
declare
  v_uid uuid;
  v_act record;
  v_stmt record;
  v_txn record;
  v_expected_direction text;
  v_new_type text;
  v_outcome text;
begin
  v_uid := auth.uid();
  if v_uid is null then
    raise exception 'fdh12_confirm_retirement_bank_leg: authentication required';
  end if;

  select * into v_act from fdh_retirement_statement_activities
    where id = p_activity_id and user_id = v_uid for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'error', 'That statement line could not be found.');
  end if;
  if v_act.bank_leg_confirmed_at is not null then
    return jsonb_build_object('ok', true, 'code', 'ALREADY_CONFIRMED', 'new_type', v_act.bank_leg_confirmed_type,
      'transaction_id', v_act.linked_transaction_id);
  end if;

  select id, approval_status, smsf_classification into v_stmt from fdh_retirement_statements
    where id = v_act.statement_id and user_id = v_uid;
  if not found or v_stmt.approval_status <> 'approved' then
    return jsonb_build_object('ok', false, 'code', 'EVIDENCE_NOT_APPROVED',
      'error', 'Approve the statement before confirming its bank payments.');
  end if;
  if v_stmt.smsf_classification <> 'not_smsf' then
    return jsonb_build_object('ok', false, 'code', 'SMSF_ACCOUNT_NOT_IMPORTABLE',
      'error', 'This is a self-managed super fund statement. It is managed in the SMSF section.');
  end if;

  v_expected_direction := case v_act.activity_type
    when 'PERSONAL_CONTRIBUTION' then 'debit'
    when 'WITHDRAWAL' then 'credit'
    when 'PENSION_PAYMENT' then 'credit'
    else null end;
  v_new_type := case v_act.activity_type
    when 'PERSONAL_CONTRIBUTION' then 'transfer'
    when 'WITHDRAWAL' then 'transfer'
    when 'PENSION_PAYMENT' then 'income'
    else null end;
  if v_expected_direction is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_A_BANK_MOVEMENT',
      'error', 'This kind of statement line never moves money through your bank account.');
  end if;
  if v_act.is_summary_total or v_act.is_year_to_date or v_act.duplicate_of_activity_id is not null then
    return jsonb_build_object('ok', false, 'code', 'NOT_A_BANK_MOVEMENT',
      'error', 'This line is a total or a repeat of another line, not a payment of its own.');
  end if;
  if v_act.bank_match_status <> 'matched' or v_act.linked_transaction_id is null then
    return jsonb_build_object('ok', false, 'code', 'NO_BANK_MATCH',
      'error', 'There is no matched bank payment for this line to confirm.');
  end if;

  select id, credit_debit, currency_original, amount_original into v_txn from fdh_transactions
    where id = v_act.linked_transaction_id and user_id = v_uid;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NO_BANK_MATCH',
      'error', 'The matched bank payment could not be found.');
  end if;
  if v_txn.credit_debit is distinct from v_expected_direction
     or v_txn.currency_original is distinct from v_act.currency_code
     or abs(v_txn.amount_original - v_act.amount) > 0.01 then
    return jsonb_build_object('ok', false, 'code', 'BANK_MATCH_INCONSISTENT',
      'error', 'The matched bank payment does not agree with this statement line (direction, currency or amount), so it was not changed.');
  end if;

  v_outcome := fdh_internal_reclassify_corroborated_leg(
    v_uid, v_txn.id, v_new_type,
    'retirement_' || lower(v_act.activity_type) || '_confirmed_by_user',
    'retirement_statement_activity', v_act.id);

  perform set_config('fhip.import_bridge_internal_write', 'true', true);
  update fdh_retirement_statement_activities
    set bank_leg_confirmed_at = now(), bank_leg_confirmed_type = v_new_type, updated_at = now()
    where id = v_act.id and user_id = v_uid and bank_leg_confirmed_at is null;
  perform set_config('fhip.import_bridge_internal_write', 'false', true);

  return jsonb_build_object('ok', true, 'code', 'CONFIRMED', 'outcome', v_outcome,
    'new_type', v_new_type, 'transaction_id', v_txn.id);
end;
$$ language plpgsql security definer set search_path = public;

revoke all on function fdh12_confirm_retirement_bank_leg(uuid) from public;
revoke all on function fdh12_confirm_retirement_bank_leg(uuid) from anon;
grant execute on function fdh12_confirm_retirement_bank_leg(uuid) to authenticated, service_role;

comment on function fdh12_confirm_retirement_bank_leg(uuid) is
  'WP-13 (0211, GAP-RET-07): the user''s confirmation that a matched bank leg is a retirement movement. Re-verifies the match and reclassifies the bank leg once (personal contribution / withdrawal -> transfer; pension payment -> income) through fdh_internal_reclassify_corroborated_leg(). Never touches a leg the user categorised themselves. Idempotent.';
