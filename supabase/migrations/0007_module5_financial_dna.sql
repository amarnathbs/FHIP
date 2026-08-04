-- Module 5: Financial DNA™ — deterministic profile classification.
-- Rules and scoring logic live in versioned application code (lib/engines/financialDna.ts),
-- the same pattern proven in Module 4: descriptive/governance content lives in the
-- database (admin-editable later), the classification RULES themselves are
-- auditable via model_version and covered by automated persona tests rather
-- than a generic runtime rule-interpreter.

-- Admin-configurable dimension weights / thresholds / confidence formula.
create table financial_dna_config (
  id uuid primary key default gen_random_uuid(),
  model_version text not null unique,
  config jsonb not null,
  is_active boolean not null default false,
  created_at timestamptz default now()
);
create unique index idx_financial_dna_config_one_active on financial_dna_config (is_active) where is_active;

alter table financial_dna_config enable row level security;
create policy "read dna config" on financial_dna_config for select using (true);

-- Descriptive profile definitions (governance content — names, descriptions,
-- icon). Admin-editable later via Module 12; read-only to end users.
create table financial_dna_archetypes (
  id uuid primary key default gen_random_uuid(),
  profile_code text not null unique,
  profile_name text not null,
  short_description text not null,
  long_description text not null,
  icon text,
  display_order int not null default 0,
  is_active boolean not null default true,
  life_stage_hint text,
  country_hint text[]
);

alter table financial_dna_archetypes enable row level security;
create policy "read dna archetypes" on financial_dna_archetypes for select using (true);

-- One row per user per calendar month, like financial_snapshots and
-- financial_health_scores: refined during the month, never rewritten once
-- the month closes.
create table financial_dna_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  profile_month date not null,
  primary_profile_code text not null,
  primary_compatibility_score numeric(5,2) not null,
  secondary_profile_code text,
  secondary_compatibility_score numeric(5,2),
  confidence_score numeric(5,2) not null,
  confidence_band text not null,
  status text not null default 'indicative',   -- insufficient_data|indicative|confirmed|high_confidence
  profile_changed boolean not null default false,
  previous_profile_code text,
  model_version text not null,
  data_completeness_pct numeric(5,2) not null,
  created_at timestamptz default now(),
  unique (user_id, profile_month)
);
create index idx_financial_dna_profiles_user on financial_dna_profiles(user_id, profile_month);

create table financial_dna_profile_scores (
  id uuid primary key default gen_random_uuid(),
  dna_profile_id uuid not null references financial_dna_profiles(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  candidate_profile_code text not null,
  raw_score numeric(5,2) not null,
  adjusted_score numeric(5,2) not null,
  rank int not null,
  eligible boolean not null default true,
  exclusion_reason text,
  dimension_scores jsonb
);
create index idx_dna_profile_scores_profile on financial_dna_profile_scores(dna_profile_id);

-- Classification drivers, strengths and risks all share this shape,
-- distinguished by driver_type.
create table financial_dna_drivers (
  id uuid primary key default gen_random_uuid(),
  dna_profile_id uuid not null references financial_dna_profiles(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  driver_type text not null,   -- classification|strength|risk
  metric_code text not null,
  metric_value numeric(18,4),
  threshold_value numeric(18,4),
  contribution numeric(6,3),
  display_rank int not null default 0,
  explanation text not null
);
create index idx_dna_drivers_profile on financial_dna_drivers(dna_profile_id);

create table financial_dna_actions (
  id uuid primary key default gen_random_uuid(),
  dna_profile_id uuid not null references financial_dna_profiles(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  action_code text not null,
  title text not null,
  explanation text not null,
  priority text not null,      -- high|medium|low
  related_module text,
  related_metric text,
  estimated_effect text,
  action_status text not null default 'new'
);
create index idx_dna_actions_profile on financial_dna_actions(dna_profile_id);

alter table financial_dna_profiles enable row level security;
alter table financial_dna_profile_scores enable row level security;
alter table financial_dna_drivers enable row level security;
alter table financial_dna_actions enable row level security;

create policy "own dna profiles" on financial_dna_profiles
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own dna profile scores" on financial_dna_profile_scores
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own dna drivers" on financial_dna_drivers
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own dna actions" on financial_dna_actions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Default model configuration -----------------------------------------------
insert into financial_dna_config (model_version, is_active, config) values (
  'dna-1.0.0',
  true,
  '{
    "dimensionWeights": {
      "savings_discipline": 0.15,
      "spending_pattern": 0.12,
      "debt_structure": 0.15,
      "asset_allocation": 0.15,
      "investment_behaviour": 0.12,
      "liquidity_position": 0.10,
      "retirement_preparation": 0.08,
      "income_capacity": 0.08,
      "protection_planning": 0.05
    },
    "secondaryThreshold": { "minScore": 55, "maxGapFromPrimary": 20 },
    "profileChangeThreshold": 5,
    "confidenceWeights": {
      "dataCompleteness": 0.40,
      "signalConsistency": 0.30,
      "separation": 0.20,
      "recency": 0.10
    },
    "confidenceBands": [
      { "min": 85, "band": "very_high", "label": "Very high" },
      { "min": 70, "band": "high", "label": "High" },
      { "min": 55, "band": "moderate", "label": "Moderate" },
      { "min": 40, "band": "low", "label": "Low" },
      { "min": 0,  "band": "insufficient", "label": "Insufficient for confirmed classification" }
    ]
  }'::jsonb
) on conflict (model_version) do nothing;

-- Default archetype descriptions ---------------------------------------------
insert into financial_dna_archetypes (profile_code, profile_name, short_description, long_description, icon, display_order) values
('cash_rich_accumulator', 'Cash-Rich Accumulator',
  'Strong liquidity and disciplined saving, with limited exposure to growth investments.',
  'Your current financial pattern most closely resembles a Cash-Rich Accumulator. You hold a significant share of your financial assets in cash and deposits, carry little debt, and maintain strong emergency reserves. This gives you real resilience against short-term shocks, though it may mean your long-term wealth grows more slowly than it could.',
  'piggy-bank', 10),
('wealth_builder', 'Wealth Builder',
  'Disciplined saving and regular investing, building net worth steadily over time.',
  'Your current financial pattern most closely resembles a Wealth Builder. You save and invest consistently, keep debt under control, and your net worth is trending upward. This is a strong long-term compounding position, provided diversification and protection keep pace with your growing wealth.',
  'trending-up', 20),
('lifestyle_optimiser', 'Lifestyle Optimiser',
  'Strong income supporting a rich lifestyle today, with room to build long-term savings momentum.',
  'Your current financial pattern most closely resembles a Lifestyle Optimiser. Your income supports a comfortable, flexible lifestyle, with discretionary spending making up a large share of your budget. Building a stronger automatic savings habit would help convert more of today''s income into long-term wealth.',
  'sparkles', 30),
('property_focused_investor', 'Property-Focused Investor',
  'Wealth concentrated in property, supported by mortgage leverage.',
  'Your current financial pattern most closely resembles a Property-Focused Investor. You have built a significant share of your wealth through property, supported by mortgage leverage. Your balance sheet has strong asset backing, but your liquid assets and investment diversification are relatively limited.',
  'home', 40),
('debt_constrained_builder', 'Debt-Constrained Builder',
  'Reasonable income currently absorbed by debt repayments, limiting monthly flexibility.',
  'Your current financial pattern most closely resembles a Debt-Constrained Builder. A significant share of your income is currently directed toward debt repayments, limiting the cash available for saving and investing. Reducing high-cost debt is likely to unlock the fastest improvement in your financial position.',
  'link', 50),
('future_ready_professional', 'Future-Ready Professional',
  'Strong earning capacity and healthy habits, with time on your side for compounding.',
  'Your current financial pattern most closely resembles a Future-Ready Professional. Your income capacity, savings habits and manageable debt put you in a strong position to build significant wealth over time, even if your accumulated net worth is still developing.',
  'graduation-cap', 60),
('financial_stabiliser', 'Financial Stabiliser',
  'Focused on building basic financial stability and a foundation to grow from.',
  'Your current financial pattern most closely resembles a Financial Stabiliser. Your household is working to establish stable cash flow and a basic financial buffer. Small, consistent changes to essential spending and emergency savings tend to produce the fastest improvement from here.',
  'life-buoy', 70),
('retirement_focused_preserver', 'Retirement-Focused Preserver',
  'Focused on preserving capital and sustaining income through retirement.',
  'Your current financial pattern most closely resembles a Retirement-Focused Preserver. Your focus has shifted from accumulation to preserving capital and generating sustainable income, typically supported by retirement savings and reduced debt.',
  'shield', 80)
on conflict (profile_code) do nothing;
