-- =============================================================================
-- Module 11.1 — Premium Entitlement, Monthly Quotas, Rate Limits, Cost
-- Controls & AI Kill Switches (migration 0115).
--
-- MIGRATION NUMBER GOVERNANCE. A full fresh scan at implementation time
-- (`git fetch origin`, then `git ls-tree` over EVERY local branch and EVERY
-- remote-tracking ref, plus a working-tree scan of all 47 worktrees on disk
-- for uncommitted/untracked files) found these 01xx numbers in use anywhere:
--   0100 0101 0102 0103 0104 0105 0106 0107 0108 0109 0110 0111 0112 0113 0114
-- The highest number in existence anywhere — committed, uncommitted, local or
-- remote — is 0114 (`0114_fdh12_retirement_provenance_guards.sql`, worktree
-- D:/fhip-fdh12). No 0115 exists on any branch, in any worktree, or on origin.
-- This migration is therefore 0115. (Note: the repo's own
-- `scripts/check-migration-versions.mjs` reports "next version is 0111"
-- because it only sees THIS branch's files — the cross-branch scan above is
-- the authoritative one, and this project has hit number collisions at least
-- 8 times by trusting a single-branch view.)
--
-- WHAT THIS MIGRATION DOES. Module 11.0 built ten AI governance tables but
-- deliberately enforced nothing: `ai_usage_ledger` accumulated counts and
-- "nothing reads it to block or allow a request" (MODULE_11_0_COMPLETION_
-- REPORT.md section M). ADR-M11-001 decision #15 deferred "enforcement, an
-- allowance, and a kill switch" to Module 11.1. This migration closes exactly
-- that gap and nothing more:
--
--   A. ai_usage_ledger gains the two counters that make it authoritative for
--      a monthly *question* allowance (not just calls/tokens/cost).
--   B. ai_platform_controls — a singleton config row: the custom-AI kill
--      switch, the monthly allowance, the rate-limit window, and the per-user
--      and platform-wide cost ceilings. Read fresh on EVERY request.
--   C. ai_task_cost_limits — per-task / per-model cost and model-tier caps.
--   D. ai_admission_events — one row per admission decision. Supplies the
--      rolling-window rate limiter and the enforcement audit trail.
--   E. ai_billing_period_for() — the single seam defining "this billing
--      month".
--   F. ai_admit_request() — the ONE atomic check-and-consume RPC. Every
--      entitlement, kill-switch, rate-limit, cost-ceiling and quota decision
--      happens inside it, in one transaction, under advisory locks.
--   G. ai_refund_admission() — returns a consumed question to the allowance
--      when the provider call it paid for did not produce an answer.
--   H. ai_usage_ledger_accumulate() — atomic replacement for Module 11.0's
--      racy read-modify-write ledger writer (disclosed defect fix; see the
--      comment on that function).
--   I. ai_runs.execution_status gains 'rejected_entitlement'.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO. No user-facing AI surface, no
-- chat, no Insight Pack, no prompt activation, no provider activation. This is
-- the enforcement boundary that a LATER, separately-authorised feature will
-- consume.
--
-- ADDITIVE + ONE WIDENED CHECK. Beyond three new tables and four new
-- functions, the only changes to existing objects are: two new columns on
-- ai_usage_ledger (both `not null default 0`, so every existing row keeps a
-- valid value), and widening ai_runs' execution_status CHECK by one
-- additional permitted value. No Module 1-10 table, column, constraint,
-- index, policy or row is altered. `user_entitlements` is READ but never
-- written or altered — Module 11.1 adds no second definition of "Premium".
--
-- SECURITY MODEL.
--   * ai_platform_controls and ai_task_cost_limits are governance-only:
--     RLS enabled, ZERO policies — identical to Module 11.0's
--     ai_model_registry / ai_prompt_templates and Module 8's
--     benchmark_update_runs precedent. Unreachable by `authenticated` and
--     `anon` for read AND write; every admin route additionally gates on
--     requireAdmin() before touching the service-role client.
--   * ai_admission_events follows the user-owned convention: RLS enabled,
--     SELECT-own only, no INSERT/UPDATE/DELETE policy, so a user can read
--     their own enforcement history and can never forge or erase it.
--   * ai_usage_ledger keeps its Module 11.0 policy set unchanged: SELECT-own
--     only. There is no UPDATE policy, so a user cannot PATCH their own
--     ledger row to reset their quota. The new counters inherit that.
--   * All four functions are SECURITY DEFINER with a pinned search_path, have
--     EXECUTE revoked from PUBLIC/anon/authenticated, and are granted only to
--     service_role. ai_admit_request() and ai_refund_admission()
--     ADDITIONALLY assert, in their own bodies, that if they are somehow
--     reached inside an authenticated session then auth.uid() must equal the
--     subject user — defence in depth, so a future accidental GRANT cannot by
--     itself become a cross-user quota attack.
--
-- FAIL-CLOSED. Every ambiguity denies. Missing controls row, missing
-- entitlement row, unparseable/negative/NaN cost estimate, unknown request
-- class, unknown model tier where a tier cap applies — all produce
-- `allowed: false` with a specific reason, never a default-allow. This
-- mirrors Module 11.0's certification idiom ("a check that could not be
-- performed is never a check that passed").
-- =============================================================================


-- ---------------------------------------------------------------------------
-- A. ai_usage_ledger becomes authoritative for the monthly question allowance
--
-- Module 11.0's ledger counted calls, tokens and cost. It had no notion of a
-- quota-consuming *user question*. These two counters add it, in the SAME
-- table, so the entitlement check reads from the ledger rather than from an
-- independent counter that could drift away from it.
--
--   custom_question_count   — units of monthly allowance consumed. Incremented
--                             ONLY for request_class='custom' AND cache_hit=
--                             false. Cache hits and 'standard' requests never
--                             touch it.
--   refunded_question_count — units handed back (provider error/timeout/bad
--                             response). Kept as its own counter, never by
--                             silently rewriting history, so
--                             `custom_question_count + refunded_question_count`
--                             = gross admissions and the two are separately
--                             auditable.
-- ---------------------------------------------------------------------------
alter table ai_usage_ledger
  add column custom_question_count int not null default 0,
  add column refunded_question_count int not null default 0;

alter table ai_usage_ledger
  add constraint ai_usage_ledger_custom_question_count_nonneg
    check (custom_question_count >= 0),
  add constraint ai_usage_ledger_refunded_question_count_nonneg
    check (refunded_question_count >= 0);

comment on column ai_usage_ledger.custom_question_count is
  'Module 11.1: units of the monthly custom-question allowance consumed in this billing period. Written only by ai_admit_request()/ai_refund_admission(). Cache hits and standard (system-generated) requests never increment this.';
comment on column ai_usage_ledger.refunded_question_count is
  'Module 11.1: units returned to the allowance because the provider call they paid for produced no answer. Increments as custom_question_count decrements.';


-- ---------------------------------------------------------------------------
-- B. ai_platform_controls — the kill switch and every tunable ceiling
--
-- A SINGLETON: `id` is constrained to the literal 'global', so this table can
-- physically hold at most one row and no code needs to guess which row is
-- current. The row is seeded by this migration; if it is ever absent,
-- ai_admit_request() denies everything (`controls_unavailable`) rather than
-- falling back to defaults.
--
-- KILL SWITCH DESIGN (brief requirement 5: "genuinely fast and independent of
-- code deploy"). ai_admit_request() reads this row inside the request
-- transaction, with NO cache and NO TTL. Setting custom_ai_enabled = false
-- takes effect on the very next request, with the latency of one primary-key
-- row read. There is deliberately no application-level memoisation anywhere:
-- an emergency stop that takes up to a TTL to apply is not an emergency stop.
-- The alternative precedent in this codebase (an env var, as in
-- lib/financial-data-hub/constants/featureFlags.ts) was rejected because
-- changing an env var on Amplify requires a redeploy.
--
-- TWO SWITCHES, not one:
--   ai_globally_enabled — stops ALL governed AI, both request classes.
--   custom_ai_enabled   — stops only user-initiated custom questions, leaving
--                         system-generated standard personalised content
--                         running. This is the narrower, likelier lever.
-- ---------------------------------------------------------------------------
create table ai_platform_controls (
  id text primary key default 'global' check (id = 'global'),

  -- Kill switches.
  ai_globally_enabled boolean not null default true,
  custom_ai_enabled boolean not null default true,
  kill_switch_reason text,

  -- Entitlement policy.
  -- standard_requires_premium defaults to TRUE (the conservative reading of
  -- "personalised/custom AI functionality gated to Premium"): today NO AI of
  -- any class is served to a free user. It is a column rather than a constant
  -- so the Product Owner can later open standard personalised content to free
  -- users without a deploy, as an explicit, audited decision.
  standard_requires_premium boolean not null default true,

  -- Monthly allowance: 10 custom questions per billing month, no rollover.
  -- "No rollover" is structural, not a rule that has to be enforced: usage is
  -- counted per billing_period, so an unused allowance in period N is simply
  -- never visible when counting period N+1.
  monthly_custom_question_allowance int not null default 10
    check (monthly_custom_question_allowance >= 0),

  -- Rate limit: a per-user request-rate ceiling INDEPENDENT of the monthly
  -- quota, so a Premium user cannot fire their whole month's allowance (plus
  -- unlimited non-quota-consuming standard/cached requests) in one burst.
  rate_limit_max_requests int not null default 12
    check (rate_limit_max_requests > 0),
  rate_limit_window_seconds int not null default 3600
    check (rate_limit_window_seconds > 0),

  -- Cost ceilings, in USD, on the SAME units the cost estimator produces
  -- (numeric dollars — see lib/ai/providers/types.ts CostEstimate.estimatedCostUsd).
  per_user_monthly_cost_ceiling_usd numeric(12, 6) not null default 5.000000
    check (per_user_monthly_cost_ceiling_usd >= 0),
  platform_monthly_cost_ceiling_usd numeric(14, 6) not null default 500.000000
    check (platform_monthly_cost_ceiling_usd >= 0),
  -- Global per-request cost cap. ai_task_cost_limits may lower this for a
  -- given task/model but never raise it (the RPC takes least() of the two).
  max_cost_per_request_usd numeric(12, 6) not null default 0.500000
    check (max_cost_per_request_usd >= 0),

  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);

comment on table ai_platform_controls is
  'Module 11.1: singleton platform-wide AI controls. Read fresh (uncached) by ai_admit_request() on every request so the kill switch applies immediately without a deploy. Governance-only: RLS enabled with zero policies; service-role + requireAdmin() only.';

insert into ai_platform_controls (id) values ('global');


-- ---------------------------------------------------------------------------
-- C. ai_task_cost_limits — per-task / per-model cost and model-tier caps
--
-- Brief requirement: "a cheap classification task should never accidentally
-- route through an expensive model without an explicit, bounded reason."
-- Two independent levers per task:
--
--   max_cost_per_request_usd — a money cap on one call.
--   max_internal_tier        — a MODEL cap, expressed in ai_model_registry's
--                              own internal_tier vocabulary
--                              (LOW_COST < STANDARD < ADVANCED). A task
--                              capped at LOW_COST is refused if it is about
--                              to run on an ADVANCED model, regardless of
--                              what that call would have cost. That is the
--                              "explicit, bounded reason" requirement: raising
--                              the cap is an admin row change, recorded here.
--
--   max_monthly_cost_usd     — PLATFORM-WIDE monthly spend cap for this task
--                              across all users (null = no task-level monthly
--                              cap; the global platform ceiling still applies).
--
-- RESOLUTION: most specific wins. A row with a matching model_identifier beats
-- a row with model_identifier IS NULL (which applies to every model for that
-- task). NULL-vs-value uniqueness is enforced by two partial unique indexes
-- rather than a plain UNIQUE, because in SQL two NULLs are distinct and a
-- plain `unique (task_type, model_identifier)` would permit unlimited
-- conflicting task-level rows.
-- ---------------------------------------------------------------------------
create table ai_task_cost_limits (
  id uuid primary key default gen_random_uuid(),
  task_type text not null,
  model_identifier text,
  max_cost_per_request_usd numeric(12, 6) not null
    check (max_cost_per_request_usd >= 0),
  max_internal_tier text not null default 'STANDARD'
    check (max_internal_tier in ('LOW_COST', 'STANDARD', 'ADVANCED')),
  max_monthly_cost_usd numeric(14, 6)
    check (max_monthly_cost_usd is null or max_monthly_cost_usd >= 0),
  active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);

create unique index idx_ai_task_cost_limits_task_default
  on ai_task_cost_limits(task_type) where model_identifier is null;
create unique index idx_ai_task_cost_limits_task_model
  on ai_task_cost_limits(task_type, model_identifier) where model_identifier is not null;

comment on table ai_task_cost_limits is
  'Module 11.1: per-task (optionally per-model) cost and model-tier ceilings. Most specific row wins; a model-specific row beats the task-level (model_identifier IS NULL) row.';

-- Seed one task-level row per AITaskType (lib/ai/providers/types.ts). The
-- three tasks that are structurally cheap classification/explanation of an
-- already-computed deterministic result are capped at LOW_COST so they cannot
-- silently drift onto an expensive model. The conversational entry point
-- (general_coach) is the only ADVANCED-eligible task and carries the highest
-- per-request cap; it remains unreachable in 11.1 regardless (no ACTIVE
-- prompt, no user-facing surface).
insert into ai_task_cost_limits (task_type, max_cost_per_request_usd, max_internal_tier, notes) values
  ('score_explanation',         0.050000, 'STANDARD', 'Explains an already-computed certified score.'),
  ('monthly_summary',           0.080000, 'STANDARD', 'Summarises certified cash flow / balance sheet.'),
  ('next_best_action',          0.050000, 'STANDARD', 'Explains one deterministically-generated recommendation.'),
  ('forecast_explanation',      0.080000, 'STANDARD', 'Explains a certified forecast scenario.'),
  ('twin_explanation',          0.050000, 'STANDARD', 'Explains certified peer-comparison output.'),
  ('missing_data_explanation',  0.020000, 'LOW_COST', 'Cheap: reads data_quality/certification only. Capped at LOW_COST.'),
  ('resilience_explanation',    0.050000, 'STANDARD', 'Explains a certified resilience score.'),
  ('dna_explanation',           0.020000, 'LOW_COST', 'Cheap: restates a deterministic classification. Capped at LOW_COST.'),
  ('goal_progress_explanation', 0.050000, 'STANDARD', 'Explains one certified goal entry.'),
  ('general_coach',             0.250000, 'ADVANCED', 'Conversational entry point. Deferred; no ACTIVE prompt and no user-facing surface exists in 11.1.'),
  ('report_explanation',        0.080000, 'STANDARD', 'Explains a certified generated report.'),
  ('cross_border_explanation',  0.020000, 'LOW_COST', 'Cheap: restates certified cross-border totals. Capped at LOW_COST.');


-- ---------------------------------------------------------------------------
-- D. ai_admission_events — one row per admission decision
--
-- Why this table has to exist rather than reusing something:
--   * ai_usage_ledger is AGGREGATED per (user, period, task, provider, model)
--     and has no per-attempt timestamp, so it cannot support a rolling-window
--     rate limit.
--   * ai_runs is written AFTER the provider call returns, so it cannot gate
--     one, and it is not written at all for a request denied before the
--     gateway is even reached.
--
-- It is also the enforcement audit trail: every denial is recorded with its
-- specific reason, so "why was this user blocked" is answerable from data.
--
-- counts_toward_rate_limit is FALSE for exactly one case: a denial that was
-- itself a rate-limit denial. If rate-limited attempts counted toward their
-- own window, a client retrying in a tight loop would extend its own lockout
-- indefinitely and could never recover. Every other outcome — allowed, or
-- denied for any other reason — represents real work performed and does count.
-- ---------------------------------------------------------------------------
create table ai_admission_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  household_id uuid references households(id) on delete set null,
  billing_period text not null,
  request_class text not null check (request_class in ('custom', 'standard')),
  task_type text not null,
  provider text not null,
  model text not null,
  internal_tier text,
  estimated_cost_usd numeric(12, 6) not null default 0,
  cache_hit boolean not null default false,
  decision text not null check (decision in ('allowed', 'denied')),
  deny_reason text,
  quota_consumed boolean not null default false,
  counts_toward_rate_limit boolean not null default true,
  refunded_at timestamptz,
  created_at timestamptz not null default now(),

  -- An allowed decision never carries a reason; a denied one always does.
  constraint ai_admission_events_reason_matches_decision check (
    (decision = 'allowed' and deny_reason is null)
    or (decision = 'denied' and deny_reason is not null)
  ),
  -- Only an allowed, quota-consuming admission can ever be refunded.
  constraint ai_admission_events_refund_requires_consumption check (
    refunded_at is null or (decision = 'allowed' and quota_consumed)
  )
);

create index idx_ai_admission_events_user_time
  on ai_admission_events(user_id, created_at desc);
create index idx_ai_admission_events_rate_window
  on ai_admission_events(user_id, created_at desc) where counts_toward_rate_limit;
create index idx_ai_admission_events_user_period
  on ai_admission_events(user_id, billing_period);
create index idx_ai_admission_events_denials
  on ai_admission_events(deny_reason, created_at desc) where decision = 'denied';

comment on table ai_admission_events is
  'Module 11.1: one row per AI admission decision (allowed or denied). Supplies the rolling-window rate limiter and the enforcement audit trail. Written only by ai_admit_request(); user-readable, never user-writable.';


-- ---------------------------------------------------------------------------
-- E. ai_billing_period_for() — the single definition of "this billing month"
--
-- HONEST LIMITATION, recorded here so it is not mistaken for a richer model
-- than it is: this codebase has NO subscription/billing system. There is no
-- Stripe/Paddle integration, no subscriptions table, and no period columns
-- anywhere; user_entitlements.effective_from/effective_to exist but are
-- written by nothing and read by nothing. The only monthly boundary that
-- genuinely exists is ai_usage_ledger.billing_period, a UTC calendar month
-- ('YYYY-MM') produced by currentBillingPeriod() in lib/ai/audit/aiRuns.ts.
--
-- Module 11.1 therefore reuses that concept rather than inventing a second
-- one, and isolates it HERE so that when a real subscriber anniversary
-- eventually exists, this one function body changes and no call site does.
-- p_user_id is accepted but unused today for exactly that reason.
-- ---------------------------------------------------------------------------
create or replace function ai_billing_period_for(p_user_id uuid, p_at timestamptz default now())
returns text
language sql
stable
set search_path = public, pg_temp
as $$
  select to_char(p_at at time zone 'utc', 'YYYY-MM');
$$;

comment on function ai_billing_period_for(uuid, timestamptz) is
  'Module 11.1: the single seam defining a billing month. Today: UTC calendar month, matching ai_usage_ledger.billing_period. p_user_id is reserved for a future per-subscriber anniversary anchor.';


-- ---------------------------------------------------------------------------
-- F. ai_admit_request() — the atomic check-and-consume RPC
--
-- ATOMICITY (brief requirement 4). "Do you have quota left" and "consume one
-- unit" are not two statements from application code. The whole decision runs
-- inside one function invocation, i.e. one transaction, and is serialised by
-- two transaction-scoped advisory locks taken in a FIXED order:
--     1. a single platform-wide key, then
--     2. a per-user key derived from p_user_id.
-- Fixed ordering means no lock-order-inversion deadlock is possible. Because
-- the per-user lock is held from before the quota is READ until after it is
-- WRITTEN and the transaction commits, two concurrent requests against a
-- 1-remaining allowance cannot both pass: the second blocks at the lock, and
-- when it proceeds it re-reads a ledger that already reflects the first.
--
-- The platform lock additionally makes the platform-wide cost ceiling exact
-- rather than approximate (concurrent requests cannot each read a
-- pre-increment platform total and both squeeze under the ceiling). It does
-- serialise all AI admissions platform-wide; at this feature's designed volume
-- (Premium-only, 10 custom questions per user per month) that is a deliberate
-- and comfortable trade of throughput for an exact ceiling, and it is recorded
-- here as a known scaling consideration for a future high-volume phase.
--
-- ORDERING OF CHECKS. Cheap, global, and most-likely-to-deny first:
--   0. input validation           -> invalid_request / invalid_request_class /
--                                    cost_estimate_unavailable
--   1. global AI switch           -> ai_disabled
--   2. custom-AI kill switch      -> kill_switch_active
--   3. plan tier                  -> entitlement_unknown / not_premium
--   4. rate limit                 -> rate_limited
--   5. per-request cost cap       -> request_cost_limit
--   6. model tier vs task cap     -> model_tier_unknown / model_tier_exceeds_task_limit
--   7. task monthly cost cap      -> task_monthly_cost_limit
--   8. per-user monthly cost cap  -> user_cost_ceiling
--   9. platform monthly cost cap  -> platform_cost_ceiling
--  10. monthly question quota     -> quota_exhausted
-- Nothing is consumed until every check has passed, so a request denied at
-- step 10 has cost the user nothing at step 1.
--
-- The gateway calls this AFTER its free local certification gates and BEFORE
-- the provider call, so an uncertified-context rejection never burns quota.
-- ---------------------------------------------------------------------------
create or replace function ai_admit_request(
  p_user_id uuid,
  p_household_id uuid,
  p_request_class text,
  p_task_type text,
  p_provider text,
  p_model text,
  p_internal_tier text,
  p_estimated_cost_usd numeric,
  p_cache_hit boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_controls        ai_platform_controls%rowtype;
  v_limit           ai_task_cost_limits%rowtype;
  v_limit_found     boolean := false;
  v_plan_tier       text;
  v_period          text;
  v_deny            text := null;
  v_quota_consumed  boolean := false;
  v_counts_rate     boolean := true;
  v_cache_hit       boolean := coalesce(p_cache_hit, false);
  v_est             numeric := p_estimated_cost_usd;
  v_rate_used       int := 0;
  v_quota_used      int := 0;
  v_user_cost       numeric := 0;
  v_platform_cost   numeric := 0;
  v_task_cost       numeric := 0;
  v_eff_max_request numeric := null;
  v_admission_id    uuid;
  v_tier_rank       int;
  v_cap_rank        int;
begin
  -- Defence in depth. These functions are granted to service_role only, but a
  -- future accidental GRANT must not by itself become a cross-user quota
  -- attack: inside any authenticated session, the caller may only ever admit
  -- requests for themselves.
  if auth.uid() is not null and auth.uid() <> p_user_id then
    raise exception 'ai_admit_request: caller % may not admit an AI request for user %', auth.uid(), p_user_id
      using errcode = '42501';
  end if;

  if p_user_id is null then
    raise exception 'ai_admit_request: p_user_id is required' using errcode = '22004';
  end if;

  -- Serialise: platform key first, then user key. Fixed order => no deadlock.
  perform pg_advisory_xact_lock(hashtextextended('fhip.ai_admission.platform', 0));
  perform pg_advisory_xact_lock(hashtextextended('fhip.ai_admission.user:' || p_user_id::text, 0));

  v_period := ai_billing_period_for(p_user_id);

  <<admission>>
  loop
    -- 0. Input validation. Anything we cannot interpret denies.
    if p_request_class is null or p_request_class not in ('custom', 'standard') then
      v_deny := 'invalid_request_class'; exit admission;
    end if;
    if p_task_type is null or p_provider is null or p_model is null then
      v_deny := 'invalid_request'; exit admission;
    end if;
    -- A cost estimate that is absent, NaN, or negative means the cost service
    -- could not answer. That is "we could not check", which is never "the
    -- check passed" (Module 11.0 fail-closed idiom).
    --
    -- NaN IS TESTED FIRST AND WITH `=`, NOT `<>`. Unlike IEEE floats,
    -- PostgreSQL `numeric` defines NaN as EQUAL to NaN (so it can be indexed
    -- and sorted), which means the usual `v <> v` NaN idiom silently never
    -- fires here. It also sorts NaN as GREATER than every number, so a NaN
    -- estimate that slipped past this guard would fall through to the
    -- per-request cost cap and be denied there — still fail-closed, but
    -- reported as 'request_cost_limit', which is a false explanation of what
    -- went wrong. Caught by this module's own PGlite fail-closed test; see
    -- MODULE_11_1_COMPLETION_REPORT.md defect D2.
    if v_est is null or v_est = 'NaN'::numeric or v_est < 0 then
      v_deny := 'cost_estimate_unavailable'; exit admission;
    end if;

    -- Controls row: read FRESH, no cache. Absent => deny everything.
    select * into v_controls from ai_platform_controls where id = 'global';
    if not found then
      v_deny := 'controls_unavailable'; exit admission;
    end if;

    -- 1/2. Kill switches.
    if not v_controls.ai_globally_enabled then
      v_deny := 'ai_disabled'; exit admission;
    end if;
    if p_request_class = 'custom' and not v_controls.custom_ai_enabled then
      v_deny := 'kill_switch_active'; exit admission;
    end if;

    -- 3. Plan tier, read from the ONE existing entitlement model. A missing
    -- row is 'we cannot determine this user's tier', which denies — it is
    -- deliberately NOT treated as 'free', so an entitlement outage can never
    -- be silently indistinguishable from a real free user.
    select plan_tier into v_plan_tier from user_entitlements where user_id = p_user_id;
    if v_plan_tier is null then
      v_deny := 'entitlement_unknown'; exit admission;
    end if;
    if v_plan_tier <> 'premium'
       and (p_request_class = 'custom' or v_controls.standard_requires_premium) then
      v_deny := 'not_premium'; exit admission;
    end if;

    -- 4. Rate limit: rolling window over this user's own admission events.
    select count(*) into v_rate_used
      from ai_admission_events
     where user_id = p_user_id
       and counts_toward_rate_limit
       and created_at > now() - make_interval(secs => v_controls.rate_limit_window_seconds);
    if v_rate_used >= v_controls.rate_limit_max_requests then
      v_deny := 'rate_limited';
      v_counts_rate := false;  -- see table comment: prevents permanent self-lockout
      exit admission;
    end if;

    -- Resolve the applicable task/model cost limit: most specific wins.
    select * into v_limit
      from ai_task_cost_limits
     where active
       and task_type = p_task_type
       and (model_identifier = p_model or model_identifier is null)
     order by (model_identifier is not null) desc
     limit 1;
    v_limit_found := found;

    -- 5. Per-request cost cap. A task-level cap may LOWER the global cap but
    -- never raise it.
    v_eff_max_request := v_controls.max_cost_per_request_usd;
    if v_limit_found then
      v_eff_max_request := least(v_eff_max_request, v_limit.max_cost_per_request_usd);
    end if;
    if v_est > v_eff_max_request then
      v_deny := 'request_cost_limit'; exit admission;
    end if;

    -- 6. Model tier vs the task's tier cap. If a cap applies but the caller
    -- did not tell us which tier the model is, we cannot check it — deny.
    if v_limit_found then
      v_cap_rank := case v_limit.max_internal_tier
                      when 'LOW_COST' then 1 when 'STANDARD' then 2 when 'ADVANCED' then 3 end;
      v_tier_rank := case p_internal_tier
                       when 'LOW_COST' then 1 when 'STANDARD' then 2 when 'ADVANCED' then 3 else null end;
      if v_tier_rank is null then
        v_deny := 'model_tier_unknown'; exit admission;
      end if;
      if v_tier_rank > v_cap_rank then
        v_deny := 'model_tier_exceeds_task_limit'; exit admission;
      end if;

      -- 7. Task-level PLATFORM-WIDE monthly spend cap (across all users).
      if v_limit.max_monthly_cost_usd is not null then
        select coalesce(sum(estimated_cost_usd), 0) into v_task_cost
          from ai_usage_ledger
         where billing_period = v_period and task_type = p_task_type;
        if v_task_cost + v_est > v_limit.max_monthly_cost_usd then
          v_deny := 'task_monthly_cost_limit'; exit admission;
        end if;
      end if;
    end if;

    -- 8. Per-user monthly cost ceiling — independent of the question quota,
    -- so one user asking unusually expensive questions is stopped even with
    -- allowance left.
    select coalesce(sum(estimated_cost_usd), 0) into v_user_cost
      from ai_usage_ledger
     where user_id = p_user_id and billing_period = v_period;
    if v_user_cost + v_est > v_controls.per_user_monthly_cost_ceiling_usd then
      v_deny := 'user_cost_ceiling'; exit admission;
    end if;

    -- 9. Platform-wide monthly cost ceiling — a usage spike cannot run an
    -- unbounded bill. Exact (not approximate) because of the platform lock.
    select coalesce(sum(estimated_cost_usd), 0) into v_platform_cost
      from ai_usage_ledger
     where billing_period = v_period;
    if v_platform_cost + v_est > v_controls.platform_monthly_cost_ceiling_usd then
      v_deny := 'platform_cost_ceiling'; exit admission;
    end if;

    -- 10. Monthly custom-question allowance. Consumed ONLY by a custom
    -- request that is not being served from cache.
    v_quota_consumed := (p_request_class = 'custom' and not v_cache_hit);
    select coalesce(sum(custom_question_count), 0) into v_quota_used
      from ai_usage_ledger
     where user_id = p_user_id and billing_period = v_period;
    if v_quota_consumed and v_quota_used >= v_controls.monthly_custom_question_allowance then
      v_deny := 'quota_exhausted'; exit admission;
    end if;

    exit admission;  -- allowed
  end loop;

  if v_deny is not null then
    v_quota_consumed := false;
  end if;

  -- Consume, in the same transaction and under the same locks as the checks.
  if v_deny is null then
    if v_quota_consumed then
      insert into ai_usage_ledger (
        user_id, household_id, billing_period, task_type, provider, model, custom_question_count
      ) values (
        p_user_id, p_household_id, v_period, p_task_type, p_provider, p_model, 1
      )
      on conflict (user_id, billing_period, task_type, provider, model) do update
        set custom_question_count = ai_usage_ledger.custom_question_count + 1;
    elsif v_cache_hit then
      -- A cached answer is still a served answer: record it so cache
      -- effectiveness is measurable. It costs no quota and no money.
      -- (Module 11.0 declared cached_answer_count but never incremented it.)
      insert into ai_usage_ledger (
        user_id, household_id, billing_period, task_type, provider, model, cached_answer_count
      ) values (
        p_user_id, p_household_id, v_period, p_task_type, p_provider, p_model, 1
      )
      on conflict (user_id, billing_period, task_type, provider, model) do update
        set cached_answer_count = ai_usage_ledger.cached_answer_count + 1;
    end if;
  end if;

  -- Every decision is audited, allowed or denied.
  insert into ai_admission_events (
    user_id, household_id, billing_period, request_class, task_type, provider, model,
    internal_tier, estimated_cost_usd, cache_hit, decision, deny_reason,
    quota_consumed, counts_toward_rate_limit
  ) values (
    p_user_id, p_household_id, v_period,
    case when p_request_class in ('custom', 'standard') then p_request_class else 'custom' end,
    coalesce(p_task_type, 'unknown'), coalesce(p_provider, 'unknown'), coalesce(p_model, 'unknown'),
    -- Same NaN-vs-numeric caveat as above: never store a NaN cost in the audit
    -- trail, since it would poison every later sum() over this column.
    p_internal_tier, case when v_est is null or v_est = 'NaN'::numeric or v_est < 0 then 0 else v_est end,
    v_cache_hit,
    case when v_deny is null then 'allowed' else 'denied' end, v_deny,
    v_quota_consumed, v_counts_rate
  )
  returning id into v_admission_id;

  return jsonb_build_object(
    'allowed',                        v_deny is null,
    'deny_reason',                    v_deny,
    'admission_id',                   v_admission_id,
    'billing_period',                 v_period,
    'plan_tier',                      v_plan_tier,
    'quota_consumed',                 v_quota_consumed,
    'quota_allowance',                v_controls.monthly_custom_question_allowance,
    'quota_used',                     v_quota_used + (case when v_quota_consumed then 1 else 0 end),
    'quota_remaining',                greatest(
                                        coalesce(v_controls.monthly_custom_question_allowance, 0)
                                        - (v_quota_used + (case when v_quota_consumed then 1 else 0 end)), 0),
    'rate_limit_used',                v_rate_used,
    'rate_limit_max',                 v_controls.rate_limit_max_requests,
    'rate_limit_window_seconds',      v_controls.rate_limit_window_seconds,
    'user_cost_used_usd',             v_user_cost,
    'user_cost_ceiling_usd',          v_controls.per_user_monthly_cost_ceiling_usd,
    'platform_cost_used_usd',         v_platform_cost,
    'platform_cost_ceiling_usd',      v_controls.platform_monthly_cost_ceiling_usd,
    'max_cost_per_request_usd',       v_eff_max_request,
    'estimated_cost_usd',             v_est
  );
end;
$$;

comment on function ai_admit_request(uuid, uuid, text, text, text, text, text, numeric, boolean) is
  'Module 11.1: the single atomic AI admission decision. Checks kill switches, Premium entitlement, rate limit, per-request/per-task/per-user/platform cost ceilings and the monthly custom-question allowance, then consumes quota — all in one transaction under fixed-order advisory locks. Fails closed on every ambiguity. service_role only.';


-- ---------------------------------------------------------------------------
-- G. ai_refund_admission() — return a consumed question to the allowance
--
-- Without this, a provider outage silently eats a user's monthly allowance:
-- quota is consumed BEFORE the provider call (it has to be, or it is not a
-- pre-provider gate), so a call that then times out or returns an unusable
-- response would cost the user a question and give them nothing.
--
-- What is refunded and what is NOT: the QUESTION is refunded; the recorded
-- COST is not. If the provider was actually invoked, real money may have been
-- spent, and the cost ceilings must keep seeing it. Refunding money we may
-- genuinely have spent would turn a cost ceiling into a fiction.
--
-- Idempotent: a second refund of the same admission is a no-op returning
-- refunded=false, reason='already_refunded'.
-- ---------------------------------------------------------------------------
create or replace function ai_refund_admission(p_admission_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ev ai_admission_events%rowtype;
begin
  if p_admission_id is null then
    return jsonb_build_object('refunded', false, 'reason', 'not_found');
  end if;

  select * into v_ev from ai_admission_events where id = p_admission_id;
  if not found then
    return jsonb_build_object('refunded', false, 'reason', 'not_found');
  end if;

  if auth.uid() is not null and auth.uid() <> v_ev.user_id then
    raise exception 'ai_refund_admission: caller % may not refund an admission belonging to user %', auth.uid(), v_ev.user_id
      using errcode = '42501';
  end if;

  -- Take the same per-user lock the admission took, so a refund cannot
  -- interleave with a concurrent admission decision for this user.
  perform pg_advisory_xact_lock(hashtextextended('fhip.ai_admission.user:' || v_ev.user_id::text, 0));

  -- Re-read under the lock.
  select * into v_ev from ai_admission_events where id = p_admission_id for update;

  if v_ev.refunded_at is not null then
    return jsonb_build_object('refunded', false, 'reason', 'already_refunded');
  end if;
  if v_ev.decision <> 'allowed' or not v_ev.quota_consumed then
    return jsonb_build_object('refunded', false, 'reason', 'nothing_to_refund');
  end if;

  update ai_usage_ledger
     set custom_question_count   = greatest(custom_question_count - 1, 0),
         refunded_question_count = refunded_question_count + 1
   where user_id = v_ev.user_id
     and billing_period = v_ev.billing_period
     and task_type = v_ev.task_type
     and provider = v_ev.provider
     and model = v_ev.model;

  update ai_admission_events set refunded_at = now() where id = p_admission_id;

  return jsonb_build_object('refunded', true, 'reason', null);
end;
$$;

comment on function ai_refund_admission(uuid) is
  'Module 11.1: returns one consumed custom-question unit to the allowance when the provider call it paid for produced no usable answer. Refunds the question, never the recorded cost. Idempotent. service_role only.';


-- ---------------------------------------------------------------------------
-- H. ai_usage_ledger_accumulate() — atomic ledger accumulation
--
-- DISCLOSED MODULE 11.0 DEFECT FIX. lib/ai/audit/aiRuns.ts's
-- upsertUsageLedger() is a read-modify-write: it SELECTs the current row, then
-- INSERTs or UPDATEs using values computed from that (already stale) read.
-- Two concurrent AI runs in the same billing period can therefore (a) both
-- miss and race the table's unique constraint, or (b) lose one run's token and
-- cost increments entirely.
--
-- In Module 11.0 that was an accounting inaccuracy with no enforcement
-- consequence. In Module 11.1 the same table is the source of truth for the
-- per-user and platform-wide COST CEILINGS, so a lost cost increment is a
-- ceiling that under-counts real spend. Fixing it is therefore genuinely
-- necessary to wire in enforcement, not opportunistic refactoring.
--
-- This replaces the two-statement RMW with a single atomic
-- `insert ... on conflict ... do update set col = table.col + excluded.col`.
-- It deliberately touches ONLY the columns it accumulates: custom_question_count,
-- refunded_question_count, cached_answer_count and batch_call_count are owned
-- by the admission RPC and are never written from here.
-- ---------------------------------------------------------------------------
create or replace function ai_usage_ledger_accumulate(
  p_user_id uuid,
  p_household_id uuid,
  p_billing_period text,
  p_task_type text,
  p_provider text,
  p_model text,
  p_live_call_count int,
  p_input_tokens int,
  p_cached_tokens int,
  p_output_tokens int,
  p_estimated_cost_usd numeric,
  p_actual_cost_usd numeric
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into ai_usage_ledger (
    user_id, household_id, billing_period, task_type, provider, model,
    live_call_count, input_tokens, cached_tokens, output_tokens,
    estimated_cost_usd, actual_cost_usd
  ) values (
    p_user_id, p_household_id, p_billing_period, p_task_type, p_provider, p_model,
    coalesce(p_live_call_count, 0), coalesce(p_input_tokens, 0),
    coalesce(p_cached_tokens, 0), coalesce(p_output_tokens, 0),
    coalesce(p_estimated_cost_usd, 0), p_actual_cost_usd
  )
  on conflict (user_id, billing_period, task_type, provider, model) do update
    set live_call_count    = ai_usage_ledger.live_call_count    + excluded.live_call_count,
        input_tokens       = ai_usage_ledger.input_tokens       + excluded.input_tokens,
        cached_tokens      = ai_usage_ledger.cached_tokens      + excluded.cached_tokens,
        output_tokens      = ai_usage_ledger.output_tokens      + excluded.output_tokens,
        estimated_cost_usd = ai_usage_ledger.estimated_cost_usd + excluded.estimated_cost_usd,
        actual_cost_usd    = case
                               when excluded.actual_cost_usd is null then ai_usage_ledger.actual_cost_usd
                               else coalesce(ai_usage_ledger.actual_cost_usd, 0) + excluded.actual_cost_usd
                             end;
end;
$$;

comment on function ai_usage_ledger_accumulate(uuid, uuid, text, text, text, text, int, int, int, int, numeric, numeric) is
  'Module 11.1: atomic replacement for Module 11.0''s racy read-modify-write ledger writer. Accumulates call/token/cost counters only; never touches the quota counters owned by ai_admit_request().';


-- ---------------------------------------------------------------------------
-- I. ai_runs.execution_status gains 'rejected_entitlement'
--
-- ADR-M11-001 decision #8: "Every gateway invocation — mock or real — writes
-- one ai_runs row before returning ... whether it succeeds, fails validation,
-- or times out." An entitlement/quota/kill-switch rejection must therefore
-- also be audited, and it needs a TRUTHFUL status: reusing 'blocked_safety'
-- or 'rejected_certification' would put a false reason in the audit log. The
-- specific reason (quota_exhausted, not_premium, kill_switch_active, ...) is
-- carried in the existing ai_runs.error_code column, so one new status value
-- is enough and the full granularity is preserved.
--
-- The constraint is dropped by discovered name rather than a guessed one:
-- migration 0110 declared it inline, so its name is server-generated.
-- ---------------------------------------------------------------------------
do $$
declare
  v_conname text;
begin
  select con.conname into v_conname
    from pg_constraint con
    join pg_class cls on cls.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = cls.relnamespace
   where nsp.nspname = 'public'
     and cls.relname = 'ai_runs'
     and con.contype = 'c'
     and pg_get_constraintdef(con.oid) ilike '%execution_status%'
   limit 1;

  if v_conname is null then
    raise exception 'Module 11.1 migration 0115: expected a CHECK constraint on ai_runs.execution_status (created by migration 0110) but found none — refusing to proceed rather than silently leaving execution_status unconstrained.';
  end if;

  execute format('alter table ai_runs drop constraint %I', v_conname);
end;
$$;

alter table ai_runs add constraint ai_runs_execution_status_check check (
  execution_status in (
    'success', 'rejected_schema', 'rejected_certification', 'rejected_source_ref',
    'provider_error', 'timeout', 'blocked_safety', 'rejected_entitlement'
  )
);


-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table ai_platform_controls enable row level security;
alter table ai_task_cost_limits enable row level security;
alter table ai_admission_events enable row level security;

-- ai_platform_controls / ai_task_cost_limits: deliberately NO policy at all,
-- matching Module 11.0's ai_model_registry / ai_prompt_templates and Module
-- 8's benchmark_update_runs. RLS is enabled with zero policies, so
-- `authenticated` and `anon` get zero rows on every operation — no user can
-- read the ceilings, and critically no user can raise their own allowance or
-- turn the kill switch back on. Only the service-role client reaches them,
-- and only behind requireAdmin().

-- ai_admission_events: the standard user-owned pattern. SELECT-own so a user
-- can see their own enforcement history; NO insert/update/delete policy, so a
-- user can neither forge an allowed decision nor delete the events that make
-- up their rate-limit window.
create policy "read own ai_admission_events" on ai_admission_events
  for select using (auth.uid() = user_id);

-- ai_usage_ledger keeps its Module 11.0 policy set EXACTLY as-is: one
-- SELECT-own policy, no UPDATE policy. That is what makes "can a user PATCH
-- their own ai_usage_ledger row to reset their quota?" answerable with a
-- flat no — the new quota counters live in a table the user has never been
-- able to write, and this migration does not start letting them.


-- ---------------------------------------------------------------------------
-- Function privileges
--
-- These three functions are SECURITY DEFINER (they bypass RLS) and they decide
-- commercial entitlement, so only the service-role client — reachable only
-- from server-side code — may invoke them.
--
-- REVOKING FROM `public` IS NOT ENOUGH, and this is the important part.
-- CREATE FUNCTION grants EXECUTE to PUBLIC by default, but a Supabase project
-- ALSO carries `alter default privileges in schema public grant execute on
-- functions to anon, authenticated, service_role`, which grants those roles
-- EXECUTE *directly* — a grant that `revoke ... from public` does not touch.
-- Left unrevoked, every one of these would be callable by any logged-in user
-- straight through PostgREST's /rpc/ endpoint, which would mean:
--   * ai_usage_ledger_accumulate() — no identity guard by design, since it is
--     an internal accounting primitive — could be called with ANY user_id and
--     ANY cost, letting a user poison another user's cost ceiling or inflate
--     the platform total until every user is refused;
--   * ai_refund_admission() — guarded to self, which is exactly the problem:
--     a user could refund their OWN consumed questions and mint unlimited
--     allowance;
--   * ai_admit_request() — likewise guarded to self, so a user could drive
--     their own admission accounting directly.
-- The role-specific revokes below are therefore load-bearing, not belt-and-
-- braces. (Found by this module's own PGlite privilege probe before any
-- deployment; see MODULE_11_1_COMPLETION_REPORT.md defect D1.)
--
-- The identity assertions inside ai_admit_request() and ai_refund_admission()
-- remain as a second, independent layer for the day someone re-grants.
-- ---------------------------------------------------------------------------
revoke all on function ai_admit_request(uuid, uuid, text, text, text, text, text, numeric, boolean) from public, anon, authenticated;
revoke all on function ai_refund_admission(uuid) from public, anon, authenticated;
revoke all on function ai_usage_ledger_accumulate(uuid, uuid, text, text, text, text, int, int, int, int, numeric, numeric) from public, anon, authenticated;

grant execute on function ai_admit_request(uuid, uuid, text, text, text, text, text, numeric, boolean) to service_role;
grant execute on function ai_refund_admission(uuid) to service_role;
grant execute on function ai_usage_ledger_accumulate(uuid, uuid, text, text, text, text, int, int, int, int, numeric, numeric) to service_role;

-- ai_billing_period_for() is a pure, side-effect-free date helper that leaks
-- nothing; it stays callable by any role so future read-only reporting views
-- can use it.
