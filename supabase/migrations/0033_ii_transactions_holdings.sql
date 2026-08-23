-- Investment Intelligence R1 — Migration C: transaction/tax-lot/holding
-- structural foundation, plus the instrument price/NAV reference series.
-- ii_transactions and ii_holding_snapshots are append-only/immutable —
-- created_at only, corrections are new rows, never UPDATEs
-- (R0_CANONICAL_DATA_CONTRACT.md cross-cutting conventions, ADR-003).
--
-- Governing docs: R0_CANONICAL_DATA_CONTRACT.md, R0_CANONICAL_IDENTIFIER_STRATEGY.md
-- section 2 (transaction source_reference de-dup — the one item R0 explicitly
-- left for R1 to name), R0_CROSS_BORDER_CONTRACT.md (currency_code never converted).

-- ---------------------------------------------------------------------------
-- ii_transactions — canonical reconstructed transaction ledger. Immutable:
-- a correction is a new row referencing the original (corrects_transaction_id),
-- matching the existing goal_contributions.reversal_of_id precedent.
-- ---------------------------------------------------------------------------
create table ii_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  account_id uuid not null references ii_accounts(id) on delete cascade,
  instrument_id uuid not null references ii_instruments(id),
  source_document_id uuid references ii_source_documents(id), -- required for imported rows, nullable for manual (app-enforced)
  currency_code char(3) not null references currencies(currency_code), -- the transaction's own currency, never pre-converted
  status text not null default 'parsed' check (status in ('parsed', 'reconciled', 'corrected', 'reversed')),
  transaction_type text not null check (transaction_type in ('purchase', 'sip', 'redemption', 'switch_in', 'switch_out', 'dividend', 'reinvestment', 'transfer', 'merger', 'fee', 'tax', 'adjustment')),
  transaction_date date not null,
  units numeric(20, 6), -- nullable for cash-only events (e.g. a cash dividend)
  price_per_unit numeric(20, 6),
  gross_amount numeric(18, 2) not null,
  corrects_transaction_id uuid references ii_transactions(id),
  source_reference text, -- provider transaction reference (CAMS/broker ref) — the R1-named de-dup column flagged in R0_CANONICAL_IDENTIFIER_STRATEGY.md section 4
  created_at timestamptz default now() -- immutable: no updated_at
);
create index idx_ii_transactions_user on ii_transactions(user_id);
create index idx_ii_transactions_account_date on ii_transactions(account_id, transaction_date); -- explicit spec requirement
-- Idempotent re-parse: the same provider transaction reference, re-derived
-- from the same document for the same account, resolves to the same row
-- rather than duplicating (PROV-008, ADR-003 testing implications).
create unique index uidx_ii_transactions_dedup
  on ii_transactions(account_id, source_document_id, source_reference)
  where source_document_id is not null and source_reference is not null;

alter table ii_transactions enable row level security;
create policy "own ii_transactions" on ii_transactions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- ii_tax_lots — lot-level acquisition record for cost-basis (schema only —
-- no tax calculation built in R0/R1, per non-goals).
-- ---------------------------------------------------------------------------
create table ii_tax_lots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  account_id uuid not null references ii_accounts(id) on delete cascade,
  instrument_id uuid not null references ii_instruments(id),
  opening_transaction_id uuid references ii_transactions(id),
  status text not null default 'open' check (status in ('open', 'partially_closed', 'closed')),
  acquisition_date date not null,
  units_acquired numeric(20, 6) not null check (units_acquired >= 0),
  units_remaining numeric(20, 6) not null check (units_remaining >= 0),
  cost_per_unit numeric(20, 6) not null check (cost_per_unit >= 0),
  created_at timestamptz default now(),
  closed_at timestamptz
);
create index idx_ii_tax_lots_user on ii_tax_lots(user_id);
create index idx_ii_tax_lots_account_instrument on ii_tax_lots(account_id, instrument_id);

alter table ii_tax_lots enable row level security;
create policy "own ii_tax_lots" on ii_tax_lots
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- ii_holding_snapshots — point-in-time certified balance per
-- account/instrument, the "current value" source of truth for publishing.
-- Immutable: one row per (account, instrument, as-of date); a newer
-- valuation is a new row, never an update, so historical net worth is
-- reconstructible.
-- ---------------------------------------------------------------------------
create table ii_holding_snapshots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  account_id uuid not null references ii_accounts(id) on delete cascade,
  instrument_id uuid not null references ii_instruments(id),
  source_document_id uuid references ii_source_documents(id), -- nullable: can also be derived by replaying ii_transactions
  currency_code char(3) not null references currencies(currency_code), -- source-country value, never pre-converted
  quality_status text not null default 'warning' check (quality_status in ('certified', 'warning', 'incomplete')),
  as_of_date date not null,
  units numeric(20, 6) not null,
  value numeric(18, 2) not null,
  created_at timestamptz default now() -- immutable: no updated_at
);
create index idx_ii_holding_snapshots_user on ii_holding_snapshots(user_id);
-- "Latest snapshot" lookup — explicit spec requirement.
create index idx_ii_holding_snapshots_account_instrument_date
  on ii_holding_snapshots(account_id, instrument_id, as_of_date desc);
-- One certified/observed balance per (account, instrument, date) — a same-day
-- re-derivation updates understanding via a new document, not a duplicate row.
create unique index uidx_ii_holding_snapshots_position_date
  on ii_holding_snapshots(account_id, instrument_id, as_of_date);

alter table ii_holding_snapshots enable row level security;
create policy "own ii_holding_snapshots" on ii_holding_snapshots
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- ii_prices_nav — instrument-level price/NAV time series, decoupled from
-- any one user's holdings. Shared reference data (no user_id), world-read/
-- admin-write (ADR-010). No AMFI NAV feed populated by R1 (non-goal) — this
-- is the shape a future release ingests into.
-- ---------------------------------------------------------------------------
create table ii_prices_nav (
  id uuid primary key default gen_random_uuid(),
  instrument_id uuid not null references ii_instruments(id) on delete cascade,
  source_id uuid references ii_sources(id),
  currency_code char(3) not null references currencies(currency_code),
  price_date date not null,
  price numeric(20, 6) not null check (price >= 0),
  created_at timestamptz default now(),
  unique (instrument_id, price_date) -- also serves as idx_ii_prices_nav_instrument_date
);
alter table ii_prices_nav enable row level security;
create policy "read ii_prices_nav" on ii_prices_nav for select using (true);
