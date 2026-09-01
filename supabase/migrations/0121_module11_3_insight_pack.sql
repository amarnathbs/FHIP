-- Module 11.3 — Monthly Personalised AI Insight Pack, Batch Generation,
-- Grounding Validation & Persistent Answer Store.
--
-- Builds the STORED_PERSONALISED layer Module 11.2's router already routes
-- to (lib/ai/resolution/storedPersonalisedResolver.ts reads ai_insights;
-- this migration adds the normalised, auditable pack/block tables that FEED
-- ai_insights, plus the structural invariants spec sections 106-107 require).
--
-- MIGRATION NUMBER: 0121. Collision-checked fresh (not assumed) against:
--   * this branch's own chain (`node scripts/check-migration-versions.mjs`
--     reported "next version is 0121" after the Module 11.2 reconciliation
--     merge filled the pre-existing 0117 gap);
--   * origin/main via check-migration-versions-against-branch.mjs (no
--     collision, 116 vs 115 files, only this file added);
--   * every other D:/fhip-* worktree's supabase/migrations/ on disk
--     (D:/fhip-fdh16 and D:/fhip-fdh13-admin-baseline top out at 0120;
--     every other worktree tops out lower; none holds 0121+).
--   * every origin/* remote ref (origin/main and origin/HEAD top out at
--     0120).
-- 0121 is therefore collision-free everywhere this repository exists.
--
-- ADDITIVE ONLY. No Module 1-10 table is touched. Module 11.0's ai_insights
-- (migration 0110) is READ and UPSERTed by the new service in application
-- code only — its schema is not altered by this migration.

-- ---------------------------------------------------------------------------
-- A. ai_insight_pack_batches — the commercial "batch" grouping (spec
-- section 26). A batch groups N households' independent pack-generation
-- jobs; it is bookkeeping only. Each household's own job still gets its own
-- context, its own provider call, its own audit row and its own cost
-- attribution (spec section 25) — nothing here lets two households' data
-- share a row.
-- ---------------------------------------------------------------------------
create table ai_insight_pack_batches (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  task_type text not null default 'monthly_insight_pack',
  status text not null default 'PENDING'
    check (status in ('PENDING', 'SUBMITTED', 'COMPLETED', 'PARTIAL', 'FAILED')),
  submitted_at timestamptz,
  completed_at timestamptz,
  request_count integer not null default 0 check (request_count >= 0),
  success_count integer not null default 0 check (success_count >= 0),
  failure_count integer not null default 0 check (failure_count >= 0),
  estimated_cost_usd numeric(12, 6) not null default 0 check (estimated_cost_usd >= 0),
  actual_cost_usd numeric(12, 6) check (actual_cost_usd is null or actual_cost_usd >= 0),
  error_summary text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chk_ai_insight_pack_batches_counts check (success_count + failure_count <= request_count)
);

comment on table ai_insight_pack_batches is
  'Module 11.3 spec section 26. Bookkeeping-only grouping of independent per-household pack generation jobs. Governance-only: no end-user RLS policy, matching ai_model_registry (Module 11.0) precedent.';

alter table ai_insight_pack_batches enable row level security;
-- Zero end-user policies — service-role only, same pattern as
-- ai_model_registry / ai_platform_controls / ai_task_cost_limits.

-- ---------------------------------------------------------------------------
-- B. ai_insight_packs — one logical pack per (subject, snapshot, context,
-- prompt, schema, country, language) identity (spec section 9).
-- ---------------------------------------------------------------------------
create table ai_insight_packs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  household_id uuid references households(id) on delete cascade,

  -- Identity dimensions (spec section 9).
  snapshot_id text not null,
  financial_context_hash text not null,
  context_schema_version text not null,
  pack_schema_version text not null,
  prompt_code text not null,
  prompt_version integer not null,
  country_context text,
  language text not null default 'en',

  -- Provider/model actually used (spec sections 27, 30).
  provider text not null,
  model text not null,
  model_version text,

  -- State machine (spec section 7).
  status text not null default 'PENDING' check (status in (
    'PENDING', 'QUEUED', 'GENERATING', 'PROVIDER_COMPLETE', 'VALIDATING',
    'READY', 'PARTIAL', 'FAILED', 'STALE', 'SUPERSEDED', 'CANCELLED'
  )),
  overall_confidence text check (overall_confidence is null or overall_confidence in ('HIGH', 'MEDIUM', 'LOW')),
  grounding_status text check (grounding_status is null or grounding_status in ('PASS', 'PARTIAL', 'FAIL')),
  critical_safety_failure boolean not null default false,

  -- Provenance (spec sections 26-27, 70).
  generation_mode text not null default 'BATCH_AI' check (generation_mode = 'BATCH_AI'),
  batch_id uuid references ai_insight_pack_batches(id) on delete set null,
  ai_run_id uuid references ai_runs(id) on delete set null,
  idempotency_key text,

  -- Cost attribution (spec section 70) — denormalised onto the pack row so
  -- an admin/KPI query never needs to join ai_runs to answer "what did this
  -- pack cost".
  input_tokens integer,
  output_tokens integer,
  estimated_cost_usd numeric(12, 6),

  -- Lifecycle timestamps (spec section 106).
  generated_at timestamptz,
  validated_at timestamptz,
  ready_at timestamptz,
  stale_at timestamptz,
  superseded_at timestamptz,
  failure_code text,

  retry_count integer not null default 0 check (retry_count >= 0),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- ---------------------------------------------------------------------
  -- Structural READY invariant (spec section 107) — it is impossible to
  -- persist status=READY without validated_at, ready_at and a PASS
  -- grounding status, and impossible for a READY row to carry a critical
  -- safety failure. This is enforced by Postgres, not merely by
  -- application code.
  -- ---------------------------------------------------------------------
  constraint chk_ai_insight_packs_ready_requires_validation check (
    status <> 'READY'
    or (validated_at is not null and ready_at is not null and grounding_status = 'PASS' and critical_safety_failure = false)
  ),
  constraint chk_ai_insight_packs_partial_requires_validation check (
    status <> 'PARTIAL'
    or (validated_at is not null and grounding_status in ('PARTIAL', 'PASS') and critical_safety_failure = false)
  ),
  constraint chk_ai_insight_packs_failed_no_ready_timestamps check (
    status not in ('FAILED', 'CANCELLED') or ready_at is null
  )
);

comment on table ai_insight_packs is
  'Module 11.3 spec section 27. One logical pack per certified household snapshot/context/prompt identity. READY is structurally impossible without a passed grounding validation (spec section 107).';

-- Pack identity (spec section 9): only one row per exact identity tuple,
-- regardless of lifecycle state (a superseded historical pack keeps its OWN
-- identity — supersession happens because the SNAPSHOT/context changed,
-- which is a different identity, not a second generation of the same one).
create unique index uq_ai_insight_packs_identity on ai_insight_packs (
  user_id, snapshot_id, financial_context_hash, context_schema_version,
  pack_schema_version, prompt_code, prompt_version,
  coalesce(country_context, '~'), language
);

create index idx_ai_insight_packs_user on ai_insight_packs (user_id, created_at desc);
create index idx_ai_insight_packs_household on ai_insight_packs (household_id);
create index idx_ai_insight_packs_status on ai_insight_packs (status);
create index idx_ai_insight_packs_batch on ai_insight_packs (batch_id);
create index idx_ai_insight_packs_idempotency on ai_insight_packs (user_id, idempotency_key);

alter table ai_insight_packs enable row level security;
create policy "select own ai_insight_packs" on ai_insight_packs
  for select using (auth.uid() = user_id);
-- No end-user insert/update/delete policy — every write goes through the
-- service-role client via AIPersonalisedInsightPackService, matching the
-- Module 11.0/11.1/11.2 pattern for every AI audit/output table.

-- ---------------------------------------------------------------------------
-- C. ai_insight_pack_blocks — normalised reusable answer blocks (spec
-- section 28). user_id/household_id are denormalised from the parent pack
-- (not joined) so RLS stays a plain auth.uid() = user_id check, matching
-- every other user-owned table in this project (no household-membership
-- subquery anywhere in the codebase — see Module 11.0's own discovery note).
-- ---------------------------------------------------------------------------
create table ai_insight_pack_blocks (
  id uuid primary key default gen_random_uuid(),
  pack_id uuid not null references ai_insight_packs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  household_id uuid references households(id) on delete cascade,

  block_code text not null,
  status text not null check (status in ('GROUNDED', 'PARTIALLY_GROUNDED', 'UNGROUNDED', 'NOT_APPLICABLE')),

  headline text,
  short_answer text,
  explanation text,
  why_it_matters text,

  source_refs_json jsonb not null default '[]',
  source_metric_codes text[] not null default '{}',
  confidence text check (confidence is null or confidence in ('HIGH', 'MEDIUM', 'LOW')),
  data_as_of timestamptz,
  limitations_json jsonb not null default '[]',
  related_module text,
  action_route text,
  safety_classification text,
  block_order integer not null default 0,

  -- What, specifically, made an UNGROUNDED/PARTIALLY_GROUNDED verdict —
  -- audit trail for spec section 48's "grounding status per block".
  violations_json jsonb not null default '[]',

  created_at timestamptz not null default now(),

  constraint uq_ai_insight_pack_blocks_pack_block unique (pack_id, block_code)
);

comment on table ai_insight_pack_blocks is
  'Module 11.3 spec section 28. One row per reusable answer block per pack. Only GROUNDED blocks are eligible to back a Module 11.2 STORED_PERSONALISED answer.';

create index idx_ai_insight_pack_blocks_pack on ai_insight_pack_blocks (pack_id, block_order);
create index idx_ai_insight_pack_blocks_user on ai_insight_pack_blocks (user_id, block_code);

alter table ai_insight_pack_blocks enable row level security;
create policy "select own ai_insight_pack_blocks" on ai_insight_pack_blocks
  for select using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- D. Prompt registry seed — PR-AI-013 PERSONALISED_INSIGHT_PACK (spec
-- section 36). PR-AI-002 (MONTHLY_FINANCIAL_SUMMARY, seeded DRAFT by
-- Module 11.0) is a single-envelope prompt whose output_schema_version /
-- contract targets ai_response_envelope, not the multi-block pack schema —
-- reusing it would silently repurpose an existing prompt's contract, which
-- spec section 36 explicitly forbids. PR-AI-013 is therefore a new, narrow,
-- governed prompt code, seeded DRAFT (never auto-activated — activation is
-- an explicit Product Owner/prompt-registry action, same as every Module
-- 11.0 seed prompt).
-- ---------------------------------------------------------------------------
insert into ai_prompt_templates (
  prompt_code, prompt_name, version, task_type, system_prompt, developer_prompt,
  context_schema_version, output_schema_version, country_scope, safety_policy_version, status
) values (
  'PR-AI-013',
  'Monthly Personalised Insight Pack',
  1,
  'monthly_insight_pack',
  'You are FHIP''s Insight Pack narrator. Use ONLY the supplied FHIP facts. '
  || 'Do not recalculate, infer missing values, or invent causes. Do not recommend '
  || 'financial products, and do not provide personal tax or legal advice. Distinguish '
  || 'forecasts (modelled projections) from facts (recorded values), and distinguish '
  || 'missing data from a confirmed zero. Preserve the household''s country/currency '
  || 'context exactly as supplied. Return the exact structured pack schema requested, '
  || 'and reference the source metric ID for every material numerical or classificatory claim.',
  'Populate only the blocks supported by the certified data supplied. Every metric_claims '
  || 'entry must cite a metric_code and source_value taken verbatim from the supplied context. '
  || 'Never state a value, percentage, currency, benchmark, classification or causal driver '
  || 'that was not supplied. If a domain is unavailable or partial, say so in plain English '
  || 'rather than omitting the block silently or fabricating a value.',
  'ai-context-1.0.0',
  'insight-pack-1.0.0',
  null,
  'safety-policy-1.0.0',
  'DRAFT'
)
on conflict (prompt_code, version) do nothing;

-- ---------------------------------------------------------------------------
-- E. Model registry + task cost limit — register the new task type so the
-- existing seeded mock model can serve it (Module 11.0's mock row already
-- carries every OTHER task type; this adds the one new value additively).
-- ---------------------------------------------------------------------------
update ai_model_registry
set task_types = array_append(task_types, 'monthly_insight_pack')
where provider = 'mock'
  and not ('monthly_insight_pack' = any(task_types));

insert into ai_task_cost_limits (task_type, max_cost_per_request_usd, max_internal_tier, max_monthly_cost_usd, active, notes)
values (
  'monthly_insight_pack', 0.50, 'STANDARD', 50.00, true,
  'Module 11.3 — one governed generation per household snapshot produces the whole pack (spec section 24); LOW_COST/STANDARD tier preferred per spec section 13.'
)
on conflict (task_type) where model_identifier is null do nothing;
