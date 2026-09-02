-- Module 11.2 — Deterministic Answer Router & Zero-Cost Response Resolution.
--
-- WHY A NEW TABLE AT ALL (spec sections 96-97: "do not assume a migration is
-- necessary... minimise new tables"). Every other Module 11.0/11.1 write
-- surface was inspected first and found unsuitable for the one genuinely
-- new write this phase needs — a resolution audit event:
--   * ai_runs requires `provider text not null` and `model text not null`,
--     and its `execution_status` CHECK does not include a zero-cost outcome.
--     Loosening either would weaken an existing Module 11.0 control (spec
--     section 5: "do not weaken or bypass any Module 11.0 or 11.1 control").
--   * ai_admission_events is entitlement/quota-admission-specific (a decision
--     ai_admit_request() itself made); the router never calls it for a
--     zero-cost resolution, so writing there would misrepresent a
--     non-admission event as an admission.
--   * ai_answer_cache and ai_insights are read/write DATA stores this phase
--     reuses as designed (lib/ai/cache/answerCache.ts,
--     lib/ai/resolution/storedPersonalisedResolver.ts) — neither is an audit
--     trail of ROUTING decisions.
-- So this migration adds exactly one new table, `ai_resolution_audit`,
-- append-only, RLS-scoped like every other Module 11 per-subject table.
--
-- Every other Module 11.2 need (intent taxonomy, resolution policy, response
-- templates) is intentionally kept as code/config
-- (lib/ai/resolution/intentTaxonomy.ts, templates.ts) per spec section 97 —
-- these are stable taxonomies, not runtime-administered data, so a table
-- would be a second, driftable source of truth for something that already
-- has one: the code that ships with a reviewed pull request.

create table ai_resolution_audit (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  household_id uuid references households(id) on delete set null,
  request_id text not null,
  intent_code text,
  intent_version int,
  intent_family text,
  normalised_question_hash text,
  resolution_type text not null check (
    resolution_type in ('DETERMINISTIC', 'KNOWLEDGE_BASE', 'STORED_PERSONALISED', 'EXACT_CACHE', 'LIVE_AI_REQUIRED', 'UNSUPPORTED', 'BLOCKED', 'UNAVAILABLE')
  ),
  completeness text not null default 'FULLY_RESOLVED' check (completeness in ('FULLY_RESOLVED', 'PARTIALLY_RESOLVED', 'UNRESOLVED')),
  certification_status text,
  premium_required boolean not null default false,
  premium_satisfied boolean not null default false,
  provider_called boolean not null default false,
  quota_consumed boolean not null default false,
  source_reference_ids text[] not null default '{}',
  template_version text,
  latency_ms int,
  created_at timestamptz not null default now(),
  -- Structural guarantee behind spec section 118's "provider invocation must
  -- remain zero": no row this phase ever writes may claim a provider call.
  -- (A future phase that genuinely calls a provider records that in
  -- ai_runs, as today — this table's own CHECK simply cannot represent a
  -- Module 11.2 event that violates the phase's central invariant.)
  constraint chk_ai_resolution_audit_no_provider_calls check (provider_called = false),
  constraint chk_ai_resolution_audit_zero_cost_no_quota check (
    resolution_type not in ('DETERMINISTIC', 'KNOWLEDGE_BASE', 'STORED_PERSONALISED', 'EXACT_CACHE', 'BLOCKED', 'UNSUPPORTED', 'UNAVAILABLE')
    or quota_consumed = false
  )
);

create index idx_ai_resolution_audit_user_created on ai_resolution_audit(user_id, created_at desc);
create index idx_ai_resolution_audit_household on ai_resolution_audit(household_id);
create index idx_ai_resolution_audit_resolution_type on ai_resolution_audit(resolution_type);

alter table ai_resolution_audit enable row level security;

-- Same shape as every other Module 11 per-subject table (ai_runs,
-- ai_answer_cache, ai_insights): the owning user may read their own rows;
-- only service_role writes (the router runs server-side under the service
-- role, exactly like recordAiRun()/storeCachedAnswer()).
create policy "read own ai_resolution_audit" on ai_resolution_audit for select using (auth.uid() = user_id);
revoke insert, update, delete on ai_resolution_audit from authenticated, anon;
grant select on ai_resolution_audit to authenticated;
grant all on ai_resolution_audit to service_role;
