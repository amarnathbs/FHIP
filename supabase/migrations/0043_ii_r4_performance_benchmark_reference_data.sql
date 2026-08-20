-- Investment Intelligence R4 — Performance & Benchmark Engine.
-- Forward-only migration. Does NOT modify any already-applied migration
-- (0001-0042 remain untouched). NOT YET APPLIED TO DEV — this session has
-- no DDL execution capability in this sandbox (same constraint as every
-- prior IL release); application status is BLOCKED pending the user
-- running this file against the real Supabase project.
--
-- Scope (spec sections 69-70):
--   1. Extend ii_prices_nav with provenance/versioning columns.
--   2. Extend ii_benchmarks / ii_benchmark_series with return-type,
--      currency, and versioning columns.
--   3. Extend ii_instrument_benchmarks with effective-dating and
--      versioning (spec sections 30-31).
--   4. New ii_risk_free_rates — versioned risk-free reference data
--      (spec section 37). World-readable, write-restricted to trusted
--      server/admin processes (no authenticated-write policy, same
--      pattern as ii_benchmarks/ii_prices_nav from R1).
--   5. New ii_analytics_results — persisted, versioned, reproducible
--      derived analytics output (spec sections 55-57). Read-restricted to
--      the owning user; write-restricted to service-role (users cannot
--      insert/update/delete their own or anyone else's analytics rows —
--      this is the DB-level enforcement behind SEC-R4 "fake-analytics-
--      insertion rejection").
--
-- No parallel transaction/holding ledger is introduced (spec section 69);
-- R4 reads existing ii_transactions / ii_holding_snapshots / ii_prices_nav
-- and writes only to the new analytics-result table below.

-- ---------------------------------------------------------------------------
-- 1. ii_prices_nav — provenance/versioning columns.
-- ---------------------------------------------------------------------------
alter table ii_prices_nav add column source_timestamp timestamptz;
alter table ii_prices_nav add column data_version text;
alter table ii_prices_nav add column quality_status text not null default 'ok' check (quality_status in ('ok', 'suspicious_jump', 'stale', 'superseded'));
comment on column ii_prices_nav.source_timestamp is 'When the source (e.g. AMFI feed, admin import) asserted this NAV value, distinct from created_at (when this row was inserted).';
comment on column ii_prices_nav.data_version is 'Free-text version/batch identifier for the ingestion run that produced this row (spec section 55-57 traceability).';

-- ---------------------------------------------------------------------------
-- 2. ii_benchmarks / ii_benchmark_series — return-type, currency, versioning.
-- ---------------------------------------------------------------------------
alter table ii_benchmarks add column return_type text check (return_type in ('TRI', 'PRI', 'DEBT_INDEX', 'COMMODITY_GOLD', 'OTHER'));
comment on column ii_benchmarks.return_type is 'Total Return Index vs Price Return Index vs other — spec section 30: a stated TRI benchmark must never be silently satisfied with a PRI series.';

alter table ii_benchmark_series add column currency_code char(3) references currencies(currency_code);
alter table ii_benchmark_series add column source_id uuid references ii_sources(id);
alter table ii_benchmark_series add column data_version text;
alter table ii_benchmark_series add column quality_status text not null default 'ok' check (quality_status in ('ok', 'duplicate_flagged', 'suspicious_jump', 'stale', 'superseded'));

-- ---------------------------------------------------------------------------
-- 3. ii_instrument_benchmarks — effective-dated mapping + versioning
--    (spec sections 30-31: schemes whose benchmark changed over time).
-- ---------------------------------------------------------------------------
alter table ii_instrument_benchmarks add column effective_from date not null default '1900-01-01';
alter table ii_instrument_benchmarks add column effective_to date;
alter table ii_instrument_benchmarks add column source_id uuid references ii_sources(id);
alter table ii_instrument_benchmarks add column mapping_version text not null default 'v1';
alter table ii_instrument_benchmarks add column quality_status text not null default 'ok' check (quality_status in ('ok', 'ambiguous', 'superseded'));
alter table ii_instrument_benchmarks add constraint ii_instrument_benchmarks_effective_range_check check (effective_to is null or effective_to >= effective_from);

-- The original unique(instrument_id, benchmark_id, relationship_type) from
-- migration 0031 would incorrectly forbid a scheme re-adopting the SAME
-- benchmark after an intervening change (A -> B -> A). Replace it with a
-- period-aware constraint; true overlap prevention (no two active PRIMARY
-- mappings for the same instrument on the same date) is enforced at the
-- application layer (BenchmarkEngine.resolveBenchmarkForDate takes the
-- first effective match deterministically) pending exclusion-constraint
-- support review — documented as a known limitation, not silently assumed.
-- The original constraint's name is looked up dynamically (rather than
-- hard-coded/guessed) because Postgres auto-generates and truncates
-- unique-constraint names, and this migration has never been run against
-- the real database to confirm the exact 0031-era generated name.
do $$
declare
  original_constraint_name text;
begin
  select con.conname into original_constraint_name
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  where rel.relname = 'ii_instrument_benchmarks'
    and con.contype = 'u'
    and con.conkey = (
      select array_agg(attnum order by attnum)
      from pg_attribute
      where attrelid = rel.oid
        and attname in ('instrument_id', 'benchmark_id', 'relationship_type')
    );
  if original_constraint_name is not null then
    execute format('alter table ii_instrument_benchmarks drop constraint %I', original_constraint_name);
  end if;
end $$;

alter table ii_instrument_benchmarks add constraint ii_instrument_benchmarks_unique_mapping_period unique (instrument_id, benchmark_id, relationship_type, effective_from);

create index idx_ii_instrument_benchmarks_effective on ii_instrument_benchmarks(instrument_id, relationship_type, effective_from);

-- ---------------------------------------------------------------------------
-- 4. ii_risk_free_rates — versioned risk-free reference data (spec 37).
--    World-readable; write-restricted to trusted server/admin processes
--    (RLS enabled, SELECT-only policy — no INSERT/UPDATE/DELETE policy for
--    the authenticated role, so ordinary users cannot alter it; the
--    service role bypasses RLS entirely for admin ingestion).
-- ---------------------------------------------------------------------------
create table ii_risk_free_rates (
  id uuid primary key default gen_random_uuid(),
  country_code char(2) not null references countries(country_code),
  period_start date not null,
  period_end date not null,
  annualised_rate numeric(8, 6) not null,
  source text not null,
  method text not null,
  version text not null default 'v1',
  created_at timestamptz not null default now(),
  constraint ii_risk_free_rates_period_check check (period_end >= period_start),
  unique (country_code, period_start, period_end, version)
);
create index idx_ii_risk_free_rates_country_period on ii_risk_free_rates(country_code, period_start, period_end);
alter table ii_risk_free_rates enable row level security;
create policy "read ii_risk_free_rates" on ii_risk_free_rates for select using (true);
-- Deliberately no insert/update/delete policy for the authenticated role —
-- this table is written only by trusted server/admin processes using the
-- service-role key, which bypasses RLS. SEC-R4-REFDATA tests must confirm
-- an ordinary authenticated user's insert/update/delete attempt is
-- rejected by RLS (not merely by app-layer logic).

-- ---------------------------------------------------------------------------
-- 5. ii_analytics_results — persisted, versioned, reproducible derived
--    analytics (spec sections 55-58). PURELY DERIVED / READ-ONLY from the
--    rest of the financial register's point of view: nothing in this
--    table is ever read back into investments/assets/retirement_accounts/
--    liabilities/income/expenses or net worth. Row-owned by the household
--    user; SELECT restricted to the owner; INSERT/UPDATE/DELETE granted
--    to NO authenticated-role policy (service-role only) so a user can
--    never insert a fabricated analytics result for themselves or anyone
--    else — this is the DB-level backing for the mandatory
--    "fake-analytics-insertion rejection" security test (spec section 95).
-- ---------------------------------------------------------------------------
create table ii_analytics_results (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  scope_type text not null check (scope_type in ('scheme', 'portfolio')),
  scope_id text not null, -- ii_instruments.id for 'scheme', or the household/account grouping key for 'portfolio'
  metric_key text not null, -- e.g. 'investor_xirr', 'scheme_cagr_3y', 'portfolio_twrr', 'max_drawdown', 'sharpe_ratio'
  metric_version text not null,
  engine_version text not null,
  data_as_of_date date not null,
  input_snapshot_version text not null, -- fingerprintInputs() sha256 hex — see lib/engines/investment-intelligence/analyticsVersioning.ts
  benchmark_mapping_version text,
  nav_data_version text,
  benchmark_data_version text,
  risk_free_version text,
  quality_status text not null check (quality_status in ('ok', 'unavailable', 'stale')),
  quality_reason text, -- populated when quality_status != 'ok' (DataQualityFlag value)
  result_value jsonb not null, -- shape depends on metric_key; documented per-metric in R4_CALCULATION_METHODOLOGY.md
  created_at timestamptz not null default now(),
  unique (user_id, scope_type, scope_id, metric_key, input_snapshot_version, engine_version)
);
create index idx_ii_analytics_results_user_scope on ii_analytics_results(user_id, scope_type, scope_id, metric_key);
create index idx_ii_analytics_results_created on ii_analytics_results(created_at);
alter table ii_analytics_results enable row level security;
create policy "read own ii_analytics_results" on ii_analytics_results for select using (auth.uid() = user_id);
-- No insert/update/delete policy for the authenticated role — see header
-- comment. Persistence happens exclusively via a service-role server
-- process (the AnalyticsOrchestrator's persistence step), never directly
-- from a client-supplied request body.

comment on table ii_analytics_results is 'R4 purely-derived, read-only, versioned calculation results. Never written by client requests; never read back into any R1-R3 financial register table or net worth. A shown number must always be reproducible from (engine_version, input_snapshot_version) — see analyticsVersioning.ts.';
