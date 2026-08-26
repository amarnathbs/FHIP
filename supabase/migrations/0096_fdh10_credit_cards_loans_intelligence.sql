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
-- PART D — fdh_liability_statement_activities (spec section 20). One row per
-- line item read off a statement. `linked_transaction_id` is the ONLY bridge
-- to the canonical ledger — no parallel activity ledger is created (spec
-- section 20's "do not unnecessarily duplicate canonical bank activity").
-- ---------------------------------------------------------------------------
create table fdh_liability_statement_activities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  statement_id uuid not null references fdh_liability_statements(id) on delete cascade,

  activity_type text not null
    check (activity_type in (
      'PURCHASE', 'REFUND', 'PAYMENT', 'CASH_ADVANCE', 'INTEREST', 'FEE',
      'PRINCIPAL', 'LOAN_ADVANCE', 'ADJUSTMENT', 'OTHER'
    )),
  activity_date date not null,
  amount numeric(20,4) not null check (amount > 0),
  currency_code char(3) not null references currencies(currency_code) on delete restrict,

  description_raw text,       -- purgeable, same discipline as fdh_transactions
  description_clean text,
  merchant_raw text,
  merchant_id uuid references fdh_merchants(id) on delete set null,
  category_id uuid references fdh_categories(id) on delete set null,

  -- Loan-payment decomposition (spec sections 5, 30-38) — populated only for
  -- activity_type = 'PAYMENT' on a loan statement. Statement-disclosed
  -- components only; this project's amortisation/formula engines are never
  -- consulted here (spec section 34's precedence rule).
  principal_component numeric(20,4) check (principal_component is null or principal_component >= 0),
  interest_component numeric(20,4) check (interest_component is null or interest_component >= 0),
  fee_component numeric(20,4) check (fee_component is null or fee_component >= 0),

  -- The single bridge to the canonical ledger (spec sections 20, 43-49).
  linked_transaction_id uuid references fdh_transactions(id) on delete set null,

  bank_match_status text not null default 'not_attempted'
    check (bank_match_status in ('matched', 'no_match', 'multiple_candidates', 'not_attempted', 'bank_evidence_not_available')),

  review_status text not null default 'not_required'
    check (review_status in ('not_required', 'pending', 'in_review', 'resolved')),

  source_row_number int check (source_row_number is null or source_row_number >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint chk_fdh_liability_activities_decomposition_sum
    check (
      (principal_component is null and interest_component is null and fee_component is null)
      or (
        coalesce(principal_component, 0) + coalesce(interest_component, 0) + coalesce(fee_component, 0)
      ) <= amount + 0.0001
    )
);
create index idx_fdh_liability_activities_user on fdh_liability_statement_activities(user_id);
create index idx_fdh_liability_activities_statement on fdh_liability_statement_activities(statement_id);
create index idx_fdh_liability_activities_linked_txn on fdh_liability_statement_activities(linked_transaction_id) where linked_transaction_id is not null;
create index idx_fdh_liability_activities_bank_match on fdh_liability_statement_activities(user_id, bank_match_status)
  where bank_match_status in ('no_match', 'multiple_candidates');

alter table fdh_liability_statement_activities enable row level security;
create policy "read own fdh_liability_statement_activities" on fdh_liability_statement_activities
  for select using (auth.uid() = user_id);
create policy "insert own fdh_liability_statement_activities" on fdh_liability_statement_activities
  for insert with check (auth.uid() = user_id);
create policy "update own fdh_liability_statement_activities" on fdh_liability_statement_activities
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);


-- ---------------------------------------------------------------------------
-- PART E — same-tenant ownership guards for the two new tables (FDH1-F1
-- discipline: every new relationship must enforce same-tenant integrity,
-- spec section 90).
-- ---------------------------------------------------------------------------
create or replace function fdh10_assert_liability_statement_owner() returns trigger as $$
declare
  ref_owner uuid;
begin
  if new.statement_upload_id is not null then
    select user_id into ref_owner from fdh_statement_uploads where id = new.statement_upload_id;
    if ref_owner is null then
      raise exception 'fdh_liability_statements: statement_upload_id % does not exist', new.statement_upload_id;
    elsif ref_owner <> new.user_id then
      raise exception 'fdh_liability_statements: cross-tenant reference — statement upload % belongs to a different user', new.statement_upload_id;
    end if;
  end if;

  if new.financial_account_id is not null then
    select user_id into ref_owner from fdh_financial_accounts where id = new.financial_account_id;
    if ref_owner is null then
      raise exception 'fdh_liability_statements: financial_account_id % does not exist', new.financial_account_id;
    elsif ref_owner <> new.user_id then
      raise exception 'fdh_liability_statements: cross-tenant reference — financial account % belongs to a different user', new.financial_account_id;
    end if;
  end if;

  if new.liability_id is not null then
    select user_id into ref_owner from liabilities where id = new.liability_id;
    if ref_owner is null then
      raise exception 'fdh_liability_statements: liability_id % does not exist', new.liability_id;
    elsif ref_owner <> new.user_id then
      raise exception 'fdh_liability_statements: cross-tenant reference — liability % belongs to a different user (forged liability target — spec section 91)', new.liability_id;
    end if;
  end if;

  if new.duplicate_of_statement_id is not null then
    select user_id into ref_owner from fdh_liability_statements where id = new.duplicate_of_statement_id;
    if ref_owner is null or ref_owner <> new.user_id then
      raise exception 'fdh_liability_statements: cross-tenant or missing reference — duplicate_of_statement_id %', new.duplicate_of_statement_id;
    end if;
  end if;

  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger trg_fdh_liability_statements_owner
  before insert or update of user_id, statement_upload_id, financial_account_id, liability_id, duplicate_of_statement_id
  on fdh_liability_statements
  for each row execute function fdh10_assert_liability_statement_owner();


create or replace function fdh10_assert_liability_activity_owner() returns trigger as $$
declare
  ref_owner uuid;
begin
  select user_id into ref_owner from fdh_liability_statements where id = new.statement_id;
  if ref_owner is null then
    raise exception 'fdh_liability_statement_activities: statement_id % does not exist', new.statement_id;
  elsif ref_owner <> new.user_id then
    raise exception 'fdh_liability_statement_activities: cross-tenant reference — statement % belongs to a different user', new.statement_id;
  end if;

  if new.linked_transaction_id is not null then
    select user_id into ref_owner from fdh_transactions where id = new.linked_transaction_id;
    if ref_owner is null then
      raise exception 'fdh_liability_statement_activities: linked_transaction_id % does not exist', new.linked_transaction_id;
    elsif ref_owner <> new.user_id then
      raise exception 'fdh_liability_statement_activities: cross-tenant reference — bank transaction % belongs to a different user (forged bank match — spec section 92)', new.linked_transaction_id;
    end if;
  end if;

  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger trg_fdh_liability_activities_owner
  before insert or update of user_id, statement_id, linked_transaction_id
  on fdh_liability_statement_activities
  for each row execute function fdh10_assert_liability_activity_owner();


-- ---------------------------------------------------------------------------
-- PART F — HARDENING: authoritative-write protection, following the EXACT
-- pattern established by migration 0091 Part D (RLS proves ownership, a
-- BEFORE trigger gated on a transaction-local GUC proves lifecycle
-- authority). See that migration's own extensive header for the full
-- rationale; it is not repeated verbatim here.
-- ---------------------------------------------------------------------------

-- F.1 fdh_liability_statements — every system-derived column (parser
-- provenance, reconciliation outcome, approval state) is authoritative.
-- `review_status`/`approval_status`/`approved_at`/`approved_by` move only via
-- a future approval RPC (mirroring fdh9_approve_payroll_event) — none exists
-- yet in this cut, so this trigger fails CLOSED: no direct authenticated
-- transition into 'approved' is legal at all today, matching FDH-9's own D.4
-- disclosed-gap precedent for `fdh_payroll_events` before its approval RPC
-- was added.
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
  then
    raise exception 'fdh_liability_statements: this field is system-authoritative and may not be written directly by the authenticated role';
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger trg_fdh_liability_statements_authoritative_write
  before update on fdh_liability_statements
  for each row execute function fdh10_liability_statements_assert_authoritative_write();

-- F.2 fdh_liability_statement_activities — bank-match outcome and the
-- decomposition components are system-derived; description/category may be
-- corrected by the existing FDH review UI infrastructure the same way any
-- other transaction correction works (spec section 68: "reuses existing
-- financial-activity/review infrastructure"), so those two columns are
-- deliberately NOT locked here.
create or replace function fdh10_liability_activities_assert_authoritative_write() returns trigger as $$
declare
  v_internal boolean := coalesce(current_setting('fhip.import_bridge_internal_write', true), 'false') = 'true';
begin
  if v_internal then
    return new;
  end if;
  if new.user_id is distinct from old.user_id
     or new.statement_id is distinct from old.statement_id
     or new.activity_type is distinct from old.activity_type
     or new.amount is distinct from old.amount
     or new.principal_component is distinct from old.principal_component
     or new.interest_component is distinct from old.interest_component
     or new.fee_component is distinct from old.fee_component
     or new.linked_transaction_id is distinct from old.linked_transaction_id
     or new.bank_match_status is distinct from old.bank_match_status
  then
    raise exception 'fdh_liability_statement_activities: this field is system-authoritative and may not be written directly by the authenticated role';
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger trg_fdh_liability_activities_authoritative_write
  before update on fdh_liability_statement_activities
  for each row execute function fdh10_liability_activities_assert_authoritative_write();

-- F.3 liabilities — provenance columns only (mirrors income_sources D.5).
-- Every other column on `liabilities` remains exactly as user-editable as
-- today (spec sections 129: manual liability add/edit/delete unaffected).
create or replace function fdh10_liabilities_assert_provenance_write() returns trigger as $$
declare
  v_internal boolean := coalesce(current_setting('fhip.import_bridge_internal_write', true), 'false') = 'true';
begin
  if v_internal then
    return new;
  end if;
  if new.source_type is distinct from old.source_type
     or new.last_import_application_id is distinct from old.last_import_application_id
     or new.last_imported_at is distinct from old.last_imported_at
  then
    raise exception 'liabilities: source_type/last_import_application_id/last_imported_at are import-bridge provenance and may not be written directly by the authenticated role';
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger trg_liabilities_provenance_write
  before update on liabilities
  for each row execute function fdh10_liabilities_assert_provenance_write();


-- ---------------------------------------------------------------------------
-- PART G — extend the FDH-9 bridge's same-tenant proposal/application guards
-- with the 'liability' branch (spec sections 6, 50-58, 91). REPLACES the
-- function bodies from migration 0091 in place (`create or replace`) —
-- exactly the widening technique the income-only functions themselves
-- documented as their own future extension point ("A future domain adapter
-- adds its own narrow branch here").
-- ---------------------------------------------------------------------------
create or replace function fdh9_assert_proposal_owner() returns trigger as $$
declare
  ref_owner uuid;
begin
  if new.source_payroll_event_id is not null then
    select user_id into ref_owner from fdh_payroll_events where id = new.source_payroll_event_id;
    if ref_owner is null then
      raise exception 'fhip_import_proposals: source_payroll_event_id % does not exist', new.source_payroll_event_id;
    elsif ref_owner <> new.user_id then
      raise exception 'fhip_import_proposals: cross-tenant reference — payroll event % belongs to a different user', new.source_payroll_event_id;
    end if;
  end if;

  if new.source_liability_statement_id is not null then
    select user_id into ref_owner from fdh_liability_statements where id = new.source_liability_statement_id;
    if ref_owner is null then
      raise exception 'fhip_import_proposals: source_liability_statement_id % does not exist', new.source_liability_statement_id;
    elsif ref_owner <> new.user_id then
      raise exception 'fhip_import_proposals: cross-tenant reference — liability statement % belongs to a different user', new.source_liability_statement_id;
    end if;
  end if;

  if new.target_entity_id is not null then
    if new.target_domain = 'income' then
      select user_id into ref_owner from income_sources where id = new.target_entity_id;
      if ref_owner is null then
        raise exception 'fhip_import_proposals: target_entity_id % does not exist in income_sources', new.target_entity_id;
      elsif ref_owner <> new.user_id then
        raise exception 'fhip_import_proposals: cross-tenant reference — income entry % belongs to a different user', new.target_entity_id;
      end if;
    elsif new.target_domain = 'liability' then
      select user_id into ref_owner from liabilities where id = new.target_entity_id;
      if ref_owner is null then
        raise exception 'fhip_import_proposals: target_entity_id % does not exist in liabilities', new.target_entity_id;
      elsif ref_owner <> new.user_id then
        raise exception 'fhip_import_proposals: cross-tenant reference — liability % belongs to a different user (forged liability target — spec section 91)', new.target_entity_id;
      end if;
    else
      raise exception 'fhip_import_proposals: target_domain % has no implemented target guard', new.target_domain;
    end if;
  end if;

  if new.duplicate_of_entity_id is not null then
    if new.target_domain = 'income' then
      select user_id into ref_owner from income_sources where id = new.duplicate_of_entity_id;
      if ref_owner is null or ref_owner <> new.user_id then
        raise exception 'fhip_import_proposals: cross-tenant reference — duplicate income entry % belongs to a different user', new.duplicate_of_entity_id;
      end if;
    elsif new.target_domain = 'liability' then
      select user_id into ref_owner from liabilities where id = new.duplicate_of_entity_id;
      if ref_owner is null or ref_owner <> new.user_id then
        raise exception 'fhip_import_proposals: cross-tenant reference — duplicate liability % belongs to a different user', new.duplicate_of_entity_id;
      end if;
    end if;
  end if;

  return new;
end;
$$ language plpgsql security definer set search_path = public;
-- trigger trg_fhip_import_proposals_owner (migration 0091) already targets
-- this function by name and does not need to be recreated; it must, however,
-- also fire on the new column below.
drop trigger if exists trg_fhip_import_proposals_owner on fhip_import_proposals;
create trigger trg_fhip_import_proposals_owner
  before insert or update of user_id, source_payroll_event_id, source_liability_statement_id, target_entity_id, target_domain, duplicate_of_entity_id
  on fhip_import_proposals
  for each row execute function fdh9_assert_proposal_owner();


create or replace function fdh9_assert_application_owner() returns trigger as $$
declare
  ref_owner uuid;
begin
  select user_id into ref_owner from fhip_import_proposals where id = new.proposal_id;
  if ref_owner is null then
    raise exception 'fhip_import_applications: proposal_id % does not exist', new.proposal_id;
  elsif ref_owner <> new.user_id then
    raise exception 'fhip_import_applications: cross-tenant reference — proposal % belongs to a different user', new.proposal_id;
  end if;

  if new.source_payroll_event_id is not null then
    select user_id into ref_owner from fdh_payroll_events where id = new.source_payroll_event_id;
    if ref_owner is null or ref_owner <> new.user_id then
      raise exception 'fhip_import_applications: cross-tenant reference — payroll event % belongs to a different user', new.source_payroll_event_id;
    end if;
  end if;

  if new.source_liability_statement_id is not null then
    select user_id into ref_owner from fdh_liability_statements where id = new.source_liability_statement_id;
    if ref_owner is null or ref_owner <> new.user_id then
      raise exception 'fhip_import_applications: cross-tenant reference — liability statement % belongs to a different user', new.source_liability_statement_id;
    end if;
  end if;

  if new.target_domain = 'income' then
    select user_id into ref_owner from income_sources where id = new.target_entity_id;
    if ref_owner is null then
      raise exception 'fhip_import_applications: target_entity_id % does not exist in income_sources', new.target_entity_id;
    elsif ref_owner <> new.user_id then
      raise exception 'fhip_import_applications: cross-tenant reference — income entry % belongs to a different user', new.target_entity_id;
    end if;
  elsif new.target_domain = 'liability' then
    select user_id into ref_owner from liabilities where id = new.target_entity_id;
    if ref_owner is null then
      raise exception 'fhip_import_applications: target_entity_id % does not exist in liabilities', new.target_entity_id;
    elsif ref_owner <> new.user_id then
      raise exception 'fhip_import_applications: cross-tenant reference — liability % belongs to a different user (forged liability target — spec section 91)', new.target_entity_id;
    end if;
  else
    raise exception 'fhip_import_applications: target_domain % has no implemented target guard', new.target_domain;
  end if;

  return new;
end;
$$ language plpgsql security definer set search_path = public;
drop trigger if exists trg_fhip_import_applications_owner on fhip_import_applications;
create trigger trg_fhip_import_applications_owner
  before insert or update on fhip_import_applications
  for each row execute function fdh9_assert_application_owner();


-- ---------------------------------------------------------------------------
-- PART H — new columns needed for the liability branch above, plus widening
-- the authoritative-write immutable-field list from migration 0091 Part D.1
-- to cover them (same "create or replace" widening technique).
-- ---------------------------------------------------------------------------
alter table fhip_import_proposals
  add column if not exists source_liability_statement_id uuid references fdh_liability_statements(id) on delete cascade;
alter table fhip_import_applications
  add column if not exists source_liability_statement_id uuid references fdh_liability_statements(id) on delete set null;

create index if not exists idx_fhip_import_proposals_source_liability_statement
  on fhip_import_proposals(source_liability_statement_id);
create index if not exists idx_fhip_import_applications_liability_statement
  on fhip_import_applications(source_liability_statement_id);

create or replace function fdh9_import_proposals_assert_authoritative_write() returns trigger as $$
declare
  v_internal boolean := coalesce(current_setting('fhip.import_bridge_internal_write', true), 'false') = 'true';
begin
  if v_internal then
    return new;
  end if;

  if new.user_id is distinct from old.user_id
     or new.target_domain is distinct from old.target_domain
     or new.source_kind is distinct from old.source_kind
     or new.source_payroll_event_id is distinct from old.source_payroll_event_id
     or new.source_liability_statement_id is distinct from old.source_liability_statement_id
     or new.currency_code is distinct from old.currency_code
     or new.target_entity_id is distinct from old.target_entity_id
     or new.target_entity_updated_at is distinct from old.target_entity_updated_at
     or new.recommended_apply_mode is distinct from old.recommended_apply_mode
     or new.duplicate_of_entity_id is distinct from old.duplicate_of_entity_id
     or new.generated_at is distinct from old.generated_at
     or new.applied_at is distinct from old.applied_at
  then
    raise exception 'fhip_import_proposals: this field is authoritative and may not be written directly by the authenticated role';
  end if;

  if new.status is distinct from old.status then
    if not (old.status = 'ready' and new.status in ('dismissed', 'superseded')) then
      raise exception 'fhip_import_proposals: status may only move from ready to dismissed or superseded via the authenticated role; applied is only ever set by the atomic apply function';
    end if;
  end if;

  if new.dismissed_at is distinct from old.dismissed_at and new.status <> 'dismissed' then
    raise exception 'fhip_import_proposals: dismissed_at may only be set alongside status=dismissed';
  end if;

  return new;
end;
$$ language plpgsql security definer set search_path = public;
-- trigger trg_fhip_import_proposals_authoritative_write (0091) already
-- targets this function by name; no re-creation needed since it fires on
-- every UPDATE regardless of column.


-- ---------------------------------------------------------------------------
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
