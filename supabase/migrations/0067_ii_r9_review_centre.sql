-- Investment Intelligence R9 — Goals, Forecasting & Review Centre.
--
-- ADDITIVE ONLY. No existing column, constraint, index, or row is removed.
-- R9's governing principle (R9_ARCHITECTURE.md, spec section 148): integrate
-- with canonical FHIP Goals (user_goals/goal_funding_sources, migration
-- 0009) and canonical FHIP Forecasting (forecast_runs/goal_forecasts,
-- migrations 0009/0013/0028), never duplicate them. Consequently this
-- migration does NOT create ii_goals, ii_forecasting_engine,
-- ii_retirement_goals, or ii_net_worth_engine — those are explicitly
-- prohibited by the spec (section 5) and nothing here recreates them.
--
-- What R9 actually needs schema-wise, after R9-P0 discovery
-- (R9_CANONICAL_INTEGRATION_DISCOVERY.md):
--   1. ii_goal_allocations (migration 0034) ALREADY has everything R9 needs
--      for allocation lifecycle (status: active/superseded/removed;
--      effective_from/effective_to) — reused as-is, zero schema change.
--   2. goal_funding_sources (migration 0009) ALREADY enforces the <=100%
--      allocation cap via checkFundingAllocation() and ALREADY feeds
--      Forecasting (lib/services/forecastData.ts) — reused as-is.
--   3. The one genuinely new concept is the Review Centre itself (spec
--      section 39 — "no dedicated review-centre entity exists anywhere in
--      the codebase" per discovery), which is what this migration adds:
--      ii_review_items (the review item ledger) and
--      ii_review_rule_registry (the versioned, trusted-write-only
--      deterministic rule/threshold registry, spec section 132).
--
-- Governing docs: R9_CANONICAL_INTEGRATION_DISCOVERY.md, R9_ARCHITECTURE.md,
-- R9_REVIEW_CENTRE_RULES.md, R9_GOAL_ALLOCATION_CONTRACT.md.

-- ===========================================================================
-- SECTION 0 — ii_goal_allocations: one additive column. The R1 schema
-- (migration 0034) deliberately never persisted which investments.id a
-- given allocation's goal_funding_sources write-through targeted (only
-- passed transiently as a function parameter) — correct for R1, where no
-- write-through ever actually fired in production. R9 activates the
-- write-through for real (R9_GOAL_ALLOCATION_CONTRACT.md), so an update or
-- removal now needs a durable way to find the SPECIFIC goal_funding_sources
-- row a given ii_goal_allocations row produced, rather than affecting every
-- investment-sourced funding source on the goal. linked_investment_id is
-- nullable (an allocation created before the position was published has no
-- value yet) and intentionally has no uniqueness constraint — the same
-- investments.id may be allocated across multiple goals (spec section 15).
-- ===========================================================================
alter table ii_goal_allocations add column linked_investment_id uuid references investments(id);
create index idx_ii_goal_allocations_linked_investment on ii_goal_allocations(linked_investment_id) where linked_investment_id is not null;

-- ===========================================================================
-- SECTION 1 — ii_review_rule_registry: versioned, effective-dated,
-- trusted-write-only deterministic thresholds (spec sections 45, 51, 120,
-- 132). RLS follows the SAME read-only-for-authenticated / no-write-policy
-- pattern as forecast_global_assumptions (migration 0013) — under RLS with
-- no insert/update/delete policy, only the service-role key (which bypasses
-- RLS entirely, the established "trusted service" pattern in this project)
-- can write. Ordinary users cannot alter rule definitions or thresholds
-- (critical fail condition — spec section 143 item 8/9 analog for review
-- rules; section 120).
-- ===========================================================================
create table ii_review_rule_registry (
  id uuid primary key default gen_random_uuid(),
  rule_key text not null,
  rule_version text not null,
  review_type text not null check (review_type in ('data_quality', 'goal', 'portfolio', 'performance', 'sip', 'tax_cost')),
  category text not null,
  default_severity text not null check (default_severity in ('info', 'low', 'medium', 'high')),
  compliance_classification text not null default 'observation' check (compliance_classification in ('observation', 'education', 'simulation')),
  threshold_config jsonb not null default '{}'::jsonb,
  description text not null,
  effective_from date not null default current_date,
  effective_to date,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (rule_key, rule_version)
);
create index idx_ii_review_rule_registry_active on ii_review_rule_registry(rule_key) where is_active;

alter table ii_review_rule_registry enable row level security;
create policy "read ii_review_rule_registry" on ii_review_rule_registry
  for select using (true);

-- ===========================================================================
-- SECTION 2 — ii_review_items: the Review Centre ledger. Every row is a
-- deterministic OBSERVATION/EDUCATION/SIMULATION (never
-- PERSONALISED_ADVICE — spec sections 40-42) produced by re-reading already
-- certified data from another module; the review engine never derives new
-- financial truth (spec sections 40, 130, 131).
--
-- Provenance (spec section 46, 60): source_module + source_record_id +
-- source_record_version identify exactly which upstream row/run produced
-- this item; evidence carries only computed numbers/identifiers, never raw
-- source-document content (spec section 61 — no raw document exposure).
--
-- Dedup / no-spam (spec section 50): identity_key is a deterministic hash
-- of (user_id, review_type, category, source_record_id) — re-running the
-- engine on unchanged evidence resolves to the SAME open row (upsert on
-- identity_key) rather than inserting a duplicate. The partial unique index
-- below enforces at most one non-terminal (open/acknowledged) row per
-- identity_key; superseded/resolved/dismissed rows are kept for history.
-- ===========================================================================
create table ii_review_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  review_type text not null check (review_type in ('data_quality', 'goal', 'portfolio', 'performance', 'sip', 'tax_cost')),
  category text not null,
  severity text not null check (severity in ('info', 'low', 'medium', 'high')),
  compliance_classification text not null default 'observation' check (compliance_classification in ('observation', 'education', 'simulation')),
  title text not null,
  description text not null,
  evidence jsonb not null default '{}'::jsonb,
  source_module text not null check (source_module in ('goals', 'forecasting', 'retirement', 'ii_publishing', 'ii_r4_performance', 'ii_r5_sip_xray', 'ii_r6_tax', 'ii_data_quality')),
  source_record_id uuid, -- app-validated polymorphic pointer (goal_forecasts.id, ii_analytics_results.id, investments.id, etc. depending on source_module) — never a raw document id (spec section 61)
  source_record_version text, -- e.g. goal_forecasts.model_version, forecast_runs.engine_version, ii_analytics_results.calculation_version
  review_engine_version text not null,
  rule_key text not null,
  rule_version text not null,
  identity_key text not null,
  as_of_date date not null,
  status text not null default 'open' check (status in ('open', 'acknowledged', 'resolved', 'dismissed', 'superseded')),
  superseded_by_id uuid references ii_review_items(id),
  user_note text,
  acknowledged_at timestamptz,
  resolved_at timestamptz,
  dismissed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_ii_review_items_user on ii_review_items(user_id);
create index idx_ii_review_items_user_status on ii_review_items(user_id, status);
create index idx_ii_review_items_type on ii_review_items(user_id, review_type);
create index idx_ii_review_items_identity on ii_review_items(user_id, identity_key);

-- No-duplicate-spam guarantee (spec section 50), enforced at the database
-- level, not just application discipline: at most one open/acknowledged row
-- per (user, identity_key). A rule re-run either updates this row in place
-- (unchanged evidence) or marks it 'superseded' and inserts a fresh row
-- (changed evidence) — both compatible with this constraint since the
-- superseded row is no longer open/acknowledged when the new one is
-- inserted (application-layer ordering enforced by reviewCentreData.ts).
create unique index uidx_ii_review_items_open_identity
  on ii_review_items(user_id, identity_key)
  where status in ('open', 'acknowledged');

alter table ii_review_items enable row level security;
create policy "own ii_review_items" on ii_review_items
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ===========================================================================
-- SECTION 3 — ii_audit_events: extend the R1/R2/R3 event-type vocabulary
-- with R9's goal-allocation-lifecycle and review-centre event types (spec
-- section 73). All prior values reproduced verbatim; nothing removed.
-- ===========================================================================
alter table ii_audit_events drop constraint ii_audit_events_event_type_check;
alter table ii_audit_events add constraint ii_audit_events_event_type_check check (event_type in (
  -- R1 (migration 0036)
  'upload', 'parse', 'parse_completed', 'reconciliation_opened', 'reconciliation_resolved',
  'user_correction', 'admin_correction', 'publication', 'republishing', 'nav_price_update',
  'calculation', 'rule_change', 'goal_allocation', 'export', 'permission_grant',
  'permission_revoke', 'professional_access', 'archive', 'deletion',
  -- R2 (migration 0039)
  'document_uploaded', 'source_detected', 'parse_started', 'parse_failed',
  'parser_version_used', 'account_resolved', 'instrument_resolved',
  'reconciliation_case_created', 'reconciliation_case_resolved',
  'portfolio_certified', 'portfolio_certified_with_warnings', 'portfolio_failed',
  'document_superseded', 'document_processing_failed',
  -- R3 (migration 0042)
  'publication_previewed', 'publication_created', 'publication_confirmed',
  'manual_duplicate_linked', 'manual_record_superseded', 'publication_refreshed',
  'publication_superseded', 'publication_unpublished', 'publication_republished',
  'publication_failed', 'conflict_detected', 'conflict_resolved',
  -- R9 (spec section 73) — new
  'goal_allocation_created', 'goal_allocation_changed', 'goal_allocation_removed',
  'forecast_integration_run', 'review_item_created', 'review_item_resolved',
  'review_acknowledged', 'review_dismissed'
));

-- ===========================================================================
-- SECTION 4 — seed the initial deterministic rule registry (rule_version
-- 'r9-1.0.0'). Every threshold cited here is also documented in
-- R9_REVIEW_CENTRE_RULES.md; this is the single source of truth the engine
-- reads at runtime, not a hardcoded constant in application code, so a
-- future threshold change is a new versioned row, never a silent edit
-- (spec section 132/133).
-- ===========================================================================
insert into ii_review_rule_registry (rule_key, rule_version, review_type, category, default_severity, compliance_classification, threshold_config, description) values
  ('unallocated_investment', 'r9-1.0.0', 'goal', 'unallocated_investment', 'info', 'observation', '{"minUnallocatedValue": 0}'::jsonb, 'A published or manual investment has no active goal_funding_sources allocation.'),
  ('goal_allocation_incomplete', 'r9-1.0.0', 'goal', 'goal_allocation_incomplete', 'low', 'observation', '{}'::jsonb, 'A goal has at least one active funding source but total allocation to it is below 100% of its own linked balances.'),
  ('goal_forecast_gap', 'r9-1.0.0', 'goal', 'goal_forecast_gap', 'medium', 'observation', '{"trackStatuses": ["off_track", "at_risk"]}'::jsonb, 'The canonical Goals forecast (goal_forecasts.track_status) reports off_track or at_risk for a goal with an active funding source.'),
  ('stale_valuation', 'r9-1.0.0', 'data_quality', 'stale_valuation', 'low', 'observation', '{"staleDays": 90}'::jsonb, 'An II-published investment has not been refreshed (ii_last_refreshed_at) within the threshold window.'),
  ('reconciliation_open', 'r9-1.0.0', 'data_quality', 'unresolved_instrument', 'medium', 'observation', '{}'::jsonb, 'An open ii_reconciliation_cases row exists for the user with no resolution.'),
  ('benchmark_underperformance', 'r9-1.0.0', 'performance', 'benchmark_underperformance', 'medium', 'observation', '{"underperformanceFraction": 0.02}'::jsonb, 'A scheme''s certified R4 scheme_active_return (since-inception CAGR minus benchmark CAGR) is more than 2 percentage points negative.'),
  ('sip_interruption', 'r9-1.0.0', 'sip', 'sip_interruption', 'low', 'observation', '{"missedInstalments": 2}'::jsonb, 'An active R5 SIP series has missed the configured number of consecutive expected instalments.'),
  ('exit_load_exposure', 'r9-1.0.0', 'tax_cost', 'exit_load_exposure', 'low', 'observation', '{}'::jsonb, 'A lot within an active exit-load window would incur an exit load if disposed today (R6 exit_load_schedules).'),
  ('tax_lot_incomplete', 'r9-1.0.0', 'tax_cost', 'tax_lot_incomplete', 'medium', 'observation', '{}'::jsonb, 'A holding has an unresolved or partial cost-base status in R6 tax-lot data.')
on conflict (rule_key, rule_version) do nothing;
