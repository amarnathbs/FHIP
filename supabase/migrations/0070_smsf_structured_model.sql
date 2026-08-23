-- Chunk 3a items 2-3 (Spec 2 §23, §38-42): SMSF Summary-vs-Detailed
-- structured model, plus SMSF property support, as new linked table(s)
-- rather than overloading the existing flat retirement grid config.
--
-- Mode-switching discipline (Spec 2 §41): a retirement_accounts row gets a
-- new `smsf_mode` flag. 'summary' (or null, for every existing row today —
-- see the note below) means the account's own `current_balance` is the sole
-- aggregation source, exactly as today. 'detailed' means the linked
-- smsf_holdings rows are the sole aggregation source, and current_balance
-- stops being read as an independent total the moment detailed mode is
-- active — see lib/engines/smsf.ts's computeSmsfTotal(), which structurally
-- can never sum both (it is an if/else on `mode`, not an addition), so a
-- stale current_balance left over from before switching to Detailed mode
-- can never double-count against the holdings sum. This migration only adds
-- the flag/table; it does not touch any existing retirement_accounts row's
-- current_balance or account_type.
--
-- RLS: reuses the exact "own rows" pattern already established for every
-- user-owned table in this codebase (see 0001_foundation.sql,
-- 0003_module2.sql, 0009_module7_goals.sql's household_members) —
-- `enable row level security` + a single `for all using (auth.uid() =
-- user_id) with check (auth.uid() = user_id)` policy, with user_id
-- denormalized directly onto the child table (matching household_members'
-- own precedent) rather than an EXISTS-subquery through the parent. Note:
-- this branch (feature/app-review-input-integrity-production, off
-- main@fe7a094) does not contain the FDH-1/Investment-Intelligence
-- branches' lib/financial-data-hub code the task brief pointed at — those
-- live on separate, still-unmerged branches not present in this worktree —
-- so this migration follows this branch's own actual, consistently-applied
-- convention instead, which is identical in substance.
--
-- SMSF property (item 3, Spec 2 §23/§42): smsf_holdings.holding_type =
-- 'property' carries acquisition price/date, country/currency, and optional
-- links to the specific rental-income row and liability (loan) that fund/
-- offset it. This is the ONE place SMSF property can be entered — there is
-- no separate "SMSF property" option added to the standalone assets/
-- liabilities/investments grids in this migration or anywhere else in this
-- sub-chunk, so no double-entry path is created going forward. Reconciling
-- any SMSF property a user may have ALREADY mis-entered as a plain Asset or
-- Investment row (pre-dating this schema) is explicitly out of scope here —
-- that is 3b's data-migration job, not 3a's.

alter table retirement_accounts
  add column if not exists smsf_mode text
    check (smsf_mode is null or smsf_mode in ('summary', 'detailed'));

comment on column retirement_accounts.smsf_mode is
  'Chunk 3a (Spec 2 §38-42): null/summary = current_balance is the aggregation source; detailed = smsf_holdings rows are, exclusively. Only meaningful for SMSF accounts (master_item_key = ''smsf''); null for every other account type and for every SMSF account created before this migration.';

create table smsf_holdings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  retirement_account_id uuid not null references retirement_accounts(id) on delete cascade,
  holding_type text not null
    check (holding_type in ('cash', 'shares', 'etfs', 'managed_funds', 'term_deposits', 'property', 'other')),
  value numeric(18,2) not null check (value >= 0),
  -- Property-specific fields (item 3) — populated for holding_type =
  -- 'property', left null for every other holding type. Not hard-restricted
  -- via a CHECK constraint to exactly 'property' rows: an acquisition date/
  -- price is also a plausible thing to record against, say, a direct-shares
  -- holding bought on a specific date, and over-constraining that here
  -- would be inventing an unreviewed business rule rather than implementing
  -- one the spec actually asks for.
  acquisition_price numeric(18,2) check (acquisition_price >= 0),
  acquisition_date date,
  country_code char(2) references countries(country_code),
  currency_code char(3) references currencies(currency_code),
  -- The rental-income and liability links required by item 3. Both
  -- optional — a fully-paid, non-rented SMSF property has neither.
  linked_income_source_id uuid references income_sources(id) on delete set null,
  linked_liability_id uuid references liabilities(id) on delete set null,
  notes text,
  is_active boolean not null default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index idx_smsf_holdings_user on smsf_holdings(user_id);
create index idx_smsf_holdings_account on smsf_holdings(retirement_account_id);

alter table smsf_holdings enable row level security;
create policy "own rows - smsf holdings" on smsf_holdings
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
