-- Investment Intelligence R1 — Migration E: analytics-result storage shape,
-- classified insights (with the structural advice gate), and reconciliation
-- cases. No analytics engine and no insight-generation rules are built in
-- R0/R1 — these tables are storage shape only (spec sections 6, non-goals).
--
-- Governing docs: R0_CANONICAL_DATA_CONTRACT.md, R0_INSIGHT_CLASSIFICATION.md,
-- R0_SOURCE_PROVENANCE_CONTRACT.md (reconciliation layer), ADR-007.

-- ---------------------------------------------------------------------------
-- ii_analytics_results — deterministic, versioned computed metric results.
-- Immutable: one row per calculation run (mirrors forecast_results/
-- goal_forecasts). subject_type/subject_id is a polymorphic reference
-- (position/account/portfolio) with no hard FK, matching the existing
-- platform precedent of not forcing a single-table FK across variable
-- subject kinds (goal_funding_sources' three nullable linked-id columns,
-- ii_fhip_publications.published_row_id above).
-- ---------------------------------------------------------------------------
create table ii_analytics_results (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  subject_type text not null check (subject_type in ('position', 'account', 'portfolio')),
  subject_id uuid not null,
  metric_key text not null,
  metric_value numeric(20, 6),
  calculation_version text not null,
  calculated_at timestamptz not null default now(),
  input_snapshot jsonb, -- captures exactly what was computed over, same pattern as goal_forecasts.input_snapshot
  created_at timestamptz default now() -- immutable
);
create index idx_ii_analytics_results_user on ii_analytics_results(user_id);
create index idx_ii_analytics_results_subject on ii_analytics_results(subject_type, subject_id);

alter table ii_analytics_results enable row level security;
create policy "own ii_analytics_results" on ii_analytics_results
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- ii_insights — generated, classified insight rows
-- (R0_INSIGHT_CLASSIFICATION.md). The 'gated' + check-constraint pairing is
-- a STRUCTURAL enforcement, not just documentation (ADR-007): a
-- personalised_advice row can never be inserted with gated=false, and the
-- service layer (see lib/services/investment-intelligence/insights.ts) additionally
-- refuses to return any personalised_advice row whose compliance_approved_at
-- is null to a consumer-facing caller.
-- ---------------------------------------------------------------------------
create table ii_insights (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  classification text not null check (classification in ('observation', 'education', 'simulation', 'personalised_advice')),
  rule_code text not null,
  rule_version text not null,
  severity text not null check (severity in ('info', 'low', 'medium', 'high')),
  evidence jsonb,
  status text not null default 'active' check (status in ('active', 'dismissed', 'superseded', 'expired')),
  gated boolean not null default true,
  compliance_approved_at timestamptz,
  created_at timestamptz not null default now(),
  constraint chk_ii_insights_advice_gated check (classification <> 'personalised_advice' or gated = true)
);
create index idx_ii_insights_user on ii_insights(user_id, status);

alter table ii_insights enable row level security;
create policy "own ii_insights" on ii_insights
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- ii_reconciliation_cases — tracks a detected mismatch (e.g. a refreshed
-- statement disagreeing with the previously certified holding) through to
-- resolution. subject_type/subject_id polymorphic, no hard FK (same
-- rationale as ii_analytics_results above).
-- ---------------------------------------------------------------------------
create table ii_reconciliation_cases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  subject_type text not null check (subject_type in ('holding_snapshot', 'transaction', 'account')),
  subject_id uuid not null,
  status text not null default 'open' check (status in ('open', 'user_reviewing', 'resolved', 'dismissed')),
  discrepancy_type text not null,
  discrepancy_details jsonb,
  opened_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index idx_ii_reconciliation_cases_user on ii_reconciliation_cases(user_id, status);

alter table ii_reconciliation_cases enable row level security;
create policy "own ii_reconciliation_cases" on ii_reconciliation_cases
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
