-- Module 2: Financial Data Capture — seven registers, all owner-scoped.

create table income_sources (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source_name text not null,
  income_type text not null,                 -- salary|business|rental|investment|other
  amount numeric(18,2) not null check (amount >= 0),
  frequency text not null,                   -- weekly|fortnightly|monthly|quarterly|annually|one_off
  currency_code char(3) not null references currencies(currency_code),
  is_active boolean default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table expense_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  expense_name text not null,
  expense_category text not null,            -- housing|transport|food|utilities|insurance|debt_repayment|other
  amount numeric(18,2) not null check (amount >= 0),
  frequency text not null,
  currency_code char(3) not null references currencies(currency_code),
  is_active boolean default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table assets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  asset_name text not null,
  asset_class text not null,                 -- cash|property|vehicle|business|other
  current_value numeric(18,2) not null check (current_value >= 0),
  currency_code char(3) not null references currencies(currency_code),
  country_code char(2) references countries(country_code),
  valuation_date date,
  is_active boolean default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table liabilities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  liability_name text not null,
  debt_type text not null,                   -- mortgage|personal_loan|credit_card|auto_loan|student_loan|other
  balance numeric(18,2) not null check (balance >= 0),
  interest_rate numeric(6,3) check (interest_rate >= 0),
  monthly_repayment numeric(18,2) default 0 check (monthly_repayment >= 0),
  currency_code char(3) not null references currencies(currency_code),
  country_code char(2) references countries(country_code),
  is_active boolean default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table investments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  investment_name text not null,
  investment_type text not null,             -- shares|managed_fund|etf|crypto|business_equity|other
  current_value numeric(18,2) not null check (current_value >= 0),
  currency_code char(3) not null references currencies(currency_code),
  country_code char(2) references countries(country_code),
  is_active boolean default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table retirement_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  account_name text not null,
  account_type text not null,                -- super|EPF|PPF|NPS|other
  current_balance numeric(18,2) not null check (current_balance >= 0),
  currency_code char(3) not null references currencies(currency_code),
  country_code char(2) references countries(country_code),
  is_active boolean default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table insurance_policies (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  policy_name text not null,
  cover_type text not null,                  -- life|income_protection|health|home|vehicle|other
  cover_amount numeric(18,2) not null check (cover_amount >= 0),
  premium numeric(18,2) not null check (premium >= 0),
  premium_frequency text not null,
  currency_code char(3) not null references currencies(currency_code),
  renewal_date date,
  is_active boolean default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table financial_records_audit (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  entity text not null,
  entity_id uuid,
  action text not null,
  changed_at timestamptz default now(),
  metadata jsonb
);

create index idx_income_sources_user on income_sources(user_id);
create index idx_expense_items_user on expense_items(user_id);
create index idx_assets_user on assets(user_id);
create index idx_liabilities_user on liabilities(user_id);
create index idx_investments_user on investments(user_id);
create index idx_retirement_accounts_user on retirement_accounts(user_id);
create index idx_insurance_policies_user on insurance_policies(user_id);
create index idx_financial_records_audit_user on financial_records_audit(user_id);

-- RLS: the same owner-only pattern as every other user-owned table.
alter table income_sources        enable row level security;
alter table expense_items         enable row level security;
alter table assets                enable row level security;
alter table liabilities           enable row level security;
alter table investments           enable row level security;
alter table retirement_accounts   enable row level security;
alter table insurance_policies    enable row level security;
alter table financial_records_audit enable row level security;

create policy "own rows - income" on income_sources
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own rows - expenses" on expense_items
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own rows - assets" on assets
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own rows - liabilities" on liabilities
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own rows - investments" on investments
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own rows - retirement" on retirement_accounts
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own rows - insurance" on insurance_policies
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own rows - financial audit" on financial_records_audit
  for select using (auth.uid() = user_id);
