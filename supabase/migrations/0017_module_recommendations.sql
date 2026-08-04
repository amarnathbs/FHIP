-- Recommendations Engine (Module 10, Phase 8 of the Forecasting Engine
-- roadmap). A deterministic, rule-based matcher — never a black box: every
-- recommendation in the master library carries its own explicit conditions,
-- and every match a user sees is traceable back to the exact rows that fired
-- (spec: same explainability discipline as the calculators in
-- lib/engines/forecast/*Calculator.ts).
--
-- Reuses the admin-governance pattern already established for benchmark
-- data (Module 8's benchmark_sources/benchmark_datasets: draft -> active ->
-- retired lifecycle, admin_users + adminClient() service-role writes) rather
-- than inventing a new one.

-- ---------------------------------------------------------------------------
-- A. Recommendation library (admin-governed, no user_id)
-- ---------------------------------------------------------------------------
create table action_recommendation_master (
  id uuid primary key default gen_random_uuid(),
  recommendation_code text not null unique,
  title text not null,
  category text not null check (category in (
    'net_worth', 'retirement', 'goal', 'debt', 'investment', 'cross_border', 'resilience', 'cash_flow', 'general'
  )),
  description text not null,
  action_text text not null,
  impact_type text not null check (impact_type in ('qualitative', 'estimated_amount', 'estimated_months', 'estimated_percentage')),
  impact_formula_notes text,
  priority int not null default 0,
  is_premium boolean not null default false,
  status text not null default 'draft' check (status in ('draft', 'active', 'retired')),
  created_by uuid references auth.users(id),
  approved_by uuid references auth.users(id),
  approved_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index idx_action_recommendation_master_status on action_recommendation_master(status, category);

-- Conditions are AND'd across distinct condition_group values and OR'd
-- within the same group — a standard sum-of-products rule model, matching
-- the rule-based validation engine's discipline (lib/engines/dataQuality.ts)
-- of keeping every check explicit and independently testable rather than a
-- single opaque predicate.
create table action_recommendation_conditions (
  id uuid primary key default gen_random_uuid(),
  recommendation_id uuid not null references action_recommendation_master(id) on delete cascade,
  condition_group int not null default 1,
  field_path text not null,
  operator text not null check (operator in ('eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'not_in', 'is_null', 'is_not_null')),
  comparison_value jsonb,
  created_at timestamptz default now()
);

create index idx_action_recommendation_conditions_recommendation on action_recommendation_conditions(recommendation_id);

-- ---------------------------------------------------------------------------
-- B. Per-user evaluation history (own-row RLS, like forecast_runs)
-- ---------------------------------------------------------------------------
-- One row per evaluation. context_snapshot retains the exact field values the
-- matcher evaluated against, so admin gap-review (users/scenarios where
-- nothing matched) can diagnose *why* without re-deriving live data that may
-- have since changed.
create table user_recommendation_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  forecast_profile_id uuid not null references forecast_profiles(id) on delete cascade,
  scenario_id uuid not null references forecast_scenarios(id) on delete cascade,
  run_at timestamptz not null default now(),
  matched_count int not null default 0,
  context_snapshot jsonb not null,
  engine_version text not null default 'recommendations-1.0.0',
  created_at timestamptz default now()
);

create index idx_user_recommendation_runs_user on user_recommendation_runs(user_id, run_at desc);
create index idx_user_recommendation_runs_gap on user_recommendation_runs(matched_count) where matched_count = 0;

create table user_recommendation_matches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  run_id uuid not null references user_recommendation_runs(id) on delete cascade,
  recommendation_id uuid not null references action_recommendation_master(id) on delete cascade,
  evaluated_impact_text text,
  evaluated_impact_value numeric(18, 2),
  dismissed boolean not null default false,
  dismissed_at timestamptz,
  created_at timestamptz default now()
);

create index idx_user_recommendation_matches_run on user_recommendation_matches(run_id);
create index idx_user_recommendation_matches_user on user_recommendation_matches(user_id, dismissed);

-- ---------------------------------------------------------------------------
-- C. RLS
-- ---------------------------------------------------------------------------
alter table action_recommendation_master enable row level security;
alter table action_recommendation_conditions enable row level security;
alter table user_recommendation_runs enable row level security;
alter table user_recommendation_matches enable row level security;

-- Reference-data tables: every authenticated user can read (the matching
-- engine runs with the user's own session client), writes go through
-- adminClient() (service-role) after requireAdmin(), exactly like the
-- benchmark_sources/benchmark_datasets pattern.
create policy "read recommendation master" on action_recommendation_master for select using (true);
create policy "read recommendation conditions" on action_recommendation_conditions for select using (true);

create policy "own recommendation runs" on user_recommendation_runs
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own recommendation matches" on user_recommendation_matches
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- updated_at is set at the application layer on every admin write, matching
-- every other module's mutation routes in this project.
