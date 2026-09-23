-- FDH-9 — payslip review/correction: provenance columns, the correction RPC,
-- and one new audit-event type (2026-09-24).
--
-- WHY THIS MIGRATION EXISTS. The Income tab's payslip panel has always shown
-- a "Review / Correct" button whose handler only re-fetched the screen the
-- user was already looking at — a visual no-op with NO correction UI behind
-- it. The user was told the extracted figures needed review, handed a button,
-- and the button did nothing. That mattered on 2026-09-24, when a real
-- production import stored a YEAR-TO-DATE total as the period base pay: the
-- one offered path to fix the figure the app itself had flagged did not
-- exist.
--
-- WHY AN RPC AND NOT A WIDER TRIGGER. Migration 0091's own D.4 comment says
-- it outright: every money/period/reconciliation/approval column on
-- `fdh_payroll_events` is system-authoritative, the ONLY column an ordinary
-- authenticated UPDATE may touch directly is the employer label, and "any
-- later correction/review UI must add its own narrowly-scoped RPC rather
-- than widen this trigger's authenticated-role allowance". This migration
-- does exactly that and nothing more. The trigger's allowance is NOT widened;
-- it is EXTENDED to cover the three new provenance columns as well, so those
-- cannot be forged directly either.
--
-- ADDITIVE ONLY. Three new nullable/defaulted columns, one new function, one
-- replaced trigger function whose protected set is a STRICT SUPERSET of the
-- one it replaces, and one CHECK-constraint widening that is a STRICT
-- SUPERSET of migration 0173's list (verified value by value below). No
-- column, constraint, index, policy or row is removed, and no data is
-- rewritten.
--
-- MIGRATION NUMBER GOVERNANCE. `npm run check:migrations` only sees this
-- worktree's own directory and `check:migrations:against-branch` only
-- compares `origin/main`, so neither can see a number claimed on an unmerged
-- sibling branch — a blind spot that caused a real collision on 2026-09-22.
-- The number below was therefore chosen after scanning, from this worktree:
--   (a) every added migration filename reachable from EVERY local and
--       remote-tracking ref (`git log --all --diff-filter=A --name-only --
--       supabase/migrations`), and
--   (b) the WORKING DIRECTORY of every registered git worktree on this
--       machine, which catches a migration that has been written but not yet
--       committed anywhere.
-- Both scans agree the highest number claimed anywhere is 0180
-- (`0180_aie_unified_document_fallback_audit_events.sql`, on the concurrent
-- unified-document-fallback branch, which was told to allocate from 0180).
-- 0181-0184 are left deliberately free as headroom for that dispatch; this
-- file takes **0185**.
--
-- STATUS: DRAFTED, NOT APPLIED to any environment. This dispatch has no DEV
-- or production apply authority. The file exists so the schema change is
-- reviewable alongside the code that depends on it.


-- ===========================================================================
-- 1. PROVENANCE COLUMNS
-- ===========================================================================

-- Where `gross_pay` came from.
--
-- A payslip that does not print a gross total under a label FDH-9 recognises
-- used to store `gross_pay` null with nothing recorded about why. The parser
-- now derives one — but ONLY when the document's own current-period earning
-- and deduction lines reproduce its own stated net EXACTLY (zero tolerance,
-- integer minor units), which makes the figure the payslip's own arithmetic
-- rather than the parser's opinion. A derived gross must never be mistaken
-- downstream for one the employer printed, so the distinction is stored, not
-- inferred.
--
-- NULL means the same thing it always did: the document does not disclose a
-- gross. That is NOT zero, and nothing fills it in.
alter table fdh_payroll_events
  add column if not exists gross_pay_source text;

alter table fdh_payroll_events
  drop constraint if exists fdh_payroll_events_gross_pay_source_check;
alter table fdh_payroll_events
  add constraint fdh_payroll_events_gross_pay_source_check
    check (gross_pay_source is null
           or gross_pay_source in ('stated_on_document', 'derived_from_components', 'user_corrected'));

-- A gross_pay_source can only exist where a gross_pay does.
alter table fdh_payroll_events
  drop constraint if exists fdh_payroll_events_gross_pay_source_coherent;
alter table fdh_payroll_events
  add constraint fdh_payroll_events_gross_pay_source_coherent
    check (gross_pay_source is null or gross_pay is not null);

-- Which fields a HUMAN replaced, so a user-corrected value is distinguishable
-- from a machine-extracted one at the row level, by column name, for every
-- downstream reader (review screen, income proposal, support).
--
-- Column NAMES only. The values themselves are already in their own columns;
-- duplicating them here would be a second copy of payroll data with no reader.
alter table fdh_payroll_events
  add column if not exists user_corrected_fields text[] not null default '{}'::text[];

alter table fdh_payroll_events
  add column if not exists last_corrected_at timestamptz;

alter table fdh_payroll_events
  add column if not exists last_corrected_by uuid references auth.users(id) on delete set null;

-- last_corrected_at and last_corrected_by cannot disagree, in the same shape
-- as 0091's existing `fdh_payroll_events_approval_coherent`.
alter table fdh_payroll_events
  drop constraint if exists fdh_payroll_events_correction_coherent;
alter table fdh_payroll_events
  add constraint fdh_payroll_events_correction_coherent
    check ((last_corrected_at is null) = (last_corrected_by is null));


-- ===========================================================================
-- 2. THE AUTHORITATIVE-WRITE TRIGGER, EXTENDED (not widened)
-- ===========================================================================
--
-- Identical to migration 0091's D.4 function with THREE ADDITIONAL protected
-- columns appended (`gross_pay_source`, `user_corrected_fields`,
-- `last_corrected_at`, `last_corrected_by`). Nothing is removed from the
-- protected set: the authenticated role's direct-UPDATE allowance is still
-- exactly `employer_name`/`employer_normalised` and nothing else.
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
     -- Added by migration 0185. Provenance is authoritative for the same
     -- reason the figures are: a row that can claim "a human corrected this"
     -- without a human having done so is worse than no claim at all.
     or new.gross_pay_source is distinct from old.gross_pay_source
     or new.user_corrected_fields is distinct from old.user_corrected_fields
     or new.last_corrected_at is distinct from old.last_corrected_at
     or new.last_corrected_by is distinct from old.last_corrected_by
  then
    raise exception 'fdh_payroll_events: this field is system-authoritative and may not be written directly by the authenticated role';
  end if;

  return new;
end;
$$ language plpgsql security definer set search_path = public;


-- ===========================================================================
-- 3. THE CORRECTION RPC
-- ===========================================================================
--
-- The one legitimate way a user-supplied figure ever reaches a payroll
-- event's authoritative columns — the narrowly-scoped RPC 0091's D.4 comment
-- asked any correction UI to add.
--
-- DESIGN NOTES, each deliberate:
--
--   * BEFORE APPROVAL ONLY. An approved payroll event is the evidence an
--     Income proposal was generated from; letting it change underneath a
--     proposal would make the proposal's staleness check meaningless.
--     Correct first, then approve.
--
--   * `p_corrections` IS AN EXPLICIT, CLOSED SET OF KEYS. No dynamic SQL. A
--     key that is ABSENT leaves the column alone; a key present with a JSON
--     null CLEARS it (back to "the document does not say"), which is a
--     different instruction and is honoured as one. Every column's own CHECK
--     constraint (`>= 0`, the frequency vocabulary, the period ordering)
--     still applies, so an impossible correction is refused by the database
--     rather than stored.
--
--   * RECONCILIATION IS RE-STAMPED BY THE CALLER, NOT RE-DERIVED HERE. The
--     certified gross-to-net identity lives in
--     `lib/financial-data-hub/payslip/reconciliation.ts` and is exercised by
--     an independent oracle; re-implementing it in PL/pgSQL would create a
--     second, divergent copy of the one rule that caught this defect. The
--     server route recomputes it with that function and passes the result.
--     It is NOT optional: a correction that did not re-stamp reconciliation
--     would leave a stale variance on the row.
--
--   * `payslip_fingerprint` IS DELIBERATELY NOT TOUCHED. It identifies the
--     DOCUMENT's own machine-read content, which is what makes re-uploading
--     the same payslip a recognised duplicate. Rewriting it on a correction
--     would let the same payslip be imported twice.
--
--   * `extraction_confidence` IS DELIBERATELY NOT TOUCHED. It is a true
--     statement about what the MACHINE managed to read, and stays true after
--     a human edits the result. `user_corrected_fields` is how a reader
--     learns a human was involved.
create or replace function fdh9_correct_payroll_event(
  p_payroll_event_id uuid,
  p_corrections jsonb,
  p_employer_normalised text,
  p_reconciliation_status text,
  p_reconciliation_variance numeric
) returns jsonb as $$
declare
  v_uid uuid;
  v_event record;
  v_changed text[] := '{}';
  v_key text;
  v_money_changed boolean := false;
begin
  v_uid := auth.uid();
  if v_uid is null then
    raise exception 'fdh9_correct_payroll_event: authentication required';
  end if;

  if p_corrections is null or jsonb_typeof(p_corrections) <> 'object' then
    return jsonb_build_object('ok', false, 'code', 'INVALID_CORRECTIONS', 'error', 'No corrections were supplied.');
  end if;

  if p_reconciliation_status is null
     or p_reconciliation_status not in ('reconciled', 'variance', 'insufficient_data') then
    return jsonb_build_object('ok', false, 'code', 'INVALID_RECONCILIATION', 'error', 'A recomputed gross-to-net result is required.');
  end if;

  select * into v_event from fdh_payroll_events where id = p_payroll_event_id for update;
  if not found or v_event.user_id <> v_uid then
    return jsonb_build_object('ok', false, 'code', 'PAYROLL_EVENT_NOT_FOUND', 'error', 'That payroll event could not be found.');
  end if;

  if v_event.approval_status = 'approved' then
    return jsonb_build_object('ok', false, 'code', 'ALREADY_APPROVED', 'error', 'This payroll evidence has already been approved and can no longer be corrected.');
  end if;

  -- Only keys this function actually understands may be named.
  for v_key in select jsonb_object_keys(p_corrections) loop
    if v_key not in (
      'employer_name', 'pay_period_start', 'pay_period_end', 'payment_date', 'pay_frequency',
      'gross_pay', 'base_pay', 'overtime_pay', 'bonus_pay', 'commission_pay',
      'allowances_total', 'reimbursements_total', 'other_earnings',
      'tax_withheld', 'employee_deductions_total', 'salary_sacrifice', 'professional_tax',
      'employer_retirement_contribution', 'employee_retirement_contribution',
      'employer_nps_contribution', 'employee_nps_contribution', 'net_pay'
    ) then
      return jsonb_build_object('ok', false, 'code', 'UNKNOWN_FIELD', 'error', format('%s is not a correctable field.', v_key));
    end if;
    v_changed := v_changed || v_key;
    if v_key not in ('employer_name', 'pay_period_start', 'pay_period_end', 'payment_date', 'pay_frequency') then
      v_money_changed := true;
    end if;
  end loop;

  if array_length(v_changed, 1) is null then
    return jsonb_build_object('ok', false, 'code', 'INVALID_CORRECTIONS', 'error', 'No corrections were supplied.');
  end if;

  perform set_config('fhip.import_bridge_internal_write', 'true', true);

  update fdh_payroll_events set
    employer_name = case when p_corrections ? 'employer_name'
      then nullif(p_corrections->>'employer_name', '') else employer_name end,
    employer_normalised = case when p_corrections ? 'employer_name'
      then nullif(p_employer_normalised, '') else employer_normalised end,
    pay_period_start = case when p_corrections ? 'pay_period_start'
      then (p_corrections->>'pay_period_start')::date else pay_period_start end,
    pay_period_end = case when p_corrections ? 'pay_period_end'
      then (p_corrections->>'pay_period_end')::date else pay_period_end end,
    payment_date = case when p_corrections ? 'payment_date'
      then (p_corrections->>'payment_date')::date else payment_date end,
    pay_frequency = case when p_corrections ? 'pay_frequency'
      then coalesce(p_corrections->>'pay_frequency', 'unknown') else pay_frequency end,
    -- A frequency the user chose is `user_confirmed` by definition — the one
    -- value in 0091's `pay_frequency_source` vocabulary that means exactly
    -- this, reused rather than a new one invented.
    pay_frequency_source = case when p_corrections ? 'pay_frequency'
      then 'user_confirmed' else pay_frequency_source end,

    gross_pay = case when p_corrections ? 'gross_pay'
      then (p_corrections->>'gross_pay')::numeric else gross_pay end,
    -- A corrected gross is a HUMAN's figure, and is labelled as one. Clearing
    -- it clears the provenance with it.
    gross_pay_source = case
      when p_corrections ? 'gross_pay' and (p_corrections->>'gross_pay') is not null then 'user_corrected'
      when p_corrections ? 'gross_pay' then null
      else gross_pay_source end,
    base_pay = case when p_corrections ? 'base_pay'
      then (p_corrections->>'base_pay')::numeric else base_pay end,
    overtime_pay = case when p_corrections ? 'overtime_pay'
      then (p_corrections->>'overtime_pay')::numeric else overtime_pay end,
    bonus_pay = case when p_corrections ? 'bonus_pay'
      then (p_corrections->>'bonus_pay')::numeric else bonus_pay end,
    commission_pay = case when p_corrections ? 'commission_pay'
      then (p_corrections->>'commission_pay')::numeric else commission_pay end,
    allowances_total = case when p_corrections ? 'allowances_total'
      then (p_corrections->>'allowances_total')::numeric else allowances_total end,
    reimbursements_total = case when p_corrections ? 'reimbursements_total'
      then (p_corrections->>'reimbursements_total')::numeric else reimbursements_total end,
    other_earnings = case when p_corrections ? 'other_earnings'
      then (p_corrections->>'other_earnings')::numeric else other_earnings end,

    tax_withheld = case when p_corrections ? 'tax_withheld'
      then (p_corrections->>'tax_withheld')::numeric else tax_withheld end,
    employee_deductions_total = case when p_corrections ? 'employee_deductions_total'
      then (p_corrections->>'employee_deductions_total')::numeric else employee_deductions_total end,
    salary_sacrifice = case when p_corrections ? 'salary_sacrifice'
      then (p_corrections->>'salary_sacrifice')::numeric else salary_sacrifice end,
    professional_tax = case when p_corrections ? 'professional_tax'
      then (p_corrections->>'professional_tax')::numeric else professional_tax end,

    employer_retirement_contribution = case when p_corrections ? 'employer_retirement_contribution'
      then (p_corrections->>'employer_retirement_contribution')::numeric else employer_retirement_contribution end,
    employee_retirement_contribution = case when p_corrections ? 'employee_retirement_contribution'
      then (p_corrections->>'employee_retirement_contribution')::numeric else employee_retirement_contribution end,
    employer_nps_contribution = case when p_corrections ? 'employer_nps_contribution'
      then (p_corrections->>'employer_nps_contribution')::numeric else employer_nps_contribution end,
    employee_nps_contribution = case when p_corrections ? 'employee_nps_contribution'
      then (p_corrections->>'employee_nps_contribution')::numeric else employee_nps_contribution end,

    net_pay = case when p_corrections ? 'net_pay'
      then (p_corrections->>'net_pay')::numeric else net_pay end,

    -- The variance safety net is RE-STAMPED, never dropped: a corrected row
    -- that still does not add up stays a 'variance', and one that can no
    -- longer be checked at all says so.
    reconciliation_status = case when v_money_changed then p_reconciliation_status else reconciliation_status end,
    reconciliation_variance = case when v_money_changed then p_reconciliation_variance else reconciliation_variance end,
    -- A corrected event is still something a human should look at before
    -- approving; nothing here ever moves review_status to 'not_required'.
    review_status = case when review_status = 'not_required' then 'in_review' else review_status end,

    -- Union, not replace: a field corrected in an earlier round stays flagged.
    user_corrected_fields = (
      select coalesce(array_agg(distinct f order by f), '{}'::text[])
      from unnest(user_corrected_fields || v_changed) as f
    ),
    last_corrected_at = now(),
    last_corrected_by = v_uid,
    updated_at = now()
  where id = p_payroll_event_id;

  perform set_config('fhip.import_bridge_internal_write', 'false', true);

  return jsonb_build_object(
    'ok', true,
    'outcome', 'corrected',
    'corrected_fields', to_jsonb(v_changed),
    'reconciliation_restamped', v_money_changed
  );
end;
$$ language plpgsql security definer set search_path = public;

revoke all on function fdh9_correct_payroll_event(uuid, jsonb, text, text, numeric) from public;
grant execute on function fdh9_correct_payroll_event(uuid, jsonb, text, text, numeric) to authenticated, service_role;


-- ===========================================================================
-- 4. AUDIT-EVENT VOCABULARY WIDENING
-- ===========================================================================
--
-- ONE new value: `payroll_event_corrected`. The list below is migration
-- 0173's list verbatim plus that value — a STRICT SUPERSET, verified value by
-- value against 0173 rather than assumed, following the widening discipline
-- 0064/0068/0071/0076/0091/0096/0106/0112/0173 established.
alter table fdh_document_audit_events
  drop constraint if exists fdh_document_audit_events_event_type_check;
alter table fdh_document_audit_events
  add constraint fdh_document_audit_events_event_type_check
    check (event_type in (
      -- FDH-3 original set (migration 0058).
      'document_upload_created', 'document_upload_completed', 'document_validated',
      'document_rejected', 'document_queued', 'document_user_deleted',
      'document_purge_scheduled', 'document_purged', 'document_purge_failed',
      -- R7 additions (migration 0064).
      'bank_csv_uploaded', 'bank_csv_detection_completed', 'bank_csv_mapping_confirmed',
      'bank_csv_processing_started', 'bank_csv_processing_completed',
      'bank_csv_processing_failed', 'transaction_duplicate_detected',
      'transaction_duplicate_resolved', 'transaction_corrected', 'import_reconciled',
      -- R8 additions (migration 0068).
      'transaction_classification_run', 'transaction_link_reviewed',
      'recurring_series_reviewed', 'personal_rule_created',
      -- FDH-5 additions (migration 0071).
      'pdf_validated', 'pdf_password_required', 'pdf_decrypted_for_processing',
      'pdf_native_extraction_started', 'pdf_native_extraction_completed',
      'pdf_ocr_started', 'pdf_ocr_completed', 'pdf_adapter_detected',
      'pdf_processing_failed', 'pdf_review_required', 'pdf_processing_completed',
      -- FDH-7 additions (migration 0076).
      'transaction_split_created', 'transaction_approved', 'statement_approved',
      'statement_reopened', 'bulk_review_action_completed',
      -- FDH-9 additions (migration 0091).
      'payslip_extraction_completed', 'payslip_extraction_failed',
      'payroll_event_approved', 'income_proposal_generated',
      'income_proposal_applied', 'income_proposal_dismissed',
      -- FDH-10 additions (migration 0096).
      'liability_statement_extraction_completed',
      'liability_statement_extraction_failed',
      'liability_statement_approved',
      'liability_bank_match_completed',
      'liability_proposal_generated',
      'liability_proposal_applied',
      'liability_proposal_dismissed',
      -- FDH-11 additions (migration 0106).
      'investment_statement_extraction_completed',
      'investment_statement_extraction_failed',
      'investment_statement_account_matched',
      'investment_statement_security_matched',
      'investment_statement_reconciled',
      'investment_statement_bank_match_completed',
      'investment_statement_approved',
      'investment_statement_applied',
      'investment_statement_apply_rejected_stale',
      -- FDH-12 additions (migration 0112).
      'retirement_statement_extraction_completed',
      'retirement_statement_extraction_failed',
      'retirement_statement_account_matched',
      'retirement_statement_payslip_matched',
      'retirement_statement_reconciled',
      'retirement_statement_bank_match_completed',
      'retirement_statement_routed_to_smsf',
      'retirement_statement_approved',
      'retirement_proposal_generated',
      'retirement_proposal_applied',
      'retirement_proposal_dismissed',
      -- AIE payslip AI-fallback additions (migration 0173).
      'payslip_ai_fallback_attempted',
      'payslip_ai_fallback_masking_below_policy',
      'payslip_ai_fallback_provider_outcome',
      'payslip_ai_fallback_insufficient_fields',
      'payslip_ai_fallback_draft_ready',
      'payslip_ai_fallback_not_usable',
      'payslip_ai_fallback_confirmed',
      -- Payslip review/correction addition (this migration).
      -- Metadata carries the corrected field NAMES only — never the figures,
      -- which already live in their own columns (auditLog.ts's own rule:
      -- `metadata` never carries document content).
      'payroll_event_corrected'
    ));
