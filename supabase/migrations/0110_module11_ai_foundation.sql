-- =============================================================================
-- Module 11.0 — AI Architecture, Certified Financial Context Contract,
-- Provider Gateway, Prompt Registry, Audit, Privacy & Safety Foundation
-- (migration 0110).
--
-- MIGRATION NUMBER GOVERNANCE. A full cross-branch/cross-worktree scan at
-- dispatch time (`git ls-tree` over every local branch, every worktree HEAD
-- on disk, and the `doclife`/`origin` remotes) found the highest COMMITTED
-- migration number anywhere to be 0108
-- (`feature/mandatory-country-confirmation-beta-cleanup`,
-- `0108_mandatory_country_confirmation_crud_and_onboarding_fix.sql`), and a
-- higher, still-UNCOMMITTED file on disk at 0109
-- (`D:/fhip-admin-a02-wave1/supabase/migrations/0109_admin_recommendation_upsert_atomicity.sql`,
-- untracked). `main`/`origin/main` itself tops out at 0102. This migration
-- is therefore numbered 0110 — one past the highest number found anywhere,
-- committed or not — to avoid any collision with in-flight work on any of
-- the many concurrent branches/worktrees active at the time of writing.
--
-- ADDITIVE ONLY. This migration creates ten new, wholly new tables. It does
-- not alter, rename, or drop any column, constraint, index, policy, or row
-- belonging to any Module 1-10 table. No Module 1-10 service, engine, or API
-- route is touched by this migration.
--
-- ARCHITECTURE (see docs/architecture/ADR-M11-001-governed-ai-explanation-
-- architecture.md for the full account). This migration implements, in
-- order: the Model Registry (A), the Prompt Registry (B), the AI Run audit
-- log (C), the Usage/Cost Ledger (D), the Answer Cache foundation (E), the
-- Insight foundation (F), the Recommendation foundation (G) — explicitly a
-- DIFFERENT concept from the pre-existing Resources-module
-- `action_recommendation_master`/`action_recommendation_conditions` admin
-- system, never joined or merged with it — the Feedback foundation (H), the
-- Evaluation foundation (I), and the Safety Event log (J).
--
-- SECURITY MODEL. Every user-owned table (ai_runs, ai_usage_ledger,
-- ai_answer_cache, ai_insights, ai_recommendations, ai_feedback) follows the
-- codebase's standard `auth.uid() = user_id` RLS pattern for SELECT; writes
-- to all of them except ai_feedback happen only through the service-role
-- client (lib/ai/audit/aiRuns.ts, future 11.1 insight/recommendation
-- generators), matching the existing audit-table convention (see
-- fdh_document_audit_events). ai_feedback additionally allows an
-- authenticated user to INSERT their own row, since a user rating an AI
-- response is a legitimate direct user action once the UI for it exists
-- (deliberately not built in 11.0 — spec section 37).
--
-- Governance-only tables — ai_model_registry, ai_prompt_templates,
-- ai_evaluations, ai_safety_events — carry NO end-user policy at all
-- (RLS enabled, zero policies), matching the existing
-- `benchmark_update_runs` precedent (migration 0011): every read and write
-- goes through requireAdmin() + the service-role client
-- (lib/services/adminAuth.ts), never through RLS as the sole gate.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- A. Model Registry (spec section 27)
-- ---------------------------------------------------------------------------
create table ai_model_registry (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  model_identifier text not null,
  unique (provider, model_identifier),
  internal_tier text not null check (internal_tier in ('LOW_COST', 'STANDARD', 'ADVANCED')),
  active boolean not null default false,
  approved boolean not null default false,
  task_types text[] not null default '{}',
  max_input_tokens int not null,
  max_output_tokens int not null,
  supports_structured_output boolean not null default true,
  supports_streaming boolean not null default false,
  supports_batch boolean not null default false,
  cost_input_per_1k_usd numeric(10, 6),
  cost_output_per_1k_usd numeric(10, 6),
  effective_from timestamptz,
  effective_to timestamptz,
  rollout_percentage int not null default 100 check (rollout_percentage between 0 and 100),
  fallback_model_id uuid references ai_model_registry(id),
  created_by uuid references auth.users(id),
  approved_by uuid references auth.users(id),
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_ai_model_registry_task_types on ai_model_registry using gin (task_types);
create index idx_ai_model_registry_active_approved on ai_model_registry(active, approved, internal_tier) where active and approved;

-- ---------------------------------------------------------------------------
-- B. Prompt Registry (spec sections 28-29)
-- ---------------------------------------------------------------------------
create table ai_prompt_templates (
  id uuid primary key default gen_random_uuid(),
  prompt_code text not null,
  prompt_name text not null,
  version int not null default 1,
  task_type text not null,
  system_prompt text not null,
  developer_prompt text not null,
  context_schema_version text not null,
  output_schema_version text not null,
  country_scope char(2) references countries(country_code),
  safety_policy_version text not null,
  status text not null default 'DRAFT' check (status in ('DRAFT', 'TESTING', 'APPROVED', 'ACTIVE', 'RETIRED')),
  approved_by uuid references auth.users(id),
  approved_at timestamptz,
  effective_from timestamptz,
  effective_to timestamptz,
  supersedes_prompt_id uuid references ai_prompt_templates(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (prompt_code, version)
);
create index idx_ai_prompt_templates_code on ai_prompt_templates(prompt_code);
create index idx_ai_prompt_templates_task_type on ai_prompt_templates(task_type);
-- Exactly one ACTIVE version per (prompt_code, country_scope) — coalesce so a
-- global (NULL country_scope) prompt is included in the uniqueness check
-- instead of Postgres treating every NULL as distinct.
create unique index idx_ai_prompt_templates_one_active
  on ai_prompt_templates(prompt_code, coalesce(country_scope, 'ZZ'))
  where status = 'ACTIVE';

-- ---------------------------------------------------------------------------
-- C. AI Run audit log (spec section 32)
-- ---------------------------------------------------------------------------
create table ai_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  household_id uuid references households(id) on delete set null,
  conversation_id uuid,
  request_type text not null,
  prompt_template_id uuid references ai_prompt_templates(id),
  prompt_version int,
  context_version text not null,
  context_hash text not null,
  source_reference_ids text[] not null default '{}',
  provider text not null,
  model text not null,
  model_version text,
  input_token_count int not null default 0,
  cached_input_token_count int not null default 0,
  output_token_count int not null default 0,
  estimated_cost_usd numeric(12, 6) not null default 0,
  actual_cost_usd numeric(12, 6),
  latency_ms int,
  structured_output jsonb,
  safety_classification text,
  safety_flags text[] not null default '{}',
  grounding_status text not null default 'not_applicable' check (grounding_status in ('grounded', 'ungrounded', 'not_applicable')),
  execution_status text not null check (
    execution_status in ('success', 'rejected_schema', 'rejected_certification', 'rejected_source_ref', 'provider_error', 'timeout', 'blocked_safety')
  ),
  error_code text,
  created_at timestamptz not null default now()
);
create index idx_ai_runs_user_created on ai_runs(user_id, created_at desc);
create index idx_ai_runs_household on ai_runs(household_id);
create index idx_ai_runs_execution_status on ai_runs(execution_status);

-- ---------------------------------------------------------------------------
-- D. Usage / Cost Ledger (spec section 33) — accumulation only, no quota
-- enforcement in 11.0 (spec section 56).
-- ---------------------------------------------------------------------------
create table ai_usage_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  household_id uuid references households(id) on delete set null,
  billing_period text not null, -- 'YYYY-MM'
  task_type text not null,
  provider text not null,
  model text not null,
  live_call_count int not null default 0,
  batch_call_count int not null default 0,
  cached_answer_count int not null default 0,
  input_tokens int not null default 0,
  cached_tokens int not null default 0,
  output_tokens int not null default 0,
  estimated_cost_usd numeric(12, 6) not null default 0,
  actual_cost_usd numeric(12, 6),
  created_at timestamptz not null default now(),
  unique (user_id, billing_period, task_type, provider, model)
);
create index idx_ai_usage_ledger_user_period on ai_usage_ledger(user_id, billing_period);

-- ---------------------------------------------------------------------------
-- E. Answer Cache foundation (spec section 34) — architecture only, no
-- semantic duplicate detection in 11.0.
-- ---------------------------------------------------------------------------
create table ai_answer_cache (
  id uuid primary key default gen_random_uuid(),
  household_id uuid references households(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  snapshot_hash text not null,
  context_version text not null,
  intent_code text not null,
  normalised_question_hash text not null,
  semantic_key text,
  prompt_version int,
  model_version text,
  answer_json jsonb not null,
  source_references jsonb not null default '[]',
  confidence text,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  invalidated_at timestamptz
);
create index idx_ai_answer_cache_lookup on ai_answer_cache(user_id, intent_code, normalised_question_hash) where invalidated_at is null;

-- ---------------------------------------------------------------------------
-- F. Insight foundation (spec section 35) — structured FACTS only, never an
-- AI-invented fact. `future_ai_explanation` is prose FHIP has not generated
-- yet in 11.0; the fact columns are always populated by a deterministic
-- engine/source_engine, never by AI.
-- ---------------------------------------------------------------------------
create table ai_insights (
  id uuid primary key default gen_random_uuid(),
  household_id uuid references households(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  snapshot_id uuid,
  insight_code text not null,
  category text not null,
  severity text not null check (severity in ('info', 'low', 'medium', 'high', 'critical')),
  metric_code text,
  current_value numeric,
  reference_value numeric,
  structured_fact_json jsonb not null default '{}',
  source_engine text not null,
  source_reference text,
  deterministic_status text not null default 'confirmed',
  future_ai_explanation text,
  confidence text,
  valid_from timestamptz not null default now(),
  valid_until timestamptz,
  created_at timestamptz not null default now()
);
create index idx_ai_insights_user on ai_insights(user_id, created_at desc);
create index idx_ai_insights_household on ai_insights(household_id);

-- ---------------------------------------------------------------------------
-- G. Recommendation foundation (spec section 36).
--
-- IMPORTANT — DISTINCT FROM THE EXISTING RESOURCES-MODULE RECOMMENDATIONS
-- SYSTEM. This project already has an unrelated, pre-existing
-- `action_recommendation_master` / `action_recommendation_conditions` admin
-- system (migration 0017, Resources module) that drives editorial,
-- content-team-authored recommendation copy shown across the app. This new
-- `ai_recommendations` table is a DIFFERENT, AI-foundation-specific concept:
-- a per-household, deterministically-triggered recommendation record whose
-- rationale/current/reference values come from a live calculation
-- (`source_metric`/`current_value`/`reference_value`/`deterministic_rule`),
-- with an OPTIONAL, not-yet-populated `future_ai_explanation` for a later
-- phase to narrate. The two tables are never joined, never merged, and
-- `ai_recommendations` never reads from or writes to
-- `action_recommendation_master`/`action_recommendation_conditions`.
-- ---------------------------------------------------------------------------
create table ai_recommendations (
  id uuid primary key default gen_random_uuid(),
  recommendation_code text not null,
  household_id uuid references households(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  category text not null,
  priority text not null,
  deterministic_rule text not null,
  source_metric text,
  current_value numeric,
  reference_value numeric,
  structured_rationale jsonb not null default '{}',
  future_ai_explanation text,
  related_module text,
  action_route text,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index idx_ai_recommendations_user on ai_recommendations(user_id, status);
create index idx_ai_recommendations_household on ai_recommendations(household_id);

-- ---------------------------------------------------------------------------
-- H. Feedback foundation (spec section 37)
-- ---------------------------------------------------------------------------
create table ai_feedback (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  ai_run_id uuid references ai_runs(id) on delete set null,
  feedback_type text not null check (
    feedback_type in ('helpful', 'not_helpful', 'incorrect', 'unclear', 'too_technical', 'too_generic', 'unsafe', 'irrelevant')
  ),
  comment text,
  created_at timestamptz not null default now()
);
create index idx_ai_feedback_run on ai_feedback(ai_run_id);
create index idx_ai_feedback_user on ai_feedback(user_id);

-- ---------------------------------------------------------------------------
-- I. Evaluation foundation (spec section 38) — admin/reviewer-only, no
-- end-user relevance.
-- ---------------------------------------------------------------------------
create table ai_evaluations (
  id uuid primary key default gen_random_uuid(),
  ai_run_id uuid references ai_runs(id) on delete cascade,
  evaluation_type text not null check (
    evaluation_type in (
      'grounding', 'financial_fact_accuracy', 'safety', 'advice_boundary_compliance', 'privacy',
      'hallucination', 'citation_accuracy', 'response_clarity', 'prompt_injection_handling', 'latency', 'cost'
    )
  ),
  result text not null check (result in ('pass', 'fail', 'warning')),
  score numeric,
  reviewer_type text not null check (reviewer_type in ('automated', 'human')),
  reviewer_id uuid references auth.users(id),
  notes text,
  created_at timestamptz not null default now()
);
create index idx_ai_evaluations_run on ai_evaluations(ai_run_id);

-- ---------------------------------------------------------------------------
-- J. Safety Events (spec section 39) — admin-only, highly sensitive.
-- ---------------------------------------------------------------------------
create table ai_safety_events (
  id uuid primary key default gen_random_uuid(),
  ai_run_id uuid references ai_runs(id) on delete set null,
  user_id uuid references auth.users(id) on delete set null,
  event_type text not null check (
    event_type in (
      'advice_boundary_violation', 'privacy_concern', 'attempted_cross_user_retrieval', 'prompt_injection',
      'unsupported_financial_claim', 'provider_failure', 'certification_gate_failure',
      'sensitive_data_leakage_prevented', 'moderation_policy_event'
    )
  ),
  severity text not null check (severity in ('INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
  detail text,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index idx_ai_safety_events_severity on ai_safety_events(severity, created_at desc);
create index idx_ai_safety_events_run on ai_safety_events(ai_run_id);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table ai_model_registry enable row level security;
alter table ai_prompt_templates enable row level security;
alter table ai_runs enable row level security;
alter table ai_usage_ledger enable row level security;
alter table ai_answer_cache enable row level security;
alter table ai_insights enable row level security;
alter table ai_recommendations enable row level security;
alter table ai_feedback enable row level security;
alter table ai_evaluations enable row level security;
alter table ai_safety_events enable row level security;

-- ai_model_registry / ai_prompt_templates / ai_evaluations / ai_safety_events:
-- deliberately NO policy at all. RLS is enabled but no policy is created for
-- any role, so `authenticated`/`anon` get zero rows on every operation and
-- only the service-role client (which bypasses RLS entirely) can read or
-- write — identical to the existing `benchmark_update_runs` precedent
-- (migration 0011). Every admin route additionally gates on requireAdmin()
-- before ever reaching the service-role client (defense in depth, not RLS
-- alone).

create policy "read own ai_runs" on ai_runs for select using (auth.uid() = user_id);

create policy "read own ai_usage_ledger" on ai_usage_ledger for select using (auth.uid() = user_id);

create policy "read own ai_answer_cache" on ai_answer_cache for select using (auth.uid() = user_id);

create policy "read own ai_insights" on ai_insights for select using (auth.uid() = user_id);

create policy "read own ai_recommendations" on ai_recommendations for select using (auth.uid() = user_id);

create policy "read own ai_feedback" on ai_feedback for select using (auth.uid() = user_id);
create policy "insert own ai_feedback" on ai_feedback for insert with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- Seed: MockAIProvider registry row — required so the mock/test harness and
-- the DEV admin preview can resolve a model without any real provider ever
-- being configured. `created_by`/`approved_by` are NULL (system seed, not a
-- real admin grant) — this activates only the zero-cost, zero-network mock
-- provider, never a real paid provider.
-- ---------------------------------------------------------------------------
insert into ai_model_registry (
  provider, model_identifier, internal_tier, active, approved, task_types,
  max_input_tokens, max_output_tokens, supports_structured_output, supports_streaming, supports_batch,
  cost_input_per_1k_usd, cost_output_per_1k_usd
) values (
  'mock', 'mock-standard-1', 'STANDARD', true, true,
  array[
    'score_explanation', 'monthly_summary', 'next_best_action', 'forecast_explanation', 'twin_explanation',
    'missing_data_explanation', 'resilience_explanation', 'dna_explanation', 'goal_progress_explanation',
    'general_coach', 'report_explanation', 'cross_border_explanation'
  ],
  8000, 800, true, false, false, 0, 0
) on conflict (provider, model_identifier) do nothing;

-- ---------------------------------------------------------------------------
-- Seed: future prompt definitions (spec section 29) — PR-AI-001 through
-- PR-AI-012, all DRAFT, all global (country_scope NULL). Placeholder
-- system/developer prompt text only; none is APPROVED or ACTIVE, so
-- getActivePrompt() returns null for every one of them until a future phase
-- explicitly reviews and activates a real prompt (spec section 29: "They may
-- remain DRAFT/INACTIVE. Do not expose them to users in 11.0.").
-- ---------------------------------------------------------------------------
insert into ai_prompt_templates (
  prompt_code, prompt_name, task_type, system_prompt, developer_prompt,
  context_schema_version, output_schema_version, safety_policy_version, status
)
values
  ('PR-AI-001', 'Financial Health Score Explanation', 'score_explanation',
   'PLACEHOLDER — not yet reviewed or approved. Explain the household''s certified Financial Health Score using only the supplied context; never recompute or invent a score.',
   'PLACEHOLDER template — interpolate the score domain of the Financial Context Object as DATA only.',
   'ai-context-1.0.0', 'ai-response-envelope-1.0.0', 'safety-policy-1.0.0', 'DRAFT'),
  ('PR-AI-002', 'Monthly Financial Summary', 'monthly_summary',
   'PLACEHOLDER — not yet reviewed or approved. Summarise the household''s certified monthly cash flow and balance sheet using only the supplied context.',
   'PLACEHOLDER template — interpolate the cash_flow and balance_sheet domains as DATA only.',
   'ai-context-1.0.0', 'ai-response-envelope-1.0.0', 'safety-policy-1.0.0', 'DRAFT'),
  ('PR-AI-003', 'Next Best Action Explanation', 'next_best_action',
   'PLACEHOLDER — not yet reviewed or approved. Explain a deterministically-generated ai_recommendations row in plain English; never invent a new recommendation.',
   'PLACEHOLDER template — interpolate one ai_recommendations row as DATA only.',
   'ai-context-1.0.0', 'ai-response-envelope-1.0.0', 'safety-policy-1.0.0', 'DRAFT'),
  ('PR-AI-004', 'Forecast Explanation', 'forecast_explanation',
   'PLACEHOLDER — not yet reviewed or approved. Explain a certified forecast scenario; always state it is a modelled estimate, never a guaranteed outcome.',
   'PLACEHOLDER template — interpolate the forecasts domain as DATA only.',
   'ai-context-1.0.0', 'ai-response-envelope-1.0.0', 'safety-policy-1.0.0', 'DRAFT'),
  ('PR-AI-005', 'Financial Twin Explanation', 'twin_explanation',
   'PLACEHOLDER — not yet reviewed or approved. Explain certified Financial Twin peer comparison results; never invent peer data or a percentile.',
   'PLACEHOLDER template — interpolate the financial_twin domain as DATA only.',
   'ai-context-1.0.0', 'ai-response-envelope-1.0.0', 'safety-policy-1.0.0', 'DRAFT'),
  ('PR-AI-006', 'Missing Data Explanation', 'missing_data_explanation',
   'PLACEHOLDER — not yet reviewed or approved. Explain, using the data_quality section only, why a domain cannot be assessed yet.',
   'PLACEHOLDER template — interpolate the data_quality and domain_certification sections as DATA only.',
   'ai-context-1.0.0', 'ai-response-envelope-1.0.0', 'safety-policy-1.0.0', 'DRAFT'),
  ('PR-AI-007', 'Resilience Explanation', 'resilience_explanation',
   'PLACEHOLDER — not yet reviewed or approved. Explain the certified Resilience score; never independently calculate a stress test.',
   'PLACEHOLDER template — interpolate the resilience domain as DATA only.',
   'ai-context-1.0.0', 'ai-response-envelope-1.0.0', 'safety-policy-1.0.0', 'DRAFT'),
  ('PR-AI-008', 'Financial DNA Explanation', 'dna_explanation',
   'PLACEHOLDER — not yet reviewed or approved. Explain the certified Financial DNA classification; never independently classify the household.',
   'PLACEHOLDER template — interpolate the financial_dna domain as DATA only.',
   'ai-context-1.0.0', 'ai-response-envelope-1.0.0', 'safety-policy-1.0.0', 'DRAFT'),
  ('PR-AI-009', 'Goal Progress Explanation', 'goal_progress_explanation',
   'PLACEHOLDER — not yet reviewed or approved. Explain certified goal progress/forecast figures for one goal; never invent a completion date.',
   'PLACEHOLDER template — interpolate one goals[] entry as DATA only.',
   'ai-context-1.0.0', 'ai-response-envelope-1.0.0', 'safety-policy-1.0.0', 'DRAFT'),
  ('PR-AI-010', 'General AI Coach', 'general_coach',
   'PLACEHOLDER — not yet reviewed or approved. General conversational entry point; deferred to Phase 11.1+, never activated in 11.0.',
   'PLACEHOLDER template — not wired to any endpoint in Module 11.0.',
   'ai-context-1.0.0', 'ai-response-envelope-1.0.0', 'safety-policy-1.0.0', 'DRAFT'),
  ('PR-AI-011', 'Report Explanation', 'report_explanation',
   'PLACEHOLDER — not yet reviewed or approved. Explain a certified generated report''s executive metrics; never invent a finding not present in the report.',
   'PLACEHOLDER template — interpolate one reports[] entry as DATA only.',
   'ai-context-1.0.0', 'ai-response-envelope-1.0.0', 'safety-policy-1.0.0', 'DRAFT'),
  ('PR-AI-012', 'Cross-Border Explanation', 'cross_border_explanation',
   'PLACEHOLDER — not yet reviewed or approved. Explain certified cross-border totals; never independently convert currencies; fail closed if currency integrity is invalid.',
   'PLACEHOLDER template — interpolate the cross_border domain as DATA only.',
   'ai-context-1.0.0', 'ai-response-envelope-1.0.0', 'safety-policy-1.0.0', 'DRAFT')
on conflict (prompt_code, version) do nothing;
