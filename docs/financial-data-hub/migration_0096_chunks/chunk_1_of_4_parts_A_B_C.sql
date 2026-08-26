-- =============================================================================
-- FDH-10 — Credit Cards & Loans Intelligence (migration 0096).
--
-- MIGRATION NUMBER GOVERNANCE. `origin/main` (2d6d1e9) tops out at 0095
-- (0094/0095 are live-on-main authoritative-forgery hotfixes). 0093 is
-- reserved by the unmerged `feature/education-goal-linkage` branch (not on
-- main) and is NOT reused here, per this project's own "do not renumber an
-- already-claimed sibling" rule. A fresh cross-branch/cross-worktree scan at
-- dispatch time (`git ls-tree` over every local branch, every worktree HEAD,
-- and the `doclife`/`origin` remotes) found no other branch claiming 0096 or
-- higher. 0096 is therefore the genuinely free next number.
--
-- ADDITIVE ONLY, same discipline as 0091 (FDH-9) and every FDH migration
-- before it. No existing column, constraint, index, policy or row is removed.
-- Every `alter ... check` widens a closed vocabulary; nothing narrows one.
--
-- ARCHITECTURE (see docs/financial-data-hub/FDH10_ARCHITECTURE.md for the
-- full account). FDH-1 (migrations 0045-0048) already anticipated FDH-10:
--   * fdh_financial_accounts.account_type already has 'credit_card',
--     'home_loan', 'personal_loan', 'vehicle_loan'.
--   * fdh_statement_uploads.document_type already has
--     'credit_card_statement', 'loan_statement'.
--   * fdh_transactions.economic_transaction_type already has
--     'debt_principal', 'debt_interest', 'fee', 'refund', 'cash_withdrawal'.
--   * fdh_transaction_links.link_type already has 'credit_card_settlement'
--     and 'loan_payment'.
--   * fdh_transaction_allocations already implements the split mechanism
--     loan-repayment decomposition reuses verbatim.
--   * fhip_import_proposals/fhip_import_applications.target_domain already
--     includes 'liability' (FDH-9, spec section 7's five-domain design).
-- FDH-10 therefore adds: (1) the four facility types the Product Owner named
-- that FDH-1 did not yet anticipate, (2) a canonical liability-STATEMENT
-- evidence model (new tables — spec sections 19-20 are explicit that this is
-- a genuinely new capability, distinct from the bank-transaction ledger it
-- feeds), (3) the liability-domain branch of the FDH-9 import bridge's
-- same-tenant guards and its own typed atomic-apply RPC, and (4) liability
-- provenance columns, mirroring income_sources' own (migration 0091 D.5).
-- =============================================================================


-- ---------------------------------------------------------------------------
-- PART A — WIDEN EXISTING CLOSED VOCABULARIES (additive only)
-- ---------------------------------------------------------------------------

alter table fdh_financial_accounts drop constraint if exists fdh_financial_accounts_account_type_check;
alter table fdh_financial_accounts
  add constraint fdh_financial_accounts_account_type_check
    check (account_type in (
      'transaction', 'savings', 'term_deposit', 'credit_card', 'home_loan',
      'personal_loan', 'vehicle_loan', 'brokerage_source', 'super_source',
      'epf_source', 'nps_source', 'other',
      -- FDH-10 additions (spec section 12).
      'investment_property_loan', 'other_term_loan', 'line_of_credit', 'overdraft'
    ));

alter table fhip_import_proposals drop constraint if exists fhip_import_proposals_source_kind_check;
alter table fhip_import_proposals
  add constraint fhip_import_proposals_source_kind_check
    check (source_kind in (
      'payslip', 'bank_statement', 'investment_statement', 'loan_statement', 'retirement_statement',
      -- FDH-10 addition (spec sections 3, 13): a credit-card statement is a
      -- distinct evidence shape from a loan statement, though both feed the
      -- same 'liability' target_domain.
      'credit_card_statement'
    ));

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
      -- FDH-10 additions (spec sections 19, 41-42).
      'liability_statement_extraction_completed',
      'liability_statement_extraction_failed',
      'liability_statement_approved',
      'liability_bank_match_completed',
      'liability_proposal_generated',
      'liability_proposal_applied',
      'liability_proposal_dismissed'
    ));


-- ---------------------------------------------------------------------------
-- PART B — liabilities: additive columns (spec sections 13-14, 19, 41, 51,
-- 77-85). Every existing column, every existing row, every existing RLS
-- policy is untouched — manual liability add/edit/delete keeps working
-- exactly as before (spec section 129).
-- ---------------------------------------------------------------------------
alter table liabilities
  add column if not exists masked_identifier text,
  add column if not exists minimum_payment numeric(18,2) check (minimum_payment is null or minimum_payment >= 0),
  add column if not exists available_credit numeric(18,2) check (available_credit is null or available_credit >= 0),
  add column if not exists due_date date,
  add column if not exists arrears_status text
    check (arrears_status is null or arrears_status in ('current', 'arrears', 'unknown')),
  add column if not exists source_type text,
  add column if not exists last_import_application_id uuid references fhip_import_applications(id) on delete set null,
  add column if not exists last_imported_at timestamptz;

-- Same masked-identifier discipline as fdh_financial_accounts (spec section
-- 13): no run of 7+ consecutive digits may ever be persisted here.
alter table liabilities drop constraint if exists chk_liabilities_masked_identifier;
alter table liabilities
  add constraint chk_liabilities_masked_identifier
    check (masked_identifier is null or masked_identifier !~ '[0-9]{7,}');

create index if not exists idx_liabilities_last_import_application
  on liabilities(last_import_application_id) where last_import_application_id is not null;


-- ---------------------------------------------------------------------------
-- PART C — fdh_liability_statements (spec sections 19-20). The canonical
-- statement-level evidence record — one row per parsed credit-card or loan
-- statement. Mirrors `fdh_payroll_events`' shape and RLS/trigger discipline.
-- ---------------------------------------------------------------------------
create table fdh_liability_statements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  household_id uuid references households(id) on delete set null,

  statement_upload_id uuid references fdh_statement_uploads(id) on delete set null,
  financial_account_id uuid references fdh_financial_accounts(id) on delete set null,
  -- Nullable: unresolved until facility matching (spec 50-52) runs, or the
  -- user picks ADD NEW at review time.
  liability_id uuid references liabilities(id) on delete set null,

  statement_type text not null check (statement_type in ('credit_card', 'loan')),
  facility_type text not null
    check (facility_type in (
      'credit_card', 'personal_loan', 'home_loan', 'investment_property_loan',
      'vehicle_loan', 'other_term_loan', 'line_of_credit', 'overdraft'
    )),
  country_code char(2) references countries(country_code) on delete restrict,
  currency_code char(3) not null references currencies(currency_code) on delete restrict,

  institution_name text,
  masked_identifier text,

  statement_period_start date,
  statement_period_end date,
  statement_date date,
  due_date date,

  opening_balance numeric(20,4),
  closing_balance numeric(20,4),
  credit_limit numeric(20,4) check (credit_limit is null or credit_limit >= 0),
  available_credit numeric(20,4) check (available_credit is null or available_credit >= 0),
  minimum_payment numeric(20,4) check (minimum_payment is null or minimum_payment >= 0),

  opening_principal numeric(20,4),
  closing_principal numeric(20,4),
  interest_rate numeric(8,4) check (interest_rate is null or interest_rate >= 0),
  rate_type text check (rate_type is null or rate_type in ('purchase', 'cash_advance', 'promotional', 'loan_variable', 'loan_fixed')),
  repayment_frequency text,
  maturity_date date,
  arrears_amount numeric(20,4) check (arrears_amount is null or arrears_amount >= 0),

  -- Statement activity totals (spec 36-38's reconciliation formula inputs).
  purchases_total numeric(20,4),
  cash_advances_total numeric(20,4),
  interest_total numeric(20,4),
  fees_total numeric(20,4),
  payments_total numeric(20,4),
  refunds_total numeric(20,4),
  adjustments_total numeric(20,4),
  drawdowns_total numeric(20,4),
  capitalised_total numeric(20,4),
  principal_repayments_total numeric(20,4),

  reconciliation_status text not null default 'insufficient_data'
    check (reconciliation_status in ('reconciled', 'variance', 'insufficient_data')),
  reconciliation_variance numeric(20,4),

  parser_name text,
  parser_version text,
  extraction_confidence numeric(5,4) check (extraction_confidence is null or (extraction_confidence >= 0 and extraction_confidence <= 1)),

  review_status text not null default 'not_required'
    check (review_status in ('not_required', 'pending', 'in_review', 'resolved')),
  approval_status text not null default 'pending'
    check (approval_status in ('pending', 'approved')),
  approved_at timestamptz,
  approved_by uuid references auth.users(id) on delete set null,

  -- Duplicate/revision provenance (spec sections 70-71) — the whole-document
  -- dedup signal itself is `fdh_statement_uploads.file_hash` (reused, not
  -- duplicated); this column records which EARLIER statement a re-upload or
  -- reissued/corrected statement supersedes, once a human/engine has decided
  -- that relationship.
  duplicate_of_statement_id uuid references fdh_liability_statements(id) on delete set null,
  supersedes_statement_id uuid references fdh_liability_statements(id) on delete set null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint chk_fdh_liability_statements_masked_identifier
    check (masked_identifier is null or masked_identifier !~ '[0-9]{7,}'),
  constraint chk_fdh_liability_statements_period
    check (statement_period_end is null or statement_period_start is null or statement_period_end >= statement_period_start),
  constraint chk_fdh_liability_statements_approved_at
    check (approved_at is null or approval_status = 'approved')
);
create index idx_fdh_liability_statements_user on fdh_liability_statements(user_id);
create index idx_fdh_liability_statements_liability on fdh_liability_statements(liability_id) where liability_id is not null;
create index idx_fdh_liability_statements_upload on fdh_liability_statements(statement_upload_id);
create index idx_fdh_liability_statements_account on fdh_liability_statements(financial_account_id);

alter table fdh_liability_statements enable row level security;
create policy "read own fdh_liability_statements" on fdh_liability_statements
  for select using (auth.uid() = user_id);
create policy "insert own fdh_liability_statements" on fdh_liability_statements
  for insert with check (auth.uid() = user_id);
create policy "update own fdh_liability_statements" on fdh_liability_statements
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);


-- ---------------------------------------------------------------------------
