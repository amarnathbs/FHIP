-- Module 11.4 — Standard Personalised Question Library & Zero-Cost Premium
-- AI Experience (spec sections 60-61).
--
-- NOT APPLIED to DEV or production by this pass — hand this file to the
-- Product Owner for explicit DEV authorisation (spec section 60). Collision
-- check performed against origin/main @ 99f0cc0 and every reachable sibling
-- worktree at the time this was written; 0123 is the latest number found
-- anywhere, so 0124 is free.
--
-- Two additive changes, both backward compatible with every existing
-- Module 11.0-11.3 caller:
--
--   1. Three new NULLABLE columns on the EXISTING `ai_resolution_audit`
--      table (Module 11.2, migration 0117) rather than a parallel audit
--      table (spec section 61). That table's own CHECK constraints
--      (chk_ai_resolution_audit_no_provider_calls,
--      chk_ai_resolution_audit_zero_cost_no_quota) are untouched and
--      continue to apply to every row this phase writes.
--
--   2. A new table, `ai_standard_questions` — the DB-backed, admin-
--      controlled SUBSET of the catalogue (enabled/display_order only;
--      wording and resolution mappings remain code-defined in
--      lib/ai/standardQuestions/catalogue.ts, the same "stable taxonomy
--      lives in code" precedent as lib/ai/resolution/intentTaxonomy.ts).
--      Governance-only, like ai_platform_controls: RLS enabled, zero
--      policies for authenticated/anon, service-role only. Seeded with the
--      approved 25 (spec section 11) so admin read visibility (spec
--      section 59) has real rows from the moment this migration lands.

alter table ai_resolution_audit
  add column standard_question_code text,
  add column standard_question_version int,
  add column answer_origins text[] not null default '{}';

create index idx_ai_resolution_audit_standard_question
  on ai_resolution_audit(standard_question_code, created_at desc)
  where standard_question_code is not null;

create table ai_standard_questions (
  id uuid primary key default gen_random_uuid(),
  question_code text not null unique,
  version int not null default 1,
  display_text text not null,
  short_label text not null,
  category text not null,
  description text not null default '',
  personalised boolean not null default true,
  premium_required boolean not null default true,
  country_scope text[],
  required_domains text[] not null default '{}',
  primary_intent_code text,
  secondary_intent_codes text[] not null default '{}',
  preferred_resolution_sources text[] not null default '{}',
  stored_pack_block_codes text[] not null default '{}',
  related_module text not null,
  action_route text not null,
  display_order int not null,
  availability_rule jsonb not null default '{}'::jsonb,
  enabled boolean not null default true,
  introduced_version text not null default 'module-11.4',
  effective_from timestamptz not null default now(),
  effective_to timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_ai_standard_questions_enabled_order on ai_standard_questions(enabled, display_order);

alter table ai_standard_questions enable row level security;

-- Governance-only, same pattern as ai_platform_controls (migration 0115):
-- nothing here is ever read directly by a client, and no authenticated/anon
-- policy is created. The application always reads via the service-role
-- client (lib/ai/standardQuestions/catalogueDb.ts), same as every other
-- Module 11 config table.
revoke all on ai_standard_questions from authenticated, anon;
grant all on ai_standard_questions to service_role;

insert into ai_standard_questions
  (question_code, version, display_text, short_label, category, description, personalised, premium_required, country_scope, required_domains, primary_intent_code, secondary_intent_codes, preferred_resolution_sources, stored_pack_block_codes, related_module, action_route, display_order, enabled, introduced_version)
values
  ('SQ-AI-001', 1, 'How healthy are my finances overall?', 'Overall health', 'FINANCIAL_OVERVIEW', 'A high-level summary of overall financial health.', true, true, null, '{score}', 'FINANCIAL_HEALTH_SCORE', '{OVERALL_FINANCIAL_SUMMARY_EXPLANATION}', '{COMPOSED_ZERO_COST,DETERMINISTIC}', '{overall_financial_summary}', 'dashboard', '/dashboard', 1, true, 'module-11.4'),
  ('SQ-AI-002', 1, 'What are my strongest financial areas?', 'Strongest areas', 'FINANCIAL_OVERVIEW', 'The household''s strongest recorded financial areas.', true, true, null, '{}', 'STRENGTHS_EXPLANATION', '{}', '{STORED_PERSONALISED}', '{strengths}', 'dashboard', '/dashboard', 2, true, 'module-11.4'),
  ('SQ-AI-003', 1, 'What should I focus on first?', 'Focus first', 'FINANCIAL_OVERVIEW', 'The single highest-priority already-ranked review area.', true, true, null, '{}', 'PRIORITY_REVIEW_AREAS_EXPLANATION', '{}', '{STORED_PERSONALISED}', '{priority_review_areas}', 'recommendations', '/recommendations', 3, true, 'module-11.4'),
  ('SQ-AI-004', 1, 'Why is my Financial Health Score what it is?', 'Why my Score', 'SCORE_AND_BEHAVIOUR', 'A grounded explanation of the current Financial Health Score.', true, true, null, '{score}', 'FINANCIAL_HEALTH_SCORE', '{SCORE_EXPLANATION}', '{COMPOSED_ZERO_COST,DETERMINISTIC}', '{score_explanation}', 'score', '/score', 4, true, 'module-11.4'),
  ('SQ-AI-005', 1, 'Why did my score change?', 'Score change', 'SCORE_AND_BEHAVIOUR', 'Why the Financial Health Score moved since the previous valid comparison.', true, true, null, '{score}', 'SCORE_CHANGE_EXPLANATION', '{}', '{STORED_PERSONALISED}', '{score_change_explanation}', 'score', '/score', 5, true, 'module-11.4'),
  ('SQ-AI-006', 1, 'How strong is my monthly cash flow?', 'Cash flow strength', 'CASH_FLOW', 'The certified monthly surplus/deficit position, in plain language.', true, true, null, '{cash_flow}', 'MONTHLY_SURPLUS', '{CASH_FLOW_EXPLANATION}', '{COMPOSED_ZERO_COST,DETERMINISTIC}', '{cash_flow_explanation}', 'dashboard', '/dashboard', 6, true, 'module-11.4'),
  ('SQ-AI-007', 1, 'What does my savings rate mean?', 'Savings rate', 'CASH_FLOW', 'Deterministic savings rate + Knowledge Base definition + stored personalised explanation.', true, true, null, '{cash_flow}', 'SAVINGS_RATE', '{SAVINGS_RATE_DEFINITION,SAVINGS_EXPLANATION}', '{COMPOSED_ZERO_COST}', '{savings_explanation}', 'dashboard', '/dashboard', 7, true, 'module-11.4'),
  ('SQ-AI-008', 1, 'Where is most of my money going?', 'Where money goes', 'CASH_FLOW', 'Recorded expense composition, in plain language.', true, true, null, '{cash_flow}', 'MONTHLY_EXPENSES', '{EXPENSE_EXPLANATION}', '{COMPOSED_ZERO_COST,DETERMINISTIC}', '{expense_explanation}', 'expenses', '/expenses', 8, true, 'module-11.4'),
  ('SQ-AI-009', 1, 'What makes up my net worth?', 'Net worth composition', 'BALANCE_SHEET_AND_LIQUIDITY', 'Recorded assets minus liabilities, and what makes up the total.', true, true, null, '{balance_sheet}', 'CURRENT_NET_WORTH', '{NET_WORTH_EXPLANATION}', '{COMPOSED_ZERO_COST,DETERMINISTIC}', '{net_worth_explanation}', 'dashboard', '/dashboard', 9, true, 'module-11.4'),
  ('SQ-AI-010', 1, 'Is my wealth concentrated?', 'Concentration', 'BALANCE_SHEET_AND_LIQUIDITY', 'Whether recorded wealth is concentrated in one asset type/holding.', true, true, null, '{balance_sheet}', 'ASSET_CONCENTRATION_EXPLANATION', '{INVESTMENT_CONCENTRATION_DEFINITION}', '{COMPOSED_ZERO_COST,STORED_PERSONALISED}', '{asset_concentration_explanation}', 'assets', '/assets', 10, true, 'module-11.4'),
  ('SQ-AI-011', 1, 'Do I have enough emergency savings?', 'Emergency savings', 'BALANCE_SHEET_AND_LIQUIDITY', 'Emergency-fund coverage in months, in plain language.', true, true, null, '{resilience}', 'EMERGENCY_FUND_MONTHS', '{EMERGENCY_FUND_DEFINITION,LIQUIDITY_EXPLANATION}', '{COMPOSED_ZERO_COST,DETERMINISTIC}', '{liquidity_explanation}', 'resilience', '/resilience', 11, true, 'module-11.4'),
  ('SQ-AI-012', 1, 'How much debt pressure do I have?', 'Debt pressure', 'BALANCE_SHEET_AND_LIQUIDITY', 'Recorded liabilities and debt pressure.', true, true, null, '{balance_sheet}', 'TOTAL_LIABILITIES', '{DEBT_EXPLANATION}', '{COMPOSED_ZERO_COST,DETERMINISTIC}', '{debt_explanation}', 'liabilities', '/liabilities', 12, true, 'module-11.4'),
  ('SQ-AI-013', 1, 'What happens if interest rates increase?', 'Rate rise impact', 'BALANCE_SHEET_AND_LIQUIDITY', 'Only ACTIVE where an existing certified stress result already covers this household — 11.4 never runs a new calculation.', true, true, null, '{resilience}', null, '{}', '{DETERMINISTIC}', '{}', 'resilience', '/resilience', 13, true, 'module-11.4'),
  ('SQ-AI-014', 1, 'How diversified are my investments?', 'Diversification', 'INVESTMENTS_AND_RETIREMENT', 'Recorded investment diversification.', true, true, null, '{investments}', 'INVESTMENT_DIVERSIFICATION', '{DIVERSIFICATION_DEFINITION,INVESTMENT_EXPLANATION}', '{COMPOSED_ZERO_COST,DETERMINISTIC}', '{investment_explanation}', 'investments', '/investments', 14, true, 'module-11.4'),
  ('SQ-AI-015', 1, 'What are the main risks in my investments?', 'Investment risks', 'INVESTMENTS_AND_RETIREMENT', 'Reuses the validated investment explanation block (no dedicated investment-risk pack block exists yet).', true, true, null, '{investments}', 'INVESTMENT_EXPLANATION', '{}', '{STORED_PERSONALISED}', '{investment_explanation}', 'investments', '/investments', 15, true, 'module-11.4'),
  ('SQ-AI-016', 1, 'Am I progressing toward retirement?', 'Retirement progress', 'INVESTMENTS_AND_RETIREMENT', 'Recorded retirement balance and progress.', true, true, null, '{retirement}', 'RETIREMENT_BALANCE', '{RETIREMENT_EXPLANATION}', '{COMPOSED_ZERO_COST,DETERMINISTIC}', '{retirement_explanation}', 'retirement', '/retirement', 16, true, 'module-11.4'),
  ('SQ-AI-017', 1, 'What is affecting my retirement forecast?', 'Retirement forecast drivers', 'INVESTMENTS_AND_RETIREMENT', 'A grounded explanation of the current retirement forecast.', true, true, null, '{forecasts,retirement}', 'FORECAST_SUMMARY_EXPLANATION', '{RETIREMENT_EXPLANATION}', '{STORED_PERSONALISED,COMPOSED_ZERO_COST}', '{forecast_summary,retirement_explanation}', 'forecasting', '/forecast/retirement', 17, true, 'module-11.4'),
  ('SQ-AI-018', 1, 'Is my insurance information complete?', 'Insurance completeness', 'PROTECTION', 'The recorded data-quality state of insurance information.', true, true, null, '{insurance}', 'INSURANCE_DATA_STATUS', '{}', '{DETERMINISTIC}', '{}', 'insurance', '/insurance', 18, true, 'module-11.4'),
  ('SQ-AI-019', 1, 'What does my protection position mean?', 'Protection meaning', 'PROTECTION', 'Never invents adequacy when insurance data is missing.', true, true, null, '{insurance}', 'INSURANCE_EXPLANATION', '{}', '{STORED_PERSONALISED}', '{insurance_explanation}', 'insurance', '/insurance', 19, true, 'module-11.4'),
  ('SQ-AI-020', 1, 'Which goals are on track?', 'Goals on track', 'GOALS_AND_FORECAST', 'The certified count of on-track vs at-risk goals.', true, true, null, '{goals}', 'GOALS_ON_TRACK_COUNT', '{GOALS_AT_RISK_COUNT}', '{DETERMINISTIC}', '{}', 'goals', '/goals', 20, true, 'module-11.4'),
  ('SQ-AI-021', 1, 'Why is one of my goals off track?', 'Goal off track', 'GOALS_AND_FORECAST', 'Requires the caller to select one of their own eligible off-track goals.', true, true, null, '{goals}', 'GOALS_AT_RISK_COUNT', '{}', '{DETERMINISTIC}', '{}', 'goals', '/goals', 21, true, 'module-11.4'),
  ('SQ-AI-022', 1, 'What does my forecast mean?', 'Forecast meaning', 'GOALS_AND_FORECAST', 'What the current base-case forecast means, in plain language.', true, true, null, '{forecasts}', 'FORECAST_LATEST_RUN_DATE', '{FORECASTING_DEFINITION,FORECAST_SUMMARY_EXPLANATION}', '{COMPOSED_ZERO_COST,STORED_PERSONALISED}', '{forecast_summary}', 'forecasting', '/forecast', 22, true, 'module-11.4'),
  ('SQ-AI-023', 1, 'How do I compare with my Financial Twin?', 'Twin comparison', 'BENCHMARK_AND_CROSS_BORDER', 'DOMAIN_UNAVAILABLE (never generic benchmark text) with no Twin comparison available.', true, true, null, '{financial_twin}', 'TWIN_COHORT', '{TWIN_SUMMARY_EXPLANATION}', '{COMPOSED_ZERO_COST,DETERMINISTIC}', '{twin_summary}', 'financial_twin', '/financial-twin', 23, true, 'module-11.4'),
  ('SQ-AI-024', 1, 'What are my cross-border financial exposures?', 'Cross-border exposure', 'BENCHMARK_AND_CROSS_BORDER', 'Only shown where cross-border context is applicable.', true, true, null, '{cross_border}', 'COUNTRIES_PRESENT', '{CROSS_BORDER_SUMMARY_EXPLANATION}', '{COMPOSED_ZERO_COST,DETERMINISTIC}', '{cross_border_summary}', 'forecasting', '/forecast/cross-border', 24, true, 'module-11.4'),
  ('SQ-AI-025', 1, 'What are the three most important things this month?', 'Top 3 this month', 'FINANCIAL_OVERVIEW', 'The same already-ranked priority list as SQ-AI-003, presented as up to 3 items.', true, true, null, '{}', 'PRIORITY_REVIEW_AREAS_EXPLANATION', '{}', '{STORED_PERSONALISED}', '{priority_review_areas}', 'recommendations', '/recommendations', 25, true, 'module-11.4');
