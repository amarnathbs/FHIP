-- Migration 0296 part 1 of 3. Run the parts in order, one at a time, in the Supabase SQL editor. Each part is safe to run again.
-- The source of truth is the migration file with the same number.
begin;


-- ---------------------------------------------------------------------------------------------------------------------
-- 1. Audit trail: append-only
-- ---------------------------------------------------------------------------------------------------------------------
create table if not exists entity_change_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  entity_kind text not null check (entity_kind in ('smsf', 'company', 'family_trust', 'huf')),
  entity_id uuid not null,
  table_name text not null,
  row_id uuid not null,
  action text not null check (action in ('insert', 'update', 'retire', 'moved_from_personal')),
  old_values jsonb,
  new_values jsonb,
  created_at timestamptz not null default now()
);

comment on table entity_change_log is
  'Append-only audit trail of changes to entity level rows (migration 0296): who, which entity, which table and row, what it was and what it became. Written only by triggers and the move function, the owner can read it and can neither update nor delete it.';

create index if not exists idx_entity_change_log_entity on entity_change_log(entity_id, created_at desc);
create index if not exists idx_entity_change_log_user on entity_change_log(user_id);

alter table entity_change_log enable row level security;
drop policy if exists own_rows_entity_change_log_read on entity_change_log;
create policy own_rows_entity_change_log_read on entity_change_log for select using (auth.uid() = user_id);

create or replace function entity_change_log_append_only() returns trigger as $fn$
begin
  raise exception 'entity_change_log is append-only' using errcode = '42501';
end;
$fn$ language plpgsql;

drop trigger if exists trg_entity_change_log_no_update on entity_change_log;
create trigger trg_entity_change_log_no_update
  before update on entity_change_log
  for each row execute function entity_change_log_append_only();

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. Income
-- ---------------------------------------------------------------------------------------------------------------------
create table if not exists entity_income_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  entity_kind text not null check (entity_kind in ('smsf', 'company', 'family_trust', 'huf')),
  smsf_fund_id uuid references smsf_funds(id) on delete cascade,
  business_entity_id uuid references business_entities(id) on delete cascade,
  income_type text not null check (income_type in ('rent', 'interest', 'dividends', 'distributions', 'trading_revenue', 'other')),
  income_name text not null check (length(btrim(income_name)) > 0),
  amount numeric(18, 2) not null check (amount >= 0),
  frequency text not null check (frequency in ('weekly', 'fortnightly', 'monthly', 'quarterly', 'annually', 'one_off')),
  currency_code char(3) not null references currencies(currency_code),
  country_code char(2) references countries(country_code),
  smsf_holding_id uuid references smsf_holdings(id) on delete set null,
  business_entity_asset_id uuid references business_entity_assets(id) on delete set null,
  source_type text not null default 'manual' check (source_type in ('manual', 'statement_import', 'moved_from_personal')),
  notes text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chk_entity_income_scope check (
    (entity_kind = 'smsf' and smsf_fund_id is not null and business_entity_id is null)
    or (entity_kind <> 'smsf' and business_entity_id is not null and smsf_fund_id is null)
  ),
  constraint chk_entity_income_rent_needs_amount check (income_type <> 'rent' or amount > 0),
  constraint chk_entity_income_asset_link check (
    (smsf_holding_id is null or (income_type = 'rent' and entity_kind = 'smsf'))
    and (business_entity_asset_id is null or (income_type = 'rent' and entity_kind <> 'smsf'))
  )
);

comment on table entity_income_items is
  'Income of ONE entity (an SMSF fund or a registered Company, Family Trust or HUF), migration 0296. Entity scoped, never read by personal Income, DTI or DSR. Rent needs an amount and a frequency and may be tied to the property asset it comes from, one active rent record per asset.';

create unique index if not exists uq_entity_income_rent_per_smsf_asset
  on entity_income_items(smsf_holding_id) where income_type = 'rent' and is_active and smsf_holding_id is not null;
create unique index if not exists uq_entity_income_rent_per_entity_asset
  on entity_income_items(business_entity_asset_id) where income_type = 'rent' and is_active and business_entity_asset_id is not null;
create index if not exists idx_entity_income_smsf on entity_income_items(smsf_fund_id) where is_active and smsf_fund_id is not null;
create index if not exists idx_entity_income_business on entity_income_items(business_entity_id) where is_active and business_entity_id is not null;
create index if not exists idx_entity_income_user on entity_income_items(user_id);

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. Expenses
-- ---------------------------------------------------------------------------------------------------------------------
create table if not exists entity_expense_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  entity_kind text not null check (entity_kind in ('smsf', 'company', 'family_trust', 'huf')),
  smsf_fund_id uuid references smsf_funds(id) on delete cascade,
  business_entity_id uuid references business_entities(id) on delete cascade,
  expense_type text not null check (expense_type in ('property_costs', 'insurance', 'accounting_audit', 'admin_fees', 'investment_fees', 'taxes_levies', 'bank_fees', 'other')),
  expense_name text not null check (length(btrim(expense_name)) > 0),
  amount numeric(18, 2) not null check (amount >= 0),
  frequency text not null check (frequency in ('weekly', 'fortnightly', 'monthly', 'quarterly', 'annually', 'one_off')),
  currency_code char(3) not null references currencies(currency_code),
  country_code char(2) references countries(country_code),
  source_type text not null default 'manual' check (source_type in ('manual', 'statement_import', 'moved_from_personal')),
  notes text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chk_entity_expense_scope check (
    (entity_kind = 'smsf' and smsf_fund_id is not null and business_entity_id is null)
    or (entity_kind <> 'smsf' and business_entity_id is not null and smsf_fund_id is null)
  )
);

comment on table entity_expense_items is
  'Recurring costs of ONE entity, migration 0296. There is no loan repayment type: principal is a cash flow derived out of the entity liabilities, never an expense row. Entity scoped, never read by personal Expenses, DTI or DSR.';

create index if not exists idx_entity_expense_smsf on entity_expense_items(smsf_fund_id) where is_active and smsf_fund_id is not null;
create index if not exists idx_entity_expense_business on entity_expense_items(business_entity_id) where is_active and business_entity_id is not null;
create index if not exists idx_entity_expense_user on entity_expense_items(user_id);

commit;
