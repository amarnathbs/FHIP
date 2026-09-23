-- FDH-10 — liability statement review/correction: provenance columns, the
-- correction RPC, and one new audit-event type (2026-09-24).
--
-- WHY THIS MIGRATION EXISTS. The Liabilities tab's statement panel rendered a
-- "Review / Correct" button whose entire handler was
-- `loadReview(documentId!)` — a re-fetch that set the phase the surrounding
-- block was ALREADY rendered under, so it re-rendered identical content and
-- changed nothing. It was a byte-for-byte copy of the same dead control on
-- `components/income/PayslipImportPanel.tsx`. On 2026-09-24 that payslip
-- control was replaced with a real correction surface (migration 0185); the
-- liability button was REMOVED the same day and replaced with honest copy
-- ("We can't edit them here yet"), because building the liability path was
-- out of that dispatch's scope. This migration is that path.
--
-- WHY AN RPC AND NOT A WIDER TRIGGER. Migration 0096's Part F.1 makes every
-- system-derived column on `fdh_liability_statements` — the balance anchors,
-- the activity totals, the reconciliation outcome, the parser provenance and
-- the approval state — authoritative, and its own comment says only a
-- SECURITY DEFINER RPC running under the internal-write GUC may ever move
-- them. This migration adds exactly such an RPC and nothing more. The
-- trigger's authenticated-role allowance is NOT widened; it is EXTENDED to
-- cover the three new provenance columns as well, so a row cannot claim "a
-- human corrected this" without a human having done so. This is the same
-- discipline migration 0185 applied to `fdh_payroll_events`, deliberately
-- mirrored rather than reinvented.
--
-- ADDITIVE ONLY. Three new nullable/defaulted columns, one new function, one
-- replaced trigger function whose protected set is a STRICT SUPERSET of the
-- one it replaces, and one CHECK-constraint widening that is a STRICT
-- SUPERSET of migration 0185's list (verified value by value below). No
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
--   (b) the WORKING DIRECTORY of all 117 registered git worktrees on this
--       machine, which catches a migration written but not yet committed
--       anywhere.
-- Both scans agree the highest number claimed anywhere is 0185
-- (`0185_fdh9_payroll_event_user_correction.sql`, the payslip precedent this
-- file builds directly on top of); 0181-0184 remain the headroom 0185
-- reserved for the concurrent unified-document-fallback branch, which in the
-- end landed on `main` as 0180, and are left untouched. This file takes
-- **0186**. That choice was independently confirmed by the session that owns
-- 0185 before this file was finalised.
--
-- STATUS: DRAFTED, NOT APPLIED to any environment. This dispatch has no DEV
-- or production apply authority. The file exists so the schema change is
-- reviewable alongside the code that depends on it.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO, each disclosed rather than
-- quietly omitted:
--
--   * NO `*_source` PROVENANCE COLUMN. 0185 added `gross_pay_source` because
--     its sibling change taught the payslip parser to DERIVE a gross from the
--     document's own component lines, creating a figure that had to stay
--     distinguishable from one the employer printed. Nothing in the liability
--     extraction path derives a balance — `statementIntake.ts` transcribes
--     what the statement discloses — so there is no second provenance to
--     record and none is invented here.
--
--   * `masked_identifier` IS NOT CORRECTABLE. It carries the table's own
--     privacy guard (`chk_fdh_liability_statements_masked_identifier`, which
--     refuses 7+ consecutive digits). A free-text correction box over a card
--     number is the one field on this screen where a user's own typing could
--     put an unmasked card number into the database, and the constraint is a
--     backstop, not a reason to offer the box. The review screen still SHOWS
--     it for verification.
--
--   * `repayment_frequency` IS NOT CORRECTABLE. It has no stored vocabulary
--     anywhere in this schema (plain `text`, no CHECK) and is never written
--     by the extraction path, while `liabilityProposalService.ts` reads it to
--     decide whether to flag a loan's proposed repayment as
--     'repayment_amount_reflects_this_statement_period_only'. Making it
--     user-settable would let a typed value silently REMOVE that review flag
--     from a proposal. That is a product decision about proposal
--     confirmation, not a correction of a misread figure, and it is left for
--     whoever owns that decision.
--
--   * `review_status` IS NOT ADDED TO THE TRIGGER'S PROTECTED SET. Migration
--     0096's F.1 comment asserts `review_status` "moves only via
--     fdh10_approve_liability_statement", but F.1's own column list does not
--     actually include it — a comment/code gap that predates this change.
--     Closing it is a hardening of an unrelated column with its own blast
--     radius and belongs in its own change, not smuggled into a correction
--     migration. It is recorded here so the next reader finds it.


-- ===========================================================================
-- 1. PROVENANCE COLUMNS
-- ===========================================================================

-- Which fields a HUMAN replaced, so a user-corrected value is distinguishable
-- from a machine-extracted one at the row level, by column name, for every
-- downstream reader (review screen, liability proposal, support).
--
-- Column NAMES only. The values themselves are already in their own columns;
-- duplicating them here would be a second copy of statement data with no
-- reader.
alter table fdh_liability_statements
  add column if not exists user_corrected_fields text[] not null default '{}'::text[];

alter table fdh_liability_statements
  add column if not exists last_corrected_at timestamptz;

alter table fdh_liability_statements
  add column if not exists last_corrected_by uuid references auth.users(id) on delete set null;

-- last_corrected_at and last_corrected_by cannot disagree, in the same shape
-- as 0096's existing `chk_fdh_liability_statements_approved_at` coherence
-- discipline and 0185's `fdh_payroll_events_correction_coherent`.
alter table fdh_liability_statements
  drop constraint if exists fdh_liability_statements_correction_coherent;
alter table fdh_liability_statements
  add constraint fdh_liability_statements_correction_coherent
    check ((last_corrected_at is null) = (last_corrected_by is null));


-- ===========================================================================
-- 2. THE AUTHORITATIVE-WRITE TRIGGER, EXTENDED (not widened)
-- ===========================================================================
--
-- Identical to migration 0096's F.1 function with THREE ADDITIONAL protected
-- columns appended (`user_corrected_fields`, `last_corrected_at`,
-- `last_corrected_by`). Nothing is removed from the protected set, and the
-- authenticated role gains no new direct-UPDATE allowance whatsoever.
create or replace function fdh10_liability_statements_assert_authoritative_write() returns trigger as $$
declare
  v_internal boolean := coalesce(current_setting('fhip.import_bridge_internal_write', true), 'false') = 'true';
begin
  if v_internal then
    return new;
  end if;
  if new.user_id is distinct from old.user_id
     or new.statement_upload_id is distinct from old.statement_upload_id
     or new.financial_account_id is distinct from old.financial_account_id
     or new.currency_code is distinct from old.currency_code
     or new.statement_type is distinct from old.statement_type
     or new.facility_type is distinct from old.facility_type
     or new.opening_balance is distinct from old.opening_balance
     or new.closing_balance is distinct from old.closing_balance
     or new.opening_principal is distinct from old.opening_principal
     or new.closing_principal is distinct from old.closing_principal
     or new.purchases_total is distinct from old.purchases_total
     or new.cash_advances_total is distinct from old.cash_advances_total
     or new.interest_total is distinct from old.interest_total
     or new.fees_total is distinct from old.fees_total
     or new.payments_total is distinct from old.payments_total
     or new.refunds_total is distinct from old.refunds_total
     or new.adjustments_total is distinct from old.adjustments_total
     or new.drawdowns_total is distinct from old.drawdowns_total
     or new.principal_repayments_total is distinct from old.principal_repayments_total
     or new.reconciliation_status is distinct from old.reconciliation_status
     or new.reconciliation_variance is distinct from old.reconciliation_variance
     or new.parser_name is distinct from old.parser_name
     or new.parser_version is distinct from old.parser_version
     or new.extraction_confidence is distinct from old.extraction_confidence
     or new.approval_status is distinct from old.approval_status
     or new.approved_at is distinct from old.approved_at
     or new.approved_by is distinct from old.approved_by
     or new.liability_id is distinct from old.liability_id
     or new.duplicate_of_statement_id is distinct from old.duplicate_of_statement_id
     -- Added by migration 0186. Provenance is authoritative for the same
     -- reason the figures are: a row that can claim "a human corrected this"
     -- without a human having done so is worse than no claim at all.
     or new.user_corrected_fields is distinct from old.user_corrected_fields
     or new.last_corrected_at is distinct from old.last_corrected_at
     or new.last_corrected_by is distinct from old.last_corrected_by
  then
    raise exception 'fdh_liability_statements: this field is system-authoritative and may not be written directly by the authenticated role';
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;


-- ===========================================================================
-- 3. THE CORRECTION RPC
-- ===========================================================================
--
-- The one legitimate way a user-supplied figure ever reaches a liability
-- statement's authoritative columns — the narrowly-scoped RPC 0096's F.1
-- discipline requires, and the exact counterpart of
-- `fdh9_correct_payroll_event` (migration 0185).
--
-- DESIGN NOTES, each deliberate:
--
--   * BEFORE APPROVAL ONLY. An approved statement is the evidence a Liability
--     proposal was generated from; letting it change underneath a proposal
--     would make the proposal's staleness check meaningless. Correct first,
--     then approve.
--
--   * `p_corrections` IS AN EXPLICIT, CLOSED SET OF KEYS. No dynamic SQL. A
--     key that is ABSENT leaves the column alone; a key present with a JSON
--     null CLEARS it (back to "the statement does not say"), which is a
--     different instruction and is honoured as one. Every column's own CHECK
--     constraint (`credit_limit >= 0`, `minimum_payment >= 0`,
--     `interest_rate >= 0`, the statement-period ordering) still applies, so
--     an impossible correction is refused by the database rather than stored.
--
--   * THE VOCABULARY IS SCOPED BY STATEMENT TYPE, here and not only in the
--     caller. A credit-card statement has no `closing_principal` that any
--     formula or proposal reads, and a loan statement has no `credit_limit`;
--     accepting one would store a figure with no reader, which is exactly the
--     kind of silently-dead data this table's authoritative discipline exists
--     to prevent. The server route refuses it first with an honest message;
--     this check is the backstop that makes the refusal true even if a future
--     caller forgets.
--
--   * RECONCILIATION IS RE-STAMPED BY THE CALLER, NOT RE-DERIVED HERE. The
--     certified credit-card and loan identities live in
--     `lib/financial-data-hub/liability/statementReconciliation.ts`, with
--     their own exact-minor-unit money primitives and a certified 0.01
--     negative control; re-implementing either in PL/pgSQL would create a
--     second, divergent copy of the rule the whole review step exists to
--     enforce. The server route recomputes with those functions and passes
--     the result. It is NOT optional: a correction that did not re-stamp
--     reconciliation would leave a stale variance on the row.
--
--   * `extraction_confidence`, `parser_name` AND `parser_version` ARE
--     DELIBERATELY NOT TOUCHED. They are true statements about what the
--     MACHINE managed to read, and stay true after a human edits the result.
--     `user_corrected_fields` is how a reader learns a human was involved.
--
--   * THE DUPLICATE SIGNAL IS DELIBERATELY NOT TOUCHED. Unlike FDH-9, the
--     liability path's whole-document dedup key is
--     `fdh_statement_uploads.file_hash` (reused, not duplicated on this
--     table), so there is no fingerprint column here to rewrite — and
--     `duplicate_of_statement_id`, which records a decided relationship
--     between two statements, is not in the correctable vocabulary either.
create or replace function fdh10_correct_liability_statement(
  p_statement_id uuid,
  p_corrections jsonb,
  p_reconciliation_status text,
  p_reconciliation_variance numeric
) returns jsonb as $$
declare
  v_uid uuid;
  v_statement record;
  v_changed text[] := '{}';
  v_key text;
  v_recon_changed boolean := false;
  v_is_credit_card boolean;
begin
  v_uid := auth.uid();
  if v_uid is null then
    raise exception 'fdh10_correct_liability_statement: authentication required';
  end if;

  if p_corrections is null or jsonb_typeof(p_corrections) <> 'object' then
    return jsonb_build_object('ok', false, 'code', 'INVALID_CORRECTIONS', 'error', 'No corrections were supplied.');
  end if;

  if p_reconciliation_status is null
     or p_reconciliation_status not in ('reconciled', 'variance', 'insufficient_data') then
    return jsonb_build_object('ok', false, 'code', 'INVALID_RECONCILIATION', 'error', 'A recomputed statement check is required.');
  end if;

  select * into v_statement from fdh_liability_statements where id = p_statement_id for update;
  if not found or v_statement.user_id <> v_uid then
    return jsonb_build_object('ok', false, 'code', 'STATEMENT_NOT_FOUND', 'error', 'That statement could not be found.');
  end if;

  if v_statement.approval_status = 'approved' then
    return jsonb_build_object('ok', false, 'code', 'ALREADY_APPROVED', 'error', 'This statement evidence has already been approved and can no longer be corrected.');
  end if;

  v_is_credit_card := v_statement.statement_type = 'credit_card';

  -- Only keys this function actually understands may be named.
  for v_key in select jsonb_object_keys(p_corrections) loop
    if v_key not in (
      'institution_name',
      'statement_period_start', 'statement_period_end', 'statement_date', 'due_date',
      'opening_balance', 'closing_balance', 'credit_limit', 'minimum_payment',
      'purchases_total', 'cash_advances_total', 'refunds_total',
      'opening_principal', 'closing_principal', 'drawdowns_total',
      'capitalised_total', 'principal_repayments_total',
      'interest_total', 'fees_total', 'payments_total', 'adjustments_total',
      'interest_rate'
    ) then
      return jsonb_build_object('ok', false, 'code', 'UNKNOWN_FIELD', 'error', format('%s is not a correctable field.', v_key));
    end if;

    -- A field that belongs to the OTHER kind of facility is refused, not
    -- quietly stored where nothing will ever read it.
    if v_is_credit_card and v_key in (
      'opening_principal', 'closing_principal', 'drawdowns_total',
      'capitalised_total', 'principal_repayments_total'
    ) then
      return jsonb_build_object('ok', false, 'code', 'WRONG_STATEMENT_TYPE', 'error', format('%s is not a figure on a credit card statement.', v_key));
    end if;
    if not v_is_credit_card and v_key in (
      'opening_balance', 'closing_balance', 'credit_limit', 'minimum_payment',
      'purchases_total', 'cash_advances_total', 'refunds_total'
    ) then
      return jsonb_build_object('ok', false, 'code', 'WRONG_STATEMENT_TYPE', 'error', format('%s is not a figure on a loan statement.', v_key));
    end if;

    v_changed := v_changed || v_key;

    -- Only a field the reconciliation formula actually READS makes the stored
    -- reconciliation outcome stale. Correcting a credit limit or a due date
    -- does not, and re-stamping on those would answer a question nobody
    -- asked.
    if v_key in (
      'opening_balance', 'closing_balance', 'purchases_total', 'cash_advances_total', 'refunds_total',
      'opening_principal', 'closing_principal', 'drawdowns_total', 'capitalised_total',
      'principal_repayments_total', 'interest_total', 'fees_total', 'payments_total', 'adjustments_total'
    ) then
      v_recon_changed := true;
    end if;
  end loop;

  if array_length(v_changed, 1) is null then
    return jsonb_build_object('ok', false, 'code', 'INVALID_CORRECTIONS', 'error', 'No corrections were supplied.');
  end if;

  perform set_config('fhip.import_bridge_internal_write', 'true', true);

  update fdh_liability_statements set
    institution_name = case when p_corrections ? 'institution_name'
      then nullif(p_corrections->>'institution_name', '') else institution_name end,

    statement_period_start = case when p_corrections ? 'statement_period_start'
      then (p_corrections->>'statement_period_start')::date else statement_period_start end,
    statement_period_end = case when p_corrections ? 'statement_period_end'
      then (p_corrections->>'statement_period_end')::date else statement_period_end end,
    statement_date = case when p_corrections ? 'statement_date'
      then (p_corrections->>'statement_date')::date else statement_date end,
    due_date = case when p_corrections ? 'due_date'
      then (p_corrections->>'due_date')::date else due_date end,

    opening_balance = case when p_corrections ? 'opening_balance'
      then (p_corrections->>'opening_balance')::numeric else opening_balance end,
    closing_balance = case when p_corrections ? 'closing_balance'
      then (p_corrections->>'closing_balance')::numeric else closing_balance end,
    credit_limit = case when p_corrections ? 'credit_limit'
      then (p_corrections->>'credit_limit')::numeric else credit_limit end,
    minimum_payment = case when p_corrections ? 'minimum_payment'
      then (p_corrections->>'minimum_payment')::numeric else minimum_payment end,
    purchases_total = case when p_corrections ? 'purchases_total'
      then (p_corrections->>'purchases_total')::numeric else purchases_total end,
    cash_advances_total = case when p_corrections ? 'cash_advances_total'
      then (p_corrections->>'cash_advances_total')::numeric else cash_advances_total end,
    refunds_total = case when p_corrections ? 'refunds_total'
      then (p_corrections->>'refunds_total')::numeric else refunds_total end,

    opening_principal = case when p_corrections ? 'opening_principal'
      then (p_corrections->>'opening_principal')::numeric else opening_principal end,
    closing_principal = case when p_corrections ? 'closing_principal'
      then (p_corrections->>'closing_principal')::numeric else closing_principal end,
    drawdowns_total = case when p_corrections ? 'drawdowns_total'
      then (p_corrections->>'drawdowns_total')::numeric else drawdowns_total end,
    capitalised_total = case when p_corrections ? 'capitalised_total'
      then (p_corrections->>'capitalised_total')::numeric else capitalised_total end,
    principal_repayments_total = case when p_corrections ? 'principal_repayments_total'
      then (p_corrections->>'principal_repayments_total')::numeric else principal_repayments_total end,

    interest_total = case when p_corrections ? 'interest_total'
      then (p_corrections->>'interest_total')::numeric else interest_total end,
    fees_total = case when p_corrections ? 'fees_total'
      then (p_corrections->>'fees_total')::numeric else fees_total end,
    payments_total = case when p_corrections ? 'payments_total'
      then (p_corrections->>'payments_total')::numeric else payments_total end,
    adjustments_total = case when p_corrections ? 'adjustments_total'
      then (p_corrections->>'adjustments_total')::numeric else adjustments_total end,

    interest_rate = case when p_corrections ? 'interest_rate'
      then (p_corrections->>'interest_rate')::numeric else interest_rate end,

    -- The variance safety net is RE-STAMPED, never dropped: a corrected
    -- statement that still does not add up stays a 'variance', and one that
    -- can no longer be checked at all says so.
    reconciliation_status = case when v_recon_changed then p_reconciliation_status else reconciliation_status end,
    reconciliation_variance = case when v_recon_changed then p_reconciliation_variance else reconciliation_variance end,
    -- A corrected statement is still something a human should look at before
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
  where id = p_statement_id;

  perform set_config('fhip.import_bridge_internal_write', 'false', true);

  return jsonb_build_object(
    'ok', true,
    'outcome', 'corrected',
    'corrected_fields', to_jsonb(v_changed),
    'reconciliation_restamped', v_recon_changed
  );
end;
$$ language plpgsql security definer set search_path = public;

revoke all on function fdh10_correct_liability_statement(uuid, jsonb, text, numeric) from public;
grant execute on function fdh10_correct_liability_statement(uuid, jsonb, text, numeric) to authenticated, service_role;


-- ===========================================================================
-- 4. AUDIT-EVENT VOCABULARY WIDENING
-- ===========================================================================
--
-- ONE new value: `liability_statement_corrected`. The list below is the
-- CURRENT constraint (migrations 0173 + 0180 + 0185) verbatim plus that value
-- — a STRICT SUPERSET, verified value by value rather than assumed, following
-- the widening discipline
-- 0064/0068/0071/0076/0091/0096/0106/0112/0173/0180/0185 established.
--
-- WHY "THE CURRENT CONSTRAINT" AND NOT "THE MIGRATION I DIFFED AGAINST". This
-- file was first drafted against a copy of 0185 that predated 0180: 81 values,
-- silently missing 0180's 28 AI-fallback event types. Applying that draft on
-- top of 0180 would have REVOKED all 28. The list below is therefore copied
-- from the 0185 that sits in this same lineage AFTER its own merge with 0180,
-- and `tests/unit/fdh10LiabilityCorrection.test.ts` re-derives the predecessor
-- from the migration ledger rather than hardcoding a number, so the same
-- mistake fails loudly next time instead of shipping.
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
      -- AIE unified AI-fallback additions for the other four document types
      -- (migration 0180). Added here because 0180 landed on `main` after this
      -- migration was first drafted: this constraint is DROPped and recreated,
      -- so omitting them would silently REVOKE 0180's vocabulary. Verified
      -- value-by-value against 0180 as a strict superset, not assumed.
      'bank_statement_ai_fallback_attempted',
      'bank_statement_ai_fallback_masking_below_policy',
      'bank_statement_ai_fallback_provider_outcome',
      'bank_statement_ai_fallback_insufficient_fields',
      'bank_statement_ai_fallback_draft_ready',
      'bank_statement_ai_fallback_not_usable',
      'bank_statement_ai_fallback_confirmed',
      'investment_statement_ai_fallback_attempted',
      'investment_statement_ai_fallback_masking_below_policy',
      'investment_statement_ai_fallback_provider_outcome',
      'investment_statement_ai_fallback_insufficient_fields',
      'investment_statement_ai_fallback_draft_ready',
      'investment_statement_ai_fallback_not_usable',
      'investment_statement_ai_fallback_confirmed',
      'liability_statement_ai_fallback_attempted',
      'liability_statement_ai_fallback_masking_below_policy',
      'liability_statement_ai_fallback_provider_outcome',
      'liability_statement_ai_fallback_insufficient_fields',
      'liability_statement_ai_fallback_draft_ready',
      'liability_statement_ai_fallback_not_usable',
      'liability_statement_ai_fallback_confirmed',
      'retirement_statement_ai_fallback_attempted',
      'retirement_statement_ai_fallback_masking_below_policy',
      'retirement_statement_ai_fallback_provider_outcome',
      'retirement_statement_ai_fallback_insufficient_fields',
      'retirement_statement_ai_fallback_draft_ready',
      'retirement_statement_ai_fallback_not_usable',
      'retirement_statement_ai_fallback_confirmed',
      -- Payslip review/correction addition (migration 0185).
      -- Metadata carries the corrected field NAMES only — never the figures,
      -- which already live in their own columns (auditLog.ts's own rule:
      -- `metadata` never carries document content).
      'payroll_event_corrected',
      -- Liability statement review/correction addition (this migration).
      -- Metadata carries the corrected field NAMES only — never the figures,
      -- which already live in their own columns (auditLog.ts's own rule:
      -- `metadata` never carries document content).
      'liability_statement_corrected'
    ));
