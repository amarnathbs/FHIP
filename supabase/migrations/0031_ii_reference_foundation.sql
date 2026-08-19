-- Investment Intelligence R1 — Migration A: core reference/catalogue tables.
-- Country-neutral shared reference data, world-readable, admin-write-only
-- (mirrors the existing master_financial_items/goal_types/benchmark_* pattern
-- confirmed in R0_CURRENT_STATE_DISCOVERY.md section 2). No user_id anywhere
-- in this migration — every table here is shared, not owned.
--
-- Governing docs: R0_CANONICAL_DATA_CONTRACT.md, R0_CANONICAL_IDENTIFIER_STRATEGY.md,
-- R0_SOURCE_PROVENANCE_CONTRACT.md section 1, ADR-002, ADR-005, ADR-010.
-- Dependency order follows R1_IMPLEMENTATION_SPEC.md section 1 items 1-2-3, 10-13, 19.

-- ---------------------------------------------------------------------------
-- ii_sources — catalogue of source TYPES Investment Intelligence can ingest
-- from (CAMS, KFintech, NSDL, CDSL, broker, manual, admin-correction, future
-- API connector). A reference/config table, not a per-upload record.
-- ---------------------------------------------------------------------------
create table ii_sources (
  id uuid primary key default gen_random_uuid(),
  source_key text not null unique,
  source_label text not null,
  source_category text not null check (source_category in ('statement_provider', 'broker', 'manual', 'admin', 'api_connector')),
  country_code char(2) references countries(country_code), -- nullable: manual/admin_correction are country-neutral
  is_active boolean not null default true,
  effective_from date,
  effective_to date,
  parser_available boolean not null default false, -- R1 seeds this false for every row — no parser exists yet (non-goal)
  metadata jsonb,
  created_at timestamptz default now()
);
alter table ii_sources enable row level security;
create policy "read ii_sources" on ii_sources for select using (true);
-- No insert/update/delete policy for the authenticated role — admin writes
-- go through the service-role client behind requireAdmin(), same as
-- master_financial_items/goal_types (R0_CURRENT_STATE_DISCOVERY.md 2.1, 10).

-- ---------------------------------------------------------------------------
-- ii_instruments — country-neutral instrument master (a specific
-- security/fund/scheme). Shared reference data, NOT user-owned — an ISIN is
-- the same instrument for everyone. A "provisional" instrument can be
-- created from a single user's own statement before any master feed
-- resolves it (ADR-002) and later merged via merged_into_instrument_id.
-- ---------------------------------------------------------------------------
create table ii_instruments (
  id uuid primary key default gen_random_uuid(),
  instrument_name text not null,
  instrument_class text not null check (instrument_class in ('equity', 'mutual_fund', 'etf', 'bond', 'fixed_deposit', 'gold', 'crypto', 'cash', 'other')),
  country_of_domicile char(2) not null references countries(country_code),
  base_currency char(3) not null references currencies(currency_code),
  isin text,
  status text not null default 'provisional' check (status in ('provisional', 'verified', 'deprecated', 'merged')),
  merged_into_instrument_id uuid references ii_instruments(id),
  source_id uuid references ii_sources(id), -- nullable: first-observed-from-statement instruments have no master-feed source yet
  is_active boolean not null default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index idx_ii_instruments_class on ii_instruments(instrument_class);
alter table ii_instruments enable row level security;
create policy "read ii_instruments" on ii_instruments for select using (true);

-- ---------------------------------------------------------------------------
-- ii_instrument_identifiers — external identifier/alias mapping, kept
-- separate from the canonical ii_instruments.id per ADR-002. One instrument
-- may carry many aliases (ISIN + AMFI code + internal provisional tag).
-- Two partial unique indexes because uniqueness scope differs by scheme:
-- ISIN/SEDOL are globally unique; AMFI/NSE/BSE codes are country-scoped.
-- ---------------------------------------------------------------------------
create table ii_instrument_identifiers (
  id uuid primary key default gen_random_uuid(),
  instrument_id uuid not null references ii_instruments(id) on delete cascade,
  identifier_scheme text not null check (identifier_scheme in ('isin', 'amfi_scheme_code', 'nse_symbol', 'bse_code', 'sedol', 'internal_provisional')),
  identifier_value text not null,
  country_code char(2) references countries(country_code),
  effective_from date,
  effective_to date,
  is_active boolean not null default true,
  created_at timestamptz default now(),
  constraint chk_ii_instrument_identifiers_country_scope check (
    identifier_scheme not in ('amfi_scheme_code', 'nse_symbol', 'bse_code', 'internal_provisional')
    or country_code is not null
  )
);
create index idx_ii_instrument_identifiers_instrument on ii_instrument_identifiers(instrument_id);
-- Globally-unique schemes (DB-006/DB-012: duplicate identifier rejection).
create unique index uidx_ii_instrument_identifiers_global
  on ii_instrument_identifiers(identifier_scheme, identifier_value)
  where identifier_scheme in ('isin', 'sedol');
-- Country-scoped schemes — the same code string can legitimately recur across countries.
create unique index uidx_ii_instrument_identifiers_country_scoped
  on ii_instrument_identifiers(identifier_scheme, identifier_value, country_code)
  where identifier_scheme in ('amfi_scheme_code', 'nse_symbol', 'bse_code', 'internal_provisional');
alter table ii_instrument_identifiers enable row level security;
create policy "read ii_instrument_identifiers" on ii_instrument_identifiers for select using (true);

-- ---------------------------------------------------------------------------
-- ii_benchmarks / ii_benchmark_series / ii_instrument_benchmarks —
-- reference-data SHAPE only (ADR-010). No benchmark content is seeded by
-- R1 (no Nifty/Sensex download — explicit non-goal); these tables exist so
-- a future release can populate them without a schema change.
-- ---------------------------------------------------------------------------
create table ii_benchmarks (
  id uuid primary key default gen_random_uuid(),
  benchmark_key text not null unique,
  benchmark_label text not null,
  benchmark_category text not null check (benchmark_category in ('index', 'category_average', 'custom')),
  country_code char(2) references countries(country_code),
  is_active boolean not null default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
alter table ii_benchmarks enable row level security;
create policy "read ii_benchmarks" on ii_benchmarks for select using (true);

create table ii_benchmark_series (
  id uuid primary key default gen_random_uuid(),
  benchmark_id uuid not null references ii_benchmarks(id) on delete cascade,
  series_date date not null,
  value numeric(18, 6) not null,
  created_at timestamptz default now(),
  unique (benchmark_id, series_date) -- also serves as idx_ii_benchmark_series_benchmark_date
);
alter table ii_benchmark_series enable row level security;
create policy "read ii_benchmark_series" on ii_benchmark_series for select using (true);

create table ii_instrument_benchmarks (
  id uuid primary key default gen_random_uuid(),
  instrument_id uuid not null references ii_instruments(id) on delete cascade,
  benchmark_id uuid not null references ii_benchmarks(id) on delete cascade,
  relationship_type text not null check (relationship_type in ('primary', 'secondary', 'category_average')),
  created_at timestamptz default now(),
  unique (instrument_id, benchmark_id, relationship_type)
);
alter table ii_instrument_benchmarks enable row level security;
create policy "read ii_instrument_benchmarks" on ii_instrument_benchmarks for select using (true);

-- ---------------------------------------------------------------------------
-- ii_fund_holdings — look-through data shape only (no X-ray analytics built
-- in R0/R1, per non-goals). underlying_instrument_id is nullable: when the
-- underlying can't be resolved to a known ii_instruments row, underlying_name
-- carries the free-text disclosure instead.
-- ---------------------------------------------------------------------------
create table ii_fund_holdings (
  id uuid primary key default gen_random_uuid(),
  fund_instrument_id uuid not null references ii_instruments(id) on delete cascade,
  underlying_instrument_id uuid references ii_instruments(id),
  underlying_name text,
  disclosure_date date not null,
  weight_pct numeric(6, 3) not null check (weight_pct >= 0 and weight_pct <= 100),
  source_id uuid references ii_sources(id),
  created_at timestamptz default now(),
  unique (fund_instrument_id, underlying_instrument_id, disclosure_date)
);
create index idx_ii_fund_holdings_fund on ii_fund_holdings(fund_instrument_id);
alter table ii_fund_holdings enable row level security;
create policy "read ii_fund_holdings" on ii_fund_holdings for select using (true);

-- ---------------------------------------------------------------------------
-- ii_tax_rule_versions — versioned reference data shape only (no STCG/LTCG/
-- exit-load rules populated or applied in R0/R1, per non-goals).
-- ---------------------------------------------------------------------------
create table ii_tax_rule_versions (
  id uuid primary key default gen_random_uuid(),
  rule_set_key text not null,
  version text not null,
  country_code char(2) not null references countries(country_code),
  rule_definition jsonb not null,
  effective_from date not null,
  effective_to date,
  created_at timestamptz default now(),
  unique (rule_set_key, version)
);
create index idx_ii_tax_rule_versions_country on ii_tax_rule_versions(country_code);
alter table ii_tax_rule_versions enable row level security;
create policy "read ii_tax_rule_versions" on ii_tax_rule_versions for select using (true);
