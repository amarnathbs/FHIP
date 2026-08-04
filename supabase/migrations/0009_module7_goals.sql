-- Module 7: Goal Planning™ — expanded multi-goal household planning with
-- deterministic, category-specific forecasting.
-- Reuses/extends the Module 1 `user_goals` table (in place, not renamed) to
-- avoid disrupting onboarding's existing simple goal-creation call and the
-- Module 3 dashboard's existing GoalRow read path.

-- ---------------------------------------------------------------------------
-- Household members — real entity so goals can reference an owner/beneficiary
-- by ID rather than an ownership-category enum.
-- ---------------------------------------------------------------------------
create table household_members (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  household_id uuid references households(id) on delete cascade,
  full_name text not null,
  relationship text not null
    check (relationship in ('self', 'spouse', 'partner', 'child', 'parent', 'other_dependant', 'other')),
  date_of_birth date,
  is_active boolean not null default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index idx_household_members_user on household_members(user_id);

alter table household_members enable row level security;
create policy "own household members" on household_members
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- Goal types — configuration-driven catalogue, extensible without a code
-- change (mirrors master_financial_items). forecast_logic_key selects which
-- of the 8 category-specific calculators in lib/engines/goalForecast.ts runs.
-- ---------------------------------------------------------------------------
create table goal_types (
  id uuid primary key default gen_random_uuid(),
  type_key text not null unique,
  category text not null,          -- foundation|debt|property|investment|retirement|family_education|lifestyle|health|custom
  type_label text not null,
  forecast_logic_key text not null, -- emergency_fund|home_deposit|debt_payoff|retirement|education|cross_border|major_purchase|business|generic
  default_priority int not null default 3 check (default_priority between 1 and 5),
  default_importance_type text not null default 'important' check (default_importance_type in ('essential', 'important', 'aspirational')),
  default_inflation_category text not null default 'general',
  suggested_horizon_years numeric,
  country_applicability char(2)[],  -- null = all supported countries
  sort_order int not null default 0,
  is_active boolean not null default true
);
create index idx_goal_types_category on goal_types(category, sort_order);

alter table goal_types enable row level security;
create policy "read goal types" on goal_types for select using (true);

-- ---------------------------------------------------------------------------
-- Admin-configurable weights/thresholds/assumptions. Same config-in-DB
-- pattern as health_score_config / resilience_config: one active row, edited
-- later via Module 12 rather than a code change.
-- ---------------------------------------------------------------------------
create table goal_planning_config (
  id uuid primary key default gen_random_uuid(),
  model_version text not null unique,
  config jsonb not null,
  is_active boolean not null default false,
  created_at timestamptz default now()
);
create unique index idx_goal_planning_config_one_active on goal_planning_config (is_active) where is_active;

alter table goal_planning_config enable row level security;
create policy "read goal planning config" on goal_planning_config for select using (true);

-- ---------------------------------------------------------------------------
-- Expand the existing user_goals table in place.
-- ---------------------------------------------------------------------------
alter table user_goals
  add column household_id uuid references households(id),
  add column owner_member_id uuid references household_members(id),
  add column beneficiary_member_id uuid references household_members(id),
  add column goal_category text,
  add column description text,
  add column country_code char(2) references countries(country_code),
  add column target_amount_basis text not null default 'today_value' check (target_amount_basis in ('today_value', 'future_value')),
  add column minimum_target_amount numeric(18,2) check (minimum_target_amount >= 0),
  add column stretch_target_amount numeric(18,2) check (stretch_target_amount >= 0),
  add column current_amount_date date,
  add column target_date_flexibility text not null default 'fixed' check (target_date_flexibility in ('fixed', 'flexible', 'indicative')),
  add column planned_contribution_amount numeric(18,2) not null default 0 check (planned_contribution_amount >= 0),
  add column contribution_frequency text not null default 'monthly',
  add column contribution_start_date date,
  add column annual_contribution_growth_pct numeric(6,3) not null default 0,
  add column user_priority int not null default 3 check (user_priority between 1 and 5),
  add column importance_type text not null default 'important' check (importance_type in ('essential', 'important', 'aspirational')),
  add column inflation_adjusted boolean not null default true,
  add column inflation_category text not null default 'general',
  add column review_frequency text not null default 'quarterly',
  add column next_review_date date,
  add column linked_liability_id uuid references liabilities(id),
  add column reason_for_status_change text,
  add column notes text,
  add column paused_at timestamptz,
  add column achieved_at timestamptz,
  add column cancelled_at timestamptz,
  add column archived_at timestamptz,
  add constraint chk_user_goals_status check (
    status in ('draft', 'active', 'paused', 'on_hold', 'achieved', 'partially_achieved', 'missed', 'cancelled', 'archived')
  );

create index idx_user_goals_status on user_goals(user_id, status);

-- ---------------------------------------------------------------------------
-- Funding sources — one goal can draw from several sources; the same
-- underlying asset/investment balance can be split across goals via
-- allocation_percentage, preventing double counting.
-- ---------------------------------------------------------------------------
create table goal_funding_sources (
  id uuid primary key default gen_random_uuid(),
  goal_id uuid not null references user_goals(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  source_type text not null check (source_type in ('asset', 'investment', 'retirement', 'cash', 'manual', 'expected')),
  linked_asset_id uuid references assets(id),
  linked_investment_id uuid references investments(id),
  linked_retirement_id uuid references retirement_accounts(id),
  allocated_amount numeric(18,2) not null default 0 check (allocated_amount >= 0),
  allocation_percentage numeric(5,2) check (allocation_percentage >= 0 and allocation_percentage <= 100),
  currency_code char(3) references currencies(currency_code),
  availability_date date,
  restricted_flag boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index idx_goal_funding_sources_goal on goal_funding_sources(goal_id);
create index idx_goal_funding_sources_asset on goal_funding_sources(linked_asset_id) where linked_asset_id is not null;
create index idx_goal_funding_sources_investment on goal_funding_sources(linked_investment_id) where linked_investment_id is not null;

-- ---------------------------------------------------------------------------
-- Contributions — actual/planned events, distinct from the goal's own
-- planned_contribution_amount (the current standing plan). Never overwritten;
-- reversals are new rows referencing the original.
-- ---------------------------------------------------------------------------
create table goal_contributions (
  id uuid primary key default gen_random_uuid(),
  goal_id uuid not null references user_goals(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  contribution_date date not null,
  amount numeric(18,2) not null,
  currency_code char(3) not null references currencies(currency_code),
  reporting_amount numeric(18,2),
  contribution_type text not null default 'regular'
    check (contribution_type in ('regular', 'one_off', 'bonus', 'tax_refund', 'family', 'asset_sale', 'transfer', 'withdrawal', 'adjustment')),
  contribution_status text not null default 'confirmed' check (contribution_status in ('planned', 'confirmed', 'reversed')),
  funding_source_id uuid references goal_funding_sources(id),
  reversal_of_id uuid references goal_contributions(id),
  notes text,
  created_at timestamptz default now()
);
create index idx_goal_contributions_goal on goal_contributions(goal_id, contribution_date);

-- ---------------------------------------------------------------------------
-- Milestones
-- ---------------------------------------------------------------------------
create table goal_milestones (
  id uuid primary key default gen_random_uuid(),
  goal_id uuid not null references user_goals(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  milestone_name text not null,
  target_amount numeric(18,2) not null check (target_amount >= 0),
  target_date date,
  display_order int not null default 0,
  status text not null default 'pending' check (status in ('pending', 'achieved', 'missed')),
  achieved_at timestamptz,
  notes text,
  created_at timestamptz default now()
);
create index idx_goal_milestones_goal on goal_milestones(goal_id, display_order);

-- ---------------------------------------------------------------------------
-- Forecasts — every calculation run is a new immutable row (never updated),
-- so historical forecasts are never silently overwritten when assumptions
-- change. The service layer reads "latest per goal + scenario" for display.
-- ---------------------------------------------------------------------------
create table goal_forecasts (
  id uuid primary key default gen_random_uuid(),
  goal_id uuid not null references user_goals(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  scenario_code text not null check (scenario_code in ('conservative', 'base', 'optimistic')),
  target_amount_original numeric(18,2) not null,
  target_amount_future numeric(18,2) not null,
  current_amount numeric(18,2) not null,
  projected_target_date_value numeric(18,2),
  projected_completion_date date,
  required_monthly_contribution numeric(18,2),
  current_monthly_contribution numeric(18,2) not null default 0,
  funding_gap_at_target_date numeric(18,2),
  progress_pct numeric(6,2),
  forecast_funding_pct numeric(6,2),
  track_status text not null,
  confidence_score numeric(5,2) not null,
  currency_code char(3) not null,
  reporting_currency_code char(3) not null,
  assumption_set_id text not null,
  model_version text not null,
  input_snapshot jsonb,
  calculated_at timestamptz default now()
);
create index idx_goal_forecasts_goal on goal_forecasts(goal_id, scenario_code, calculated_at desc);

-- ---------------------------------------------------------------------------
-- Immutable monthly snapshots (one per goal per calendar month — refined
-- during the month, never rewritten once it closes, same pattern as
-- financial_snapshots / financial_health_scores / resilience_scores).
-- ---------------------------------------------------------------------------
create table goal_snapshots (
  id uuid primary key default gen_random_uuid(),
  goal_id uuid not null references user_goals(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  snapshot_month date not null,
  current_amount numeric(18,2) not null,
  target_amount numeric(18,2) not null,
  target_date date,
  planned_contribution_amount numeric(18,2) not null,
  progress_pct numeric(6,2) not null,
  required_monthly_contribution numeric(18,2),
  forecast_completion_date date,
  track_status text not null,
  confidence_score numeric(5,2) not null,
  model_version text not null,
  assumption_set_id text not null,
  reporting_currency_equivalent numeric(18,2),
  created_at timestamptz default now(),
  unique (goal_id, snapshot_month)
);
create index idx_goal_snapshots_goal on goal_snapshots(goal_id, snapshot_month);

alter table goal_funding_sources enable row level security;
alter table goal_contributions enable row level security;
alter table goal_milestones enable row level security;
alter table goal_forecasts enable row level security;
alter table goal_snapshots enable row level security;

create policy "own goal funding sources" on goal_funding_sources
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own goal contributions" on goal_contributions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own goal milestones" on goal_milestones
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own goal forecasts" on goal_forecasts
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own goal snapshots" on goal_snapshots
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Default model configuration -----------------------------------------------
insert into goal_planning_config (model_version, is_active, config) values (
  'goals-1.0.0',
  true,
  '{
    "trackStatusThresholds": {
      "aheadMin": 105,
      "onTrackMin": 100,
      "atRiskMin": 90
    },
    "confidenceWeights": {
      "targetAmountCompleteness": 0.15,
      "targetDateCertainty": 0.10,
      "currentBalanceVerification": 0.15,
      "contributionHistory": 0.15,
      "linkedCashFlowData": 0.15,
      "assumptionReliability": 0.10,
      "timeHorizon": 0.10,
      "dataRecency": 0.10
    },
    "confidenceBands": [
      { "min": 85, "band": "high", "label": "High" },
      { "min": 70, "band": "good", "label": "Good" },
      { "min": 55, "band": "moderate", "label": "Moderate" },
      { "min": 40, "band": "low", "label": "Low" },
      { "min": 0,  "band": "insufficient", "label": "Insufficient" }
    ],
    "affordabilityThresholds": {
      "comfortableMax": 0.6,
      "manageableMax": 0.85,
      "tightMax": 1.0
    },
    "priorityWeights": {
      "userImportance": 0.25,
      "dateUrgency": 0.20,
      "protectionValue": 0.20,
      "mandatoryObligation": 0.15,
      "consequenceOfDelay": 0.10,
      "fundingGap": 0.05,
      "dependency": 0.05
    },
    "scenarioAssumptions": {
      "generic": {
        "conservative": { "returnRate": 0.02, "costInflation": 0.035, "contributionGrowth": 0.0 },
        "base": { "returnRate": 0.045, "costInflation": 0.025, "contributionGrowth": 0.02 },
        "optimistic": { "returnRate": 0.07, "costInflation": 0.015, "contributionGrowth": 0.04 }
      },
      "emergency_fund": {
        "conservative": { "returnRate": 0.01, "costInflation": 0.035, "contributionGrowth": 0.0 },
        "base": { "returnRate": 0.03, "costInflation": 0.025, "contributionGrowth": 0.0 },
        "optimistic": { "returnRate": 0.045, "costInflation": 0.015, "contributionGrowth": 0.0 }
      },
      "home_deposit": {
        "conservative": { "returnRate": 0.02, "costInflation": 0.06, "contributionGrowth": 0.0 },
        "base": { "returnRate": 0.04, "costInflation": 0.045, "contributionGrowth": 0.02 },
        "optimistic": { "returnRate": 0.06, "costInflation": 0.03, "contributionGrowth": 0.04 }
      },
      "debt_payoff": {
        "conservative": { "returnRate": 0.0, "costInflation": 0.0, "contributionGrowth": 0.0 },
        "base": { "returnRate": 0.0, "costInflation": 0.0, "contributionGrowth": 0.02 },
        "optimistic": { "returnRate": 0.0, "costInflation": 0.0, "contributionGrowth": 0.05 }
      },
      "retirement": {
        "conservative": { "returnRate": 0.04, "costInflation": 0.03, "contributionGrowth": 0.0 },
        "base": { "returnRate": 0.065, "costInflation": 0.025, "contributionGrowth": 0.03 },
        "optimistic": { "returnRate": 0.09, "costInflation": 0.02, "contributionGrowth": 0.05 }
      },
      "education": {
        "conservative": { "returnRate": 0.02, "costInflation": 0.07, "contributionGrowth": 0.0 },
        "base": { "returnRate": 0.04, "costInflation": 0.05, "contributionGrowth": 0.02 },
        "optimistic": { "returnRate": 0.06, "costInflation": 0.035, "contributionGrowth": 0.04 }
      },
      "cross_border": {
        "conservative": { "returnRate": 0.01, "costInflation": 0.04, "contributionGrowth": 0.0 },
        "base": { "returnRate": 0.03, "costInflation": 0.03, "contributionGrowth": 0.0 },
        "optimistic": { "returnRate": 0.045, "costInflation": 0.02, "contributionGrowth": 0.0 }
      },
      "major_purchase": {
        "conservative": { "returnRate": 0.02, "costInflation": 0.045, "contributionGrowth": 0.0 },
        "base": { "returnRate": 0.035, "costInflation": 0.03, "contributionGrowth": 0.0 },
        "optimistic": { "returnRate": 0.05, "costInflation": 0.02, "contributionGrowth": 0.0 }
      },
      "business": {
        "conservative": { "returnRate": 0.02, "costInflation": 0.03, "contributionGrowth": 0.0 },
        "base": { "returnRate": 0.04, "costInflation": 0.025, "contributionGrowth": 0.03 },
        "optimistic": { "returnRate": 0.07, "costInflation": 0.02, "contributionGrowth": 0.06 }
      }
    },
    "fxAssumptions": {
      "AUD_INR": { "conservative": 54, "base": 57, "optimistic": 60 },
      "INR_AUD": { "conservative": 0.0167, "base": 0.0175, "optimistic": 0.0185 }
    }
  }'::jsonb
) on conflict (model_version) do nothing;

-- Default goal type catalogue -------------------------------------------------
insert into goal_types (type_key, category, type_label, forecast_logic_key, default_priority, default_importance_type, default_inflation_category, suggested_horizon_years, sort_order) values
('starter_emergency_fund', 'foundation', 'Starter Emergency Fund', 'emergency_fund', 5, 'essential', 'general', 1, 10),
('full_emergency_fund', 'foundation', 'Full Emergency Fund', 'emergency_fund', 4, 'essential', 'general', 2, 20),
('cash_reserve', 'foundation', 'Cash Reserve', 'emergency_fund', 3, 'important', 'general', 1, 30),
('tax_payment_reserve', 'foundation', 'Tax Payment Reserve', 'generic', 4, 'essential', 'general', 1, 40),
('insurance_premium_reserve', 'foundation', 'Insurance Premium Reserve', 'generic', 3, 'important', 'general', 1, 50),

('pay_off_credit_card', 'debt', 'Pay Off Credit Card', 'debt_payoff', 5, 'essential', 'general', 2, 110),
('pay_off_personal_loan', 'debt', 'Pay Off Personal Loan', 'debt_payoff', 4, 'important', 'general', 3, 120),
('pay_off_car_loan', 'debt', 'Pay Off Car Loan', 'debt_payoff', 3, 'important', 'general', 4, 130),
('reduce_mortgage', 'debt', 'Reduce Home Mortgage', 'debt_payoff', 3, 'important', 'general', 10, 140),
('pay_off_education_loan', 'debt', 'Pay Off Education Loan', 'debt_payoff', 3, 'important', 'general', 5, 150),
('become_debt_free', 'debt', 'Become Debt Free', 'debt_payoff', 4, 'important', 'general', 5, 160),

('first_home_deposit', 'property', 'First Home Deposit', 'home_deposit', 4, 'important', 'property', 5, 210),
('upgrade_home_deposit', 'property', 'Upgrade Home Deposit', 'home_deposit', 3, 'aspirational', 'property', 5, 220),
('investment_property_deposit', 'property', 'Investment Property Deposit', 'home_deposit', 3, 'aspirational', 'property', 5, 230),
('property_purchase', 'property', 'Property Purchase', 'home_deposit', 3, 'aspirational', 'property', 5, 240),
('renovation', 'property', 'Renovation', 'major_purchase', 2, 'aspirational', 'property', 2, 250),
('overseas_property_purchase', 'property', 'Overseas Property Purchase', 'home_deposit', 3, 'aspirational', 'property', 6, 260),

('start_investing', 'investment', 'Start Investing', 'generic', 3, 'important', 'general', 3, 310),
('investment_portfolio_target', 'investment', 'Investment Portfolio Target', 'generic', 3, 'aspirational', 'general', 5, 320),
('passive_income_target', 'investment', 'Passive Income Target', 'generic', 3, 'aspirational', 'general', 10, 330),
('financial_independence_target', 'investment', 'Financial Independence Target', 'generic', 3, 'aspirational', 'general', 15, 340),
('diversified_assets_target', 'investment', 'Build Diversified Assets', 'generic', 2, 'aspirational', 'general', 5, 350),
('business_investment', 'investment', 'Business Investment', 'business', 3, 'aspirational', 'general', 3, 360),
('business_startup', 'investment', 'Business Startup Capital', 'business', 3, 'aspirational', 'general', 3, 370),

('retirement_balance_target', 'retirement', 'Retirement Balance Target', 'retirement', 4, 'important', 'general', 20, 410),
('additional_retirement_contribution', 'retirement', 'Additional Retirement Contribution', 'retirement', 3, 'important', 'general', 15, 420),
('early_retirement', 'retirement', 'Early Retirement', 'retirement', 3, 'aspirational', 'general', 20, 430),
('superannuation_goal', 'retirement', 'Superannuation Goal', 'retirement', 3, 'important', 'general', 20, 440),
('ppf_goal', 'retirement', 'PPF Goal', 'retirement', 3, 'important', 'general', 15, 450),
('nps_goal', 'retirement', 'NPS Goal', 'retirement', 3, 'important', 'general', 20, 460),

('school_fees', 'family_education', 'School Fees', 'education', 4, 'essential', 'education', 5, 510),
('university_education', 'family_education', 'University Education', 'education', 4, 'important', 'education', 10, 520),
('overseas_education', 'family_education', 'Overseas Education', 'education', 4, 'important', 'education', 10, 530),
('childcare_reserve', 'family_education', 'Childcare Reserve', 'education', 3, 'important', 'education', 2, 540),
('wedding', 'family_education', 'Wedding', 'major_purchase', 3, 'aspirational', 'general', 3, 550),
('family_support', 'family_education', 'Family Support', 'generic', 3, 'important', 'general', 3, 560),
('support_relatives_overseas', 'family_education', 'Support Relatives Overseas', 'cross_border', 3, 'important', 'general', 5, 570),

('holiday', 'lifestyle', 'Holiday', 'major_purchase', 2, 'aspirational', 'general', 1, 610),
('vehicle_purchase', 'lifestyle', 'Vehicle Purchase', 'major_purchase', 2, 'aspirational', 'general', 3, 620),
('major_household_purchase', 'lifestyle', 'Major Household Purchase', 'major_purchase', 2, 'aspirational', 'general', 2, 630),
('sabbatical', 'lifestyle', 'Sabbatical', 'generic', 2, 'aspirational', 'general', 3, 640),
('relocation', 'lifestyle', 'Relocation', 'generic', 2, 'aspirational', 'general', 2, 650),
('immigration_visa_costs', 'lifestyle', 'Immigration or Visa Costs', 'generic', 3, 'important', 'general', 2, 660),

('medical_procedure', 'health', 'Medical Procedure', 'generic', 4, 'essential', 'medical', 1, 710),
('health_reserve', 'health', 'Health Reserve', 'generic', 3, 'important', 'medical', 2, 720),
('aged_care_reserve', 'health', 'Aged Care Reserve', 'generic', 3, 'important', 'medical', 10, 730),
('home_repair_emergency_reserve', 'health', 'Home Repair Emergency Reserve', 'generic', 3, 'important', 'general', 2, 740),

('custom_goal', 'custom', 'Custom Goal', 'generic', 3, 'important', 'general', 3, 910)
on conflict (type_key) do nothing;
