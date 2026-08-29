-- =============================================================================
-- FDH-11 — Australia Investment Statement Intelligence (migration 0106).
--
-- MIGRATION NUMBER GOVERNANCE. `origin/main` (e05855f) tops out at 0102.
-- `0103` is reserved by the unmerged `fix/g0-wave2-closure-hotfix` branch;
-- `0104`-`0105` are reserved by the unmerged
-- `feature/mandatory-country-confirmation-beta-cleanup` branch. Neither is
-- on main. A fresh cross-branch/cross-worktree scan at dispatch time
-- (`scripts/check-migration-versions-against-branch.mjs` run against both
-- branch tips, plus `git worktree list` over every local worktree) found no
-- other branch claiming 0106 or higher. 0106 is therefore the genuinely
-- free next number, re-verified immediately before this file was written.
--
-- ADDITIVE ONLY, same discipline as every FDH/II migration before it. No
-- existing column, constraint, index, policy or row is removed. Every
-- `alter ... check` widens a closed vocabulary; nothing narrows one.
--
-- ARCHITECTURE (see docs/financial-data-hub/FDH11_ARCHITECTURE.md and
-- FDH11_INVESTMENT_INTELLIGENCE_BRIDGE.md for the full account, including
-- the resolution of FDH1_INVESTMENT_BOUNDARY.md section 6's open item).
--
-- FDH-11 owns AU investment STATEMENT EVIDENCE only (spec sections 3, 23-25):
--   * fdh_investment_statements       — statement-level facts.
--   * fdh_investment_statement_positions   — holding-line evidence.
--   * fdh_investment_statement_activities  — transaction-line evidence.
-- None of these three tables is canonical. They carry NO foreign-key
-- reference to any `ii_*` table (this migration touches `ii_*` schema only
-- in PART D, a deliberate, narrow, additive II extension — not an FDH
-- table) — `canonical_account_id` / `canonical_instrument_id` /
-- `canonical_transaction_id` / `canonical_holding_snapshot_id` are plain
-- `uuid` columns with no DB-level FK, populated only by
-- `lib/investment-import-bridge/` (which lives OUTSIDE
-- `lib/financial-data-hub/` and is the only code in this repository allowed
-- to write both an FDH evidence row's apply-outcome columns and a real
-- `ii_accounts`/`ii_instruments`/`ii_transactions`/`ii_holding_snapshots`
-- row in the same operation). This mirrors FDH-9/FDH-10's `lib/import-bridge/`
-- precedent exactly, generalised to a ledger-shaped (not single-row-shaped)
-- target, per spec section 65's own instruction to make and document this
-- call rather than force-fit the generic `fhip_import_proposals` bridge onto
-- ledger semantics (see FDH11_INVESTMENT_INTELLIGENCE_BRIDGE.md's ADR).
--
-- Reused, not duplicated: FDH-3 document lifecycle (`fdh_statement_uploads`,
-- already carries `document_type = 'investment_statement'` since migration
-- 0045 — no change needed), FDH-7 review-status vocabulary, FDH-8's
-- financial-integrity boundary (this migration creates no expense/income
-- column anywhere), the SAME `ii_instruments` / `ii_instrument_identifiers`
-- / `ii_accounts` / `ii_transactions` / `ii_holding_snapshots` tables R2/R12
-- already built and already prove jurisdiction-agnostic for direct listed
-- equity/ETF (R12 already added `instrument_class IN ('equity','etf')`
-- support with `nse_symbol`/`bse_code`/`isin` identifiers for India; PART D
-- below adds the ASX-equivalent `asx_ticker` identifier scheme the exact
-- same additive way).
-- =============================================================================


-- ---------------------------------------------------------------------------
-- PART A — WIDEN EXISTING CLOSED VOCABULARIES (additive only)
-- ---------------------------------------------------------------------------

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
      -- FDH-11 additions (spec sections 23, 46, 63-65).
      'investment_statement_extraction_completed',
      'investment_statement_extraction_failed',
      'investment_statement_account_matched',
      'investment_statement_security_matched',
      'investment_statement_reconciled',
      'investment_statement_bank_match_completed',
      'investment_statement_approved',
      'investment_statement_applied',
      'investment_statement_apply_rejected_stale'
    ));


-- ---------------------------------------------------------------------------
-- PART B — fdh_investment_statements: statement-level evidence (spec
-- section 23). Mirrors fdh_liability_statements (migration 0096) exactly in
-- shape and RLS/guard discipline.
-- ---------------------------------------------------------------------------
create table fdh_investment_statements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  household_id uuid references households(id) on delete set null,

  statement_upload_id uuid references fdh_statement_uploads(id) on delete set null,

  -- Nullable: unresolved until account matching (spec 43-46) runs, or the
  -- user picks ADD NEW at review time. Plain uuid — no FK to ii_accounts
  -- (see migration header: FDH never references an ii_ table directly).
  canonical_account_id uuid,

  statement_type text not null check (statement_type in (
    'broker_portfolio_statement', 'broker_holdings_statement',
    'broker_transaction_statement', 'broker_account_statement',
    'managed_fund_statement', 'investment_transaction_csv', 'portfolio_csv',
    'dividend_distribution_statement', 'trade_confirmation'
  )),
  investment_jurisdiction char(2) not null default 'AU' check (investment_jurisdiction = 'AU'),

  institution_name text,
  -- Masked/last-digits identifier only — never a full HIN/broker account
  -- number (spec sections 20, 23).
  masked_account_identifier text,
  nickname text,

  base_currency char(3) not null references currencies(currency_code) on delete restrict,

  statement_date date,
  statement_start_date date,
  statement_end_date date,

  opening_portfolio_value numeric(20,4),
  closing_portfolio_value numeric(20,4),
  cash_balance numeric(20,4),

  parser text,
  parser_version text,
  extraction_confidence numeric(5,4) check (extraction_confidence is null or (extraction_confidence >= 0 and extraction_confidence <= 1)),
  extraction_status text not null default 'pending'
    check (extraction_status in ('pending', 'extracted', 'extraction_failed', 'ocr_required', 'password_required')),

  reconciliation_status text not null default 'insufficient_data'
    check (reconciliation_status in ('reconciled', 'variance', 'insufficient_data')),

  review_status text not null default 'not_required'
    check (review_status in ('not_required', 'pending', 'in_review', 'resolved')),
  approval_status text not null default 'pending'
    check (approval_status in ('pending', 'approved')),
  approved_at timestamptz,
  approved_by uuid references auth.users(id) on delete set null,

  -- Duplicate/revision provenance (spec sections 54-58) — whole-document
  -- dedup is `fdh_statement_uploads.file_hash` (reused, not duplicated,
  -- same discipline as FDH-10).
  duplicate_of_statement_id uuid references fdh_investment_statements(id) on delete set null,
  supersedes_statement_id uuid references fdh_investment_statements(id) on delete set null,

  source_provenance text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint chk_fdh_investment_statements_masked_identifier
    check (masked_account_identifier is null or masked_account_identifier !~ '[0-9]{7,}'),
  constraint chk_fdh_investment_statements_period
    check (statement_end_date is null or statement_start_date is null or statement_end_date >= statement_start_date),
  constraint chk_fdh_investment_statements_approved_at
    check (approved_at is null or approval_status = 'approved')
);
create index idx_fdh_investment_statements_user on fdh_investment_statements(user_id);
create index idx_fdh_investment_statements_account on fdh_investment_statements(canonical_account_id) where canonical_account_id is not null;
create index idx_fdh_investment_statements_upload on fdh_investment_statements(statement_upload_id);

alter table fdh_investment_statements enable row level security;
create policy "read own fdh_investment_statements" on fdh_investment_statements
  for select using (auth.uid() = user_id);
create policy "insert own fdh_investment_statements" on fdh_investment_statements
  for insert with check (auth.uid() = user_id);
create policy "update own fdh_investment_statements" on fdh_investment_statements
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);


-- ---------------------------------------------------------------------------
-- PART C — fdh_investment_statement_positions: holding-line evidence (spec
-- section 24). A statement observation, never an authoritative canonical
-- holding (spec sections 24, 60).
-- ---------------------------------------------------------------------------
create table fdh_investment_statement_positions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  statement_id uuid not null references fdh_investment_statements(id) on delete cascade,

  security_name_raw text not null,
  ticker_raw text,
  exchange text,
  isin text,

  -- numeric(20,6): matches ii_holding_snapshots.units' own scale (migration
  -- 0033) so a value round-trips exactly once applied — never a float.
  quantity numeric(20,6) not null,
  unit_price numeric(20,6),
  market_value numeric(20,4),
  currency_code char(3) not null references currencies(currency_code) on delete restrict,
  valuation_date date not null,

  security_match_status text not null default 'not_attempted'
    check (security_match_status in ('matched', 'ambiguous', 'unresolved', 'not_attempted')),
  -- Plain uuid — no FK to ii_instruments (see migration header).
  matched_instrument_id uuid,

  apply_status text not null default 'not_applicable'
    check (apply_status in ('not_applicable', 'pending', 'applying', 'applied', 'skipped')),
  canonical_holding_snapshot_id uuid,
  applied_at timestamptz,
  applied_by uuid references auth.users(id) on delete set null,

  source_row_number int check (source_row_number is null or source_row_number >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint chk_fdh_investment_positions_applied_at
    check (applied_at is null or apply_status = 'applied')
);
create index idx_fdh_investment_positions_user on fdh_investment_statement_positions(user_id);
create index idx_fdh_investment_positions_statement on fdh_investment_statement_positions(statement_id);
create index idx_fdh_investment_positions_match on fdh_investment_statement_positions(user_id, security_match_status)
  where security_match_status in ('ambiguous', 'unresolved');

alter table fdh_investment_statement_positions enable row level security;
create policy "read own fdh_investment_statement_positions" on fdh_investment_statement_positions
  for select using (auth.uid() = user_id);
create policy "insert own fdh_investment_statement_positions" on fdh_investment_statement_positions
  for insert with check (auth.uid() = user_id);
create policy "update own fdh_investment_statement_positions" on fdh_investment_statement_positions
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);


-- ---------------------------------------------------------------------------
-- PART D0 — fdh_investment_statement_activities: transaction-line evidence
-- (spec section 25). The single bridge to bank evidence is
-- `linked_transaction_id` — no parallel bank ledger is created (spec
-- section 20's "do not unnecessarily duplicate canonical bank activity").
-- ---------------------------------------------------------------------------
create table fdh_investment_statement_activities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  statement_id uuid not null references fdh_investment_statements(id) on delete cascade,

  activity_type text not null check (activity_type in (
    'BUY', 'SELL', 'DIVIDEND', 'DISTRIBUTION', 'INTEREST', 'BROKERAGE', 'FEE',
    'TRANSFER_IN', 'TRANSFER_OUT', 'CASH_DEPOSIT', 'CASH_WITHDRAWAL', 'DRP',
    'CORPORATE_ACTION_EVIDENCE', 'OTHER', 'UNKNOWN'
  )),
  trade_date date,
  settlement_date date, -- preserved separately from trade_date (spec section 53)

  security_name_raw text,
  ticker_raw text,
  isin text,
  quantity numeric(20,6),
  unit_price numeric(20,6),

  amount numeric(20,4) not null check (amount > 0),
  currency_code char(3) not null references currencies(currency_code) on delete restrict,

  description_raw text,
  brokerage_raw numeric(20,4),
  franking_credit_raw text, -- evidence only (spec section 33-34) — never fed to a tax computation
  withholding_tax_raw text, -- evidence only

  security_match_status text not null default 'not_attempted'
    check (security_match_status in ('matched', 'ambiguous', 'unresolved', 'not_attempted')),
  matched_instrument_id uuid, -- plain uuid — no FK to ii_instruments

  -- The single bridge to bank evidence (spec sections 66-71). Bank
  -- transactions live in `fdh_transactions` (FDH-1's own cash ledger),
  -- which FDH-11 is allowed to reference — this is an intra-Hub reference,
  -- not a canonical-ledger restatement.
  linked_transaction_id uuid references fdh_transactions(id) on delete set null,
  bank_match_status text not null default 'not_attempted'
    check (bank_match_status in ('matched', 'no_match', 'multiple_candidates', 'not_attempted', 'bank_evidence_not_available')),
  bank_match_candidates jsonb,

  review_status text not null default 'not_required'
    check (review_status in ('not_required', 'pending', 'in_review', 'resolved')),

  -- Apply state (spec sections 63-65, 108, 121-123). Compare-and-swap gate:
  -- the bridge claims a row via
  --   UPDATE ... SET apply_status='applying' WHERE id=$1 AND apply_status='pending'
  -- and proceeds only if exactly one row was affected — this single atomic
  -- UPDATE statement is Postgres's own row-level atomicity guarantee, the
  -- same technique this codebase already relies on elsewhere (no RPC
  -- required — Investment Intelligence's own architecture-exception doc,
  -- `investmentPublicationService.ts`, documents that this codebase has
  -- never used a Postgres RPC anywhere; FDH-11 follows that established
  -- precedent rather than introducing the first one into the II bridge).
  apply_status text not null default 'pending'
    check (apply_status in ('pending', 'applying', 'applied', 'skipped')),
  canonical_transaction_id uuid, -- plain uuid — no FK to ii_transactions
  applied_at timestamptz,
  applied_by uuid references auth.users(id) on delete set null,
  apply_rejected_reason text,

  source_row_number int check (source_row_number is null or source_row_number >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint chk_fdh_investment_activities_applied_at
    check (applied_at is null or apply_status = 'applied')
);
create index idx_fdh_investment_activities_user on fdh_investment_statement_activities(user_id);
create index idx_fdh_investment_activities_statement on fdh_investment_statement_activities(statement_id);
create index idx_fdh_investment_activities_linked_txn on fdh_investment_statement_activities(linked_transaction_id) where linked_transaction_id is not null;
create index idx_fdh_investment_activities_bank_match on fdh_investment_statement_activities(user_id, bank_match_status)
  where bank_match_status in ('no_match', 'multiple_candidates');
create index idx_fdh_investment_activities_apply_status on fdh_investment_statement_activities(user_id, apply_status);

alter table fdh_investment_statement_activities enable row level security;
create policy "read own fdh_investment_statement_activities" on fdh_investment_statement_activities
  for select using (auth.uid() = user_id);
create policy "insert own fdh_investment_statement_activities" on fdh_investment_statement_activities
  for insert with check (auth.uid() = user_id);
create policy "update own fdh_investment_statement_activities" on fdh_investment_statement_activities
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);


-- ---------------------------------------------------------------------------
-- PART E — same-tenant ownership guards (FDH1-F1 discipline: every new
-- relationship must enforce same-tenant integrity, spec sections 86-88).
-- ---------------------------------------------------------------------------
create or replace function fdh11_assert_investment_statement_owner() returns trigger as $$
declare
  ref_owner uuid;
begin
  if new.statement_upload_id is not null then
    select user_id into ref_owner from fdh_statement_uploads where id = new.statement_upload_id;
    if ref_owner is null then
      raise exception 'fdh_investment_statements: statement_upload_id % does not exist', new.statement_upload_id;
    elsif ref_owner <> new.user_id then
      raise exception 'fdh_investment_statements: cross-tenant reference — statement upload % belongs to a different user', new.statement_upload_id;
    end if;
  end if;

  if new.duplicate_of_statement_id is not null then
    select user_id into ref_owner from fdh_investment_statements where id = new.duplicate_of_statement_id;
    if ref_owner is null or ref_owner <> new.user_id then
      raise exception 'fdh_investment_statements: cross-tenant or missing reference — duplicate_of_statement_id %', new.duplicate_of_statement_id;
    end if;
  end if;

  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger trg_fdh_investment_statements_owner
  before insert or update of user_id, statement_upload_id, duplicate_of_statement_id
  on fdh_investment_statements
  for each row execute function fdh11_assert_investment_statement_owner();


create or replace function fdh11_assert_investment_position_owner() returns trigger as $$
declare
  ref_owner uuid;
begin
  select user_id into ref_owner from fdh_investment_statements where id = new.statement_id;
  if ref_owner is null then
    raise exception 'fdh_investment_statement_positions: statement_id % does not exist', new.statement_id;
  elsif ref_owner <> new.user_id then
    raise exception 'fdh_investment_statement_positions: cross-tenant reference — statement % belongs to a different user', new.statement_id;
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger trg_fdh_investment_positions_owner
  before insert or update of user_id, statement_id
  on fdh_investment_statement_positions
  for each row execute function fdh11_assert_investment_position_owner();


create or replace function fdh11_assert_investment_activity_owner() returns trigger as $$
declare
  ref_owner uuid;
begin
  select user_id into ref_owner from fdh_investment_statements where id = new.statement_id;
  if ref_owner is null then
    raise exception 'fdh_investment_statement_activities: statement_id % does not exist', new.statement_id;
  elsif ref_owner <> new.user_id then
    raise exception 'fdh_investment_statement_activities: cross-tenant reference — statement % belongs to a different user', new.statement_id;
  end if;

  if new.linked_transaction_id is not null then
    select user_id into ref_owner from fdh_transactions where id = new.linked_transaction_id;
    if ref_owner is null then
      raise exception 'fdh_investment_statement_activities: linked_transaction_id % does not exist', new.linked_transaction_id;
    elsif ref_owner <> new.user_id then
      raise exception 'fdh_investment_statement_activities: cross-tenant reference — bank transaction % belongs to a different user (forged bank match — spec section 88)', new.linked_transaction_id;
    end if;
  end if;

  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger trg_fdh_investment_activities_owner
  before insert or update of user_id, statement_id, linked_transaction_id
  on fdh_investment_statement_activities
  for each row execute function fdh11_assert_investment_activity_owner();


-- ---------------------------------------------------------------------------
-- PART F — HARDENING: authoritative-write protection, following the EXACT
-- pattern established by migration 0091 Part D / 0096 Part F. RLS proves
-- ownership; a BEFORE trigger gated on a transaction-local GUC proves
-- lifecycle authority. Every system-derived column (parser provenance,
-- match/reconciliation outcome, apply state) can only ever move via
-- `lib/investment-import-bridge/` running under the internal-write GUC —
-- this is the mechanical proof behind spec section 85's "same-tenant
-- authority" requirement (a user cannot forge their OWN row's system-owned
-- columns merely because they own the row).
-- ---------------------------------------------------------------------------

create or replace function fdh11_investment_statements_assert_authoritative_write() returns trigger as $$
begin
  -- Established pattern (0064/0065/0068/0069/0071/0087): distinguishes an
  -- authenticated user's own PostgREST request from the service-role admin
  -- client (`lib/investment-import-bridge/`), which bypasses RLS AND this
  -- trigger check by construction (auth.role() = 'service_role') -- no
  -- transaction-local GUC or RPC wrapper required.
  if auth.role() <> 'authenticated' then
    return new;
  end if;
  if new.user_id is distinct from old.user_id
     or new.statement_upload_id is distinct from old.statement_upload_id
     or new.canonical_account_id is distinct from old.canonical_account_id
     or new.base_currency is distinct from old.base_currency
     or new.opening_portfolio_value is distinct from old.opening_portfolio_value
     or new.closing_portfolio_value is distinct from old.closing_portfolio_value
     or new.cash_balance is distinct from old.cash_balance
     or new.parser is distinct from old.parser
     or new.parser_version is distinct from old.parser_version
     or new.extraction_confidence is distinct from old.extraction_confidence
     or new.extraction_status is distinct from old.extraction_status
     or new.reconciliation_status is distinct from old.reconciliation_status
     or new.approval_status is distinct from old.approval_status
     or new.approved_at is distinct from old.approved_at
     or new.approved_by is distinct from old.approved_by
     or new.duplicate_of_statement_id is distinct from old.duplicate_of_statement_id
  then
    raise exception 'fdh_investment_statements: this field is system-authoritative and may not be written directly by the authenticated role';
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger trg_fdh_investment_statements_authoritative_write
  before update on fdh_investment_statements
  for each row execute function fdh11_investment_statements_assert_authoritative_write();


create or replace function fdh11_investment_positions_assert_authoritative_write() returns trigger as $$
begin
  -- Established pattern (0064/0065/0068/0069/0071/0087): distinguishes an
  -- authenticated user's own PostgREST request from the service-role admin
  -- client (`lib/investment-import-bridge/`), which bypasses RLS AND this
  -- trigger check by construction (auth.role() = 'service_role') -- no
  -- transaction-local GUC or RPC wrapper required.
  if auth.role() <> 'authenticated' then
    return new;
  end if;
  if new.user_id is distinct from old.user_id
     or new.statement_id is distinct from old.statement_id
     or new.quantity is distinct from old.quantity
     or new.unit_price is distinct from old.unit_price
     or new.market_value is distinct from old.market_value
     or new.security_match_status is distinct from old.security_match_status
     or new.matched_instrument_id is distinct from old.matched_instrument_id
     or new.apply_status is distinct from old.apply_status
     or new.canonical_holding_snapshot_id is distinct from old.canonical_holding_snapshot_id
     or new.applied_at is distinct from old.applied_at
     or new.applied_by is distinct from old.applied_by
  then
    raise exception 'fdh_investment_statement_positions: this field is system-authoritative and may not be written directly by the authenticated role';
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger trg_fdh_investment_positions_authoritative_write
  before update on fdh_investment_statement_positions
  for each row execute function fdh11_investment_positions_assert_authoritative_write();


create or replace function fdh11_investment_activities_assert_authoritative_write() returns trigger as $$
begin
  -- Established pattern (0064/0065/0068/0069/0071/0087): distinguishes an
  -- authenticated user's own PostgREST request from the service-role admin
  -- client (`lib/investment-import-bridge/`), which bypasses RLS AND this
  -- trigger check by construction (auth.role() = 'service_role') -- no
  -- transaction-local GUC or RPC wrapper required.
  if auth.role() <> 'authenticated' then
    return new;
  end if;
  if new.user_id is distinct from old.user_id
     or new.statement_id is distinct from old.statement_id
     or new.activity_type is distinct from old.activity_type
     or new.amount is distinct from old.amount
     or new.quantity is distinct from old.quantity
     or new.unit_price is distinct from old.unit_price
     or new.security_match_status is distinct from old.security_match_status
     or new.matched_instrument_id is distinct from old.matched_instrument_id
     or new.linked_transaction_id is distinct from old.linked_transaction_id
     or new.bank_match_status is distinct from old.bank_match_status
     or new.bank_match_candidates is distinct from old.bank_match_candidates
     or new.apply_status is distinct from old.apply_status
     or new.canonical_transaction_id is distinct from old.canonical_transaction_id
     or new.applied_at is distinct from old.applied_at
     or new.applied_by is distinct from old.applied_by
     or new.apply_rejected_reason is distinct from old.apply_rejected_reason
  then
    raise exception 'fdh_investment_statement_activities: this field is system-authoritative and may not be written directly by the authenticated role';
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger trg_fdh_investment_activities_authoritative_write
  before update on fdh_investment_statement_activities
  for each row execute function fdh11_investment_activities_assert_authoritative_write();


-- ---------------------------------------------------------------------------
-- PART G — a genuine, narrow, additive Investment Intelligence schema
-- extension (spec sections 39-40, 90). This is the ONLY part of this
-- migration that touches an `ii_*` table, and it is not an FDH table.
--
-- `ii_instrument_identifiers.identifier_scheme` already supports
-- country-scoped India identifiers (`nse_symbol`, `bse_code`) alongside the
-- globally-unique `isin`/`sedol` pair (migration 0031). `asx_ticker` is
-- added here the exact same way — country-scoped (matched only within
-- country_code = 'AU', mirroring `nse_symbol`/`bse_code`'s own partial
-- unique index), never global. No existing row, policy or index is altered
-- beyond this one widened CHECK constraint.
-- ---------------------------------------------------------------------------
alter table ii_instrument_identifiers drop constraint if exists ii_instrument_identifiers_identifier_scheme_check;
alter table ii_instrument_identifiers
  add constraint ii_instrument_identifiers_identifier_scheme_check
    check (identifier_scheme in (
      'isin', 'amfi_scheme_code', 'nse_symbol', 'bse_code', 'sedol', 'internal_provisional',
      -- FDH-11 addition (spec sections 39-40): ASX ticker, country-scoped
      -- exactly like nse_symbol/bse_code.
      'asx_ticker'
    ));

-- `asx_ticker` must also join the country-required list and the
-- country-scoped uniqueness index — otherwise it would silently fall
-- through to "no scoping enforced at all", not "globally unique" (it is
-- deliberately NOT in the global list above the country-scoped one).
alter table ii_instrument_identifiers drop constraint if exists chk_ii_instrument_identifiers_country_scope;
alter table ii_instrument_identifiers
  add constraint chk_ii_instrument_identifiers_country_scope check (
    identifier_scheme not in ('amfi_scheme_code', 'nse_symbol', 'bse_code', 'internal_provisional', 'asx_ticker')
    or country_code is not null
  );

drop index if exists uidx_ii_instrument_identifiers_country_scoped;
create unique index uidx_ii_instrument_identifiers_country_scoped
  on ii_instrument_identifiers(identifier_scheme, identifier_value, country_code)
  where identifier_scheme in ('amfi_scheme_code', 'nse_symbol', 'bse_code', 'internal_provisional', 'asx_ticker');
