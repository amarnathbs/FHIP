-- FHIP production bootstrap — PART 4 of 9
-- Forecasting engine foundation + seeds, recommendations schema (0013-0019).

-- === migrations/0013_module10_forecasting_foundation.sql ===
-- Module 10 (Forecasting Engine) — Phase 1: Foundation.
-- Forecast profile/scenario/assumption/run/result tables plus the
-- explainability framework. Reuses existing Income/Expense/Asset/
-- Liability/Investment/Goal/Retirement data and the canonical dashboard.ts
-- aggregation service as the starting position for every forecast — this
-- module never re-derives a financial total dashboard.ts already computes.

create table forecast_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null default 'My Forecast',
  base_currency char(3) not null references currencies(currency_code),
  country_code char(2) references countries(country_code),
  -- FK to forecast_scenarios added below via ALTER TABLE once that table
  -- exists (forecast_scenarios itself references forecast_profiles).
  default_scenario_id uuid,
  forecast_start_date date not null default current_date,
  forecast_end_date date,
  retirement_age int check (retirement_age > 0 and retirement_age < 120),
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index idx_forecast_profiles_user on forecast_profiles(user_id);

create table forecast_scenarios (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  forecast_profile_id uuid not null references forecast_profiles(id) on delete cascade,
  scenario_name text not null,
  scenario_type text not null check (scenario_type in ('base', 'conservative', 'optimistic', 'custom', 'stress')),
  description text,
  is_default boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index idx_forecast_scenarios_profile on forecast_scenarios(forecast_profile_id);
create index idx_forecast_scenarios_user on forecast_scenarios(user_id);

alter table forecast_profiles
  add constraint fk_forecast_profiles_default_scenario
  foreign key (default_scenario_id) references forecast_scenarios(id) on delete set null;

-- Assumption hierarchy (Section 6.4 of the spec): user-specific forecast
-- assumption -> user-specific product assumption -> scenario assumption ->
-- country default -> global default. This table stores every level except
-- "global default", which lives in forecast_global_assumptions (seeded,
-- admin-maintained, no user_id) so a user's forecast never has to carry a
-- full copy of platform-wide defaults.
create table forecast_assumptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  forecast_profile_id uuid not null references forecast_profiles(id) on delete cascade,
  scenario_id uuid references forecast_scenarios(id) on delete cascade,
  assumption_category text not null,
  assumption_key text not null,
  assumption_value numeric(18, 6) not null,
  value_type text not null default 'percentage' check (value_type in ('percentage', 'currency', 'number', 'ratio', 'years')),
  unit text,
  effective_from date not null default current_date,
  effective_to date,
  source_type text not null default 'user_override' check (source_type in ('user_override', 'scenario_default', 'country_default', 'global_default')),
  source_reference text,
  user_override boolean not null default true,
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index idx_forecast_assumptions_profile on forecast_assumptions(forecast_profile_id, assumption_key);
create index idx_forecast_assumptions_scenario on forecast_assumptions(scenario_id);
create index idx_forecast_assumptions_user on forecast_assumptions(user_id);

-- Platform-wide default assumptions (no user_id — administered separately,
-- read-only to regular users). Seeded with sensible AU/IN starting values;
-- users can override any of these per-profile via forecast_assumptions.
create table forecast_global_assumptions (
  id uuid primary key default gen_random_uuid(),
  country_code char(2) references countries(country_code),
  assumption_category text not null,
  assumption_key text not null,
  assumption_value numeric(18, 6) not null,
  value_type text not null default 'percentage' check (value_type in ('percentage', 'currency', 'number', 'ratio', 'years')),
  unit text,
  source_reference text,
  effective_from date not null default current_date,
  is_active boolean not null default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (country_code, assumption_key)
);

create table forecast_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  forecast_profile_id uuid not null references forecast_profiles(id) on delete cascade,
  scenario_id uuid not null references forecast_scenarios(id) on delete cascade,
  forecast_type text not null check (forecast_type in ('net_worth', 'retirement', 'goal', 'debt', 'investment', 'cross_border', 'resilience')),
  run_version int not null default 1,
  baseline_date date not null,
  calculation_date date not null default current_date,
  period_start date not null,
  period_end date not null,
  status text not null default 'pending' check (status in ('pending', 'running', 'completed', 'failed')),
  input_hash text,
  engine_version text not null default 'forecast-1.0.0',
  created_at timestamptz default now(),
  completed_at timestamptz,
  error_message text
);

create index idx_forecast_runs_profile on forecast_runs(forecast_profile_id, forecast_type);
create index idx_forecast_runs_scenario on forecast_runs(scenario_id);
create index idx_forecast_runs_user on forecast_runs(user_id);
create index idx_forecast_runs_input_hash on forecast_runs(input_hash);

create table forecast_results (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  forecast_run_id uuid not null references forecast_runs(id) on delete cascade,
  forecast_type text not null,
  entity_type text not null,
  entity_id uuid,
  period_date date not null,
  period_number int not null,
  opening_value numeric(18, 2) not null default 0,
  contributions numeric(18, 2) not null default 0,
  withdrawals numeric(18, 2) not null default 0,
  income numeric(18, 2) not null default 0,
  expenses numeric(18, 2) not null default 0,
  interest numeric(18, 2) not null default 0,
  investment_return numeric(18, 2) not null default 0,
  fees numeric(18, 2) not null default 0,
  fx_gain_loss numeric(18, 2) not null default 0,
  other_movement numeric(18, 2) not null default 0,
  closing_value numeric(18, 2) not null default 0,
  target_value numeric(18, 2),
  variance_value numeric(18, 2),
  variance_percentage numeric(9, 4),
  currency char(3) not null,
  base_currency_value numeric(18, 2),
  metadata jsonb,
  created_at timestamptz default now()
);

create index idx_forecast_results_run on forecast_results(forecast_run_id, period_date);
create index idx_forecast_results_entity on forecast_results(entity_type, entity_id);
create index idx_forecast_results_user on forecast_results(user_id);

create table forecast_explanations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  forecast_run_id uuid not null references forecast_runs(id) on delete cascade,
  entity_type text not null,
  entity_id uuid,
  explanation_type text not null,
  title text not null,
  explanation_text text not null,
  calculation_inputs jsonb,
  calculation_formula text,
  priority int not null default 0,
  created_at timestamptz default now()
);

create index idx_forecast_explanations_run on forecast_explanations(forecast_run_id);
create index idx_forecast_explanations_user on forecast_explanations(user_id);

alter table forecast_profiles enable row level security;
alter table forecast_scenarios enable row level security;
alter table forecast_assumptions enable row level security;
alter table forecast_runs enable row level security;
alter table forecast_results enable row level security;
alter table forecast_explanations enable row level security;
alter table forecast_global_assumptions enable row level security;

create policy "own forecast profiles" on forecast_profiles
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own forecast scenarios" on forecast_scenarios
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own forecast assumptions" on forecast_assumptions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own forecast runs" on forecast_runs
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own forecast results" on forecast_results
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own forecast explanations" on forecast_explanations
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "read forecast global assumptions" on forecast_global_assumptions
  for select using (true);

-- updated_at is set at the application layer on every write (matching the
-- pattern used by every other module's PUT/PATCH routes in this project —
-- see e.g. app/api/household/route.ts, app/api/user/profile/route.ts —
-- rather than a DB trigger, so there is nothing further to do here.

-- === migrations/0014_module10_forecasting_seed.sql ===
-- Module 10 (Forecasting Engine) — seed data for forecast_global_assumptions.
-- Starting defaults only, administered/updatable later via an admin page
-- (not built in Phase 1). Values are broad, defensible planning
-- assumptions, not statutory rates — per the spec, nothing here is
-- hardcoded into application code, only referenced by key at read time.

insert into forecast_global_assumptions (country_code, assumption_category, assumption_key, assumption_value, value_type, unit, source_reference) values
  -- General inflation and growth assumptions — Australia
  ('AU', 'general', 'general_inflation', 2.5, 'percentage', 'per_annum', 'RBA inflation target band midpoint'),
  ('AU', 'general', 'education_inflation', 4.0, 'percentage', 'per_annum', 'Historical education cost growth, indicative'),
  ('AU', 'general', 'healthcare_inflation', 4.5, 'percentage', 'per_annum', 'Historical healthcare cost growth, indicative'),
  ('AU', 'general', 'property_growth', 4.0, 'percentage', 'per_annum', 'Long-run indicative residential property growth'),
  ('AU', 'general', 'salary_growth', 3.0, 'percentage', 'per_annum', 'Long-run indicative wage growth'),
  ('AU', 'general', 'rental_income_growth', 3.0, 'percentage', 'per_annum', 'Indicative, tracks general inflation'),
  ('AU', 'general', 'general_expense_growth', 2.5, 'percentage', 'per_annum', 'Tracks general inflation assumption'),
  ('AU', 'general', 'savings_rate_assumption', 15.0, 'percentage', 'of_net_income', 'Indicative planning reference, not a target'),
  ('AU', 'general', 'investment_contribution_growth', 2.5, 'percentage', 'per_annum', 'Tracks salary growth assumption'),
  ('AU', 'general', 'retirement_contribution_growth', 2.5, 'percentage', 'per_annum', 'Tracks salary growth assumption'),
  ('AU', 'general', 'emergency_fund_target_months', 6.0, 'number', 'months', 'FHIP planning reference'),
  ('AU', 'general', 'retirement_age', 67, 'number', 'years', 'Australian Age Pension qualifying age reference'),
  ('AU', 'general', 'life_expectancy', 87, 'number', 'years', 'ABS indicative life expectancy reference'),
  ('AU', 'general', 'withdrawal_rate', 4.0, 'percentage', 'per_annum', 'Common indicative safe-withdrawal-rate reference'),
  -- Investment return assumptions by asset class — Australia
  ('AU', 'investment_return', 'cash', 3.5, 'percentage', 'per_annum', 'Indicative cash/term-deposit return'),
  ('AU', 'investment_return', 'fixed_interest', 4.0, 'percentage', 'per_annum', 'Indicative bond/fixed-interest return'),
  ('AU', 'investment_return', 'equity', 7.5, 'percentage', 'per_annum', 'Indicative long-run equity return'),
  ('AU', 'investment_return', 'property', 5.0, 'percentage', 'per_annum', 'Indicative long-run property total return'),
  ('AU', 'investment_return', 'superannuation', 6.5, 'percentage', 'per_annum', 'Indicative balanced-option long-run return'),
  ('AU', 'investment_return', 'other_asset', 5.0, 'percentage', 'per_annum', 'Generic fallback for unclassified asset types'),

  -- General inflation and growth assumptions — India
  ('IN', 'general', 'general_inflation', 5.0, 'percentage', 'per_annum', 'RBI inflation target band midpoint'),
  ('IN', 'general', 'education_inflation', 8.0, 'percentage', 'per_annum', 'Historical India education cost growth, indicative'),
  ('IN', 'general', 'healthcare_inflation', 8.0, 'percentage', 'per_annum', 'Historical India healthcare cost growth, indicative'),
  ('IN', 'general', 'property_growth', 6.0, 'percentage', 'per_annum', 'Long-run indicative Indian residential property growth'),
  ('IN', 'general', 'salary_growth', 7.0, 'percentage', 'per_annum', 'Long-run indicative Indian wage growth'),
  ('IN', 'general', 'rental_income_growth', 5.0, 'percentage', 'per_annum', 'Indicative, tracks general inflation'),
  ('IN', 'general', 'general_expense_growth', 5.0, 'percentage', 'per_annum', 'Tracks general inflation assumption'),
  ('IN', 'general', 'savings_rate_assumption', 20.0, 'percentage', 'of_net_income', 'Indicative planning reference, not a target'),
  ('IN', 'general', 'investment_contribution_growth', 5.0, 'percentage', 'per_annum', 'Tracks salary growth assumption'),
  ('IN', 'general', 'retirement_contribution_growth', 5.0, 'percentage', 'per_annum', 'Tracks salary growth assumption'),
  ('IN', 'general', 'emergency_fund_target_months', 6.0, 'number', 'months', 'FHIP planning reference'),
  ('IN', 'general', 'retirement_age', 60, 'number', 'years', 'Common Indian retirement age reference'),
  ('IN', 'general', 'life_expectancy', 75, 'number', 'years', 'Indicative Indian life expectancy reference'),
  ('IN', 'general', 'withdrawal_rate', 4.0, 'percentage', 'per_annum', 'Common indicative safe-withdrawal-rate reference'),
  -- Investment return assumptions by asset class — India
  ('IN', 'investment_return', 'cash', 6.5, 'percentage', 'per_annum', 'Indicative FD/savings return'),
  ('IN', 'investment_return', 'fixed_interest', 7.0, 'percentage', 'per_annum', 'Indicative bond/debt-fund return'),
  ('IN', 'investment_return', 'equity', 11.0, 'percentage', 'per_annum', 'Indicative long-run Indian equity return'),
  ('IN', 'investment_return', 'property', 7.0, 'percentage', 'per_annum', 'Indicative long-run Indian property total return'),
  ('IN', 'investment_return', 'retirement', 8.0, 'percentage', 'per_annum', 'Indicative EPF/PPF/NPS blended long-run return'),
  ('IN', 'investment_return', 'other_asset', 6.0, 'percentage', 'per_annum', 'Generic fallback for unclassified asset types'),

  -- Country-neutral defaults (used when country_code is null / unmatched)
  (null, 'general', 'general_inflation', 3.0, 'percentage', 'per_annum', 'Global fallback default'),
  (null, 'general', 'emergency_fund_target_months', 6.0, 'number', 'months', 'FHIP planning reference'),
  (null, 'general', 'withdrawal_rate', 4.0, 'percentage', 'per_annum', 'Common indicative safe-withdrawal-rate reference'),
  (null, 'investment_return', 'other_asset', 5.0, 'percentage', 'per_annum', 'Global fallback default')
on conflict (country_code, assumption_key) do nothing;

-- === migrations/0015_module10_forecasting_seed_fix.sql ===
-- Fixes an inconsistency in 0014's seed data: the AU investment_return row
-- for retirement/superannuation returns was keyed 'superannuation' while the
-- IN row for the equivalent concept was keyed 'retirement'. The net worth
-- calculator (lib/engines/forecast/netWorthCalculator.ts) looks up the
-- single key 'retirement' for both countries, so the AU row was silently
-- never matched. Rename to align both countries on 'retirement'.
update forecast_global_assumptions
set assumption_key = 'retirement'
where country_code = 'AU' and assumption_key = 'superannuation';

-- === migrations/0016_module10_forecasting_fx_seed.sql ===
-- Phase 6 — Cross-Border Forecasting (spec section 12). Seeds the FX
-- assumptions the cross-border calculator needs. Convention (must match
-- lib/engines/forecast/crossBorderCalculator.ts and be displayed to the
-- user per spec 12.4's "the exact convention must be stored and displayed
-- to prevent calculation errors"):
--   fx_rate_aud_inr = number of INR per 1 AUD.
--   AUD value = INR value / fx_rate_aud_inr
--   INR value = AUD value * fx_rate_aud_inr
-- fx_drift_aud_inr is the assumed annual % change in that rate going
-- forward (positive = INR weakens further against AUD, i.e. more INR per
-- AUD over time). Default 0 = spec 12.6's "Constant exchange rate"
-- scenario; users can override it via the Assumptions page like any other
-- assumption to model appreciation/depreciation scenarios.
insert into forecast_global_assumptions (country_code, assumption_category, assumption_key, assumption_value, value_type, unit, source_reference) values
  (null, 'fx', 'fx_rate_aud_inr', 56.0, 'ratio', 'INR_per_AUD', 'Indicative starting rate, editable — not a live market feed'),
  (null, 'fx', 'fx_drift_aud_inr', 0.0, 'percentage', 'per_annum', 'Constant-rate scenario by default (spec 12.6); user-adjustable for appreciation/depreciation scenarios')
on conflict (country_code, assumption_key) do nothing;

-- === migrations/0017_module_recommendations.sql ===
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

-- === migrations/0018_recommendations_seed.sql ===
-- Starter recommendation library (~19 rows across all 9 categories). Written
-- generically enough to apply across scenarios; the user will review and can
-- add/edit further entries via the admin UI (task #152) as real-world
-- parameter combinations surface additional cases. All conditions reference
-- the flat evaluation context built by lib/services/recommendationsData.ts's
-- buildEvaluationContext() — see lib/engines/recommendations/matcher.ts for
-- the AND-across-groups/OR-within-group evaluation rule.

insert into action_recommendation_master
  (recommendation_code, title, category, description, action_text, impact_type, impact_formula_notes, priority, is_premium, status)
values
  ('debt_high_credit_utilization', 'High credit card utilisation', 'debt',
   'Your credit card balance is a large share of your available credit limit, which typically carries a high interest rate and can affect credit scoring.',
   'Prioritise paying down credit card balances before other discretionary spending, and consider consolidating to a lower-rate facility if utilisation stays high.',
   'qualitative', null, 80, false, 'active'),

  ('debt_off_track_variance', 'Debt repayment falling behind plan', 'debt',
   'Your actual outstanding debt balance is behind what your forecast expected by this point.',
   'Review your repayment schedule and consider directing any spare surplus toward the debt with the highest interest rate first.',
   'qualitative', null, 70, false, 'active'),

  ('debt_extra_repayment_opportunity', 'Spare surplus available to accelerate debt payoff', 'debt',
   'You have outstanding debt and a positive disposable income each month that is not committed elsewhere.',
   'Consider directing part of your disposable income toward additional debt repayments to reduce total interest paid and shorten the payoff timeline.',
   'estimated_amount', 'You currently have {{dashboard.disposableIncome}} in disposable income each month after essential expenses and debt repayments.', 60, false, 'active'),

  ('retirement_material_gap', 'Retirement funding gap', 'retirement',
   'Your projected retirement balance is tracking below the corpus required to fund your stated retirement income target.',
   'Consider increasing your regular retirement contribution, reviewing your target retirement age, or adjusting your desired retirement income.',
   'estimated_amount', '{{retirement.fundingGap}} is the current projected gap between your required retirement corpus and your projected balance at retirement.', 90, false, 'active'),

  ('retirement_depletion_risk', 'Retirement savings projected to deplete', 'retirement',
   'At the current withdrawal rate and contribution settings, your retirement balance is projected to run out before the end of the forecast horizon.',
   'Consider a lower withdrawal rate, a later retirement age, or a higher contribution rate to extend how long your retirement savings last.',
   'estimated_months', '{{retirement.depletionMonth}} is the forecast month at which your retirement balance is projected to reach zero.', 95, false, 'active'),

  ('resilience_low_emergency_fund', 'Emergency fund below the planning reference', 'resilience',
   'Your liquid reserves currently cover fewer months of essential expenses than the standard 6-month planning reference.',
   'Consider directing part of your monthly surplus into a liquid cash or high-interest savings account until you reach a 6-month buffer.',
   'estimated_months', '{{dashboard.emergencyFundMonths}} months of essential expenses are currently covered by your liquid reserves.', 85, false, 'active'),

  ('resilience_depletion_during_shock', 'Limited resilience to an income or expense shock', 'resilience',
   'Under a modelled stress scenario (income loss, unexpected expense, or similar), your liquid reserves are projected to be depleted before recovery.',
   'Building a larger liquid buffer, or reviewing insurance cover for the specific risk modelled, would improve resilience to this kind of shock.',
   'estimated_months', 'Liquid reserves are projected to deplete by month {{resilience.depletionMonth}} of the modelled stress scenario.', 75, false, 'active'),

  ('resilience_no_insurance_recorded', 'No insurance cover recorded', 'resilience',
   'No insurance policies are recorded for your household, which leaves income, health, or asset risks unmitigated in a shock scenario.',
   'Review your insurance needs (income protection, health, home and contents, life) and record any existing cover, or consider taking out cover for material gaps.',
   'qualitative', null, 50, false, 'active'),

  ('cash_flow_negative_surplus', 'Monthly expenses exceed income', 'cash_flow',
   'Your recorded monthly expenses and debt repayments currently exceed your income, producing a negative monthly surplus.',
   'Review discretionary expenses for reductions, and check whether any income sources are missing or under-recorded.',
   'estimated_amount', 'Your current monthly surplus is {{dashboard.monthlySurplus}}.', 100, false, 'active'),

  ('cash_flow_low_savings_rate', 'Savings rate below 10% of income', 'cash_flow',
   'Less than 10% of your net income is currently being retained as surplus each month.',
   'Look for opportunities to increase your savings rate toward a 20% target, either by reducing lifestyle spending or increasing income.',
   'qualitative', null, 55, false, 'active'),

  ('cash_flow_high_discretionary', 'High discretionary spending share', 'cash_flow',
   'More than half of your income is going toward lifestyle (non-essential) spending.',
   'Review your lifestyle expense categories for the largest discretionary items and consider reallocating some toward savings or debt repayment.',
   'qualitative', null, 45, false, 'active'),

  ('net_worth_off_track', 'Net worth tracking below forecast', 'net_worth',
   'Your actual net worth is behind what your forecast expected by the comparison date.',
   'Review the Consolidated Variance section for which category (assets, investments, debt) is driving the gap, and address that category directly.',
   'qualitative', null, 65, false, 'active'),

  ('net_worth_low_liquidity', 'Very low share of liquid assets', 'net_worth',
   'Only a small share of your total assets are held in liquid form (cash or equivalents), which can limit flexibility in a shock.',
   'Consider whether some less-liquid holdings could be rebalanced toward cash or liquid investments to improve flexibility.',
   'qualitative', null, 40, false, 'active'),

  ('net_worth_property_concentration', 'High concentration in property', 'net_worth',
   'A large majority of your assets are concentrated in property, which can increase exposure to a single asset class.',
   'Consider whether diversifying future contributions into other asset classes (equities, fixed interest) would reduce concentration risk over time.',
   'qualitative', null, 35, false, 'active'),

  ('goal_off_track', 'One or more goals behind schedule', 'goal',
   'Your recorded goal progress is behind what your forecast expected by the comparison date.',
   'Review the Goal Forecasts section for the specific goal(s) affected and consider increasing contributions or adjusting the target date.',
   'qualitative', null, 60, false, 'active'),

  ('investment_start_investing_surplus', 'Surplus available but no investments recorded', 'investment',
   'You have a positive monthly surplus but no investment holdings currently recorded.',
   'Consider directing part of your monthly surplus into a diversified investment (e.g. a low-cost index fund) rather than leaving it uninvested.',
   'estimated_amount', 'You currently have {{dashboard.monthlySurplus}} in monthly surplus that is not directed to any recorded investment.', 55, false, 'active'),

  ('cross_border_fx_exposure', 'Assets held across multiple countries', 'cross_border',
   'You hold recorded assets, investments or liabilities in more than one country, which introduces currency exchange rate exposure.',
   'Review the Cross-Border Forecast section to understand how currency movements affect your consolidated net worth, and consider whether any FX hedging or diversification is appropriate.',
   'qualitative', null, 40, false, 'active'),

  ('general_income_concentration', 'Income concentrated in a single source', 'general',
   'A large majority of your income currently comes from a single employer or income source.',
   'Consider whether diversifying income sources (a second income stream, passive income) would reduce reliance on a single source.',
   'qualitative', null, 30, false, 'active')
on conflict (recommendation_code) do nothing;

-- Conditions: groups are AND'd, rows within the same group are OR'd.
insert into action_recommendation_conditions (recommendation_id, condition_group, field_path, operator, comparison_value)
select id, 1, 'dashboard.creditUtilization', 'gt', '0.3'::jsonb from action_recommendation_master where recommendation_code = 'debt_high_credit_utilization'
union all
select id, 1, 'variance.debt.status', 'in', '["at_risk", "significantly_off_track", "slightly_behind"]'::jsonb from action_recommendation_master where recommendation_code = 'debt_off_track_variance'
union all
select id, 1, 'dashboard.totalLiabilities', 'gt', '0'::jsonb from action_recommendation_master where recommendation_code = 'debt_extra_repayment_opportunity'
union all
select id, 2, 'dashboard.disposableIncome', 'gt', '0'::jsonb from action_recommendation_master where recommendation_code = 'debt_extra_repayment_opportunity'
union all
select id, 1, 'retirement.readinessPct', 'lt', '75'::jsonb from action_recommendation_master where recommendation_code = 'retirement_material_gap'
union all
select id, 1, 'retirement.depletionMonth', 'is_not_null', null from action_recommendation_master where recommendation_code = 'retirement_depletion_risk'
union all
select id, 1, 'dashboard.emergencyFundMonths', 'lt', '3'::jsonb from action_recommendation_master where recommendation_code = 'resilience_low_emergency_fund'
union all
select id, 1, 'resilience.depletionMonth', 'is_not_null', null from action_recommendation_master where recommendation_code = 'resilience_depletion_during_shock'
union all
select id, 1, 'dashboard.hasInsurance', 'eq', 'false'::jsonb from action_recommendation_master where recommendation_code = 'resilience_no_insurance_recorded'
union all
select id, 1, 'dashboard.monthlySurplus', 'lt', '0'::jsonb from action_recommendation_master where recommendation_code = 'cash_flow_negative_surplus'
union all
select id, 1, 'dashboard.savingsRate', 'lt', '0.1'::jsonb from action_recommendation_master where recommendation_code = 'cash_flow_low_savings_rate'
union all
select id, 1, 'dashboard.discretionaryRatio', 'gt', '0.5'::jsonb from action_recommendation_master where recommendation_code = 'cash_flow_high_discretionary'
union all
select id, 1, 'variance.net_worth.status', 'in', '["at_risk", "significantly_off_track"]'::jsonb from action_recommendation_master where recommendation_code = 'net_worth_off_track'
union all
select id, 1, 'dashboard.liquidAssetRatio', 'lt', '0.05'::jsonb from action_recommendation_master where recommendation_code = 'net_worth_low_liquidity'
union all
select id, 2, 'dashboard.totalAssets', 'gt', '0'::jsonb from action_recommendation_master where recommendation_code = 'net_worth_low_liquidity'
union all
select id, 1, 'dashboard.propertyConcentration', 'gt', '0.7'::jsonb from action_recommendation_master where recommendation_code = 'net_worth_property_concentration'
union all
select id, 1, 'variance.goal.status', 'in', '["at_risk", "significantly_off_track", "slightly_behind"]'::jsonb from action_recommendation_master where recommendation_code = 'goal_off_track'
union all
select id, 1, 'dashboard.hasInvestments', 'eq', 'false'::jsonb from action_recommendation_master where recommendation_code = 'investment_start_investing_surplus'
union all
select id, 2, 'dashboard.monthlySurplus', 'gt', '0'::jsonb from action_recommendation_master where recommendation_code = 'investment_start_investing_surplus'
union all
select id, 1, 'dashboard.countriesInUseCount', 'gt', '1'::jsonb from action_recommendation_master where recommendation_code = 'cross_border_fx_exposure'
union all
select id, 1, 'dashboard.employerConcentration', 'gt', '0.7'::jsonb from action_recommendation_master where recommendation_code = 'general_income_concentration';

-- === migrations/0019_recommendations_schema_v2.sql ===
-- Recommendations Engine schema v2 — supersedes the starter schema in
-- 0017/0018. The user supplied a complete, production-scale recommendation
-- library (542 master rows / 2143 conditions / 88 calculation methods / 120
-- template placeholders) with its own richer column set; this migration
-- adopts that schema directly rather than forcing their data into the
-- narrower starter shape.
--
-- Nothing user-facing depends on the 19 starter rows yet (the feature just
-- shipped), so action_recommendation_master/action_recommendation_conditions
-- are dropped and recreated rather than altered. user_recommendation_runs/
-- matches keep their shape but are truncated (their recommendation_id values
-- point at rows that no longer exist once master is recreated).

truncate table user_recommendation_matches, user_recommendation_runs;

drop table if exists action_recommendation_conditions cascade;
drop table if exists action_recommendation_master cascade;

create table action_recommendation_master (
  id uuid primary key default gen_random_uuid(),
  recommendation_code text not null unique,
  forecast_category text not null check (forecast_category in (
    'net_worth', 'retirement', 'goal', 'debt', 'investment_growth', 'cross_border', 'resilience', 'data_quality'
  )),
  sub_category text not null,
  scenario_name text not null,
  scenario_description text,
  variance_result text check (variance_result in ('favourable', 'unfavourable', 'neutral')),
  forecast_status text not null check (forecast_status in (
    'ahead_of_plan', 'on_track', 'slightly_behind', 'at_risk', 'significantly_off_track', 'review_required'
  )),
  severity text not null check (severity in ('low', 'medium', 'high', 'critical')),
  action_type text not null,
  action_title_template text not null,
  action_content_template text not null,
  financial_impact_template text,
  calculation_method_code text,
  required_input_fields text[] not null default '{}',
  supported_placeholders text[] not null default '{}',
  priority_score int not null default 0,
  country_code char(2) references countries(country_code),
  currency_code char(3) references currencies(currency_code),
  customer_segment text not null default 'base',
  effective_from date not null default current_date,
  effective_to date,
  is_active boolean not null default true,
  requires_ai boolean not null default false,
  -- Not part of the user-supplied library data (every imported row has
  -- requires_ai=false) — this is FHIP's own Free/Premium gating flag,
  -- defaulted false on import, settable per-row by an admin afterward.
  is_premium boolean not null default false,
  version_number int not null default 1,
  admin_notes text,
  -- Per user decision: forecasting-performance recommendations are shown in
  -- the Recommendations page; data_quality rows are reserved for the
  -- Monthly/Initial Report's data-quality section instead, not this engine's
  -- output — same master list, tagged for where each row is consumed.
  include_in_forecasting boolean not null default true,
  include_in_monthly_report boolean not null default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index idx_action_recommendation_master_lookup on action_recommendation_master(forecast_category, sub_category, forecast_status, is_active);
create index idx_action_recommendation_master_context on action_recommendation_master(include_in_forecasting, include_in_monthly_report);

create table action_recommendation_conditions (
  id uuid primary key default gen_random_uuid(),
  recommendation_code text not null references action_recommendation_master(recommendation_code) on delete cascade,
  condition_group int not null default 1,
  field_name text not null,
  operator text not null default 'equals',
  comparison_value text,
  comparison_value_2 text,
  data_type text not null default 'text',
  logical_operator text not null default 'AND',
  evaluation_order int not null default 1,
  is_active boolean not null default true,
  created_at timestamptz default now()
);

create index idx_action_recommendation_conditions_code on action_recommendation_conditions(recommendation_code);

create table recommendation_calculation_methods (
  id uuid primary key default gen_random_uuid(),
  calculation_method_code text not null unique,
  method_name text not null,
  forecast_categories text[] not null default '{}',
  description text,
  calculation_service text,
  required_inputs text[] not null default '{}',
  outputs text[] not null default '{}',
  rounding_method text,
  supported_scenarios text[] not null default '{}',
  is_active boolean not null default true,
  version_number int not null default 1,
  admin_notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table recommendation_template_placeholders (
  id uuid primary key default gen_random_uuid(),
  placeholder text not null unique,
  data_type text not null,
  description text,
  source text,
  availability text,
  display_format text,
  is_active boolean not null default true,
  validation_note text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table action_recommendation_master enable row level security;
alter table action_recommendation_conditions enable row level security;
alter table recommendation_calculation_methods enable row level security;
alter table recommendation_template_placeholders enable row level security;

create policy "read recommendation master" on action_recommendation_master for select using (true);
create policy "read recommendation conditions" on action_recommendation_conditions for select using (true);
create policy "read recommendation calculation methods" on recommendation_calculation_methods for select using (true);
create policy "read recommendation template placeholders" on recommendation_template_placeholders for select using (true);

-- Re-attach the FK from the (truncated, otherwise-unchanged) match table to
-- the recreated master table.
alter table user_recommendation_matches
  add constraint user_recommendation_matches_recommendation_id_fkey
  foreign key (recommendation_id) references action_recommendation_master(id) on delete cascade;
