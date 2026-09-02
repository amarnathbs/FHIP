-- Module 11.5 — Contextual Explain / Why? Integration (spec sections 58-59,
-- 100-103).
--
-- NOT APPLIED to DEV or production by this pass — hand this file to the
-- Product Owner for explicit DEV authorisation (spec sections 100, 77).
--
-- ============================ COLLISION SCAN =============================
-- Performed per spec section 101, which explicitly names the Admin A0.2
-- Wave 4 vs Module 11.4 `0124` collision as the failure mode not to repeat.
--
--   * origin/main @ b7b28ca            -> highest migration is 0124
--     (0124_module11_4_standard_question_library.sql). 120 active migrations,
--     `node scripts/check-migration-versions.mjs` reports "next version is
--     0125".
--   * ALL other refs, scanned with
--     `git log --all --diff-filter=A --name-only -- supabase/migrations`
--     (covers every local branch, every reachable sibling worktree branch and
--     the `doclife` remote) -> ONE further number is already claimed:
--         0125_admin_a02_wave4_benchmark_source_audit.sql
--     added by commit ee92d90 on the in-flight Admin A0.2 Wave 4 worktree
--     (D:/FHIP/.claude/worktrees/agent-a3cfa187061e5a032).
--   * Under the project's established migration-lineage rule an
--     already-allocated sibling number retains precedence, so 0125 is NOT
--     taken here.
--
--   => Module 11.5 allocates 0126. Re-verified against a fresh
--      `git fetch origin` immediately before this file was written;
--      origin/main was still b7b28ca and no 0126 existed on any ref.
--
-- ============================ WHAT THIS DOES =============================
-- Three additive changes, all backward compatible with every existing
-- Module 11.0-11.4 caller. No existing column, constraint, policy or grant is
-- altered or dropped.
--
--   1. One new column on `ai_platform_controls` — the
--      AI_CONTEXTUAL_EXPLANATIONS_ENABLED feature switch (spec section 58),
--      following the exact pattern of the existing named switches
--      (live_provider_enabled / batch_generation_enabled / scenario_ai_enabled,
--      migration 0115).
--
--   2. Six new NULLABLE/defaulted columns on the EXISTING
--      `ai_resolution_audit` table (Module 11.2, migration 0117; extended by
--      11.4's 0124) rather than a parallel audit table (spec section 102:
--      "Reuse existing resolution audit").
--
--      SPEC SECTION 103 — DATABASE INVARIANTS ARE PRESERVED, NOT RELAXED.
--      That table's two structural guarantees are deliberately left exactly
--      as migration 0117 wrote them:
--          chk_ai_resolution_audit_no_provider_calls  (provider_called=false)
--          chk_ai_resolution_audit_zero_cost_no_quota (zero-cost => no quota)
--      Every Module 11.5 audit row is written through them unchanged, so it
--      is structurally impossible for a contextual explanation to record a
--      provider call or a quota consumption even if application code tried.
--
--      PRIVACY (spec section 102 — "Do not log unnecessary financial values"):
--      no financial value and no answer prose is stored. The owned entity a
--      user asked about is stored ONLY as a SHA-256 hash prefix, so the audit
--      trail can prove two requests addressed the same entity without
--      persisting which goal or report anybody asked about.
--
--   3. One new table, `ai_contextual_explanation_targets` — the DB-backed,
--      admin-controlled subset of the contextual target registry (`enabled`
--      only; wording, intent mappings, ownership rules and country scope
--      remain code-defined in lib/ai/contextualExplanations/registry.ts, the
--      same "stable taxonomy lives in code" precedent as
--      lib/ai/resolution/intentTaxonomy.ts and 11.4's ai_standard_questions).
--      Governance-only, exactly like ai_standard_questions and
--      ai_platform_controls: RLS enabled, ZERO policies for authenticated/
--      anon, service-role only.

-- ---------------------------------------------------------------------------
-- 1. Feature switch (spec sections 58-59)
-- ---------------------------------------------------------------------------
alter table ai_platform_controls
  add column contextual_explanations_enabled boolean not null default true;

comment on column ai_platform_controls.contextual_explanations_enabled is
  'Module 11.5 AI_CONTEXTUAL_EXPLANATIONS_ENABLED. When false, in-module Explain/Why? controls and the contextual API stop, while ordinary financial modules and the Module 11.4 standard question library keep working. Deliberately INDEPENDENT of live_provider_enabled: Module 11.5 never invokes a provider, so turning live providers off must not disable it (spec section 59/92).';

-- ---------------------------------------------------------------------------
-- 2. Contextual audit metadata on the existing resolution audit table
--    (spec section 102)
-- ---------------------------------------------------------------------------
alter table ai_resolution_audit
  add column contextual_target_code text,
  add column contextual_module_code text,
  add column contextual_intent_code text,
  add column contextual_target_entity_hash text,
  add column contextual_historical_context boolean not null default false,
  add column contextual_data_as_of text;

comment on column ai_resolution_audit.contextual_target_entity_hash is
  'Module 11.5: SHA-256 hash prefix of the owned entity id (goal/report) a contextual explanation addressed. Never the raw id, so the audit trail cannot reveal which goal or report a user asked about (spec section 102).';

comment on column ai_resolution_audit.contextual_historical_context is
  'Module 11.5: true when the explanation was bound to a historical report snapshot rather than the household''s current snapshot (spec sections 46-48, 64).';

create index idx_ai_resolution_audit_contextual_target
  on ai_resolution_audit(contextual_target_code, created_at desc)
  where contextual_target_code is not null;

create index idx_ai_resolution_audit_contextual_module
  on ai_resolution_audit(contextual_module_code, created_at desc)
  where contextual_module_code is not null;

-- ---------------------------------------------------------------------------
-- 3. Contextual target registry (spec section 12)
-- ---------------------------------------------------------------------------
create table ai_contextual_explanation_targets (
  id uuid primary key default gen_random_uuid(),
  target_code text not null unique,
  module_code text not null,
  version int not null default 1,
  display_label text not null,
  display_question text not null,
  intent_code text not null,
  standard_question_code text,
  required_domains text[] not null default '{}',
  target_entity_type text,
  stored_pack_block_codes text[] not null default '{}',
  country_scope text[],
  availability_rule text not null default '',
  related_module text not null,
  action_route text not null,
  premium_required boolean not null default true,
  enabled boolean not null default true,
  introduced_version text not null default 'module-11.5',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chk_ai_contextual_targets_module check (
    module_code in ('dashboard', 'score', 'dna', 'resilience', 'goals', 'forecast', 'twin', 'reports')
  ),
  constraint chk_ai_contextual_targets_entity_type check (
    target_entity_type is null or target_entity_type in ('goal', 'report')
  )
);

create index idx_ai_contextual_targets_module_enabled
  on ai_contextual_explanation_targets(module_code, enabled);

alter table ai_contextual_explanation_targets enable row level security;

-- Governance-only, identical to ai_standard_questions (migration 0124) and
-- ai_platform_controls (0115): nothing here is ever read directly by a client
-- and no authenticated/anon policy is created. The application always reads
-- via the service-role client (lib/ai/contextualExplanations/registryDb.ts).
revoke all on ai_contextual_explanation_targets from authenticated, anon;
grant all on ai_contextual_explanation_targets to service_role;

insert into ai_contextual_explanation_targets
  (target_code, module_code, version, display_label, display_question, intent_code, standard_question_code, required_domains, target_entity_type, stored_pack_block_codes, availability_rule, related_module, action_route, premium_required, enabled, introduced_version)
values
  ('DASHBOARD_NET_WORTH', 'dashboard', 1, 'Explain', 'What makes up my net worth?', 'CTX_DASHBOARD_NET_WORTH_EXPLAIN', 'SQ-AI-009', '{balance_sheet}', null, '{net_worth_explanation}', 'Balance-sheet domain certified; composes the certified net worth with the stored net-worth explanation where one exists.', 'dashboard', '/dashboard', true, true, 'module-11.5'),
  ('DASHBOARD_CASH_FLOW', 'dashboard', 1, 'Explain', 'How strong is my monthly cash flow?', 'CTX_DASHBOARD_CASH_FLOW_EXPLAIN', 'SQ-AI-006', '{cash_flow}', null, '{cash_flow_explanation}', 'Cash-flow domain certified. Never recalculates surplus.', 'dashboard', '/dashboard', true, true, 'module-11.5'),
  ('DASHBOARD_SAVINGS_RATE', 'dashboard', 1, 'Explain', 'What does my savings rate mean?', 'CTX_DASHBOARD_SAVINGS_RATE_EXPLAIN', 'SQ-AI-007', '{cash_flow}', null, '{savings_explanation}', 'Cash-flow domain certified and a savings rate is recorded (a missing rate is never shown as 0%).', 'dashboard', '/dashboard', true, true, 'module-11.5'),
  ('DASHBOARD_DATA_QUALITY', 'dashboard', 1, 'Explain', 'What does my data quality state mean?', 'CTX_DASHBOARD_DATA_QUALITY_EXPLAIN', null, '{}', null, '{data_quality_summary}', 'Always answerable from the certified context; stored data-quality commentary added when a compatible pack exists.', 'dashboard', '/dashboard', true, true, 'module-11.5'),
  ('SCORE_OVERALL', 'score', 1, 'Why?', 'Why is my Financial Health Score what it is?', 'CTX_SCORE_OVERALL_EXPLAIN', 'SQ-AI-004', '{score}', null, '{score_explanation}', 'Score domain certified. Never reverse-engineers the scoring model.', 'score', '/score', true, true, 'module-11.5'),
  ('SCORE_CHANGE', 'score', 1, 'Why did this change?', 'Why did my score change?', 'CTX_SCORE_CHANGE_EXPLAIN', 'SQ-AI-005', '{score}', null, '{score_change_explanation}', 'NOT_APPLICABLE when no prior comparable score exists — a movement reason is never invented.', 'score', '/score', true, true, 'module-11.5'),
  ('DNA_PRIMARY_PROFILE', 'dna', 1, 'Explain', 'What does my Financial DNA profile mean?', 'CTX_DNA_PRIMARY_EXPLAIN', null, '{financial_dna}', null, '{}', 'Financial DNA domain certified and a primary profile is classified. The classification is read, never recomputed.', 'financial_dna', '/dna', true, true, 'module-11.5'),
  ('DNA_SECONDARY_PROFILE', 'dna', 1, 'Explain', 'What does my secondary Financial DNA trait mean?', 'CTX_DNA_SECONDARY_EXPLAIN', null, '{financial_dna}', null, '{}', 'Only when a secondary profile is actually classified — NOT_APPLICABLE otherwise.', 'financial_dna', '/dna', true, true, 'module-11.5'),
  ('RESILIENCE_OVERALL', 'resilience', 1, 'Explain', 'What does my Financial Resilience status mean?', 'CTX_RESILIENCE_OVERALL_EXPLAIN', null, '{resilience}', null, '{}', 'Resilience domain certified. Reads the certified status band; never recalculates resilience or runs a stress scenario.', 'resilience', '/resilience', true, true, 'module-11.5'),
  ('RESILIENCE_EMERGENCY_FUND', 'resilience', 1, 'Explain', 'Do I have enough emergency savings?', 'CTX_RESILIENCE_EMERGENCY_FUND_EXPLAIN', 'SQ-AI-011', '{resilience}', null, '{liquidity_explanation}', 'Resilience domain certified and emergency-fund months recorded. No independent threshold logic in 11.5.', 'resilience', '/resilience', true, true, 'module-11.5'),
  ('RESILIENCE_DEBT_PRESSURE', 'resilience', 1, 'Explain', 'How much debt pressure do I have?', 'CTX_RESILIENCE_DEBT_PRESSURE_EXPLAIN', 'SQ-AI-012', '{balance_sheet}', null, '{debt_explanation}', 'Balance-sheet domain certified. Confirmed-zero and missing liability data stay distinguishable.', 'liabilities', '/liabilities', true, true, 'module-11.5'),
  ('GOALS_OVERALL_STATUS', 'goals', 1, 'Explain', 'Which of my goals are on track?', 'CTX_GOALS_OVERALL_EXPLAIN', 'SQ-AI-020', '{goals}', null, '{}', 'Goals domain certified. Counts certified per-goal track statuses; runs no new forecast.', 'goals', '/goals', true, true, 'module-11.5'),
  ('GOAL_STATUS', 'goals', 1, 'Why?', 'Why is this goal off track?', 'CTX_GOAL_STATUS_EXPLAIN', 'SQ-AI-021', '{goals}', 'goal', '{}', 'Requires a goal_id owned by the authenticated household AND currently off-track/at-risk.', 'goals', '/goals', true, true, 'module-11.5'),
  ('FORECAST_SUMMARY', 'forecast', 1, 'Explain', 'What does my forecast mean?', 'CTX_FORECAST_SUMMARY_EXPLAIN', 'SQ-AI-022', '{forecasts}', null, '{forecast_summary}', 'Forecast domain certified and a base-case run exists. Explains the currently displayed forecast only.', 'forecasting', '/forecast', true, true, 'module-11.5'),
  ('FORECAST_RETIREMENT', 'forecast', 1, 'Explain', 'What is affecting my retirement forecast?', 'CTX_FORECAST_RETIREMENT_EXPLAIN', 'SQ-AI-017', '{forecasts,retirement}', null, '{forecast_summary,retirement_explanation}', 'Forecast AND retirement domains certified. Never re-runs the projection.', 'forecasting', '/forecast/retirement', true, true, 'module-11.5'),
  ('TWIN_COMPARISON', 'twin', 1, 'Explain', 'How do I compare with my Financial Twin?', 'CTX_TWIN_COMPARISON_EXPLAIN', 'SQ-AI-023', '{financial_twin}', null, '{twin_summary}', 'Financial Twin domain certified. DOMAIN_UNAVAILABLE with no Twin comparison — generic benchmark education is never substituted.', 'financial_twin', '/financial-twin', true, true, 'module-11.5'),
  ('TWIN_CONFIDENCE', 'twin', 1, 'What does this mean?', 'What does my Twin benchmark confidence mean?', 'CTX_TWIN_CONFIDENCE_EXPLAIN', null, '{financial_twin}', null, '{}', 'Only when a certified Twin run records a benchmark confidence.', 'financial_twin', '/financial-twin', true, true, 'module-11.5'),
  ('REPORT_OVERVIEW', 'reports', 1, 'Explain', 'What period and data does this report cover?', 'CTX_REPORT_OVERVIEW_EXPLAIN', null, '{reports}', 'report', '{report_reading_summary}', 'Requires a report_id owned by the household. Resolved from that report''s own certified record, so it is valid for a current or historical report.', 'reports', '/reports', true, true, 'module-11.5'),
  ('REPORT_SCORE', 'reports', 1, 'Explain', 'What does the Financial Health Score in this report mean?', 'CTX_REPORT_SCORE_EXPLAIN', null, '{score,reports}', 'report', '{score_explanation}', 'Requires a report_id owned by the household AND bound to the current financial snapshot; HISTORICAL_EXPLANATION_UNAVAILABLE otherwise.', 'score', '/score', true, true, 'module-11.5'),
  ('REPORT_CASH_FLOW', 'reports', 1, 'Explain', 'What does the cash-flow section of this report mean?', 'CTX_REPORT_CASH_FLOW_EXPLAIN', null, '{cash_flow,reports}', 'report', '{cash_flow_explanation}', 'Requires a report_id owned by the household AND bound to the current financial snapshot; HISTORICAL_EXPLANATION_UNAVAILABLE otherwise.', 'dashboard', '/dashboard', true, true, 'module-11.5');
