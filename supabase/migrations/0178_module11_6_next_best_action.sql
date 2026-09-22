-- Module 11.6 — Rules-First Next Best Action (Module 11 AI Remediation
-- Programme R5, 2026-09-22; brief sections 40-49).
--
-- MIGRATION NUMBER: 0178 — next after this programme's 0175/0176/0177.
-- ADDITIVE ONLY. No Module 1-10 table is touched: Module 11.6 CONSUMES
-- certified Module 1-10 statuses through the FinancialContextObject and
-- writes only its own audit table.
--
-- A. Kill switch (brief section 36 "NBA switch where implemented").
--    Semantics mirror Module 11.5's (0126): ai_globally_enabled=false stops
--    NBA (an AI-surfaced feature); live_provider_enabled=false does NOT
--    (NBA never calls a provider — brief section 47); this switch alone
--    stops NBA and SQ-AI-003/025 while every other feature keeps working.
--    Ships true, like every other shipped zero-cost feature switch
--    (contextual_explanations_enabled); audited by 0115's generic trigger.
alter table ai_platform_controls
  add column if not exists next_best_action_enabled boolean not null default true;
comment on column ai_platform_controls.next_best_action_enabled is
  'Module 11.6: whether Next Best Action (and SQ-AI-003/025, which resolve from it) is served. Zero-cost deterministic feature; independent of live_provider_enabled.';

-- B. Evaluation audit (brief section 49 "audit"; one row per evaluation).
--    Records WHICH certified state (snapshot + context hash) produced WHICH
--    ranked actions under WHICH rules/policy versions. No provider fields
--    exist here by design: provider_calls and quota consumption are
--    structurally zero and are asserted by tests, not recorded as data.
--    user_id-scoped RLS (select own) like every Module 11 output table;
--    writes are service-role only.
create table if not exists ai_next_best_action_evaluations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  household_id uuid references households(id) on delete cascade,
  snapshot_id text,
  context_hash text not null,
  rules_version text not null,
  ranking_policy_version text not null,
  country text,
  reporting_currency text,
  candidate_count integer not null check (candidate_count >= 0),
  suppressed_count integer not null check (suppressed_count >= 0),
  action_count integer not null check (action_count between 0 and 3),
  action_codes text[] not null default '{}',
  actions_json jsonb not null default '[]',
  suppressed_json jsonb not null default '[]',
  trigger text not null check (trigger in ('api', 'standard_question', 'insight_pack', 'admin')),
  evaluated_at timestamptz not null default now(),
  constraint chk_ai_nba_action_count_matches check (action_count = coalesce(array_length(action_codes, 1), 0))
);
create index if not exists idx_ai_nba_evaluations_user on ai_next_best_action_evaluations (user_id, evaluated_at desc);
alter table ai_next_best_action_evaluations enable row level security;
create policy "select own ai_next_best_action_evaluations" on ai_next_best_action_evaluations
  for select using (auth.uid() = user_id);
comment on table ai_next_best_action_evaluations is
  'Module 11.6 audit: one row per deterministic Next Best Action evaluation. Max 3 actions structurally (CHECK). No provider or cost columns: the feature is zero-cost by construction.';

-- C. The pre-seeded task cost limit for next_best_action (0115) is left
--    untouched: Module 11.6 never admits a provider request, so the limit is
--    inert; it remains as the closed vocabulary's placeholder.
