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
