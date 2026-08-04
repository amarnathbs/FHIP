-- Module 4: Financial Health Score — 10-component weighted model.
-- Replaces the 6-pillar sketch from the original build guide.

-- Admin-configurable weights/thresholds/bands. One active row at a time;
-- a future admin UI (Module 12) edits this via the config jsonb blob rather
-- than requiring an engine code change.
create table health_score_config (
  id uuid primary key default gen_random_uuid(),
  model_version text not null unique,
  config jsonb not null,
  is_active boolean not null default false,
  created_at timestamptz default now()
);
create unique index idx_health_score_config_one_active on health_score_config (is_active) where is_active;

alter table health_score_config enable row level security;
create policy "read health score config" on health_score_config for select using (true);

-- One row per user per calendar month, like financial_snapshots: refined as
-- data changes during the month, left untouched once the month rolls over.
create table financial_health_scores (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  score_month date not null,
  overall_score numeric(5,2) not null,
  rounded_score int not null,
  status_band text not null,
  data_confidence numeric(5,2) not null,
  model_version text not null,
  previous_score numeric(5,2),
  score_change numeric(5,2),
  risk_override_applied boolean not null default false,
  risk_override_reason text,
  created_at timestamptz default now(),
  unique (user_id, score_month)
);
create index idx_financial_health_scores_user on financial_health_scores(user_id, score_month);

create table financial_health_component_scores (
  id uuid primary key default gen_random_uuid(),
  score_id uuid not null references financial_health_scores(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  component_code text not null,
  raw_score numeric(5,2),
  adjusted_score numeric(5,2),
  component_weight numeric(6,4) not null,
  weighted_contribution numeric(6,3) not null,
  status_band text,
  data_completeness numeric(5,2),
  treatment text not null default 'scored',   -- scored|not_applicable|missing_data
  explanation text,
  current_value jsonb,
  benchmark_value jsonb
);
create index idx_health_component_scores_score on financial_health_component_scores(score_id);

create table financial_health_recommendations (
  id uuid primary key default gen_random_uuid(),
  score_id uuid not null references financial_health_scores(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  component_code text not null,
  priority text not null,
  title text not null,
  explanation text,
  estimated_score_improvement numeric(5,2),
  estimated_financial_benefit numeric(18,2),
  target_date date,
  status text not null default 'open'
);
create index idx_health_recommendations_score on financial_health_recommendations(score_id);

-- Minimal self-declared checklist backing the Financial Management Behaviour
-- component. A future module may replace this with richer tracking.
create table health_check_ins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  goals_reviewed_at date,
  insurance_reviewed_at date,
  debt_reviewed_at date,
  investment_plan_reviewed_at date,
  beneficiaries_reviewed_at date,
  bills_paid_on_time boolean,
  budget_maintained boolean,
  savings_automated boolean,
  updated_at timestamptz default now()
);

alter table financial_health_scores enable row level security;
alter table financial_health_component_scores enable row level security;
alter table financial_health_recommendations enable row level security;
alter table health_check_ins enable row level security;

create policy "own health scores" on financial_health_scores
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own health component scores" on financial_health_component_scores
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own health recommendations" on financial_health_recommendations
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own check ins" on health_check_ins
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Default model configuration -----------------------------------------------
insert into health_score_config (model_version, is_active, config) values (
  'fhs-2.0.0',
  true,
  '{
    "componentWeights": {
      "cash_flow": 0.15,
      "savings": 0.12,
      "emergency_fund": 0.12,
      "debt": 0.15,
      "net_worth": 0.10,
      "investment": 0.08,
      "retirement": 0.10,
      "insurance": 0.08,
      "resilience": 0.05,
      "behaviour": 0.05
    },
    "scoreBands": [
      { "min": 85, "band": "excellent", "label": "Excellent" },
      { "min": 70, "band": "good", "label": "Good" },
      { "min": 55, "band": "fair", "label": "Fair" },
      { "min": 40, "band": "needs_attention", "label": "Needs Attention" },
      { "min": 0,  "band": "critical", "label": "Critical" }
    ],
    "riskOverride": {
      "deficitMonthsThreshold": 2,
      "emergencyMonthsThreshold": 1,
      "scoreCap": 49
    }
  }'::jsonb
) on conflict (model_version) do nothing;
