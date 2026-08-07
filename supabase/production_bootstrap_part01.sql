-- FHIP production bootstrap — PART 1 of 9
-- Foundation, Module 1, Module 2, financial data grid, dashboard, health score,
-- financial DNA, resilience (migrations 0001-0008).
-- Run parts in order (01, 02, 03, ...) in the Supabase SQL Editor, on a brand-new project only.


-- === migrations/0001_foundation.sql ===
-- Reference data ---------------------------------------------------------
create table countries (
  country_code char(2) primary key,
  country_name text not null,
  default_currency_code char(3) not null,
  is_supported boolean default true
);

create table currencies (
  currency_code char(3) primary key,
  currency_name text not null,
  currency_symbol text not null,
  country_code char(2)
);

-- Profile (1:1 with auth.users) ------------------------------------------
create table user_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  date_of_birth date,
  country_of_residence char(2) references countries(country_code),
  secondary_country char(2),
  preferred_currency char(3) references currencies(currency_code),
  employment_status text,
  onboarding_completed boolean default false,
  profile_completion_percentage int default 0,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table households (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  household_name text,
  household_type text,
  marital_status text,
  dependants_count int default 0 check (dependants_count >= 0),
  annual_household_income_range text,
  primary_country char(2),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table user_goals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  goal_name text not null,
  goal_type text not null,
  target_amount numeric(18,2) not null check (target_amount >= 0),
  current_amount numeric(18,2) default 0 check (current_amount >= 0),
  currency_code char(3) not null references currencies(currency_code),
  target_date date,
  priority text default 'medium',
  status text default 'active',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Consent + audit primitives (scaffolded early for compliance) ------------
create table consents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  consent_type text not null,
  consent_version text not null,
  granted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz default now()
);

create table audit_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  event_type text not null,          -- login, update, delete, export, calc_run
  entity text,
  entity_id uuid,
  metadata jsonb,
  created_at timestamptz default now()
);

create index idx_households_user on households(user_id);
create index idx_user_goals_user on user_goals(user_id);
create index idx_consents_user on consents(user_id);
create index idx_audit_user on audit_events(user_id);

-- Row Level Security: the reusable pattern for EVERY user-owned table -----
alter table user_profiles enable row level security;
alter table households    enable row level security;
alter table user_goals    enable row level security;
alter table consents      enable row level security;
alter table audit_events  enable row level security;

-- Owner-only policy, applied identically to each table
create policy "own rows - profiles" on user_profiles
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own rows - households" on households
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own rows - goals" on user_goals
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own rows - consents" on consents
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own rows - audit" on audit_events
  for select using (auth.uid() = user_id);

-- Reference tables are world-readable, admin-writable (see Module 12)
alter table countries enable row level security;
alter table currencies enable row level security;
create policy "read countries" on countries for select using (true);
create policy "read currencies" on currencies for select using (true);

-- === migrations/0002_module1.sql ===
-- Module 1 reuses foundation tables (user_profiles, households, user_goals).
-- Auto-create an empty profile row whenever a new auth.users row is created.
create or replace function handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into public.user_profiles (user_id) values (new.id)
  on conflict do nothing;
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- === migrations/0003_module2.sql ===
-- Module 2: Financial Data Capture — seven registers, all owner-scoped.

create table income_sources (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source_name text not null,
  income_type text not null,                 -- salary|business|rental|investment|other
  amount numeric(18,2) not null check (amount >= 0),
  frequency text not null,                   -- weekly|fortnightly|monthly|quarterly|annually|one_off
  currency_code char(3) not null references currencies(currency_code),
  is_active boolean default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table expense_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  expense_name text not null,
  expense_category text not null,            -- housing|transport|food|utilities|insurance|debt_repayment|other
  amount numeric(18,2) not null check (amount >= 0),
  frequency text not null,
  currency_code char(3) not null references currencies(currency_code),
  is_active boolean default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table assets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  asset_name text not null,
  asset_class text not null,                 -- cash|property|vehicle|business|other
  current_value numeric(18,2) not null check (current_value >= 0),
  currency_code char(3) not null references currencies(currency_code),
  country_code char(2) references countries(country_code),
  valuation_date date,
  is_active boolean default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table liabilities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  liability_name text not null,
  debt_type text not null,                   -- mortgage|personal_loan|credit_card|auto_loan|student_loan|other
  balance numeric(18,2) not null check (balance >= 0),
  interest_rate numeric(6,3) check (interest_rate >= 0),
  monthly_repayment numeric(18,2) default 0 check (monthly_repayment >= 0),
  currency_code char(3) not null references currencies(currency_code),
  country_code char(2) references countries(country_code),
  is_active boolean default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table investments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  investment_name text not null,
  investment_type text not null,             -- shares|managed_fund|etf|crypto|business_equity|other
  current_value numeric(18,2) not null check (current_value >= 0),
  currency_code char(3) not null references currencies(currency_code),
  country_code char(2) references countries(country_code),
  is_active boolean default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table retirement_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  account_name text not null,
  account_type text not null,                -- super|EPF|PPF|NPS|other
  current_balance numeric(18,2) not null check (current_balance >= 0),
  currency_code char(3) not null references currencies(currency_code),
  country_code char(2) references countries(country_code),
  is_active boolean default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table insurance_policies (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  policy_name text not null,
  cover_type text not null,                  -- life|income_protection|health|home|vehicle|other
  cover_amount numeric(18,2) not null check (cover_amount >= 0),
  premium numeric(18,2) not null check (premium >= 0),
  premium_frequency text not null,
  currency_code char(3) not null references currencies(currency_code),
  renewal_date date,
  is_active boolean default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table financial_records_audit (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  entity text not null,
  entity_id uuid,
  action text not null,
  changed_at timestamptz default now(),
  metadata jsonb
);

create index idx_income_sources_user on income_sources(user_id);
create index idx_expense_items_user on expense_items(user_id);
create index idx_assets_user on assets(user_id);
create index idx_liabilities_user on liabilities(user_id);
create index idx_investments_user on investments(user_id);
create index idx_retirement_accounts_user on retirement_accounts(user_id);
create index idx_insurance_policies_user on insurance_policies(user_id);
create index idx_financial_records_audit_user on financial_records_audit(user_id);

-- RLS: the same owner-only pattern as every other user-owned table.
alter table income_sources        enable row level security;
alter table expense_items         enable row level security;
alter table assets                enable row level security;
alter table liabilities           enable row level security;
alter table investments           enable row level security;
alter table retirement_accounts   enable row level security;
alter table insurance_policies    enable row level security;
alter table financial_records_audit enable row level security;

create policy "own rows - income" on income_sources
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own rows - expenses" on expense_items
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own rows - assets" on assets
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own rows - liabilities" on liabilities
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own rows - investments" on investments
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own rows - retirement" on retirement_accounts
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own rows - insurance" on insurance_policies
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own rows - financial audit" on financial_records_audit
  for select using (auth.uid() = user_id);

-- === migrations/0004_financial_data_grid.sql ===
-- Financial Data Grid: master item catalogue + owner/master-item linkage + category-specific columns.
-- Replaces the sequential "one item at a time" capture with a pre-populated, spreadsheet-style grid.

create table master_financial_items (
  id uuid primary key default gen_random_uuid(),
  category text not null,          -- income|expense|asset|liability|investment|retirement|insurance
  item_key text not null,
  item_label text not null,
  sort_order int not null default 0,
  is_active boolean default true,
  unique (category, item_key)
);

alter table master_financial_items enable row level security;
create policy "read master items" on master_financial_items for select using (true);

create index idx_master_financial_items_category on master_financial_items(category, sort_order);

-- Owner is common to every register; allowed values enforced via check constraint.
-- master_item_key links a saved row back to its master item; null = user-defined custom row.
-- unique(user_id, master_item_key) lets an upsert resolve to "the row for this master item"
-- for a single POST call, while multiple NULLs (custom rows) stay unconstrained — Postgres
-- unique constraints never treat NULL as equal to NULL, so any number of custom rows is fine.

alter table income_sources
  add column owner text not null default 'self'
    check (owner in ('self','spouse','joint','child','family_trust','company','smsf','other')),
  add column master_item_key text,
  add column net_amount numeric(18,2) check (net_amount >= 0),
  add column is_taxable boolean not null default true,
  add column notes text,
  add constraint uq_income_sources_user_master unique (user_id, master_item_key);

alter table expense_items
  add column owner text not null default 'self'
    check (owner in ('self','spouse','joint','child','family_trust','company','smsf','other')),
  add column master_item_key text,
  add column is_essential boolean not null default false,
  add column notes text,
  add constraint uq_expense_items_user_master unique (user_id, master_item_key);

alter table assets
  add column owner text not null default 'self'
    check (owner in ('self','spouse','joint','child','family_trust','company','smsf','other')),
  add column master_item_key text,
  add column purchase_price numeric(18,2) check (purchase_price >= 0),
  add column purchase_date date,
  add column notes text,
  add constraint uq_assets_user_master unique (user_id, master_item_key);

alter table liabilities
  add column owner text not null default 'self'
    check (owner in ('self','spouse','joint','child','family_trust','company','smsf','other')),
  add column master_item_key text,
  add column lender text,
  add column notes text,
  add constraint uq_liabilities_user_master unique (user_id, master_item_key);

alter table investments
  add column owner text not null default 'self'
    check (owner in ('self','spouse','joint','child','family_trust','company','smsf','other')),
  add column master_item_key text,
  add column institution text,
  add column cost_base numeric(18,2) check (cost_base >= 0),
  add column annual_contribution numeric(18,2) check (annual_contribution >= 0),
  add column risk_profile text check (risk_profile in ('conservative','balanced','growth','high_growth','unknown')),
  add column notes text,
  add constraint uq_investments_user_master unique (user_id, master_item_key);

alter table retirement_accounts
  add column owner text not null default 'self'
    check (owner in ('self','spouse','joint','child','family_trust','company','smsf','other')),
  add column master_item_key text,
  add column employer_contribution numeric(18,2) check (employer_contribution >= 0),
  add column personal_contribution numeric(18,2) check (personal_contribution >= 0),
  add column contribution_frequency text,
  add column target_retirement_age int check (target_retirement_age > 0 and target_retirement_age < 120),
  add column notes text,
  add constraint uq_retirement_accounts_user_master unique (user_id, master_item_key);

alter table insurance_policies
  add column owner text not null default 'self'
    check (owner in ('self','spouse','joint','child','family_trust','company','smsf','other')),
  add column master_item_key text,
  add column provider text,
  add column notes text,
  add constraint uq_insurance_policies_user_master unique (user_id, master_item_key);

-- === migrations/0005_module3_dashboard.sql ===
-- Module 3: Core Dashboard — monthly snapshot history for trend charts.
-- One row per user per calendar month; upserted as data changes during the
-- month, so it always reflects "the latest known state as of this month".
-- Once a new month starts, a fresh row is created and prior months are left
-- untouched, giving genuine month-over-month history over time.

create table financial_snapshots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  snapshot_month date not null,
  total_assets numeric(18,2),
  total_liabilities numeric(18,2),
  net_worth numeric(18,2),
  monthly_income numeric(18,2),
  monthly_expenses numeric(18,2),
  monthly_surplus numeric(18,2),
  savings_rate numeric(6,4),
  currency_code char(3),
  created_at timestamptz default now(),
  unique (user_id, snapshot_month)
);

create index idx_financial_snapshots_user on financial_snapshots(user_id, snapshot_month);

alter table financial_snapshots enable row level security;
create policy "own snapshots" on financial_snapshots
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- === migrations/0006_module4_health_score.sql ===
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

-- === migrations/0007_module5_financial_dna.sql ===
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

-- === migrations/0008_module6_resilience.sql ===
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
