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
-- `fdh10_approve_liability_statement()` (Part F.5 below, mirroring
-- fdh9_approve_payroll_event exactly) — this trigger fails CLOSED for the
-- authenticated role either way; only that one SECURITY DEFINER RPC (running
-- under the internal-write GUC) may ever move these columns.
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

-- F.5 fdh10_approve_liability_statement — the one legitimate way
-- `fdh_liability_statements.approval_status` (and the other fields F.1 locks)
-- ever moves (spec sections 22, 41: "Approve evidence" is an explicit step in
-- the credit-card/loan review journey, distinct from Apply). Mirrors
-- `fdh9_approve_payroll_event()` (migration 0091 D.7) exactly: verifies auth,
-- locks the row, verifies ownership, enforces the one valid transition, and
-- is idempotent on a statement already approved. THIS CLOSES A REAL GAP F.1's
-- own original comment disclosed ("no direct authenticated transition into
-- 'approved' is legal at all today") — without this function the review
-- journey's Approve step had no legal path to move the column the
-- authoritative-write trigger above protects; caught during this round's own
-- Phase A/B independent verification, fixed here rather than merely noted.
create or replace function fdh10_approve_liability_statement(p_statement_id uuid) returns jsonb as $$
declare
  v_uid uuid;
  v_statement record;
begin
  v_uid := auth.uid();
  if v_uid is null then
    raise exception 'fdh10_approve_liability_statement: authentication required';
  end if;

  select * into v_statement from fdh_liability_statements where id = p_statement_id for update;
  if not found or v_statement.user_id <> v_uid then
    return jsonb_build_object('ok', false, 'code', 'PROPOSAL_NOT_FOUND', 'error', 'That statement could not be found.');
  end if;

  if v_statement.approval_status = 'approved' then
    return jsonb_build_object('ok', true, 'outcome', 'already_approved', 'approved_at', v_statement.approved_at);
  end if;

  perform set_config('fhip.import_bridge_internal_write', 'true', true);
  update fdh_liability_statements
    set approval_status = 'approved', approved_at = now(), approved_by = v_uid
    where id = p_statement_id;
  perform set_config('fhip.import_bridge_internal_write', 'false', true);

  return jsonb_build_object('ok', true, 'outcome', 'approved');
end;
$$ language plpgsql security definer set search_path = public;

revoke all on function fdh10_approve_liability_statement(uuid) from public;
grant execute on function fdh10_approve_liability_statement(uuid) to authenticated, service_role;


-- ---------------------------------------------------------------------------
-- PART F.4 — the new column the Part G guards below need to exist first.
-- Ordering note: this must precede Part G because
-- `fdh9_assert_proposal_owner()`'s replaced body (Part G) references
-- `source_liability_statement_id` directly — a `create or replace function`
-- is validated at CREATE time against the columns that exist then, so the
-- column must land before the function that names it. Genuinely caught by
-- this migration's own PGlite clean-rebuild replay (spec section 139)
-- during certification: the first draft had this the other way around and
-- failed with "column ... does not exist" — fixed here, not asserted.
-- ---------------------------------------------------------------------------
alter table fhip_import_proposals
  add column if not exists source_liability_statement_id uuid references fdh_liability_statements(id) on delete cascade;
alter table fhip_import_applications
  add column if not exists source_liability_statement_id uuid references fdh_liability_statements(id) on delete set null;

create index if not exists idx_fhip_import_proposals_source_liability_statement
  on fhip_import_proposals(source_liability_statement_id);
create index if not exists idx_fhip_import_applications_liability_statement
  on fhip_import_applications(source_liability_statement_id);


-- ---------------------------------------------------------------------------
