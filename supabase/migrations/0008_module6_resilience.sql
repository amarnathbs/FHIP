-- Module 6: Financial Resilience™ — 6-component stress-resilience model.
-- Supersedes/absorbs Module 4's inline "Financial Resilience" component,
-- which now delegates to this engine (see lib/engines/healthScore.ts).

-- New columns on existing registers, needed for income-concentration,
-- debt/refinance-risk and insurance-adequacy accuracy.
alter table income_sources add column employer_name text;

alter table liabilities
  add column interest_rate_type text check (interest_rate_type in ('fixed', 'variable')),
  add column fixed_rate_expiry date,
  add column credit_limit numeric(18,2) check (credit_limit >= 0);

alter table insurance_policies
  add column waiting_period_days int check (waiting_period_days >= 0),
  add column benefit_period text;

-- Admin-configurable weights/bands/confidence formula/risk overrides. Same
-- config-in-DB pattern as health_score_config and financial_dna_config.
create table resilience_config (
  id uuid primary key default gen_random_uuid(),
  model_version text not null unique,
  config jsonb not null,
  is_active boolean not null default false,
  created_at timestamptz default now()
);
create unique index idx_resilience_config_one_active on resilience_config (is_active) where is_active;

alter table resilience_config enable row level security;
create policy "read resilience config" on resilience_config for select using (true);

-- One row per user per calendar month, same immutable-snapshot pattern as
-- financial_health_scores / financial_dna_profiles: refined during the
-- month, never rewritten once the month closes.
create table resilience_scores (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  score_month date not null,
  overall_score numeric(5,2) not null,
  rounded_score int not null,
  status_band text not null,
  confidence_score numeric(5,2) not null,
  model_version text not null,
  previous_score numeric(5,2),
  score_change numeric(5,2),
  risk_override_applied boolean not null default false,
  risk_override_reason text,
  created_at timestamptz default now(),
  unique (user_id, score_month)
);
create index idx_resilience_scores_user on resilience_scores(user_id, score_month);

create table resilience_component_scores (
  id uuid primary key default gen_random_uuid(),
  score_id uuid not null references resilience_scores(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  component_code text not null,
  raw_score numeric(5,2),
  component_weight numeric(6,4) not null,
  weighted_contribution numeric(6,3) not null,
  status_band text,
  data_completeness numeric(5,2),
  treatment text not null default 'scored',   -- scored|not_applicable|missing_data
  explanation text,
  current_value jsonb,
  benchmark_value jsonb
);
create index idx_resilience_component_scores_score on resilience_component_scores(score_id);

-- Risk exposure register: each row is one identified risk with a severity,
-- regenerated on every calculation (tied to the immutable monthly score).
create table resilience_risks (
  id uuid primary key default gen_random_uuid(),
  score_id uuid not null references resilience_scores(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  risk_code text not null,
  category text not null,        -- liquidity|income|insurance|debt|concentration
  severity text not null,        -- low|medium|high|critical
  title text not null,
  explanation text not null,
  metric_value numeric(18,4),
  threshold_value numeric(18,4)
);
create index idx_resilience_risks_score on resilience_risks(score_id);

create table resilience_actions (
  id uuid primary key default gen_random_uuid(),
  score_id uuid not null references resilience_scores(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  action_code text not null,
  title text not null,
  explanation text not null,
  priority text not null,        -- high|medium|low
  related_module text,
  related_metric text,
  action_status text not null default 'new'
);
create index idx_resilience_actions_score on resilience_actions(score_id);

-- User-maintained register of known upcoming large/one-off outflows —
-- excluded from "accessible" emergency resources so the Emergency Fund
-- component doesn't overstate what's actually available. Ongoing data
-- (like liabilities), not a monthly snapshot.
create table future_financial_commitments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  commitment_name text not null,
  category text not null default 'other',  -- tax|education|property|legal|medical|other
  amount numeric(18,2) not null check (amount >= 0),
  due_date date not null,
  is_mandatory boolean not null default true,
  currency_code text not null default 'AUD',
  notes text,
  is_active boolean not null default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index idx_future_commitments_user on future_financial_commitments(user_id, due_date);

alter table resilience_scores enable row level security;
alter table resilience_component_scores enable row level security;
alter table resilience_risks enable row level security;
alter table resilience_actions enable row level security;
alter table future_financial_commitments enable row level security;

create policy "own resilience scores" on resilience_scores
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own resilience component scores" on resilience_component_scores
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own resilience risks" on resilience_risks
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own resilience actions" on resilience_actions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own future commitments" on future_financial_commitments
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Default model configuration -----------------------------------------------
insert into resilience_config (model_version, is_active, config) values (
  'resilience-1.0.0',
  true,
  '{
    "componentWeights": {
      "emergency_fund": 0.25,
      "liquidity": 0.15,
      "income_resilience": 0.15,
      "insurance_protection": 0.20,
      "debt_pressure": 0.15,
      "concentration_risk": 0.10
    },
    "scoreBands": [
      { "min": 85, "band": "highly_resilient", "label": "Highly Resilient" },
      { "min": 70, "band": "resilient", "label": "Resilient" },
      { "min": 55, "band": "moderately_vulnerable", "label": "Moderately Vulnerable" },
      { "min": 40, "band": "vulnerable", "label": "Vulnerable" },
      { "min": 0,  "band": "fragile", "label": "Fragile" }
    ],
    "confidenceWeights": {
      "incomeCompleteness": 0.15,
      "expenseCompleteness": 0.15,
      "liquidAssetCompleteness": 0.20,
      "liabilityCompleteness": 0.15,
      "insuranceCompleteness": 0.20,
      "dataRecency": 0.10,
      "verificationHistory": 0.05
    },
    "riskOverride": {
      "scoreCapPrimary": 49,
      "scoreCapSecondary": 59,
      "criticalLiquidityWeeks": 2,
      "refinanceExposureMonths": 6
    }
  }'::jsonb
) on conflict (model_version) do nothing;
