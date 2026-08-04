-- Module 8: Financial Twin (TM) and Benchmark Intelligence Engine (TM).
-- A deterministic, source-controlled, auditable peer-comparison module. Adds
-- (a) two household dimensions needed for cohort matching that nothing in
-- Modules 1-7 captured (housing_tenure, residence_type), (b) the benchmark
-- reference-data hierarchy (sources -> datasets -> cohorts -> values ->
-- target ranges), (c) immutable Financial Twin run history, and (d) a
-- minimal admin-governance layer (admin_users + benchmark_update_runs).
--
-- Benchmark class discipline (spec section 1): every benchmark_datasets row
-- is tagged with exactly one benchmark_class, and every benchmark_values /
-- benchmark_target_ranges row inherits it via its dataset. The four classes
-- (observed_market, regulatory_statutory, fhip_planning, platform_peer) are
-- never blended without disclosure — the UI layer surfaces benchmark_class
-- on every displayed comparison (Rule: never blend without labelling).

-- ---------------------------------------------------------------------------
-- A. Household dimensions needed for cohort matching that don't exist yet
-- ---------------------------------------------------------------------------
alter table households
  add column housing_tenure text check (housing_tenure in ('renter', 'mortgage_owner', 'outright_owner', 'other')),
  add column residence_type text check (residence_type in ('metro', 'regional', 'rural', 'unspecified')) default 'unspecified';

-- A recurring family-support/remittance expense master item did not exist —
-- needed for the cross-border "remittance burden" metric (spec section 7.10).
-- Additive seed row only; does not touch any existing category or user data.
insert into master_financial_items (category, item_key, item_label, sort_order, is_active)
values ('expense', 'family_support_remittance', 'Family Support / Remittances Sent Overseas', 900, true)
on conflict (category, item_key) do nothing;

-- ---------------------------------------------------------------------------
-- B. Minimal admin-governance layer
-- ---------------------------------------------------------------------------
create table admin_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  granted_at timestamptz default now(),
  granted_by uuid references auth.users(id),
  notes text
);
alter table admin_users enable row level security;
-- A user may check their own admin flag; grants/revokes happen only via the
-- service-role client (no self-service admin escalation through RLS).
create policy "self read admin flag" on admin_users for select using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- C. Benchmark reference-data hierarchy
-- ---------------------------------------------------------------------------
create table benchmark_sources (
  id uuid primary key default gen_random_uuid(),
  source_name text not null,                 -- ABS, ATO, APRA, ASFA, MoSPI, EPFO, FHIP
  source_type text not null check (source_type in ('official', 'industry', 'internal', 'licensed')),
  publisher text not null,
  source_title text not null,
  country_code char(2) references countries(country_code),
  publication_date date,
  reference_period_start date,
  reference_period_end date,
  source_location text,
  licence_type text,
  citation_text text not null,
  methodology_notes text,
  quality_rating text check (quality_rating in ('high', 'medium', 'low')),
  status text not null default 'draft'
    check (status in ('draft', 'under_review', 'approved', 'active', 'superseded', 'suspended', 'archived')),
  created_by uuid references auth.users(id),
  approved_by uuid references auth.users(id),
  approved_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table benchmark_datasets (
  id uuid primary key default gen_random_uuid(),
  benchmark_source_id uuid not null references benchmark_sources(id) on delete cascade,
  dataset_name text not null,
  version text not null,
  benchmark_class text not null
    check (benchmark_class in ('observed_market', 'regulatory_statutory', 'fhip_planning', 'platform_peer')),
  evidence_level text not null default 'official_statistical'
    check (evidence_level in ('official_statistical', 'regulatory', 'research_informed', 'platform_derived')),
  is_indicative boolean not null default true,
  requires_periodic_review boolean not null default true,
  source_period text,
  geography_level text,                      -- country|state|urban_rural
  statistic_coverage text,                   -- e.g. "mean, median, P10-P90"
  sample_size int,
  data_status text not null default 'draft'
    check (data_status in ('draft', 'under_review', 'approved', 'active', 'superseded', 'suspended', 'archived')),
  effective_from date,
  effective_to date,
  approved_by uuid references auth.users(id),
  approved_at timestamptz,
  review_due_at date,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (dataset_name, version)
);

create table benchmark_metric_definitions (
  id uuid primary key default gen_random_uuid(),
  metric_code text not null unique,
  metric_name text not null,
  category_code text not null check (category_code in (
    'income_cashflow', 'expenses_savings', 'liquidity_resilience', 'debt_commitments',
    'assets_networth', 'investments', 'retirement', 'insurance', 'goals', 'cross_border'
  )),
  formula_reference text,
  unit text not null,                        -- currency|percentage|months|ratio|count|years|days
  comparison_direction text not null
    check (comparison_direction in ('higher_better', 'lower_better', 'target_range', 'context_only')),
  household_or_person text not null default 'household'
    check (household_or_person in ('household', 'person', 'per_capita')),
  display_precision int not null default 1,
  explanation text,
  active_flag boolean not null default true,
  display_order int not null default 0
);

create table benchmark_cohorts (
  id uuid primary key default gen_random_uuid(),
  dataset_id uuid references benchmark_datasets(id) on delete cascade,
  cohort_code text not null unique,
  country_code char(2) references countries(country_code),
  region_code text,
  urban_rural text check (urban_rural in ('urban', 'rural', 'metro', 'regional')),
  age_band text,
  income_band text,
  household_type text,
  life_stage text,
  housing_tenure text,
  employment_type text,
  dependant_band text,
  financial_dna_code text,
  cross_border_flag boolean not null default false,
  cohort_tier int not null check (cohort_tier between 1 and 5),
  sample_size int,
  cohort_description text not null
);

create table benchmark_values (
  id uuid primary key default gen_random_uuid(),
  dataset_id uuid not null references benchmark_datasets(id) on delete cascade,
  cohort_id uuid references benchmark_cohorts(id) on delete cascade,
  metric_definition_id uuid not null references benchmark_metric_definitions(id),
  statistic_type text not null
    check (statistic_type in ('mean', 'median', 'p10', 'p20', 'p25', 'p50', 'p75', 'p80', 'p90', 'target_min', 'target_max', 'threshold', 'rate', 'share')),
  value_numeric numeric(18,4),
  value_text text,
  unit text,
  original_currency char(3),
  base_date date,
  is_derived boolean not null default false,
  derivation_method text,
  confidence_score numeric(5,2),
  effective_from date default current_date,
  effective_to date,
  version int not null default 1,
  created_at timestamptz default now()
);
create index idx_benchmark_values_lookup on benchmark_values(metric_definition_id, cohort_id, statistic_type);

-- FHIP Planning Benchmarks (target ranges): country/life-stage-aware banded
-- ranges. Most rows are FHIP's own research-informed bands (evidence_level
-- default), but a few (ASFA retirement standards, EPF contribution rates)
-- are externally published planning/statutory standards reused here as
-- range data rather than a single observed statistic — benchmark_source_id
-- lets those cite their real publisher instead of implying FHIP authorship.
create table benchmark_target_ranges (
  id uuid primary key default gen_random_uuid(),
  metric_definition_id uuid not null references benchmark_metric_definitions(id),
  benchmark_source_id uuid references benchmark_sources(id),
  country_code char(2) references countries(country_code),
  life_stage text,
  household_type text,
  band_label text not null,                  -- display wording varies per metric (e.g. "strong" vs "highly_resilient")
  band_tier int not null check (band_tier between 1 and 4), -- normalised: 1=critical/worst .. 4=strongest, regardless of display wording
  lower_bound numeric(18,4),
  upper_bound numeric(18,4),
  direction text not null default 'target_range' check (direction in ('higher_better', 'lower_better', 'target_range')),
  explanation text,
  evidence_level text not null default 'research_informed',
  model_version text not null default 'fhip-planning-1.0.0',
  effective_from date not null default current_date,
  effective_to date,
  created_at timestamptz default now()
);
create index idx_benchmark_target_ranges_lookup on benchmark_target_ranges(metric_definition_id, country_code, life_stage);

-- ---------------------------------------------------------------------------
-- D. Immutable Financial Twin run history
-- ---------------------------------------------------------------------------
create table financial_twin_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  household_id uuid references households(id),
  source_snapshot_id uuid references financial_snapshots(id),
  run_date date not null default current_date,
  official_month date,
  primary_cohort_id uuid references benchmark_cohorts(id),
  cohort_tier int,
  cohort_confidence numeric(5,2),
  model_version text not null default 'twin-1.0.0',
  benchmark_version text,
  overall_confidence numeric(5,2),
  metrics_compared int not null default 0,
  ahead_count int not null default 0,
  aligned_count int not null default 0,
  behind_count int not null default 0,
  not_comparable_count int not null default 0,
  status text not null default 'indicative' check (status in ('indicative', 'confirmed', 'restated')),
  restates_run_id uuid references financial_twin_runs(id),
  data_completeness_pct numeric(5,2),
  created_at timestamptz default now()
);
create index idx_financial_twin_runs_user on financial_twin_runs(user_id, run_date desc);

create table financial_twin_metric_results (
  id uuid primary key default gen_random_uuid(),
  financial_twin_run_id uuid not null references financial_twin_runs(id) on delete cascade,
  metric_code text not null,
  category_code text not null,
  user_value numeric(18,4),
  peer_value numeric(18,4),
  healthy_min numeric(18,4),
  healthy_max numeric(18,4),
  future_self_value numeric(18,4),
  statistic_type text,
  absolute_gap numeric(18,4),
  percentage_gap numeric(10,4),
  percentile_rank numeric(5,2),
  comparison_status text
    check (comparison_status in (
      'materially_ahead', 'ahead', 'broadly_aligned', 'slightly_behind', 'materially_behind',
      'target_range_met', 'context_required', 'not_comparable'
    )),
  comparison_direction text,
  benchmark_class text,                      -- denormalised for display without an extra join
  benchmark_value_id uuid references benchmark_values(id),
  target_range_id uuid references benchmark_target_ranges(id),
  confidence_score numeric(5,2),
  not_comparable_reason text,
  explanation_token text,
  display_rank int not null default 0
);
create index idx_financial_twin_metric_results_run on financial_twin_metric_results(financial_twin_run_id);

create table financial_twin_insights (
  id uuid primary key default gen_random_uuid(),
  financial_twin_run_id uuid not null references financial_twin_runs(id) on delete cascade,
  insight_type text not null check (insight_type in ('strength', 'gap', 'opportunity', 'methodology_warning')),
  priority text check (priority in ('high', 'medium', 'low')),
  metric_code text,
  user_value numeric(18,4),
  peer_value numeric(18,4),
  target_value numeric(18,4),
  related_module text,
  action_code text,
  status text not null default 'active',
  title text not null,
  explanation text not null,
  display_rank int not null default 0,
  created_at timestamptz default now()
);
create index idx_financial_twin_insights_run on financial_twin_insights(financial_twin_run_id);

-- ---------------------------------------------------------------------------
-- E. Platform Peer Benchmark cohorts (spec section 18) — schema only. With
-- only a handful of users on this platform, PlatformCohortAggregationService
-- will always find every cohort below the minimum-sample-size threshold and
-- report "insufficient sample", never exposing platform-derived values. The
-- table exists so the pipeline and privacy suppression logic are real and
-- testable now, ready to activate once the user base is large enough.
-- ---------------------------------------------------------------------------
create table platform_cohort_aggregates (
  id uuid primary key default gen_random_uuid(),
  cohort_key text not null,
  metric_code text not null,
  statistic_type text not null,
  sample_size int not null,
  value_numeric numeric(18,4),
  min_sample_size_required int not null default 50,
  suppressed boolean not null default true,
  computed_at timestamptz default now(),
  unique (cohort_key, metric_code, statistic_type)
);

-- ---------------------------------------------------------------------------
-- F. Benchmark update / import audit trail
-- ---------------------------------------------------------------------------
create table benchmark_update_runs (
  id uuid primary key default gen_random_uuid(),
  source_id uuid references benchmark_sources(id),
  dataset_id uuid references benchmark_datasets(id),
  import_date timestamptz default now(),
  rows_imported int not null default 0,
  rows_rejected int not null default 0,
  validation_results jsonb,
  approval_status text not null default 'pending' check (approval_status in ('pending', 'approved', 'rejected')),
  previous_version text,
  new_version text,
  effective_date date,
  audit_user uuid references auth.users(id),
  created_at timestamptz default now()
);

-- ---------------------------------------------------------------------------
-- G. Reports (Module 9) integration — the financial_twin_id column existed
-- as a bare uuid with no FK since Module 8 didn't exist yet; wire it up now.
-- ---------------------------------------------------------------------------
alter table reports
  add constraint reports_financial_twin_id_fkey
  foreign key (financial_twin_id) references financial_twin_runs(id);

-- ---------------------------------------------------------------------------
-- H. RLS
-- ---------------------------------------------------------------------------
alter table financial_twin_runs enable row level security;
alter table financial_twin_metric_results enable row level security;
alter table financial_twin_insights enable row level security;

create policy "own twin runs" on financial_twin_runs
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own twin metric results" on financial_twin_metric_results
  for all using (exists (select 1 from financial_twin_runs r where r.id = financial_twin_run_id and r.user_id = auth.uid()))
  with check (exists (select 1 from financial_twin_runs r where r.id = financial_twin_run_id and r.user_id = auth.uid()));
create policy "own twin insights" on financial_twin_insights
  for all using (exists (select 1 from financial_twin_runs r where r.id = financial_twin_run_id and r.user_id = auth.uid()))
  with check (exists (select 1 from financial_twin_runs r where r.id = financial_twin_run_id and r.user_id = auth.uid()));

-- Reference/benchmark tables: world-readable (every user needs to read active
-- benchmarks to render their own Twin), write-only via the service-role
-- client from admin API routes (gated by requireAdmin(), not by RLS).
alter table benchmark_sources enable row level security;
alter table benchmark_datasets enable row level security;
alter table benchmark_metric_definitions enable row level security;
alter table benchmark_cohorts enable row level security;
alter table benchmark_values enable row level security;
alter table benchmark_target_ranges enable row level security;
alter table platform_cohort_aggregates enable row level security;
alter table benchmark_update_runs enable row level security;

create policy "read benchmark sources" on benchmark_sources for select using (true);
create policy "read benchmark datasets" on benchmark_datasets for select using (true);
create policy "read benchmark metric definitions" on benchmark_metric_definitions for select using (true);
create policy "read benchmark cohorts" on benchmark_cohorts for select using (true);
create policy "read benchmark values" on benchmark_values for select using (true);
create policy "read benchmark target ranges" on benchmark_target_ranges for select using (true);
create policy "read platform cohort aggregates" on platform_cohort_aggregates for select using (true);
-- benchmark_update_runs contains only import/governance audit metadata, not
-- user financial data, but is admin-only reading since it's not needed by
-- the end-user Twin UI at all. No select policy -> service-role only.
