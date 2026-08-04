-- Module 3: Core Dashboard — monthly snapshot history for trend charts.
-- One row per user per calendar month; upserted as data changes during the
-- month, so it always reflects "the latest known state as of this month".
-- Once a new month starts, a fresh row is created and prior months are left
-- untouched, giving genuine month-over-month history over time.

create table financial_snapshots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  snapshot_month date not null,
  total_assets numeric(18,2),
  total_liabilities numeric(18,2),
  net_worth numeric(18,2),
  monthly_income numeric(18,2),
  monthly_expenses numeric(18,2),
  monthly_surplus numeric(18,2),
  savings_rate numeric(6,4),
  currency_code char(3),
  created_at timestamptz default now(),
  unique (user_id, snapshot_month)
);

create index idx_financial_snapshots_user on financial_snapshots(user_id, snapshot_month);

alter table financial_snapshots enable row level security;
create policy "own snapshots" on financial_snapshots
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
