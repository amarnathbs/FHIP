-- =============================================================================
-- 0210 -- Approved Upload -> Canonical User Data programme, WP-09:
-- payslip -> Income apply guards (event-level idempotency, currency, the
-- spouse path, bank re-match, revised payslips).
-- =============================================================================
--
-- WHAT THIS CLOSES (gap ids from APPROVED_UPLOAD_CANONICAL_DATA_FLOW_MATRIX.md):
--
--   GAP-04  Idempotency was per PROPOSAL. After a proposal was applied, a new
--           'ready' proposal could be generated for the same payroll event
--           and, with no employer name on the payslip, add a SECOND Salary
--           row. Now: (a) the apply RPC refuses ALREADY_APPLIED when any
--           application already names this payroll event for Income, and (b)
--           a partial UNIQUE index on fhip_import_applications
--           (source_payroll_event_id) WHERE target_domain = 'income' is the
--           un-bypassable backstop. The payroll event row is locked FOR UPDATE
--           first, so two different proposals of one event serialise.
--   GAP-03  update_existing never compared currencies, so an INR payslip
--           could overwrite an AUD row's amount. Now CURRENCY_MISMATCH.
--   GAP-05  Every payslip was 'self': the RPC hard-coded owner = 'self' on
--           add_new and refused any non-self target. The owner now comes from
--           fdh_payroll_events.income_owner (0207), chosen by the user and
--           stamped at approval (fdh9_approve_payroll_event below): add_new
--           uses it, update requires target.owner = event owner (the 0120
--           MEMBER_MISMATCH guard, generalised). A null owner (every event
--           approved before this migration) means 'self' -- exactly the old
--           behaviour.
--   X-01    update_existing with no field list applied EVERY proposal field,
--           including ones the proposal itself marked "please confirm"
--           (an inferred frequency). Now only is_recommended AND NOT
--           requires_confirmation fields are applied by default.
--   GAP-10  Bank matching ran once, at payslip processing. A bank statement
--           approved later never linked. fdh9_restamp_payroll_bank_match is
--           the narrow RPC the post-bank-approval matcher calls (the
--           bank_match_* columns are trigger-locked, 0091 D.4 / 0185).
--   GAP-15  superseded_by_payroll_event_id had no writer. fdh9_supersede_
--           payroll_event links a revised payslip (same employer, same period,
--           different content) to the one it replaces, moves the bank match
--           when it is the same deposit, and supersedes the old event's open
--           proposals.
--   GAP-16 / review gate  fdh9_approve_payroll_event approved a 'pending'
--           review in one click. It now requires the review to be
--           acknowledged (p_acknowledge_review) and records it as 'resolved'.
--   master_item_key  A payslip add_new row had no master_item_key, so it was
--           an unclassified custom row. It is now 'employment_salary' when the
--           user has no row with that key yet (unique (user_id,
--           master_item_key), migration 0004), otherwise null.
--
-- PREDECESSORS, DERIVED FROM THE LEDGER (grep of every migration, not assumed):
--   fdh9_apply_income_proposal(uuid, text, text[])      0091 -> 0120 (latest)
--   fdh9_approve_payroll_event(uuid)                     0091 (never replaced)
--   fdh9_payroll_events_assert_authoritative_write()     0091 -> 0185 (latest)
-- Each body below starts from that latest predecessor. The trigger's protected
-- column list is 0185's list VERBATIM plus income_owner (a strict superset --
-- proven by scripts/fdh9_0210_pglite_verification.mjs, which fails if any 0185
-- column became writable).
--
-- PRIVILEGES. Every function here is revoked from public AND anon (Supabase's
-- default privileges grant anon EXECUTE on new public functions; 0091/0120
-- revoked only from public). anon could never do anything -- each body raises
-- without auth.uid() -- but the grant was never intended.
--
-- NOT TOUCHED: every shared CHECK constraint. The two audit event types used
-- here (payroll_bank_match_restamped, payroll_event_superseded) were added by
-- 0207, which owns that widening. No column is added.
--
-- PREFLIGHT (the unique index). If an environment already holds two Income
-- applications for one payroll event (the GAP-04 defect happened), the DO
-- block below REFUSES to run and names the count. The PO runs the report in
-- scripts/fdh9_0210_duplicate_income_applications_report.sql first; it lists
-- every duplicate and contains the prepared cleanup statement. Nothing here
-- rewrites data.
--
-- IDEMPOTENT: create or replace / create index if not exists / drop function
-- if exists (the old one-argument approve signature only). A second apply is
-- a no-op (proven by the PGlite script).
-- =============================================================================


-- ============================================================================
-- A. Event-level idempotency: one Income application per payroll event.
-- ============================================================================
do $$
declare
  v_dupes integer;
begin
  select count(*) into v_dupes from (
    select source_payroll_event_id
    from fhip_import_applications
    where target_domain = 'income' and source_payroll_event_id is not null
    group by source_payroll_event_id
    having count(*) > 1
  ) d;
  if v_dupes > 0 then
    raise exception '0210 preflight: % payroll event(s) already have more than one Income application (GAP-04 duplicates). Run scripts/fdh9_0210_duplicate_income_applications_report.sql, resolve them, then re-run 0210.', v_dupes;
  end if;
end $$;

create unique index if not exists uq_fhip_import_applications_income_payroll_event_0210
  on fhip_import_applications(source_payroll_event_id)
  where target_domain = 'income' and source_payroll_event_id is not null;


-- ============================================================================
-- B. The authoritative-write trigger: 0185's protected set + income_owner.
-- ============================================================================
create or replace function fdh9_payroll_events_assert_authoritative_write() returns trigger as $$
declare
  v_internal boolean := coalesce(current_setting('fhip.import_bridge_internal_write', true), 'false') = 'true';
begin
  if v_internal then
    return new;
  end if;

  if new.user_id is distinct from old.user_id
     or new.household_id is distinct from old.household_id
     or new.statement_upload_id is distinct from old.statement_upload_id
     or new.country_code is distinct from old.country_code
     or new.currency_code is distinct from old.currency_code
     or new.pay_period_start is distinct from old.pay_period_start
     or new.pay_period_end is distinct from old.pay_period_end
     or new.payment_date is distinct from old.payment_date
     or new.pay_frequency is distinct from old.pay_frequency
     or new.pay_frequency_source is distinct from old.pay_frequency_source
     or new.gross_pay is distinct from old.gross_pay
     or new.base_pay is distinct from old.base_pay
     or new.overtime_pay is distinct from old.overtime_pay
     or new.bonus_pay is distinct from old.bonus_pay
     or new.commission_pay is distinct from old.commission_pay
     or new.allowances_total is distinct from old.allowances_total
     or new.reimbursements_total is distinct from old.reimbursements_total
     or new.other_earnings is distinct from old.other_earnings
     or new.tax_withheld is distinct from old.tax_withheld
     or new.employee_deductions_total is distinct from old.employee_deductions_total
     or new.salary_sacrifice is distinct from old.salary_sacrifice
     or new.professional_tax is distinct from old.professional_tax
     or new.employer_retirement_contribution is distinct from old.employer_retirement_contribution
     or new.employee_retirement_contribution is distinct from old.employee_retirement_contribution
     or new.employer_nps_contribution is distinct from old.employer_nps_contribution
     or new.employee_nps_contribution is distinct from old.employee_nps_contribution
     or new.net_pay is distinct from old.net_pay
     or new.ytd_gross is distinct from old.ytd_gross
     or new.ytd_tax is distinct from old.ytd_tax
     or new.ytd_net is distinct from old.ytd_net
     or new.ytd_employer_retirement is distinct from old.ytd_employer_retirement
     or new.ytd_employee_retirement is distinct from old.ytd_employee_retirement
     or new.parser_name is distinct from old.parser_name
     or new.parser_version is distinct from old.parser_version
     or new.extraction_confidence is distinct from old.extraction_confidence
     or new.reconciliation_status is distinct from old.reconciliation_status
     or new.reconciliation_variance is distinct from old.reconciliation_variance
     or new.bank_match_status is distinct from old.bank_match_status
     or new.bank_match_transaction_id is distinct from old.bank_match_transaction_id
     or new.bank_match_confidence is distinct from old.bank_match_confidence
     or new.review_status is distinct from old.review_status
     or new.approval_status is distinct from old.approval_status
     or new.approved_at is distinct from old.approved_at
     or new.approved_by is distinct from old.approved_by
     or new.superseded_by_payroll_event_id is distinct from old.superseded_by_payroll_event_id
     or new.payslip_fingerprint is distinct from old.payslip_fingerprint
     -- Added by migration 0185.
     or new.gross_pay_source is distinct from old.gross_pay_source
     or new.user_corrected_fields is distinct from old.user_corrected_fields
     or new.last_corrected_at is distinct from old.last_corrected_at
     or new.last_corrected_by is distinct from old.last_corrected_by
     -- Added by migration 0210 (GAP-05). Whose income this payslip is decides
     -- which household member's Income row it may create or update; it is set
     -- only by fdh9_approve_payroll_event.
     or new.income_owner is distinct from old.income_owner
  then
    raise exception 'fdh_payroll_events: this field is system-authoritative and may not be written directly by the authenticated role';
  end if;

  return new;
end;
$$ language plpgsql security definer set search_path = public;


-- ============================================================================
-- C. fdh9_approve_payroll_event: owner + review acknowledgement.
--    The one-argument signature is dropped so no caller can reach the old,
--    ungated approval; every existing call (named p_payroll_event_id only)
--    resolves to this function through the defaults.
-- ============================================================================
drop function if exists fdh9_approve_payroll_event(uuid);

create or replace function fdh9_approve_payroll_event(
  p_payroll_event_id uuid,
  p_income_owner text default null,
  p_acknowledge_review boolean default false
) returns jsonb as $$
declare
  v_uid uuid;
  v_event record;
  v_owner text;
begin
  v_uid := auth.uid();
  if v_uid is null then
    raise exception 'fdh9_approve_payroll_event: authentication required';
  end if;

  if p_income_owner is not null and p_income_owner not in ('self', 'spouse') then
    return jsonb_build_object('ok', false, 'code', 'INVALID_OWNER', 'error', 'Choose whose payslip this is: yours or your spouse''s.');
  end if;

  select * into v_event from fdh_payroll_events where id = p_payroll_event_id for update;
  if not found or v_event.user_id <> v_uid then
    return jsonb_build_object('ok', false, 'code', 'PROPOSAL_NOT_FOUND', 'error', 'That payroll event could not be found.');
  end if;

  if v_event.approval_status = 'approved' then
    -- Idempotent re-click. The owner is fixed at approval and never moves
    -- afterwards (it decides which Income row the payslip may touch).
    if p_income_owner is not null and p_income_owner is distinct from coalesce(v_event.income_owner, 'self') then
      return jsonb_build_object('ok', false, 'code', 'OWNER_LOCKED', 'error', 'This payslip was already approved for a different household member.');
    end if;
    return jsonb_build_object('ok', true, 'outcome', 'already_approved', 'approved_at', v_event.approved_at, 'income_owner', coalesce(v_event.income_owner, 'self'));
  end if;

  if v_event.superseded_by_payroll_event_id is not null then
    return jsonb_build_object('ok', false, 'code', 'EVENT_SUPERSEDED', 'error', 'A revised version of this payslip has replaced it.');
  end if;

  -- REVIEW GATE. A payslip whose figures did not add up, whose columns were
  -- ambiguous or which matched two deposits carries review_status 'pending'
  -- (or 'in_review' after a correction). It can still be approved -- the user
  -- may know better -- but only as an explicit acknowledgement, never one
  -- unexamined click.
  if v_event.review_status in ('pending', 'in_review') and not coalesce(p_acknowledge_review, false) then
    return jsonb_build_object('ok', false, 'code', 'REVIEW_REQUIRED',
      'error', 'Some figures on this payslip need your check. Confirm you have reviewed them before approving.',
      'review_status', v_event.review_status);
  end if;

  v_owner := coalesce(p_income_owner, v_event.income_owner, 'self');

  perform set_config('fhip.import_bridge_internal_write', 'true', true);
  update fdh_payroll_events
    set approval_status = 'approved', approved_at = now(), approved_by = v_uid,
        income_owner = v_owner,
        review_status = case when review_status in ('pending', 'in_review') then 'resolved' else review_status end
    where id = p_payroll_event_id;
  perform set_config('fhip.import_bridge_internal_write', 'false', true);

  return jsonb_build_object('ok', true, 'outcome', 'approved', 'income_owner', v_owner,
    'review_acknowledged', v_event.review_status in ('pending', 'in_review'));
end;
$$ language plpgsql security definer set search_path = public;

revoke all on function fdh9_approve_payroll_event(uuid, text, boolean) from public, anon;
grant execute on function fdh9_approve_payroll_event(uuid, text, boolean) to authenticated, service_role;


-- ============================================================================
-- D. fdh9_apply_income_proposal (predecessor 0120).
--    Unchanged from 0120 except the blocks marked "0210".
-- ============================================================================
create or replace function fdh9_apply_income_proposal(
  p_proposal_id uuid,
  p_decision text,
  p_selected_fields text[] default null
) returns jsonb as $$
declare
  v_uid uuid;
  v_proposal record;
  v_income record;
  v_event record;
  v_existing_application record;
  v_owner text := 'self';
  v_master_key text;
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

  -- 0210 (GAP-04, GAP-05, GAP-15): the payroll event behind the proposal.
  -- Locked FOR UPDATE so two different proposals of the SAME event serialise
  -- here; the second then sees the first one's application below.
  if v_proposal.source_kind = 'payslip' and v_proposal.source_payroll_event_id is not null then
    select * into v_event from fdh_payroll_events
      where id = v_proposal.source_payroll_event_id and user_id = v_uid
      for update;
    if not found then
      return jsonb_build_object('ok', false, 'code', 'PROPOSAL_NOT_ACTIONABLE', 'error', 'The payslip behind this proposal could not be found.');
    end if;
    if v_event.approval_status <> 'approved' then
      return jsonb_build_object('ok', false, 'code', 'PROPOSAL_NOT_ACTIONABLE', 'error', 'Approve this payslip before applying it to your income.');
    end if;
    if v_event.superseded_by_payroll_event_id is not null then
      return jsonb_build_object('ok', false, 'code', 'PROPOSAL_NOT_ACTIONABLE', 'error', 'A revised version of this payslip has replaced it. Apply the revised payslip instead.');
    end if;
    select * into v_existing_application from fhip_import_applications
      where source_payroll_event_id = v_event.id and target_domain = 'income' and user_id = v_uid
      order by applied_at
      limit 1;
    if found then
      return jsonb_build_object('ok', false, 'code', 'ALREADY_APPLIED',
        'error', 'This payslip is already in your income.',
        'target_entity_id', v_existing_application.target_entity_id,
        'application_id', v_existing_application.id);
    end if;
    v_owner := coalesce(v_event.income_owner, 'self');
  end if;

  if p_decision <> 'add_new' and v_proposal.target_entity_id is null then
    return jsonb_build_object('ok', false, 'code', 'INVALID_APPLY_MODE', 'error', 'There is no existing entry to update.');
  end if;

  if p_decision = 'update_existing' and (p_selected_fields is null or array_length(p_selected_fields, 1) is null) then
    -- 0210 (X-01): "every field" means every field the proposal RECOMMENDS
    -- and does not ask the user to confirm. A field marked "please confirm"
    -- (e.g. a frequency inferred from one payslip) is applied only when the
    -- user ticks it explicitly (apply_selected_fields).
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

    -- MEMBER/OWNER BOUNDARY. 0120 required a self-owned target; 0210
    -- (GAP-05) generalises it: the target must belong to the household
    -- member the payslip was approved for (self when never chosen).
    if v_proposal.source_kind = 'payslip' and v_income.owner is distinct from v_owner then
      return jsonb_build_object('ok', false, 'code', 'MEMBER_MISMATCH',
        'error', 'This payslip is for a different household member than the income entry you are updating.');
    end if;

    -- 0210 (GAP-03): never write one currency's figures into another
    -- currency's row. The user can add the payslip as a new income source.
    if v_proposal.currency_code is not null and v_income.currency_code is distinct from v_proposal.currency_code then
      return jsonb_build_object('ok', false, 'code', 'CURRENCY_MISMATCH',
        'error', format('This payslip is in %s but the income entry is in %s, so it was not updated. Add the payslip as a new income source instead.', v_proposal.currency_code, v_income.currency_code),
        'proposal_currency', v_proposal.currency_code, 'target_currency', v_income.currency_code);
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
    elsif v_kind = 'bool' then
      -- Restored from 0091 (0120 dropped this branch; the untyped literal
      -- happened to coerce, but the cast is the explicit contract).
      v_set_parts := array_append(v_set_parts, format('%I = %L::boolean', v_field.field_name, (v_field.proposed_value = 'true')));
      v_cols := array_append(v_cols, v_field.field_name);
      v_vals := array_append(v_vals, format('%L::boolean', (v_field.proposed_value = 'true')));
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
    -- 0210: classify a new payslip salary row under the Employment Salary
    -- catalogue item when that slot is free (unique (user_id,
    -- master_item_key), 0004); otherwise it stays a custom salary row.
    v_master_key := null;
    if v_proposal.source_kind = 'payslip'
       and exists (select 1 from fhip_import_proposal_fields where proposal_id = p_proposal_id and field_name = 'income_type' and proposed_value = 'salary' and field_name = any(v_selected))
       and not exists (select 1 from income_sources where user_id = v_uid and master_item_key = 'employment_salary') then
      v_master_key := 'employment_salary';
    end if;
    v_cols := array_prepend('master_item_key', array_prepend('last_imported_at', array_prepend('source_type', array_prepend('is_active', array_prepend('owner', array_prepend('user_id', v_cols))))));
    v_vals := array_prepend(coalesce(format('%L', v_master_key), 'NULL'), array_prepend('now()', array_prepend(format('%L', 'payslip_import'), array_prepend('true', array_prepend(format('%L', v_owner), array_prepend(format('%L::uuid', v_uid), v_vals))))));
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
    'applied_fields', to_jsonb(v_applied_fields), 'owner', v_owner
  );
end;
$$ language plpgsql security definer set search_path = public;

revoke all on function fdh9_apply_income_proposal(uuid, text, text[]) from public, anon;
grant execute on function fdh9_apply_income_proposal(uuid, text, text[]) to authenticated, service_role;

comment on function fdh9_apply_income_proposal(uuid, text, text[]) is
  'The ONLY path from payslip evidence to canonical Income. Writes at most the eight columns in its v_allowed array (plus the add_new base columns), on exactly one income_sources row. 0210: one Income application per payroll event (ALREADY_APPLIED + partial unique index), owner = the payroll event''s income_owner (MEMBER_MISMATCH otherwise), CURRENCY_MISMATCH on a cross-currency update, default field set excludes requires_confirmation fields, superseded or unapproved evidence is not actionable.';


-- ============================================================================
-- E. fdh9_restamp_payroll_bank_match (GAP-10): link a payslip to a bank
--    salary credit that was approved AFTER the payslip was processed.
-- ============================================================================
create or replace function fdh9_restamp_payroll_bank_match(
  p_payroll_event_id uuid,
  p_transaction_id uuid,
  p_confidence numeric default null
) returns jsonb as $$
declare
  v_uid uuid;
  v_event record;
  v_txn record;
  v_conf numeric;
begin
  v_uid := auth.uid();
  if v_uid is null then
    raise exception 'fdh9_restamp_payroll_bank_match: authentication required';
  end if;

  select * into v_event from fdh_payroll_events where id = p_payroll_event_id for update;
  if not found or v_event.user_id <> v_uid then
    return jsonb_build_object('ok', false, 'code', 'PAYROLL_EVENT_NOT_FOUND');
  end if;
  if v_event.superseded_by_payroll_event_id is not null then
    return jsonb_build_object('ok', false, 'code', 'EVENT_SUPERSEDED');
  end if;
  if v_event.bank_match_status = 'matched' then
    if v_event.bank_match_transaction_id = p_transaction_id then
      return jsonb_build_object('ok', true, 'outcome', 'already_matched');
    end if;
    -- Never re-point an existing match: that is a user decision, not a sweep.
    return jsonb_build_object('ok', false, 'code', 'ALREADY_MATCHED');
  end if;
  if v_event.net_pay is null then
    return jsonb_build_object('ok', false, 'code', 'NO_NET_PAY');
  end if;

  select * into v_txn from fdh_transactions where id = p_transaction_id for share;
  if not found or v_txn.user_id <> v_uid then
    return jsonb_build_object('ok', false, 'code', 'TRANSACTION_NOT_FOUND');
  end if;
  -- Narrow on purpose: only an APPROVED INCOME CREDIT can corroborate a pay run.
  if v_txn.credit_debit <> 'credit' or v_txn.approval_status <> 'approved' or v_txn.economic_transaction_type is distinct from 'income' then
    return jsonb_build_object('ok', false, 'code', 'NOT_AN_APPROVED_INCOME_CREDIT');
  end if;
  if upper(v_txn.currency_original) <> upper(v_event.currency_code) then
    return jsonb_build_object('ok', false, 'code', 'CURRENCY_MISMATCH');
  end if;
  if round(abs(v_txn.amount_original), 2) <> round(v_event.net_pay, 2) then
    return jsonb_build_object('ok', false, 'code', 'AMOUNT_MISMATCH');
  end if;
  if v_event.payment_date is not null and abs(v_txn.transaction_date - v_event.payment_date) > 7 then
    return jsonb_build_object('ok', false, 'code', 'DATE_TOO_FAR');
  end if;
  -- One deposit corroborates at most one pay run (uq_fdh_payroll_events_bank_match, 0091).
  if exists (select 1 from fdh_payroll_events where bank_match_transaction_id = p_transaction_id and id <> v_event.id) then
    return jsonb_build_object('ok', false, 'code', 'TRANSACTION_ALREADY_MATCHED');
  end if;

  v_conf := least(1, greatest(0, coalesce(p_confidence, 0.65)));

  perform set_config('fhip.import_bridge_internal_write', 'true', true);
  update fdh_payroll_events
    set bank_match_status = 'matched', bank_match_transaction_id = p_transaction_id, bank_match_confidence = v_conf, updated_at = now()
    where id = v_event.id;
  perform set_config('fhip.import_bridge_internal_write', 'false', true);

  insert into fdh_document_audit_events (user_id, document_id, event_type, actor_type, actor_id, metadata)
  values (v_uid, v_event.statement_upload_id, 'payroll_bank_match_restamped', 'system', v_uid,
    jsonb_build_object('payroll_event_id', v_event.id, 'transaction_id', p_transaction_id,
      'previous_status', v_event.bank_match_status, 'confidence', v_conf));

  return jsonb_build_object('ok', true, 'outcome', 'matched', 'previous_status', v_event.bank_match_status);
end;
$$ language plpgsql security definer set search_path = public;

revoke all on function fdh9_restamp_payroll_bank_match(uuid, uuid, numeric) from public, anon;
grant execute on function fdh9_restamp_payroll_bank_match(uuid, uuid, numeric) to authenticated, service_role;


-- ============================================================================
-- F. fdh9_supersede_payroll_event (GAP-15): a revised payslip replaces the
--    earlier one for the same employer and pay period.
-- ============================================================================
create or replace function fdh9_supersede_payroll_event(
  p_superseded_payroll_event_id uuid,
  p_superseding_payroll_event_id uuid
) returns jsonb as $$
declare
  v_uid uuid;
  v_old record;
  v_new record;
  v_moved uuid;
  v_txn record;
  v_proposals integer := 0;
begin
  v_uid := auth.uid();
  if v_uid is null then
    raise exception 'fdh9_supersede_payroll_event: authentication required';
  end if;
  if p_superseded_payroll_event_id is null or p_superseding_payroll_event_id is null
     or p_superseded_payroll_event_id = p_superseding_payroll_event_id then
    return jsonb_build_object('ok', false, 'code', 'NOT_A_REVISION');
  end if;

  -- Lock both rows in a fixed order so two concurrent calls cannot deadlock.
  perform 1 from fdh_payroll_events
    where id in (p_superseded_payroll_event_id, p_superseding_payroll_event_id)
    order by id for update;
  select * into v_old from fdh_payroll_events where id = p_superseded_payroll_event_id;
  select * into v_new from fdh_payroll_events where id = p_superseding_payroll_event_id;
  if v_old.id is null or v_new.id is null or v_old.user_id <> v_uid or v_new.user_id <> v_uid then
    return jsonb_build_object('ok', false, 'code', 'PAYROLL_EVENT_NOT_FOUND');
  end if;
  if v_old.superseded_by_payroll_event_id is not null then
    if v_old.superseded_by_payroll_event_id = v_new.id then
      return jsonb_build_object('ok', true, 'outcome', 'already_superseded');
    end if;
    return jsonb_build_object('ok', false, 'code', 'ALREADY_SUPERSEDED');
  end if;
  if v_new.superseded_by_payroll_event_id is not null then
    return jsonb_build_object('ok', false, 'code', 'EVENT_SUPERSEDED');
  end if;
  -- A revision is the SAME employer and the SAME pay period with DIFFERENT
  -- content. Identical content is a duplicate (0091's fingerprint index), not
  -- a revision.
  if v_old.employer_normalised is null or v_old.employer_normalised is distinct from v_new.employer_normalised
     or v_old.pay_period_end is null or v_old.pay_period_end is distinct from v_new.pay_period_end
     or (v_old.pay_period_start is not null and v_new.pay_period_start is not null and v_old.pay_period_start <> v_new.pay_period_start)
     or v_old.currency_code is distinct from v_new.currency_code
     or v_old.payslip_fingerprint is not distinct from v_new.payslip_fingerprint then
    return jsonb_build_object('ok', false, 'code', 'NOT_A_REVISION');
  end if;

  perform set_config('fhip.import_bridge_internal_write', 'true', true);

  -- The bank deposit follows the revision when it is the same money.
  if v_old.bank_match_status = 'matched' and v_new.bank_match_status <> 'matched' and v_new.net_pay is not null then
    select id, amount_original into v_txn from fdh_transactions where id = v_old.bank_match_transaction_id and user_id = v_uid;
    if found and round(abs(v_txn.amount_original), 2) = round(v_new.net_pay, 2) then
      update fdh_payroll_events set bank_match_status = 'no_match', bank_match_transaction_id = null, bank_match_confidence = null, updated_at = now()
        where id = v_old.id;
      update fdh_payroll_events set bank_match_status = 'matched', bank_match_transaction_id = v_txn.id, bank_match_confidence = v_old.bank_match_confidence, updated_at = now()
        where id = v_new.id;
      v_moved := v_txn.id;
    end if;
  end if;

  update fdh_payroll_events set superseded_by_payroll_event_id = v_new.id, updated_at = now() where id = v_old.id;

  update fhip_import_proposals set status = 'superseded'
    where user_id = v_uid and source_payroll_event_id = v_old.id and status = 'ready';
  get diagnostics v_proposals = row_count;

  perform set_config('fhip.import_bridge_internal_write', 'false', true);

  insert into fdh_document_audit_events (user_id, document_id, event_type, actor_type, actor_id, metadata)
  values (v_uid, v_old.statement_upload_id, 'payroll_event_superseded', 'user', v_uid,
    jsonb_build_object('payroll_event_id', v_old.id, 'superseded_by_payroll_event_id', v_new.id,
      'bank_match_moved', v_moved is not null, 'proposals_superseded', v_proposals));

  return jsonb_build_object('ok', true, 'outcome', 'superseded', 'bank_match_moved', v_moved is not null, 'proposals_superseded', v_proposals);
end;
$$ language plpgsql security definer set search_path = public;

revoke all on function fdh9_supersede_payroll_event(uuid, uuid) from public, anon;
grant execute on function fdh9_supersede_payroll_event(uuid, uuid) to authenticated, service_role;
