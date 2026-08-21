-- Investment Intelligence R5 — SIP Intelligence & Portfolio X-Ray schema.
-- Forward-only migration. Does NOT modify any already-applied migration
-- (0001-0043 remain untouched).
--
-- ===========================================================================
-- MIGRATION NUMBERING CAVEAT — READ BEFORE ADDING THE NEXT MIGRATION
-- ===========================================================================
-- This repository currently has an ACTIVE, UNRESOLVED migration-numbering
-- fork, disclosed during the FDH-0 architecture audit and NOT resolved here
-- (it is an open Product Owner decision, deliberately left alone by R5):
--
--   * The Investment Intelligence lineage and the Resources CMS lineage have
--     independently consumed overlapping numbers. For example TWO different
--     "0035" files exist on different branches:
--         0035_ii_analytics_insights_reconciliation.sql   (II lineage)
--         0035_resources_analyst_role_delta.sql           (Resources lineage)
--
--   * R5 therefore picks the next number that is genuinely free WITHIN THE
--     INVESTMENT INTELLIGENCE LINEAGE SPECIFICALLY. On
--     feature/investment-intelligence-r4-performance-benchmark the highest
--     II migration is 0043 (R4), so R5 is 0044. Verified by directly listing
--     that branch's supabase/migrations/ directory, not assumed.
--
--   * Reserved ranges observed by this session's convention:
--         0100+  reserved for the Resources CMS stream
--         0200+  reserved for the new Financial Data Hub (FDH) stream
--     R5 uses NEITHER.
--
-- Anyone adding the next II migration should re-inspect the II lineage rather
-- than trusting a global max across branches.
--
-- ===========================================================================
-- APPLICATION STATUS
-- ===========================================================================
-- NOT YET APPLIED to DEV (vqycarelcoijzwlpkpcz) as at authoring time. See
-- R5_IMPLEMENTATION_REPORT.md for the live application record. This file is
-- written to be IDEMPOTENT and safe to re-run end to end: every DDL statement
-- is guarded (`if not exists` / `drop policy if exists`), so a partial
-- application can be completed by re-running the WHOLE file.
--
-- ===========================================================================
-- SCOPE
-- ===========================================================================
--   1. ii_fund_holdings_snapshots — versioned, preserved fund-holdings
--      snapshot headers (the R1 ii_fund_holdings table is shape-only and has
--      no versioning, no market value, and no classification metadata).
--   2. ii_fund_holdings_lines — the per-holding detail lines belonging to a
--      snapshot, with the as-applicable fields R5's X-Ray needs.
--   3. ii_security_classifications — versioned sector/industry/market-cap/
--      credit/maturity metadata for canonical securities.
--   4. ii_security_aliases — the CURATED, admin-only controlled-alias table
--      that is the ONLY place a display name participates in identity.
--   5. ii_sip_series — analytical SIP series metadata (an interpretation
--      layer; it never modifies ii_transactions).
--   6. ii_r5_analytics_results — persisted, versioned R5 results.
--
-- SECURITY POSTURE (the critical R5 gate, spec sections 76-78):
--   Reference/market data (1-4) is WORLD-READABLE and WRITE-RESTRICTED to
--   trusted server/admin processes via the service role — there is NO
--   insert/update/delete policy for the authenticated role, exactly like
--   ii_benchmarks / ii_prices_nav / ii_fund_holdings from R1 and
--   ii_risk_free_rates from R4. An ordinary user must be structurally unable
--   to invent a fund holding, a security classification, or a credit rating.
--
--   User-owned analytics (5-6) is SELECT-ONLY for its owner. There is NO
--   authenticated-role INSERT/UPDATE/DELETE policy, so a user can never forge
--   a SIP or X-Ray result for themselves or anyone else. This is the direct
--   R5 continuation of the same-user analytics-forgery vulnerability found
--   and fixed in R4 (migration 0043 section 5), and it is re-tested by
--   scripts/ii_r5_analytics_forgery_regression.mjs.
--
-- NO NET-WORTH IMPACT: nothing in this migration is ever read back into
-- investments / assets / retirement_accounts / liabilities / income /
-- expenses, or into net worth. R5 is purely analytical and strictly
-- read-only with respect to the financial register and R3's publication
-- lifecycle.

-- ---------------------------------------------------------------------------
-- 1. ii_fund_holdings_snapshots — versioned snapshot headers.
--    A NEW SNAPSHOT NEVER DESTROYS AN OLDER ONE (spec section 62): each
--    disclosure is its own immutable row, and analytics selects the latest
--    row at-or-before the analytics as-of date. `superseded_at` is
--    informational only — superseded rows are retained and remain auditable.
-- ---------------------------------------------------------------------------
create table if not exists ii_fund_holdings_snapshots (
  id uuid primary key default gen_random_uuid(),
  fund_instrument_id uuid not null references ii_instruments(id) on delete cascade,
  -- The date the holdings DESCRIBE, not the date they were ingested. These
  -- are genuinely different and both are displayed in the UI.
  holdings_as_of_date date not null,
  ingested_at timestamptz not null default now(),
  source_id uuid references ii_sources(id),
  -- Provider/document version so two ingests of the same as-of date are
  -- distinguishable and reproducible.
  source_document_version text,
  source_data_version text,
  classification_version text,
  -- Sum of disclosed weights as ingested, BEFORE any normalisation. R5 never
  -- rescales a partial disclosure up to 100%; this column records the truth.
  disclosed_weight_total_pct numeric(9, 4),
  quality_status text not null default 'ok'
    check (quality_status in ('ok', 'partial_disclosure', 'unverified_source', 'superseded')),
  superseded_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  -- One snapshot per (fund, as-of date, source document version). A genuine
  -- re-issue of the same date by the same source updates nothing — it lands
  -- as a distinct version.
  unique (fund_instrument_id, holdings_as_of_date, source_document_version)
);
create index if not exists idx_ii_fund_holdings_snapshots_fund_date
  on ii_fund_holdings_snapshots(fund_instrument_id, holdings_as_of_date desc);
alter table ii_fund_holdings_snapshots enable row level security;
drop policy if exists "read ii_fund_holdings_snapshots" on ii_fund_holdings_snapshots;
create policy "read ii_fund_holdings_snapshots" on ii_fund_holdings_snapshots for select using (true);
-- No authenticated-role write policy: service-role/admin ingestion only.

comment on table ii_fund_holdings_snapshots is
  'R5 versioned fund-holdings snapshot headers. Shared reference data: world-readable, write-restricted to trusted server/admin processes. Snapshots are preserved, never overwritten — analytics uses the latest snapshot at-or-before the analysis as-of date and never a future one.';

-- ---------------------------------------------------------------------------
-- 2. ii_fund_holdings_lines — per-holding detail.
--    underlying_instrument_id is NULLABLE ON PURPOSE: a line that cannot be
--    resolved to a canonical security by a deterministic identifier stays
--    UNRESOLVED and is retained as explicit unresolved exposure. It is never
--    name-matched into a lookalike security, and never silently dropped.
-- ---------------------------------------------------------------------------
create table if not exists ii_fund_holdings_lines (
  id uuid primary key default gen_random_uuid(),
  snapshot_id uuid not null references ii_fund_holdings_snapshots(id) on delete cascade,
  -- Canonical resolution result. NULL = genuinely unresolved.
  underlying_instrument_id uuid references ii_instruments(id),
  -- Raw source disclosure, retained verbatim and separate from identity.
  holding_name text not null,
  source_identifier text,
  isin text,
  issuer_id uuid references ii_instruments(id),
  issuer_name text,
  -- Buckets that must be PRESERVED, never redistributed across equities.
  asset_kind text not null default 'security'
    check (asset_kind in ('security', 'cash', 'derivative', 'other')),
  quantity numeric(24, 6),
  market_value numeric(20, 2),
  weight_pct numeric(9, 4) not null check (weight_pct >= 0 and weight_pct <= 100),
  -- Classification as disclosed/resolved at ingestion time.
  sector_code text,
  industry_code text,
  market_cap_class text check (market_cap_class in ('LARGE', 'MID', 'SMALL', 'OTHER')),
  security_type text,
  -- Debt metadata. All nullable: absence means UNAVAILABLE, never zero.
  credit_rating_band text
    check (credit_rating_band in ('SOVEREIGN', 'AAA', 'AA', 'A', 'BELOW_A', 'UNRATED', 'OTHER_UNCLASSIFIED')),
  agency_ratings jsonb, -- retained agency-specific ratings; never collapsed arbitrarily
  maturity_date date,
  coupon_pct numeric(9, 4),
  -- Source-provided ONLY. R5 never estimates duration from maturity.
  modified_duration numeric(12, 6),
  resolution_method text
    check (resolution_method in ('ISIN', 'EXCHANGE_ID', 'PROVIDER_ID', 'CONTROLLED_ALIAS', 'EXACT_MAP', 'UNRESOLVED')),
  created_at timestamptz not null default now()
);
create index if not exists idx_ii_fund_holdings_lines_snapshot on ii_fund_holdings_lines(snapshot_id);
create index if not exists idx_ii_fund_holdings_lines_underlying on ii_fund_holdings_lines(underlying_instrument_id);
alter table ii_fund_holdings_lines enable row level security;
drop policy if exists "read ii_fund_holdings_lines" on ii_fund_holdings_lines;
create policy "read ii_fund_holdings_lines" on ii_fund_holdings_lines for select using (true);
-- No authenticated-role write policy: service-role/admin ingestion only.

comment on table ii_fund_holdings_lines is
  'R5 per-holding detail for a fund-holdings snapshot. underlying_instrument_id NULL means the line is genuinely unresolved and is reported as unresolved exposure — never name-matched, never dropped. Debt metadata columns are nullable: absent means unavailable, never zero.';

-- ---------------------------------------------------------------------------
-- 3. ii_security_classifications — versioned classification metadata.
--    Two taxonomies are never mixed without version metadata (spec 69).
-- ---------------------------------------------------------------------------
create table if not exists ii_security_classifications (
  id uuid primary key default gen_random_uuid(),
  instrument_id uuid not null references ii_instruments(id) on delete cascade,
  classification_version text not null,
  taxonomy_key text not null, -- e.g. 'amfi_sector_v1', 'gics_v2023'
  sector_code text,
  sector_label text,
  industry_code text,
  industry_label text,
  market_cap_class text check (market_cap_class in ('LARGE', 'MID', 'SMALL', 'OTHER')),
  market_cap_source text, -- e.g. 'AMFI half-yearly categorisation'; never inferred from a fund's own name
  effective_from date not null default '1900-01-01',
  effective_to date,
  source_id uuid references ii_sources(id),
  created_at timestamptz not null default now(),
  unique (instrument_id, classification_version, taxonomy_key, effective_from)
);
create index if not exists idx_ii_security_classifications_instrument
  on ii_security_classifications(instrument_id, effective_from desc);
alter table ii_security_classifications enable row level security;
drop policy if exists "read ii_security_classifications" on ii_security_classifications;
create policy "read ii_security_classifications" on ii_security_classifications for select using (true);
-- No authenticated-role write policy: service-role/admin ingestion only.

comment on table ii_security_classifications is
  'R5 versioned sector/industry/market-cap classification for canonical securities. market_cap_class is only ever populated from a real classification source — never inferred from a fund category label.';

-- ---------------------------------------------------------------------------
-- 4. ii_security_aliases — CURATED controlled aliases.
--    This is the ONLY place a display name participates in security identity,
--    and only because an administrator explicitly approved that exact string.
--    Exact match after minimal normalisation; no fuzzy matching anywhere.
-- ---------------------------------------------------------------------------
create table if not exists ii_security_aliases (
  id uuid primary key default gen_random_uuid(),
  instrument_id uuid not null references ii_instruments(id) on delete cascade,
  alias_normalised text not null, -- uppercase, whitespace-collapsed, trailing period removed
  alias_raw text not null,
  source_id uuid references ii_sources(id),
  approved_by text,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  -- A single normalised alias must never point at two different securities;
  -- that ambiguity has to be resolved by a human, not by the engine.
  unique (alias_normalised)
);
create index if not exists idx_ii_security_aliases_instrument on ii_security_aliases(instrument_id);
alter table ii_security_aliases enable row level security;
drop policy if exists "read ii_security_aliases" on ii_security_aliases;
create policy "read ii_security_aliases" on ii_security_aliases for select using (true);
-- No authenticated-role write policy: service-role/admin curation only.

comment on table ii_security_aliases is
  'R5 curated controlled aliases — the only sanctioned path from a display name to a canonical security. Unique on alias_normalised so one name can never map to two securities. Admin-curated; not user-writable.';

-- ---------------------------------------------------------------------------
-- 5. ii_sip_series — analytical recurring-contribution series metadata.
--    An INTERPRETATION LAYER over certified R2 data. Nothing here modifies
--    ii_transactions, and no certified transaction_type is ever rewritten.
-- ---------------------------------------------------------------------------
create table if not exists ii_sip_series (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  account_id uuid not null references ii_accounts(id) on delete cascade,
  instrument_id uuid not null references ii_instruments(id),
  -- Deterministic identity: account + instrument + mandate discriminator.
  series_key text not null,
  cadence text not null
    check (cadence in ('MONTHLY', 'QUARTERLY', 'WEEKLY', 'FORTNIGHTLY', 'ANNUAL', 'OTHER_RECURRING', 'IRREGULAR', 'UNKNOWN')),
  -- CONFIRMED_SOURCE is reachable ONLY from genuine source evidence.
  -- An inferred series can never carry it (spec section 41).
  detection_confidence text not null
    check (detection_confidence in ('CONFIRMED_SOURCE', 'HIGH_CONFIDENCE', 'POSSIBLE', 'AMBIGUOUS', 'NOT_SIP')),
  confidence_rationale text,
  contribution_trend text check (contribution_trend in ('FLAT', 'INCREASING', 'DECREASING', 'MIXED')),
  first_contribution_date date,
  latest_contribution_date date,
  contribution_count integer,
  currency_code char(3) references currencies(currency_code), -- never pre-converted
  detection_method_version text not null,
  threshold_config_version text not null,
  computed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (user_id, series_key, detection_method_version, threshold_config_version)
);
create index if not exists idx_ii_sip_series_user on ii_sip_series(user_id, instrument_id);
alter table ii_sip_series enable row level security;
drop policy if exists "own ii_sip_series" on ii_sip_series;
drop policy if exists "read own ii_sip_series" on ii_sip_series;
create policy "read own ii_sip_series" on ii_sip_series for select using (auth.uid() = user_id);
-- No authenticated-role INSERT/UPDATE/DELETE policy: derived analytics are
-- written exclusively by a service-role server process. A user can never
-- declare their own SIP series into existence.

comment on table ii_sip_series is
  'R5 analytical recurring-contribution series. Purely derived from certified ii_transactions; never modifies them. Owner-readable, service-role-writable only.';

-- ---------------------------------------------------------------------------
-- 6. ii_r5_analytics_results — persisted, versioned R5 results.
--    Deliberately a SEPARATE table from R4's ii_analytics_results rather than
--    a widening of it: R4's table is certified and in production use, its
--    unique constraint and scope_type check are tuned to R4's metric set, and
--    R5 needs holdings-snapshot/classification lineage columns that would be
--    permanently NULL for every R4 row. Additive, not disruptive.
-- ---------------------------------------------------------------------------
create table if not exists ii_r5_analytics_results (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  scope_type text not null check (scope_type in ('sip_series', 'scheme', 'fund_pair', 'portfolio')),
  scope_id text not null,
  metric_key text not null,
  metric_version text not null,
  engine_version text not null,
  -- Analysis as-of date, and the two data as-of dates that may legitimately
  -- DIFFER from it and from each other. Both are surfaced in the UI so a
  -- number is never silently attributed to "today".
  data_as_of_date date not null,
  portfolio_as_of_date date,
  holdings_as_of_date date,
  holdings_snapshot_ids uuid[],
  holdings_source_versions text[],
  classification_version text,
  benchmark_mapping_version text,
  benchmark_data_version text,
  nav_data_version text,
  input_snapshot_version text not null, -- fingerprintSipInputs/fingerprintXrayInputs sha256 hex
  coverage numeric(9, 6), -- effective look-through coverage, 0..1, where applicable
  quality_status text not null,
  quality_reason text,
  result_value jsonb not null,
  created_at timestamptz not null default now(),
  unique (user_id, scope_type, scope_id, metric_key, input_snapshot_version, engine_version)
);
create index if not exists idx_ii_r5_analytics_results_user_scope
  on ii_r5_analytics_results(user_id, scope_type, scope_id, metric_key);
create index if not exists idx_ii_r5_analytics_results_created on ii_r5_analytics_results(created_at);
alter table ii_r5_analytics_results enable row level security;
-- Defensive: ensure no permissive policy of any vintage survives on this name.
drop policy if exists "own ii_r5_analytics_results" on ii_r5_analytics_results;
drop policy if exists "read own ii_r5_analytics_results" on ii_r5_analytics_results;
create policy "read own ii_r5_analytics_results" on ii_r5_analytics_results for select using (auth.uid() = user_id);
-- No insert/update/delete policy for the authenticated role. This is the
-- DB-level enforcement behind the mandatory R5 "fake-analytics-insertion
-- rejection" test, and the direct continuation of R4's fix.

comment on table ii_r5_analytics_results is
  'R5 purely-derived, read-only, versioned SIP and X-Ray results. Never written by client requests; never read back into any R1-R3 financial register table or net worth. A shown number must always be reproducible from (engine_version, input_snapshot_version).';
