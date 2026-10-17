-- Migration 0289 part 1 of 3: liabilities table. Run the parts in order, one at a time, in the Supabase SQL editor. Each part is safe to run again.
-- The source of truth is the migration file with the same number.
begin;

create table if not exists smsf_liabilities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  smsf_fund_id uuid not null references smsf_funds(id) on delete cascade,
  liability_name text not null check (length(btrim(liability_name)) > 0),
  liability_type text not null default 'other' check (liability_type in ('property_loan', 'other_loan', 'tax_payable', 'other')),
  lender text,
  balance numeric(18, 2) not null check (balance >= 0),
  interest_rate numeric(6, 3) check (interest_rate >= 0 and interest_rate <= 100),
  monthly_repayment numeric(18, 2) check (monthly_repayment >= 0),
  currency_code char(3) not null references currencies(currency_code),
  country_code char(2) references countries(country_code),
  notes text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table smsf_liabilities is
  'Entity-level SMSF debts (migration 0289). Counted only while the fund is itemised (smsf_funds.mode = detailed), the fund net is derived as holdings minus these rows (and any still-linked legacy personal loans). Never read by the personal liabilities, DTI or DSR formulas: the exclusion is structural, this is a different table. Soft-retired with is_active, never hard-deleted by the app.';
comment on column smsf_liabilities.balance is 'Outstanding amount, in currency_code. A fund debt is always non-negative, a fund that owes more than it owns shows a negative NET, never a negative liability.';

create index if not exists idx_smsf_liabilities_fund on smsf_liabilities(smsf_fund_id) where is_active;
create index if not exists idx_smsf_liabilities_user on smsf_liabilities(user_id);

alter table smsf_liabilities enable row level security;
drop policy if exists own_rows_smsf_liabilities on smsf_liabilities;
create policy own_rows_smsf_liabilities on smsf_liabilities
  for all using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id
    and smsf_fund_id in (select id from smsf_funds where user_id = auth.uid())
  );

commit;
