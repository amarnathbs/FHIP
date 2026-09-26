-- 0207 -- Approved Upload -> Canonical User Data programme: the shared schema
-- and integration-seam foundation (work package WP-01).
--
-- WHAT THIS IS. The additive columns, one internal helper and the two shared
-- CHECK widenings that the eight downstream work packages (WP-08..WP-13) need
-- in order to build in parallel. It changes NO existing behaviour for any row
-- or any caller that does not opt in:
--   * every new column is nullable, or has a constant default (no rewrite);
--   * the two widened CHECKs are strict supersets of the live predecessors,
--     and the migration REFUSES to run if the live constraint holds a value
--     this file does not list (see section F/G);
--   * r7_block_authenticated_insert() keeps refusing every authenticated
--     INSERT exactly as before unless the transaction has set the internal-
--     write GUC -- which only SECURITY DEFINER functions can do;
--   * the new helper is not executable by public/anon/authenticated.
--
-- OWNERSHIP RULE. This is the ONLY migration of the programme allowed to widen
-- a shared CHECK (fdh_statement_uploads.error_code and
-- fdh_document_audit_events.event_type). Every later package (0208-0214) that
-- needs a new code/event type must come back here, never DROP-and-recreate the
-- constraint itself -- that is the trap that has silently revoked sibling
-- values twice in this repository (0185 vs 0180, 0186 draft vs 0180).
--
-- PREDECESSORS, DERIVED FROM THE LEDGER (not assumed):
--   * fdh_statement_uploads_error_code_check -- rebuilt by 0046, 0071, 0170,
--     0179. 0206 does NOT touch it (its header says so, and it is verified in
--     tests/unit/canonical0207SchemaContract.test.ts). Latest: 0179, 24 values.
--   * fdh_document_audit_events_event_type_check -- base 0058, rebuilt by
--     0064, 0068, 0071, 0076, 0091, 0096, 0106, 0112, 0173, 0180, 0185, 0186.
--     Latest: 0186, 109 values.
-- Both lists below repeat the predecessor verbatim and only APPEND.
--
-- IDEMPOTENT. Every statement is guarded (add column if not exists, guarded
-- add constraint, create or replace, drop trigger if exists + create, create
-- index if not exists). A second apply is a no-op; proven by
-- scripts/canonical_0207_pglite_verification.mjs.
--
-- ZERO ROWS REWRITTEN. `add column ... default <constant>` is a catalogue-only
-- change on PG11+; no UPDATE statement appears in this file.

-- ============================================================================
-- A. fdh_financial_accounts: owner attribution (PO D-10) and the facility ->
--    liability link that the FDH-10 ledger Apply (WP-11) and the canonical
--    read models (WP-02) use to tell a card/loan facility account apart.
-- ============================================================================
alter table fdh_financial_accounts
  add column if not exists owner_role text,
  add column if not exists liability_id uuid references liabilities(id) on delete set null;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'fdh_financial_accounts'::regclass and conname = 'chk_fdh_financial_accounts_owner_role_0207') then
    alter table fdh_financial_accounts add constraint chk_fdh_financial_accounts_owner_role_0207
      check (owner_role is null or owner_role in ('self', 'spouse', 'joint', 'smsf'));
  end if;
end $$;

-- One facility account per liability (a liability row is one card/loan).
create unique index if not exists uq_fdh_financial_accounts_liability_0207
  on fdh_financial_accounts(liability_id) where liability_id is not null;

-- Same-tenant guard: a FOREIGN KEY proves the liability exists, not that it
-- belongs to the account's owner (the 0058 FDH1-F1 pattern). Runs for every
-- role, including service_role.
create or replace function fdh0207_assert_account_liability_owner() returns trigger as $$
declare
  v_owner uuid;
begin
  if new.liability_id is null then
    return new;
  end if;
  select user_id into v_owner from liabilities where id = new.liability_id;
  if v_owner is null then
    raise exception 'fdh_financial_accounts: liability_id % does not exist', new.liability_id;
  end if;
  if v_owner <> new.user_id then
    raise exception 'fdh_financial_accounts: cross-tenant reference -- liability % belongs to a different user', new.liability_id;
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists trg_fdh_financial_accounts_liability_owner_0207 on fdh_financial_accounts;
create trigger trg_fdh_financial_accounts_liability_owner_0207
  before insert or update of user_id, liability_id on fdh_financial_accounts
  for each row execute function fdh0207_assert_account_liability_owner();

-- ============================================================================
-- B. fdh_liability_statement_activities: the canonical ledger row an approved
--    activity became (WP-11), and the Indian card GST line that extraction
--    already reads but has never had a column for (G6, WP-10 persists it).
-- ============================================================================
alter table fdh_liability_statement_activities
  add column if not exists ledger_transaction_id uuid references fdh_transactions(id) on delete set null,
  add column if not exists gst_amount_raw text;

-- One activity -> at most one ledger row, and one ledger row -> at most one
-- activity (repeat Apply can never create a second effect).
create unique index if not exists uq_fdh_liability_activities_ledger_txn_0207
  on fdh_liability_statement_activities(ledger_transaction_id) where ledger_transaction_id is not null;

create or replace function fdh0207_assert_activity_ledger_owner() returns trigger as $$
declare
  v_owner uuid;
begin
  if new.ledger_transaction_id is null then
    return new;
  end if;
  select user_id into v_owner from fdh_transactions where id = new.ledger_transaction_id;
  if v_owner is null then
    raise exception 'fdh_liability_statement_activities: ledger_transaction_id % does not exist', new.ledger_transaction_id;
  end if;
  if v_owner <> new.user_id then
    raise exception 'fdh_liability_statement_activities: cross-tenant reference -- transaction % belongs to a different user', new.ledger_transaction_id;
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists trg_fdh_liability_activities_ledger_owner_0207 on fdh_liability_statement_activities;
create trigger trg_fdh_liability_activities_ledger_owner_0207
  before insert or update of user_id, ledger_transaction_id on fdh_liability_statement_activities
  for each row execute function fdh0207_assert_activity_ledger_owner();

-- ============================================================================
-- C. extraction_warnings on the three statement-evidence tables (G6, INV-G6,
--    GAP-RET-05): dropped rows and parser warnings become persisted, visible
--    evidence instead of vanishing. A JSON array of {code, count?, detail?}.
-- ============================================================================
alter table fdh_liability_statements
  add column if not exists extraction_warnings jsonb not null default '[]'::jsonb;
alter table fdh_retirement_statements
  add column if not exists extraction_warnings jsonb not null default '[]'::jsonb;
alter table fdh_investment_statements
  add column if not exists extraction_warnings jsonb not null default '[]'::jsonb;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'fdh_liability_statements'::regclass and conname = 'chk_fdh_liability_statements_extraction_warnings_0207') then
    alter table fdh_liability_statements add constraint chk_fdh_liability_statements_extraction_warnings_0207
      check (jsonb_typeof(extraction_warnings) = 'array');
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'fdh_retirement_statements'::regclass and conname = 'chk_fdh_retirement_statements_extraction_warnings_0207') then
    alter table fdh_retirement_statements add constraint chk_fdh_retirement_statements_extraction_warnings_0207
      check (jsonb_typeof(extraction_warnings) = 'array');
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'fdh_investment_statements'::regclass and conname = 'chk_fdh_investment_statements_extraction_warnings_0207') then
    alter table fdh_investment_statements add constraint chk_fdh_investment_statements_extraction_warnings_0207
      check (jsonb_typeof(extraction_warnings) = 'array');
  end if;
end $$;

-- ============================================================================
-- D. fdh_payroll_events.income_owner (GAP-05): whose payslip this is. Null
--    means "not yet chosen" (every existing row); the Apply RPC (WP-09, 0210)
--    scopes income_sources candidates to it.
-- ============================================================================
alter table fdh_payroll_events
  add column if not exists income_owner text;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'fdh_payroll_events'::regclass and conname = 'chk_fdh_payroll_events_income_owner_0207') then
    alter table fdh_payroll_events add constraint chk_fdh_payroll_events_income_owner_0207
      check (income_owner is null or income_owner in ('self', 'spouse'));
  end if;
end $$;

-- ============================================================================
-- E. Import-bridge evidence: what an Apply wrote to the ledger (WP-11) and the
--    proposal explanation that persistProposal used to discard (GAP-07).
-- ============================================================================
alter table fhip_import_applications
  add column if not exists ledger_effects jsonb;
alter table fhip_import_proposals
  add column if not exists summary jsonb;

-- ============================================================================
-- F. fdh_statement_uploads.error_code: + 'extraction_timeout' (UPL-01).
--    Predecessor: 0179 (24 values), repeated verbatim.
-- ============================================================================
-- Revocation guard. Before the constraint is replaced, every value the LIVE
-- constraint currently permits must appear in the new list. If a sibling
-- migration (not in this ledger) widened it first, this raises instead of
-- silently revoking that sibling's values.
do $$
declare
  v_live text[];
  v_new text[] := array[
    'unsupported_file_type', 'file_corrupt', 'password_required',
    'password_invalid', 'institution_not_identified',
    'document_type_not_identified', 'parser_not_found', 'layout_unsupported',
    'extraction_failed', 'reconciliation_failed', 'data_validation_failed',
    'malware_detected', 'privacy_purge_failed', 'internal_error',
    'page_limit_exceeded', 'format_ambiguous', 'extraction_low_confidence',
    'ocr_required', 'ocr_failed',
    'structural_scan_rejected',
    'malware_scan_suspicious', 'malware_scan_failed',
    'malware_scan_timeout', 'malware_scan_unknown',
    'extraction_timeout'
  ];
  v_missing text[];
begin
  select array_agg(m[1]) into v_live
  from pg_constraint c, regexp_matches(pg_get_constraintdef(c.oid), '''([a-z0-9_]+)''', 'g') as m
  where c.conrelid = 'fdh_statement_uploads'::regclass and c.conname = 'fdh_statement_uploads_error_code_check';
  select array_agg(v) into v_missing from unnest(coalesce(v_live, '{}'::text[])) as v where not (v = any (v_new));
  if v_missing is not null then
    raise exception '0207 would REVOKE fdh_statement_uploads.error_code values %: add them to this migration first', v_missing;
  end if;
end $$;

alter table fdh_statement_uploads
  drop constraint if exists fdh_statement_uploads_error_code_check;
alter table fdh_statement_uploads
  add constraint fdh_statement_uploads_error_code_check
    check (error_code is null or error_code in (
      -- FDH-1 original set (migration 0046) -- unchanged.
      'unsupported_file_type', 'file_corrupt', 'password_required',
      'password_invalid', 'institution_not_identified',
      'document_type_not_identified', 'parser_not_found', 'layout_unsupported',
      'extraction_failed', 'reconciliation_failed', 'data_validation_failed',
      'malware_detected', 'privacy_purge_failed', 'internal_error',
      -- FDH-5 additions (migration 0071) -- unchanged.
      'page_limit_exceeded', 'format_ambiguous', 'extraction_low_confidence',
      'ocr_required', 'ocr_failed',
      -- FDH-3 structural-scan addition (migration 0170) -- unchanged.
      'structural_scan_rejected',
      -- FDH-3 real malware-scan additions (migration 0179) -- unchanged.
      'malware_scan_suspicious', 'malware_scan_failed',
      'malware_scan_timeout', 'malware_scan_unknown',
      -- Canonical-upload addition (this migration): a bounded wall-clock
      -- extraction timeout (residual R-14-8), distinct from a parse failure
      -- so the panel can tell the user to retry.
      'extraction_timeout'
    ));

-- ============================================================================
-- G. fdh_document_audit_events.event_type: + 7 canonical-upload event types.
--    Predecessor: 0186 (109 values), repeated verbatim.
-- ============================================================================
do $$
declare
  v_live text[];
  v_new text[] := array[
    'document_upload_created', 'document_upload_completed', 'document_validated',
    'document_rejected', 'document_queued', 'document_user_deleted',
    'document_purge_scheduled', 'document_purged', 'document_purge_failed',
    'bank_csv_uploaded', 'bank_csv_detection_completed', 'bank_csv_mapping_confirmed',
    'bank_csv_processing_started', 'bank_csv_processing_completed',
    'bank_csv_processing_failed', 'transaction_duplicate_detected',
    'transaction_duplicate_resolved', 'transaction_corrected', 'import_reconciled',
    'transaction_classification_run', 'transaction_link_reviewed',
    'recurring_series_reviewed', 'personal_rule_created',
    'pdf_validated', 'pdf_password_required', 'pdf_decrypted_for_processing',
    'pdf_native_extraction_started', 'pdf_native_extraction_completed',
    'pdf_ocr_started', 'pdf_ocr_completed', 'pdf_adapter_detected',
    'pdf_processing_failed', 'pdf_review_required', 'pdf_processing_completed',
    'transaction_split_created', 'transaction_approved', 'statement_approved',
    'statement_reopened', 'bulk_review_action_completed',
    'payslip_extraction_completed', 'payslip_extraction_failed',
    'payroll_event_approved', 'income_proposal_generated',
    'income_proposal_applied', 'income_proposal_dismissed',
    'liability_statement_extraction_completed', 'liability_statement_extraction_failed',
    'liability_statement_approved', 'liability_bank_match_completed',
    'liability_proposal_generated', 'liability_proposal_applied', 'liability_proposal_dismissed',
    'investment_statement_extraction_completed', 'investment_statement_extraction_failed',
    'investment_statement_account_matched', 'investment_statement_security_matched',
    'investment_statement_reconciled', 'investment_statement_bank_match_completed',
    'investment_statement_approved', 'investment_statement_applied',
    'investment_statement_apply_rejected_stale',
    'retirement_statement_extraction_completed', 'retirement_statement_extraction_failed',
    'retirement_statement_account_matched', 'retirement_statement_payslip_matched',
    'retirement_statement_reconciled', 'retirement_statement_bank_match_completed',
    'retirement_statement_routed_to_smsf', 'retirement_statement_approved',
    'retirement_proposal_generated', 'retirement_proposal_applied', 'retirement_proposal_dismissed',
    'payslip_ai_fallback_attempted', 'payslip_ai_fallback_masking_below_policy',
    'payslip_ai_fallback_provider_outcome', 'payslip_ai_fallback_insufficient_fields',
    'payslip_ai_fallback_draft_ready', 'payslip_ai_fallback_not_usable',
    'payslip_ai_fallback_confirmed',
    'bank_statement_ai_fallback_attempted', 'bank_statement_ai_fallback_masking_below_policy',
    'bank_statement_ai_fallback_provider_outcome', 'bank_statement_ai_fallback_insufficient_fields',
    'bank_statement_ai_fallback_draft_ready', 'bank_statement_ai_fallback_not_usable',
    'bank_statement_ai_fallback_confirmed',
    'investment_statement_ai_fallback_attempted', 'investment_statement_ai_fallback_masking_below_policy',
    'investment_statement_ai_fallback_provider_outcome', 'investment_statement_ai_fallback_insufficient_fields',
    'investment_statement_ai_fallback_draft_ready', 'investment_statement_ai_fallback_not_usable',
    'investment_statement_ai_fallback_confirmed',
    'liability_statement_ai_fallback_attempted', 'liability_statement_ai_fallback_masking_below_policy',
    'liability_statement_ai_fallback_provider_outcome', 'liability_statement_ai_fallback_insufficient_fields',
    'liability_statement_ai_fallback_draft_ready', 'liability_statement_ai_fallback_not_usable',
    'liability_statement_ai_fallback_confirmed',
    'retirement_statement_ai_fallback_attempted', 'retirement_statement_ai_fallback_masking_below_policy',
    'retirement_statement_ai_fallback_provider_outcome', 'retirement_statement_ai_fallback_insufficient_fields',
    'retirement_statement_ai_fallback_draft_ready', 'retirement_statement_ai_fallback_not_usable',
    'retirement_statement_ai_fallback_confirmed',
    'payroll_event_corrected',
    'liability_statement_corrected',
    'liability_ledger_applied', 'liability_statement_rejected',
    'payroll_bank_match_restamped', 'payroll_event_superseded',
    'bank_leg_reclassified_by_import', 'investment_positions_published',
    'post_approval_matcher_failed'
  ];
  v_missing text[];
begin
  select array_agg(m[1]) into v_live
  from pg_constraint c, regexp_matches(pg_get_constraintdef(c.oid), '''([a-z0-9_]+)''', 'g') as m
  where c.conrelid = 'fdh_document_audit_events'::regclass and c.conname = 'fdh_document_audit_events_event_type_check';
  select array_agg(v) into v_missing from unnest(coalesce(v_live, '{}'::text[])) as v where not (v = any (v_new));
  if v_missing is not null then
    raise exception '0207 would REVOKE fdh_document_audit_events.event_type values %: add them to this migration first', v_missing;
  end if;
end $$;

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
      -- AIE unified AI-fallback additions (migration 0180).
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
      'payroll_event_corrected',
      -- Liability statement review/correction addition (migration 0186).
      'liability_statement_corrected',
      -- Canonical-upload programme additions (this migration). Metadata
      -- carries ids, types and counts only -- never document figures.
      'liability_ledger_applied',
      'liability_statement_rejected',
      'payroll_bank_match_restamped',
      'payroll_event_superseded',
      'bank_leg_reclassified_by_import',
      'investment_positions_published',
      'post_approval_matcher_failed'
    ));

-- ============================================================================
-- H. r7_block_authenticated_insert(): the ONE new way through.
--
-- Predecessor: 0064:393-400 (no later migration redefines it). It is the
-- trigger function on fdh_transactions, fdh_reconciliation_results,
-- fdh_data_quality_results, fdh_data_provenance, fdh_duplicate_candidates
-- (0064) and two R8 tables (0068). An authenticated INSERT is still refused
-- -- unless the SAME transaction has set fhip.import_bridge_internal_write
-- = 'true'. set_config(..., true) is transaction-local, PostgREST never runs
-- a caller-supplied set_config, and every writer of this GUC is a SECURITY
-- DEFINER function that sets it, performs its own write and resets it (the
-- 0091/0096/0112/0113 pattern). This is what lets the FDH-10 ledger Apply
-- (WP-11) write fdh_transactions from inside its atomic RPC, where
-- auth.role() is still 'authenticated'.
-- ============================================================================
create or replace function r7_block_authenticated_insert() returns trigger as $$
begin
  if auth.role() = 'authenticated'
     and coalesce(current_setting('fhip.import_bridge_internal_write', true), 'false') <> 'true' then
    raise exception '% is engine-authoritative: rows may only be created by trusted server-side processing', tg_table_name;
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

-- ============================================================================
-- I. fdh_internal_reclassify_corroborated_leg(): the one sanctioned way for an
--    import to change the economic type of an EXISTING bank leg that another
--    approved document corroborates (payroll, liability, investment,
--    retirement evidence). Used by WP-09/WP-11/WP-12/WP-13.
--
--   * never touches a row the user settled (user_override) -- returns
--     'skipped_user_override';
--   * writes the fdh_transaction_corrections row FIRST, so the 0068 R8
--     evidence check (r8_transaction_field_evidenced) passes when the caller
--     is an authenticated RPC, and the history is preserved;
--   * audits 'bank_leg_reclassified_by_import' against the leg's statement;
--   * refuses a cross-tenant call (auth.uid() set and different from p_user);
--   * NOT executable by public/anon/authenticated: only other SECURITY
--     DEFINER functions (owner) and service_role can call it.
-- ============================================================================
create or replace function fdh_internal_reclassify_corroborated_leg(
  p_user uuid,
  p_txn uuid,
  p_new_type text,
  p_reason text,
  p_source_kind text,
  p_source_id uuid
) returns text as $$
declare
  v_txn record;
begin
  if p_user is null or p_txn is null then
    raise exception 'RECLASSIFY_INVALID_ARGUMENT';
  end if;
  if auth.uid() is not null and auth.uid() <> p_user then
    raise exception 'RECLASSIFY_FOREIGN_USER';
  end if;
  if p_new_type is null or p_new_type not in (
    'income', 'expense', 'transfer', 'investment', 'debt_principal', 'debt_interest',
    'refund', 'asset_purchase', 'asset_sale', 'tax', 'fee', 'cash_withdrawal'
  ) then
    raise exception 'RECLASSIFY_INVALID_TYPE';
  end if;
  if p_source_kind is null or p_source_kind not in (
    'payroll_event', 'liability_statement_activity',
    'investment_statement_activity', 'retirement_statement_activity'
  ) then
    raise exception 'RECLASSIFY_INVALID_SOURCE_KIND';
  end if;

  select id, user_id, statement_upload_id, economic_transaction_type, user_override
    into v_txn
    from fdh_transactions
   where id = p_txn and user_id = p_user
   for update;
  if not found then
    raise exception 'RECLASSIFY_NOT_FOUND';
  end if;
  if v_txn.user_override then
    return 'skipped_user_override';
  end if;
  if v_txn.economic_transaction_type = p_new_type then
    return 'unchanged';
  end if;

  insert into fdh_transaction_corrections (user_id, transaction_id, field_name, previous_value, corrected_value, reason)
  values (p_user, p_txn, 'economic_transaction_type', to_jsonb(v_txn.economic_transaction_type), to_jsonb(p_new_type),
          left('system:' || p_source_kind || ':' || coalesce(p_reason, ''), 500));

  update fdh_transactions
     set economic_transaction_type = p_new_type,
         updated_at = now()
   where id = p_txn and user_id = p_user;

  insert into fdh_document_audit_events (user_id, document_id, event_type, actor_type, actor_id, metadata)
  values (p_user, v_txn.statement_upload_id, 'bank_leg_reclassified_by_import', 'system', null,
          jsonb_build_object(
            'transaction_id', p_txn,
            'previous_type', v_txn.economic_transaction_type,
            'new_type', p_new_type,
            'source_kind', p_source_kind,
            'source_id', p_source_id,
            'reason', p_reason));

  return 'reclassified';
end;
$$ language plpgsql security definer set search_path = public;

revoke all on function fdh_internal_reclassify_corroborated_leg(uuid, uuid, text, text, text, uuid) from public;
revoke all on function fdh_internal_reclassify_corroborated_leg(uuid, uuid, text, text, text, uuid) from anon;
revoke all on function fdh_internal_reclassify_corroborated_leg(uuid, uuid, text, text, text, uuid) from authenticated;
grant execute on function fdh_internal_reclassify_corroborated_leg(uuid, uuid, text, text, text, uuid) to service_role;
