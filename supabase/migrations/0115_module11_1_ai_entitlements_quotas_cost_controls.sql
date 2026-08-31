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


-- =============================================================================
-- PART 2 — Module 11.1 full-specification closure.
--
-- Part 1 (above) built the enforcement core: Premium gate, monthly allowance,
-- rolling-window rate limit, per-request / per-user / platform cost ceilings,
-- two kill switches, refunds, atomic ledger accumulation.
--
-- Part 2 closes the requirements the fuller Module 11.1 specification asks for
-- that Part 1 did not implement. Each block below names the specification
-- section it satisfies. Nothing here weakens or replaces Part 1; every
-- addition is an ADDITIONAL gate, an ADDITIONAL audit surface, or an
-- ADDITIONAL configuration seam.
--
-- WHY THIS IS APPENDED TO 0115 RATHER THAN BEING A NEW MIGRATION. 0115 has
-- not been applied to DEV, to production, or to any hosted environment — it
-- exists only on this branch. Editing an unapplied migration in place is
-- correct here and avoids burning a second migration number for a feature
-- that has never shipped. A fresh cross-branch scan (git fetch origin; then
-- git ls-tree over every refs/heads and refs/remotes ref; plus an on-disk scan
-- of every worktree for untracked *.sql) at the time of writing found 0115
-- (this file, this branch only) and 0116 (Admin A0.2 Wave 2, branch
-- fix/admin-a02-wave2-workflow-ordering-integrity) as the only numbers above
-- 0114. Splitting Part 2 into its own migration would have had to be 0117 and
-- would have added a number for no operational benefit, since 0115 itself has
-- never run anywhere.
-- =============================================================================


-- ---------------------------------------------------------------------------
-- J. Additional platform controls  (spec sections 18, 20, 21, 26, 27, 29)
--
-- Section 29 names five feature switches. Part 1 shipped two
-- (ai_globally_enabled = AI_GLOBAL_ENABLED, custom_ai_enabled =
-- AI_CUSTOM_QUESTIONS_ENABLED). The remaining three are added here.
-- scenario_ai_enabled defaults to FALSE because Scenario Coach is an
-- explicitly deferred capability (spec section 1) — a switch for a feature
-- that does not exist yet must default to off, not on.
--
-- Section 27 requires SOFT and HARD thresholds as distinct concepts. Part 1
-- had only hard ceilings. A soft threshold does not block: it records an
-- operational warning event and the request continues. Both soft columns are
-- NULLABLE, and NULL means "no soft threshold configured" — not zero, which
-- would warn on every request.
--
-- Section 20/21 require configurable request and output token budgets. These
-- are platform-level ceilings; ai_model_registry.max_input_tokens /
-- max_output_tokens remain the per-model physical limits, and the RPC enforces
-- the LOWER of the two, so neither can be raised by relaxing the other.
-- ---------------------------------------------------------------------------
alter table ai_platform_controls
  -- section 29 — the remaining three named feature switches
  add column live_provider_enabled boolean not null default true,
  add column batch_generation_enabled boolean not null default true,
  add column scenario_ai_enabled boolean not null default false,

  -- section 18 — concurrency
  add column max_concurrent_requests_per_subject int not null default 1
    check (max_concurrent_requests_per_subject > 0),
  -- A reservation that is never finalised or released (server crash mid-flight)
  -- must not deadlock a subject forever, so a reservation holds a LEASE rather
  -- than an unbounded lock. The lease is deliberately longer than the gateway's
  -- 20s provider timeout.
  add column concurrency_lease_seconds int not null default 120
    check (concurrency_lease_seconds > 0),

  -- section 20/21 — token budgets
  add column max_context_tokens int not null default 12000
    check (max_context_tokens > 0),
  add column max_user_input_tokens int not null default 2000
    check (max_user_input_tokens > 0),
  add column max_output_tokens int not null default 800
    check (max_output_tokens > 0),

  -- section 27 — soft thresholds (warn and continue)
  add column platform_soft_cost_threshold_usd numeric(14, 6)
    check (platform_soft_cost_threshold_usd is null or platform_soft_cost_threshold_usd >= 0),
  add column per_user_soft_cost_threshold_usd numeric(12, 6)
    check (per_user_soft_cost_threshold_usd is null or per_user_soft_cost_threshold_usd >= 0),

  -- section 26 — a daily live-AI spend limit, distinct from the monthly one.
  -- A monthly ceiling alone permits an entire month's budget to be burned in
  -- one afternoon; this bounds the blast radius of a single bad day.
  add column daily_live_ai_cost_limit_usd numeric(14, 6)
    check (daily_live_ai_cost_limit_usd is null or daily_live_ai_cost_limit_usd >= 0);

-- section 58 — a soft threshold at or above its hard ceiling is a silently
-- useless configuration (it could never fire before the hard stop). Rejected
-- in the DATABASE, not only in the admin route, so no write path can create it.
alter table ai_platform_controls
  add constraint ai_platform_controls_soft_below_hard_platform check (
    platform_soft_cost_threshold_usd is null
    or platform_soft_cost_threshold_usd <= platform_monthly_cost_ceiling_usd
  ),
  add constraint ai_platform_controls_soft_below_hard_user check (
    per_user_soft_cost_threshold_usd is null
    or per_user_soft_cost_threshold_usd <= per_user_monthly_cost_ceiling_usd
  );

-- DEV-safe defaults (spec section 79). Soft thresholds at 80% of the hard
-- ceilings so the warning path is genuinely reachable and testable.
update ai_platform_controls
   set platform_soft_cost_threshold_usd = 400.000000,
       per_user_soft_cost_threshold_usd = 4.000000,
       daily_live_ai_cost_limit_usd     = 50.000000
 where id = 'global';

comment on column ai_platform_controls.live_provider_enabled is
  'Spec section 29 AI_LIVE_PROVIDER_ENABLED: false stops every outcome that would reach a provider, while cached/deterministic answers keep being served.';
comment on column ai_platform_controls.scenario_ai_enabled is
  'Spec section 29 AI_SCENARIO_ENABLED: defaults FALSE because Scenario Coach is a deferred capability (spec section 1).';
comment on column ai_platform_controls.platform_soft_cost_threshold_usd is
  'Spec section 27 SOFT_THRESHOLD: crossing it records an ai_operational_events warning and the request CONTINUES. NULL = not configured (never warns); it is not the same as zero.';


-- ---------------------------------------------------------------------------
-- K. ai_provider_controls  (spec sections 31, 26)
--
-- Section 31 requires a provider-level enable/disable that is independent of
-- any individual model, plus (section 26) a per-provider monthly spend limit.
--
-- "No silent unapproved fallback" (section 31) is satisfied structurally: this
-- table can only DISABLE a provider. There is no mechanism anywhere in Module
-- 11.1 that reroutes a denied request to a different provider — a request whose
-- provider is disabled is refused, full stop. Model-level fallback remains
-- ai_model_registry.fallback_model_id, which an admin sets explicitly.
-- ---------------------------------------------------------------------------
create table ai_provider_controls (
  provider text primary key,
  enabled boolean not null default true,
  disabled_reason text,
  monthly_cost_limit_usd numeric(14, 6)
    check (monthly_cost_limit_usd is null or monthly_cost_limit_usd >= 0),
  notes text,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);

comment on table ai_provider_controls is
  'Module 11.1 spec section 31/26: per-provider kill switch and monthly spend limit. A provider absent from this table is treated as ENABLED with no provider-specific limit, so adding a provider to the model registry does not require a row here first; disabling one always does.';

-- Seeded for the two providers this codebase actually has adapters for
-- (lib/ai/providers/). 'mock' is the only one that can execute today.
insert into ai_provider_controls (provider, enabled, notes) values
  ('mock',   true, 'Deterministic in-process provider used for certification. Costs nothing.'),
  ('openai', true, 'Adapter exists but generateStructured() still throws unconditionally — no live provider execution is possible in Module 11.1.');


-- ---------------------------------------------------------------------------
-- L. ai_config_audit  (spec sections 33, 59)
--
-- "Every material AI feature-control change must be auditable: setting,
--  previous value, new value, changed_by, changed_at, reason."
--
-- Implemented as an APPEND-ONLY table fed by triggers, not by application
-- code. Application-code auditing can be forgotten at a new call site; a
-- trigger cannot. One row per CHANGED FIELD (not per statement), so
-- "who turned the kill switch off" is a direct query rather than a diff of
-- two JSON blobs.
--
-- Append-only is enforced, not merely intended: a trigger raises on any UPDATE
-- or DELETE. History that can be edited is not an audit trail.
--
-- NEVER LOGS SECRETS (section 59). The audited tables hold switches, ceilings
-- and prices only. No provider API key is stored in the database at all — keys
-- live in server environment variables (lib/ai/providers/openaiProvider.ts) and
-- are therefore structurally outside this trigger's reach.
-- ---------------------------------------------------------------------------
create table ai_config_audit (
  id uuid primary key default gen_random_uuid(),
  config_table text not null,
  config_id text not null,
  field text not null,
  previous_value text,
  new_value text,
  operation text not null check (operation in ('INSERT', 'UPDATE', 'DELETE')),
  changed_by uuid references auth.users(id),
  changed_at timestamptz not null default now(),
  reason text
);

create index idx_ai_config_audit_table_time on ai_config_audit(config_table, changed_at desc);
create index idx_ai_config_audit_field_time on ai_config_audit(config_table, field, changed_at desc);

comment on table ai_config_audit is
  'Module 11.1 spec sections 33/59: append-only change history for every AI operational control. One row per changed field. Written by triggers; UPDATE and DELETE are refused by trigger.';

create or replace function ai_config_audit_immutable()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $fn$
begin
  raise exception 'ai_config_audit is append-only: % is not permitted', tg_op
    using errcode = '42501';
end;
$fn$;

create trigger trg_ai_config_audit_no_update
  before update or delete on ai_config_audit
  for each row execute function ai_config_audit_immutable();

-- The generic field-level differ. Reads the row's own `updated_by` column when
-- it has one, so `changed_by` is populated without every write path having to
-- remember to pass an actor separately.
create or replace function ai_config_audit_capture()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_old    jsonb := case when tg_op = 'INSERT' then '{}'::jsonb else to_jsonb(old) end;
  v_new    jsonb := case when tg_op = 'DELETE' then '{}'::jsonb else to_jsonb(new) end;
  v_id     text;
  v_actor  uuid;
  v_key    text;
  v_reason text;
begin
  -- tg_argv[0] names the primary-key column of the audited table.
  v_id := coalesce(
            case when tg_op = 'DELETE' then v_old ->> tg_argv[0] else v_new ->> tg_argv[0] end,
            'unknown');

  begin
    v_actor := nullif(coalesce(v_new ->> 'updated_by', v_old ->> 'updated_by'), '')::uuid;
  exception when others then
    v_actor := null;
  end;

  -- A kill-switch flip carries its own explanation; reuse it as the audit
  -- reason rather than inventing a parallel field.
  v_reason := coalesce(v_new ->> 'kill_switch_reason', v_new ->> 'disabled_reason');

  for v_key in select k from jsonb_object_keys(v_old || v_new) k
  loop
    -- updated_at/created_at change on every write and carry no governance meaning.
    if v_key in ('updated_at', 'created_at') then continue; end if;
    if (v_old -> v_key) is not distinct from (v_new -> v_key) then continue; end if;

    insert into ai_config_audit (
      config_table, config_id, field, previous_value, new_value, operation, changed_by, reason
    ) values (
      tg_table_name, v_id, v_key,
      case when v_old ? v_key then v_old ->> v_key else null end,
      case when v_new ? v_key then v_new ->> v_key else null end,
      tg_op, v_actor, v_reason
    );
  end loop;

  return null;
end;
$fn$;

create trigger trg_ai_platform_controls_audit
  after insert or update or delete on ai_platform_controls
  for each row execute function ai_config_audit_capture('id');
create trigger trg_ai_task_cost_limits_audit
  after insert or update or delete on ai_task_cost_limits
  for each row execute function ai_config_audit_capture('id');
create trigger trg_ai_provider_controls_audit
  after insert or update or delete on ai_provider_controls
  for each row execute function ai_config_audit_capture('provider');
create trigger trg_ai_model_registry_audit
  after insert or update or delete on ai_model_registry
  for each row execute function ai_config_audit_capture('id');


-- ---------------------------------------------------------------------------
-- M. ai_operational_events  (spec sections 27, 38, 60)
--
-- Section 38 enumerates the operational events that must be recorded. Some of
-- them (quota exhausted, rate limited, cost ceiling reached) are already
-- implicit in ai_admission_events, but three things make a dedicated table the
-- right answer rather than a duplicate one:
--
--   1. Section 27's SOFT threshold produces an event on a request that was
--      ALLOWED. There is no denial row to hang it off.
--   2. Section 38 requires a SEVERITY, and admission events have none — a
--      quota exhaustion (routine, INFO) and a global cost hard stop (an
--      incident, CRITICAL) are not the same operational fact.
--   3. Kill-switch activation and provider/model disable are CONFIG events
--      with no request at all.
--
-- It is deliberately NOT ai_safety_events: that table's event_type CHECK is
-- Module 11.0's *safety* vocabulary (prompt injection, advice-boundary
-- violation, privacy). Widening it with commercial/ops reasons would blur a
-- security signal into a billing signal, and section 38 asks for "severity
-- appropriate to actual operational risk", which is a different scale.
-- ---------------------------------------------------------------------------
create table ai_operational_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null check (event_type in (
    -- per-request enforcement outcomes
    'quota_exhausted',
    'rate_limit_triggered',
    'concurrency_denied',
    'user_cost_ceiling_reached',
    'task_cost_ceiling_reached',
    'provider_cost_ceiling_reached',
    'global_cost_ceiling_reached',
    'daily_cost_ceiling_reached',
    'soft_cost_threshold_reached',
    'token_budget_exceeded',
    'kill_switch_blocked',
    'provider_disabled_blocked',
    'model_disabled_blocked',
    'entitlement_mismatch',
    'idempotency_conflict',
    -- configuration events
    'kill_switch_activated',
    'config_validation_rejected'
  )),
  severity text not null check (severity in ('INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
  user_id uuid references auth.users(id) on delete set null,
  billing_period text,
  task_type text,
  provider text,
  model text,
  admission_id uuid references ai_admission_events(id) on delete set null,
  detail text,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index idx_ai_operational_events_type_time on ai_operational_events(event_type, created_at desc);
create index idx_ai_operational_events_severity_time on ai_operational_events(severity, created_at desc);
create index idx_ai_operational_events_user_time on ai_operational_events(user_id, created_at desc);

comment on table ai_operational_events is
  'Module 11.1 spec sections 27/38/60: AI operational and abuse-control events with severity. Distinct from ai_safety_events, which is Module 11.0 safety vocabulary. Governance-only: RLS enabled with zero policies.';


-- ---------------------------------------------------------------------------
-- N. ai_admission_events gains the reservation lifecycle, usage-outcome
--    accounting, and idempotency  (spec sections 14, 15, 16, 18)
--
-- SECTION 14 — reservation lifecycle. Part 1 consumed quota at admission and
-- refunded on failure, which is behaviourally correct but left the in-flight
-- state invisible. execution_state makes AVAILABLE -> RESERVED -> CONSUMED /
-- RELEASED an explicit, queryable fact, which is also what section 18's
-- concurrency limit needs in order to know what "already in progress" means.
--
--   reserved  — admitted; the provider call has not yet returned.
--   finalised — a valid answer was delivered. Quota consumption stands.
--   released  — no valid answer was delivered; the question was refunded.
--
-- SECTION 16 — usage outcome. The eight accounting outcome types are recorded
-- per decision so future phases (11.2's deterministic router, 11.8's semantic
-- cache) can report exactly how many answers were served without paid AI. Only
-- LIVE_AI can consume the allowance; BATCH_AI never can, structurally.
--
-- SECTION 15 — idempotency. A client retry carrying the same key must not
-- consume a second credit or start a second provider execution.
-- ---------------------------------------------------------------------------
alter table ai_admission_events
  add column usage_outcome text not null default 'LIVE_AI' check (usage_outcome in (
    'DETERMINISTIC', 'KNOWLEDGE_BASE', 'STANDARD_PERSONALISED',
    'EXACT_CACHE', 'SEMANTIC_CACHE', 'LIVE_AI', 'BATCH_AI', 'ADMIN_EVALUATION'
  )),
  add column execution_state text not null default 'finalised'
    check (execution_state in ('reserved', 'finalised', 'released')),
  add column lease_expires_at timestamptz,
  add column finalised_at timestamptz,
  add column idempotency_key text,
  add column request_hash text;

alter table ai_admission_events
  -- Only an ALLOWED decision can hold a live reservation. A denial is terminal.
  add constraint ai_admission_events_reserved_requires_allowed check (
    execution_state <> 'reserved' or decision = 'allowed'
  ),
  -- BATCH_AI must never consume the user allowance (spec section 16).
  add constraint ai_admission_events_batch_never_consumes check (
    usage_outcome <> 'BATCH_AI' or quota_consumed = false
  ),
  -- Only LIVE_AI can consume it (every other outcome is quota-exempt by
  -- section 2.D). Encoded as a CHECK so no future code path can quietly meter
  -- a cached, deterministic, batch or admin-evaluation answer.
  add constraint ai_admission_events_only_live_ai_consumes check (
    quota_consumed = false or usage_outcome = 'LIVE_AI'
  );

-- Section 15: one admission per (subject, idempotency key). Partial, because
-- the overwhelming majority of rows carry no key and NULLs are distinct.
create unique index idx_ai_admission_events_idempotency
  on ai_admission_events(user_id, idempotency_key) where idempotency_key is not null;

-- Section 18: the concurrency probe. Indexed on exactly the predicate the RPC
-- uses so an in-flight check stays a cheap index scan.
create index idx_ai_admission_events_active_lease
  on ai_admission_events(user_id, lease_expires_at) where execution_state = 'reserved';

comment on column ai_admission_events.execution_state is
  'Spec section 14: reserved = admitted, provider call outstanding; finalised = a valid answer was delivered; released = no valid answer, quota returned.';
comment on column ai_admission_events.usage_outcome is
  'Spec section 16: how this answer was (or would have been) served. Only LIVE_AI may consume the monthly allowance; a CHECK constraint enforces that, and a second CHECK makes BATCH_AI structurally incapable of consuming it.';


-- ---------------------------------------------------------------------------
-- O. ai_model_registry pricing metadata  (spec section 23)
--
-- Section 23: "Model registry/cost config should support: input cost per
-- million tokens, cached input cost, output cost, batch discount/multiplier,
-- effective_from/to, currency, source/reference note, last_verified_at. Do not
-- assume provider pricing is permanent."
--
-- Module 11.0 already shipped cost_input_per_1k_usd, cost_output_per_1k_usd,
-- effective_from and effective_to. The four genuinely missing pieces are added
-- here. Prices stay per-1k rather than per-million to match the columns that
-- already exist and are already read by lib/ai/cost/registryCost.ts — changing
-- the unit would have silently rescaled every existing price by 1000.
--
-- price_last_verified_at exists precisely because provider pricing is NOT
-- permanent: it lets an admin surface show how stale a price is, rather than
-- presenting a figure from an unknown date as current fact.
-- ---------------------------------------------------------------------------
alter table ai_model_registry
  add column cost_cached_input_per_1k_usd numeric(10, 6)
    check (cost_cached_input_per_1k_usd is null or cost_cached_input_per_1k_usd >= 0),
  -- A multiplier rather than a percentage, and capped at 1.0: batch pricing is
  -- a DISCOUNT. A value above 1 would make batch generation more expensive
  -- than live, which is never a real provider's pricing and is far more likely
  -- to be a typo that quietly inflates every batch cost estimate.
  add column batch_cost_multiplier numeric(6, 4) not null default 1.0000
    check (batch_cost_multiplier > 0 and batch_cost_multiplier <= 1),
  add column price_currency text not null default 'USD'
    check (price_currency = upper(price_currency) and char_length(price_currency) = 3),
  add column price_source_note text,
  add column price_last_verified_at timestamptz;

comment on column ai_model_registry.batch_cost_multiplier is
  'Spec section 23: batch discount as a multiplier on the live price. Capped at 1.0 because batch pricing is a discount; a value above 1 is far likelier to be a typo than a real tariff.';
comment on column ai_model_registry.price_last_verified_at is
  'Spec section 23: when a human last checked this price against the provider tariff. Provider pricing is not permanent; a stale price must be visibly stale rather than silently authoritative.';


-- ---------------------------------------------------------------------------
-- P. ai_admit_request() — full-specification version
--
-- The Part 1 function is DROPPED and recreated here rather than edited in
-- place above, so that Part 1 stays readable as the enforcement core it was
-- and this block reads as exactly the delta the fuller specification asked
-- for. The migration has never been applied anywhere, so replaying it from
-- empty simply creates the Part 1 function and immediately replaces it.
--
-- WHAT PART 2 ADDS TO THE DECISION:
--   * section 15 — idempotency replay: a retry with the same key returns the
--                  ORIGINAL verdict and consumes nothing further.
--   * section 16 — the eight usage-outcome accounting types, with only LIVE_AI
--                  able to consume the allowance.
--   * section 18 — a concurrency limit backed by a reservation lease.
--   * section 20/21 — request/context/output token budgets, enforced as the
--                  LOWER of the platform control and the model's own limit.
--   * section 26 — per-provider monthly and platform daily spend limits.
--   * section 27 — soft thresholds that warn and continue.
--   * section 29 — the live-provider, batch and scenario switches.
--   * section 31 — provider disable.
--   * section 32 — model disable (and an unknown model fails closed).
--   * section 38 — an operational event, with severity, for every material
--                  denial and for every soft-threshold crossing.
--
-- ORDER OF CHECKS (and a deliberate, disclosed deviation from section 42).
-- Section 42 recommends QUOTA -> RATE LIMIT -> CONCURRENCY -> COST BUDGET.
-- This implementation checks rate limit and the cost ceilings BEFORE the
-- quota, and checks quota availability immediately before concurrency. Two
-- reasons, both of which make the stricter guarantees easier to prove:
--
--   1. Section 57 requires that a rate-limit, concurrency, entitlement,
--      cost-limit or kill-switch denial consume NO quota. Here that is
--      structural rather than a property of ordering: consumption is the very
--      last action taken, after every gate has passed, so no denial of any
--      kind can consume anything.
--   2. Section 81 requires that a subject with ONE credit left issuing two
--      concurrent requests sees the second one refused with a LIMIT response.
--      Checking quota availability just before concurrency gives the quota
--      denial precedence in exactly that case, while a subject who still has
--      allowance and fires two at once correctly gets the section 18
--      concurrency refusal.
--
-- The interface does not prevent section 42's future ordering: the
-- deterministic/knowledge-base router of Module 11.2 sits UPSTREAM of this
-- function entirely — it decides the usage_outcome, and an outcome that needs
-- no provider never reaches a cost or quota gate here.
-- ---------------------------------------------------------------------------
drop function if exists ai_admit_request(uuid, uuid, text, text, text, text, text, numeric, boolean);

create or replace function ai_admit_request(
  p_user_id uuid,
  p_household_id uuid,
  p_request_class text,
  p_task_type text,
  p_provider text,
  p_model text,
  p_internal_tier text,
  p_estimated_cost_usd numeric,
  p_cache_hit boolean,
  p_usage_outcome text default null,
  p_idempotency_key text default null,
  p_request_hash text default null,
  p_context_tokens int default null,
  p_user_input_tokens int default null,
  p_output_tokens int default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_controls        ai_platform_controls%rowtype;
  v_limit           ai_task_cost_limits%rowtype;
  v_limit_found     boolean := false;
  v_prov            ai_provider_controls%rowtype;
  v_prov_found      boolean := false;
  v_model           ai_model_registry%rowtype;
  v_model_found     boolean := false;
  v_prior           ai_admission_events%rowtype;
  v_plan_tier       text;
  v_period          text;
  v_deny            text := null;
  v_outcome         text;
  v_quota_consumed  boolean := false;
  v_counts_rate     boolean := true;
  v_cache_hit       boolean := coalesce(p_cache_hit, false);
  v_est             numeric := p_estimated_cost_usd;
  v_rate_used       int := 0;
  v_active_leases   int := 0;
  v_quota_used      int := 0;
  v_user_cost       numeric := 0;
  v_platform_cost   numeric := 0;
  v_task_cost       numeric := 0;
  v_provider_cost   numeric := 0;
  v_daily_cost      numeric := 0;
  v_eff_max_request numeric := null;
  v_admission_id    uuid;
  v_tier_rank       int;
  v_cap_rank        int;
  v_needs_provider  boolean := false;
  v_is_live         boolean := false;
  v_state           text := 'finalised';
  v_lease           timestamptz := null;
  v_severity        text;
  v_ev_type         text;
  v_soft_events     jsonb := '[]'::jsonb;
begin
  -- Defence in depth, unchanged from Part 1: inside any authenticated session
  -- the caller may only ever admit requests for themselves.
  if auth.uid() is not null and auth.uid() <> p_user_id then
    raise exception 'ai_admit_request: caller % may not admit an AI request for user %', auth.uid(), p_user_id
      using errcode = '42501';
  end if;

  if p_user_id is null then
    raise exception 'ai_admit_request: p_user_id is required' using errcode = '22004';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('fhip.ai_admission.platform', 0));
  perform pg_advisory_xact_lock(hashtextextended('fhip.ai_admission.user:' || p_user_id::text, 0));

  v_period := ai_billing_period_for(p_user_id);

  -- -------------------------------------------------------------------------
  -- Section 15 — IDEMPOTENCY REPLAY, evaluated first and under the lock.
  --
  -- A network retry carrying the same key must not consume a second credit,
  -- start a second provider execution, or create a second audit row. The
  -- ORIGINAL verdict is replayed verbatim, including a denial: a retry of a
  -- request that was refused is still refused, for the same reason.
  --
  -- A key reused with a DIFFERENT request body is not a retry, it is a
  -- collision, and answering it with the first request's verdict would be
  -- wrong in both directions. It is refused and recorded.
  -- -------------------------------------------------------------------------
  if p_idempotency_key is not null and p_idempotency_key <> '' then
    select * into v_prior
      from ai_admission_events
     where user_id = p_user_id and idempotency_key = p_idempotency_key;
    if found then
      if p_request_hash is not null and v_prior.request_hash is not null
         and p_request_hash <> v_prior.request_hash then
        insert into ai_operational_events (event_type, severity, user_id, billing_period, task_type, provider, model, admission_id, detail)
        values ('idempotency_conflict', 'MEDIUM', p_user_id, v_period, p_task_type, p_provider, p_model, v_prior.id,
                'An idempotency key was reused with a different request body.');
        return jsonb_build_object(
          'allowed', false, 'deny_reason', 'idempotency_conflict', 'admission_id', null,
          'billing_period', v_period, 'plan_tier', null, 'quota_consumed', false,
          'idempotency_reuse', false
        );
      end if;

      select coalesce(sum(custom_question_count), 0) into v_quota_used
        from ai_usage_ledger where user_id = p_user_id and billing_period = v_prior.billing_period;
      select monthly_custom_question_allowance into v_controls.monthly_custom_question_allowance
        from ai_platform_controls where id = 'global';

      return jsonb_build_object(
        'allowed',            v_prior.decision = 'allowed',
        'deny_reason',        v_prior.deny_reason,
        'admission_id',       v_prior.id,
        'billing_period',     v_prior.billing_period,
        'plan_tier',          null,
        'quota_consumed',     v_prior.quota_consumed,
        'usage_outcome',      v_prior.usage_outcome,
        'execution_state',    v_prior.execution_state,
        'quota_allowance',    v_controls.monthly_custom_question_allowance,
        'quota_used',         v_quota_used,
        'quota_remaining',    greatest(coalesce(v_controls.monthly_custom_question_allowance, 0) - v_quota_used, 0),
        'estimated_cost_usd', v_prior.estimated_cost_usd,
        -- The caller MUST be able to tell a replay from a fresh admission:
        -- a replayed allow means "your earlier execution already holds this
        -- credit", not "you may start a second provider call".
        'idempotency_reuse',  true
      );
    end if;
  end if;

  <<admission>>
  loop
    -- 0. Input validation. Anything we cannot interpret denies.
    if p_request_class is null or p_request_class not in ('custom', 'standard') then
      v_deny := 'invalid_request_class'; exit admission;
    end if;
    if p_task_type is null or p_provider is null or p_model is null then
      v_deny := 'invalid_request'; exit admission;
    end if;
    -- NaN tested FIRST and with `=`: PostgreSQL numeric defines NaN as EQUAL
    -- to NaN, so the usual `v <> v` idiom never fires (defect D2, Part 1).
    if v_est is null or v_est = 'NaN'::numeric or v_est < 0 then
      v_deny := 'cost_estimate_unavailable'; exit admission;
    end if;

    -- Section 16 — resolve and validate the usage outcome. When the caller
    -- does not declare one, it is DERIVED from the request class and the
    -- server-derived cache-hit flag rather than defaulted to the cheapest or
    -- the most permissive value.
    v_outcome := coalesce(nullif(p_usage_outcome, ''),
                   case when v_cache_hit then 'EXACT_CACHE'
                        when p_request_class = 'custom' then 'LIVE_AI'
                        else 'STANDARD_PERSONALISED' end);
    if v_outcome not in ('DETERMINISTIC', 'KNOWLEDGE_BASE', 'STANDARD_PERSONALISED',
                         'EXACT_CACHE', 'SEMANTIC_CACHE', 'LIVE_AI', 'BATCH_AI', 'ADMIN_EVALUATION') then
      v_deny := 'invalid_usage_outcome'; exit admission;
    end if;
    -- The cache flag and the outcome must agree. A caller claiming a cache
    -- outcome without a cache hit (or the reverse) is incoherent, and since
    -- the cache outcome is the one that BYPASSES the allowance, an incoherent
    -- claim is refused rather than reconciled in the permissive direction.
    if (v_outcome in ('EXACT_CACHE', 'SEMANTIC_CACHE')) <> v_cache_hit then
      v_deny := 'invalid_usage_outcome'; exit admission;
    end if;

    v_needs_provider := v_outcome in ('LIVE_AI', 'STANDARD_PERSONALISED', 'BATCH_AI', 'ADMIN_EVALUATION');
    v_is_live        := v_outcome in ('LIVE_AI', 'STANDARD_PERSONALISED', 'ADMIN_EVALUATION');

    -- Controls row: read FRESH, no cache. Absent => deny everything.
    select * into v_controls from ai_platform_controls where id = 'global';
    if not found then
      v_deny := 'controls_unavailable'; exit admission;
    end if;

    -- 1/2. Kill switches (section 29).
    if not v_controls.ai_globally_enabled then
      v_deny := 'ai_disabled'; exit admission;
    end if;
    if p_request_class = 'custom' and v_outcome = 'LIVE_AI' and not v_controls.custom_ai_enabled then
      v_deny := 'kill_switch_active'; exit admission;
    end if;
    if v_needs_provider and not v_controls.live_provider_enabled then
      v_deny := 'live_provider_disabled'; exit admission;
    end if;
    if v_outcome = 'BATCH_AI' and not v_controls.batch_generation_enabled then
      v_deny := 'batch_disabled'; exit admission;
    end if;
    -- Scenario Coach is a deferred capability. The switch gates the surface
    -- that WOULD be it: a user-initiated custom question about a forecast
    -- scenario. System-generated (standard) forecast explanations are
    -- deliberately unaffected, so this switch cannot silently disable an
    -- already-shipped non-scenario feature.
    if v_outcome = 'LIVE_AI' and p_request_class = 'custom'
       and p_task_type = 'forecast_explanation' and not v_controls.scenario_ai_enabled then
      v_deny := 'scenario_disabled'; exit admission;
    end if;

    -- 3. Plan tier, from the ONE existing entitlement model. A missing row is
    -- "we cannot determine this user's tier", which denies — deliberately not
    -- treated as 'free', so an entitlement outage is never silently
    -- indistinguishable from a real free user.
    --
    -- ADMIN_EVALUATION is exempt from the commercial gate (section 2.D:
    -- system/admin evaluation calls must not be charged to a consumer
    -- allowance). It remains subject to every kill switch and every cost
    -- ceiling below.
    select plan_tier into v_plan_tier from user_entitlements where user_id = p_user_id;
    if v_plan_tier is null then
      v_deny := 'entitlement_unknown'; exit admission;
    end if;
    if v_outcome <> 'ADMIN_EVALUATION'
       and v_plan_tier <> 'premium'
       and (p_request_class = 'custom' or v_controls.standard_requires_premium) then
      v_deny := 'not_premium'; exit admission;
    end if;

    -- 4. Provider kill switch (section 31). A provider with no controls row is
    -- ENABLED — so registering a new provider does not require a row here
    -- first — but disabling one always does, and there is no fallback rerouting
    -- anywhere: a disabled provider is a refusal, not a redirect.
    if v_needs_provider then
      select * into v_prov from ai_provider_controls where provider = p_provider;
      v_prov_found := found;
      if v_prov_found and not v_prov.enabled then
        v_deny := 'provider_disabled'; exit admission;
      end if;
    end if;

    -- 5. Model kill switch (section 32). Unlike the provider check this fails
    -- CLOSED on an unknown model: the model registry is the only place a task
    -- may be bound to a concrete model (ADR-M11-001 #14), so a model that is
    -- not in it has not been approved by anyone and must not execute.
    if v_needs_provider then
      select * into v_model from ai_model_registry
       where provider = p_provider and model_identifier = p_model;
      v_model_found := found;
      if not v_model_found then
        v_deny := 'model_unknown'; exit admission;
      end if;
      if not v_model.active or not v_model.approved then
        v_deny := 'model_disabled'; exit admission;
      end if;
      if (v_model.effective_from is not null and v_model.effective_from > now())
         or (v_model.effective_to is not null and v_model.effective_to <= now()) then
        v_deny := 'model_disabled'; exit admission;
      end if;
    end if;

    -- 6. Token budgets (sections 20, 21). Enforced as the LOWER of the
    -- platform control and the model's own physical limit, so relaxing one
    -- cannot raise the other. A provider-bound request that declares no token
    -- figures cannot be checked, and "could not check" is never "passed".
    if v_needs_provider then
      if p_context_tokens is null or p_output_tokens is null then
        v_deny := 'token_budget_unavailable'; exit admission;
      end if;
      if p_context_tokens < 0 or p_output_tokens < 0
         or (p_user_input_tokens is not null and p_user_input_tokens < 0) then
        v_deny := 'invalid_request'; exit admission;
      end if;
      if p_context_tokens > least(v_controls.max_context_tokens, v_model.max_input_tokens) then
        v_deny := 'token_budget_exceeded'; exit admission;
      end if;
      if p_output_tokens > least(v_controls.max_output_tokens, v_model.max_output_tokens) then
        v_deny := 'token_budget_exceeded'; exit admission;
      end if;
      if p_user_input_tokens is not null and p_user_input_tokens > v_controls.max_user_input_tokens then
        v_deny := 'token_budget_exceeded'; exit admission;
      end if;
    end if;

    -- 7. Rate limit: rolling window over this user's own admission events.
    select count(*) into v_rate_used
      from ai_admission_events
     where user_id = p_user_id
       and counts_toward_rate_limit
       and created_at > now() - make_interval(secs => v_controls.rate_limit_window_seconds);
    if v_rate_used >= v_controls.rate_limit_max_requests then
      v_deny := 'rate_limited';
      v_counts_rate := false;  -- prevents permanent self-lockout
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

    -- 8. Per-request cost cap. A task-level cap may LOWER the global cap but
    -- never raise it.
    v_eff_max_request := v_controls.max_cost_per_request_usd;
    if v_limit_found then
      v_eff_max_request := least(v_eff_max_request, v_limit.max_cost_per_request_usd);
    end if;
    if v_est > v_eff_max_request then
      v_deny := 'request_cost_limit'; exit admission;
    end if;

    -- 9. Model tier vs the task's tier cap.
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

      -- 10. Task-level platform-wide monthly spend cap.
      if v_limit.max_monthly_cost_usd is not null then
        select coalesce(sum(estimated_cost_usd), 0) into v_task_cost
          from ai_usage_ledger
         where billing_period = v_period and task_type = p_task_type;
        if v_task_cost + v_est > v_limit.max_monthly_cost_usd then
          v_deny := 'task_monthly_cost_limit'; exit admission;
        end if;
      end if;
    end if;

    -- 11. Per-provider monthly spend cap (section 26).
    if v_prov_found and v_prov.monthly_cost_limit_usd is not null then
      select coalesce(sum(estimated_cost_usd), 0) into v_provider_cost
        from ai_usage_ledger
       where billing_period = v_period and provider = p_provider;
      if v_provider_cost + v_est > v_prov.monthly_cost_limit_usd then
        v_deny := 'provider_cost_limit'; exit admission;
      end if;
    end if;

    -- 12. Platform DAILY live-AI spend cap (section 26). Sourced from
    -- admission events rather than the ledger, because the ledger is
    -- aggregated per billing MONTH and carries no daily granularity.
    if v_controls.daily_live_ai_cost_limit_usd is not null and v_is_live then
      select coalesce(sum(estimated_cost_usd), 0) into v_daily_cost
        from ai_admission_events
       where decision = 'allowed'
         and execution_state <> 'released'
         and created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc';
      if v_daily_cost + v_est > v_controls.daily_live_ai_cost_limit_usd then
        v_deny := 'daily_cost_limit'; exit admission;
      end if;
    end if;

    -- 13. Per-user monthly cost ceiling — independent of the question quota.
    select coalesce(sum(estimated_cost_usd), 0) into v_user_cost
      from ai_usage_ledger
     where user_id = p_user_id and billing_period = v_period;
    if v_user_cost + v_est > v_controls.per_user_monthly_cost_ceiling_usd then
      v_deny := 'user_cost_ceiling'; exit admission;
    end if;

    -- 14. Platform-wide monthly cost ceiling. Exact (not approximate) because
    -- of the platform advisory lock.
    select coalesce(sum(estimated_cost_usd), 0) into v_platform_cost
      from ai_usage_ledger
     where billing_period = v_period;
    if v_platform_cost + v_est > v_controls.platform_monthly_cost_ceiling_usd then
      v_deny := 'platform_cost_ceiling'; exit admission;
    end if;

    -- 15. Monthly custom-question allowance. Section 16: ONLY the LIVE_AI
    -- outcome can consume it. Cache hits, deterministic and knowledge-base
    -- answers, standard personalised content, batch generation and admin
    -- evaluations are all quota-exempt, and a CHECK constraint on the audit
    -- table makes that structural rather than merely intended.
    v_quota_consumed := (p_request_class = 'custom' and v_outcome = 'LIVE_AI');
    select coalesce(sum(custom_question_count), 0) into v_quota_used
      from ai_usage_ledger
     where user_id = p_user_id and billing_period = v_period;
    if v_quota_consumed and v_quota_used >= v_controls.monthly_custom_question_allowance then
      v_deny := 'quota_exhausted'; exit admission;
    end if;

    -- 16. Concurrency (section 18). Checked AFTER quota availability so that a
    -- subject on their last credit issuing two concurrent requests sees the
    -- more informative quota refusal (section 81), while a subject with
    -- allowance to spare correctly sees the concurrency refusal.
    --
    -- A reservation holds a LEASE, not an unbounded lock: a server that dies
    -- mid-flight releases its subject automatically once the lease expires,
    -- so a crash can never permanently bar a user from their own allowance.
    if v_is_live then
      select count(*) into v_active_leases
        from ai_admission_events
       where user_id = p_user_id
         and execution_state = 'reserved'
         and lease_expires_at is not null
         and lease_expires_at > now();
      if v_active_leases >= v_controls.max_concurrent_requests_per_subject then
        v_deny := 'request_in_progress'; exit admission;
      end if;
    end if;

    exit admission;  -- allowed
  end loop;

  if v_deny is not null then
    v_quota_consumed := false;
  end if;

  -- Reservation lifecycle (section 14). A live, provider-bound admission is
  -- RESERVED until the gateway finalises or releases it. Everything else —
  -- every denial, and every outcome that reaches no provider — is terminal on
  -- creation and is recorded as finalised.
  if v_deny is null and v_is_live then
    v_state := 'reserved';
    v_lease := now() + make_interval(secs => v_controls.concurrency_lease_seconds);
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
    quota_consumed, counts_toward_rate_limit,
    usage_outcome, execution_state, lease_expires_at, finalised_at,
    idempotency_key, request_hash
  ) values (
    p_user_id, p_household_id, v_period,
    case when p_request_class in ('custom', 'standard') then p_request_class else 'custom' end,
    coalesce(p_task_type, 'unknown'), coalesce(p_provider, 'unknown'), coalesce(p_model, 'unknown'),
    p_internal_tier, case when v_est is null or v_est = 'NaN'::numeric or v_est < 0 then 0 else v_est end,
    v_cache_hit,
    case when v_deny is null then 'allowed' else 'denied' end, v_deny,
    v_quota_consumed, v_counts_rate,
    coalesce(v_outcome, 'LIVE_AI'), v_state, v_lease,
    case when v_state = 'finalised' then now() else null end,
    nullif(p_idempotency_key, ''), p_request_hash
  )
  returning id into v_admission_id;

  -- -------------------------------------------------------------------------
  -- Section 38 — operational event, with a severity that reflects real
  -- operational risk rather than a flat level for everything. A user hitting
  -- their monthly allowance is routine (INFO). A platform-wide cost ceiling or
  -- an active kill switch is an incident (HIGH/CRITICAL).
  -- -------------------------------------------------------------------------
  if v_deny is not null then
    v_ev_type := case v_deny
                   when 'quota_exhausted'               then 'quota_exhausted'
                   when 'rate_limited'                  then 'rate_limit_triggered'
                   when 'request_in_progress'           then 'concurrency_denied'
                   when 'user_cost_ceiling'             then 'user_cost_ceiling_reached'
                   when 'task_monthly_cost_limit'       then 'task_cost_ceiling_reached'
                   when 'provider_cost_limit'           then 'provider_cost_ceiling_reached'
                   when 'platform_cost_ceiling'         then 'global_cost_ceiling_reached'
                   when 'daily_cost_limit'              then 'daily_cost_ceiling_reached'
                   when 'token_budget_exceeded'         then 'token_budget_exceeded'
                   when 'token_budget_unavailable'      then 'token_budget_exceeded'
                   when 'kill_switch_active'            then 'kill_switch_blocked'
                   when 'ai_disabled'                   then 'kill_switch_blocked'
                   when 'live_provider_disabled'        then 'kill_switch_blocked'
                   when 'batch_disabled'                then 'kill_switch_blocked'
                   when 'scenario_disabled'             then 'kill_switch_blocked'
                   when 'provider_disabled'             then 'provider_disabled_blocked'
                   when 'model_disabled'                then 'model_disabled_blocked'
                   when 'model_unknown'                 then 'model_disabled_blocked'
                   when 'not_premium'                   then 'entitlement_mismatch'
                   when 'entitlement_unknown'           then 'entitlement_mismatch'
                   else null
                 end;
    if v_ev_type is not null then
      v_severity := case v_ev_type
                      when 'quota_exhausted'              then 'INFO'
                      when 'entitlement_mismatch'         then 'INFO'
                      when 'rate_limit_triggered'         then 'LOW'
                      when 'concurrency_denied'           then 'LOW'
                      when 'token_budget_exceeded'        then 'LOW'
                      when 'user_cost_ceiling_reached'    then 'MEDIUM'
                      when 'task_cost_ceiling_reached'    then 'MEDIUM'
                      when 'provider_cost_ceiling_reached' then 'HIGH'
                      when 'daily_cost_ceiling_reached'   then 'HIGH'
                      when 'model_disabled_blocked'       then 'MEDIUM'
                      when 'provider_disabled_blocked'    then 'MEDIUM'
                      when 'kill_switch_blocked'          then 'HIGH'
                      when 'global_cost_ceiling_reached'  then 'CRITICAL'
                      else 'LOW'
                    end;
      insert into ai_operational_events (
        event_type, severity, user_id, billing_period, task_type, provider, model, admission_id, detail, metadata
      ) values (
        v_ev_type, v_severity, p_user_id, v_period, p_task_type, p_provider, p_model, v_admission_id,
        'AI request denied: ' || v_deny,
        jsonb_build_object('deny_reason', v_deny, 'usage_outcome', v_outcome, 'request_class', p_request_class)
      );
    end if;
  else
    -- ---------------------------------------------------------------------
    -- Section 27 — SOFT thresholds. These do NOT block: the request has
    -- already been admitted at this point. They record a warning so an
    -- operator learns that spend is approaching a hard stop while there is
    -- still time to act, rather than discovering it when AI stops working.
    -- ---------------------------------------------------------------------
    if v_controls.platform_soft_cost_threshold_usd is not null
       and v_platform_cost + v_est > v_controls.platform_soft_cost_threshold_usd then
      insert into ai_operational_events (event_type, severity, user_id, billing_period, task_type, provider, model, admission_id, detail, metadata)
      values ('soft_cost_threshold_reached', 'MEDIUM', null, v_period, p_task_type, p_provider, p_model, v_admission_id,
              'Platform AI spend has crossed its soft threshold; requests are still being served.',
              jsonb_build_object('scope', 'platform', 'spend_usd', v_platform_cost + v_est,
                                 'soft_threshold_usd', v_controls.platform_soft_cost_threshold_usd,
                                 'hard_ceiling_usd', v_controls.platform_monthly_cost_ceiling_usd));
      v_soft_events := v_soft_events || jsonb_build_array('platform');
    end if;
    if v_controls.per_user_soft_cost_threshold_usd is not null
       and v_user_cost + v_est > v_controls.per_user_soft_cost_threshold_usd then
      insert into ai_operational_events (event_type, severity, user_id, billing_period, task_type, provider, model, admission_id, detail, metadata)
      values ('soft_cost_threshold_reached', 'LOW', p_user_id, v_period, p_task_type, p_provider, p_model, v_admission_id,
              'This subject''s AI spend has crossed its soft threshold; requests are still being served.',
              jsonb_build_object('scope', 'user', 'spend_usd', v_user_cost + v_est,
                                 'soft_threshold_usd', v_controls.per_user_soft_cost_threshold_usd,
                                 'hard_ceiling_usd', v_controls.per_user_monthly_cost_ceiling_usd));
      v_soft_events := v_soft_events || jsonb_build_array('user');
    end if;
  end if;

  return jsonb_build_object(
    'allowed',                        v_deny is null,
    'deny_reason',                    v_deny,
    'admission_id',                   v_admission_id,
    'billing_period',                 v_period,
    'plan_tier',                      v_plan_tier,
    'quota_consumed',                 v_quota_consumed,
    'usage_outcome',                  v_outcome,
    'execution_state',                v_state,
    'lease_expires_at',               v_lease,
    'idempotency_reuse',              false,
    'quota_allowance',                v_controls.monthly_custom_question_allowance,
    'quota_used',                     v_quota_used + (case when v_quota_consumed then 1 else 0 end),
    'quota_remaining',                greatest(
                                        coalesce(v_controls.monthly_custom_question_allowance, 0)
                                        - (v_quota_used + (case when v_quota_consumed then 1 else 0 end)), 0),
    'rate_limit_used',                v_rate_used,
    'rate_limit_max',                 v_controls.rate_limit_max_requests,
    'rate_limit_window_seconds',      v_controls.rate_limit_window_seconds,
    'concurrency_active',             v_active_leases,
    'concurrency_max',                v_controls.max_concurrent_requests_per_subject,
    'user_cost_used_usd',             v_user_cost,
    'user_cost_ceiling_usd',          v_controls.per_user_monthly_cost_ceiling_usd,
    'platform_cost_used_usd',         v_platform_cost,
    'platform_cost_ceiling_usd',      v_controls.platform_monthly_cost_ceiling_usd,
    'soft_thresholds_crossed',        v_soft_events,
    'max_cost_per_request_usd',       v_eff_max_request,
    'estimated_cost_usd',             v_est
  );
end;
$fn$;

comment on function ai_admit_request(uuid, uuid, text, text, text, text, text, numeric, boolean, text, text, text, int, int, int) is
  'Module 11.1: the single atomic AI admission decision. Idempotency replay, usage-outcome accounting, kill switches (global/custom/live-provider/batch/scenario), Premium entitlement, provider and model disable, token budgets, rate limit, concurrency lease, per-request/task/provider/daily/user/platform cost ceilings and the monthly custom-question allowance — all in one transaction under fixed-order advisory locks. Fails closed on every ambiguity. service_role only.';


-- ---------------------------------------------------------------------------
-- Q. ai_finalise_admission() — close a reservation on success  (section 14)
--
-- The counterpart to ai_refund_admission(). A valid, validated answer was
-- delivered, so the consumed credit stands and the concurrency lease is
-- released. Idempotent, and it refuses to finalise an admission that has
-- already been released — the two terminal states are mutually exclusive, and
-- silently overwriting one with the other would corrupt the audit trail.
-- ---------------------------------------------------------------------------
create or replace function ai_finalise_admission(p_admission_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_ev ai_admission_events%rowtype;
begin
  if p_admission_id is null then
    return jsonb_build_object('finalised', false, 'reason', 'not_found');
  end if;

  select * into v_ev from ai_admission_events where id = p_admission_id;
  if not found then
    return jsonb_build_object('finalised', false, 'reason', 'not_found');
  end if;

  if auth.uid() is not null and auth.uid() <> v_ev.user_id then
    raise exception 'ai_finalise_admission: caller % may not finalise an admission belonging to user %', auth.uid(), v_ev.user_id
      using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('fhip.ai_admission.user:' || v_ev.user_id::text, 0));
  select * into v_ev from ai_admission_events where id = p_admission_id for update;

  if v_ev.execution_state = 'released' then
    return jsonb_build_object('finalised', false, 'reason', 'already_released');
  end if;
  if v_ev.execution_state = 'finalised' then
    return jsonb_build_object('finalised', false, 'reason', 'already_finalised');
  end if;

  update ai_admission_events
     set execution_state = 'finalised',
         finalised_at = now(),
         lease_expires_at = null
   where id = p_admission_id;

  return jsonb_build_object('finalised', true, 'reason', null);
end;
$fn$;

comment on function ai_finalise_admission(uuid) is
  'Module 11.1 spec section 14: closes a reservation after a valid answer was delivered. Consumed quota stands; the concurrency lease is released. Idempotent, and refuses to finalise an already-released admission.';


-- ---------------------------------------------------------------------------
-- R. ai_refund_admission() — now also closes the reservation as RELEASED
--
-- Replaces the Part 1 body. Same contract (refund the question, never the
-- cost; idempotent), plus the section 14 lifecycle transition so a released
-- reservation immediately stops counting against the concurrency limit
-- instead of waiting out its lease.
-- ---------------------------------------------------------------------------
create or replace function ai_refund_admission(p_admission_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
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

  perform pg_advisory_xact_lock(hashtextextended('fhip.ai_admission.user:' || v_ev.user_id::text, 0));
  select * into v_ev from ai_admission_events where id = p_admission_id for update;

  if v_ev.refunded_at is not null then
    return jsonb_build_object('refunded', false, 'reason', 'already_refunded');
  end if;
  if v_ev.decision <> 'allowed' then
    return jsonb_build_object('refunded', false, 'reason', 'nothing_to_refund');
  end if;

  -- A live admission that consumed nothing (a 'standard' request, say) still
  -- has to release its reservation, or its lease would bar the subject's next
  -- request for no reason. Releasing and refunding are separate facts.
  if v_ev.execution_state = 'reserved' then
    update ai_admission_events
       set execution_state = 'released', lease_expires_at = null
     where id = p_admission_id;
  end if;

  if not v_ev.quota_consumed then
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
$fn$;


-- ---------------------------------------------------------------------------
-- S. ai_entitlement_state() — the read model behind the entitlement API
--    (spec sections 5, 8, 39)
--
-- Server-authoritative answer to "what is this subject entitled to right now".
-- Returns ONLY the fields section 8 permits a user to see. It deliberately
-- does NOT return: the per-user or platform dollar ceilings, the platform
-- spend total, provider or model identities, rate-limit internals beyond a
-- retry hint, the kill-switch REASON, or any other subject's data. Section 7
-- and section 61 both forbid leaking those, so they are excluded here at the
-- source rather than being fetched and then remembered to be stripped in a
-- route handler.
--
-- Fails closed in the same direction as the admission RPC: a subject with no
-- entitlement row is reported not-eligible with reason 'entitlement_unknown',
-- never defaulted to free-but-fine or premium.
-- ---------------------------------------------------------------------------
create or replace function ai_entitlement_state(p_user_id uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $fn$
declare
  v_controls  ai_platform_controls%rowtype;
  v_plan_tier text;
  v_period    text;
  v_used      int := 0;
  v_eligible  boolean := false;
  v_reason    text := null;
begin
  if auth.uid() is not null and auth.uid() <> p_user_id then
    raise exception 'ai_entitlement_state: caller % may not read the entitlement of user %', auth.uid(), p_user_id
      using errcode = '42501';
  end if;
  if p_user_id is null then
    raise exception 'ai_entitlement_state: p_user_id is required' using errcode = '22004';
  end if;

  v_period := ai_billing_period_for(p_user_id);
  select * into v_controls from ai_platform_controls where id = 'global';
  if not found then
    -- No controls row means ai_admit_request() denies everything, so reporting
    -- eligibility here would be a lie the very next request would contradict.
    return jsonb_build_object(
      'eligible', false, 'reason', 'ai_unavailable', 'upgrade_available', false,
      'plan_feature', 'AI_COACH_PREMIUM', 'billing_period', v_period
    );
  end if;

  select plan_tier into v_plan_tier from user_entitlements where user_id = p_user_id;

  if v_plan_tier is null then
    v_reason := 'entitlement_unknown';
  elsif v_plan_tier <> 'premium' then
    v_reason := 'premium_required';
  elsif not v_controls.ai_globally_enabled then
    v_reason := 'ai_temporarily_disabled';
  elsif not v_controls.custom_ai_enabled then
    v_reason := 'ai_temporarily_disabled';
  else
    v_eligible := true;
  end if;

  select coalesce(sum(custom_question_count), 0) into v_used
    from ai_usage_ledger where user_id = p_user_id and billing_period = v_period;

  return jsonb_build_object(
    'eligible',          v_eligible,
    'reason',            v_reason,
    -- Only a genuinely free user can upgrade their way out of the denial. An
    -- unknown entitlement or a kill switch is not fixed by paying, and telling
    -- the user otherwise would be a dishonest upsell.
    --
    -- coalesce() is load-bearing: v_reason is NULL for an eligible Premium
    -- subject, and `NULL = 'premium_required'` is NULL, not false — which
    -- would have shipped a null-valued boolean straight out of the public
    -- entitlement API. Caught by this module's own smoke test.
    'upgrade_available', coalesce(v_reason = 'premium_required', false),
    'plan_feature',      'AI_COACH_PREMIUM',
    'billing_period',    v_period,
    'period_start',      (to_date(v_period || '-01', 'YYYY-MM-DD'))::text,
    'period_end',        ((to_date(v_period || '-01', 'YYYY-MM-DD') + interval '1 month - 1 day'))::date::text,
    'custom_questions',  jsonb_build_object(
      'limit',     v_controls.monthly_custom_question_allowance,
      'used',      v_used,
      'remaining', greatest(v_controls.monthly_custom_question_allowance - v_used, 0)
    )
  );
end;
$fn$;

comment on function ai_entitlement_state(uuid) is
  'Module 11.1 spec sections 5/8/39: the server-authoritative entitlement read model. Returns only user-safe fields — never cost ceilings, platform spend, provider/model identities or kill-switch reasons.';


-- ---------------------------------------------------------------------------
-- T. Row Level Security and privileges for the Part 2 objects
-- ---------------------------------------------------------------------------
alter table ai_provider_controls enable row level security;
alter table ai_config_audit enable row level security;
alter table ai_operational_events enable row level security;

-- All three are governance-only: RLS enabled with ZERO policies, exactly like
-- ai_platform_controls / ai_task_cost_limits / ai_model_registry. `anon` and
-- `authenticated` therefore get zero rows on every operation.
--
-- ai_operational_events is deliberately NOT user-readable even for a user's
-- own rows: its metadata carries soft-threshold spend figures and hard-ceiling
-- values, which sections 8 and 61 both forbid exposing to end users.

-- Section 50/61: the same revoke discipline that defect D1 proved is
-- load-bearing on Supabase, where `alter default privileges ... grant execute
-- ... to anon, authenticated` means `revoke from public` alone does nothing.
-- The recreated ai_admit_request has a NEW signature, so the Part 1 grants no
-- longer apply to it and must be reissued.
revoke all on function ai_admit_request(uuid, uuid, text, text, text, text, text, numeric, boolean, text, text, text, int, int, int) from public, anon, authenticated;
revoke all on function ai_finalise_admission(uuid) from public, anon, authenticated;
revoke all on function ai_refund_admission(uuid) from public, anon, authenticated;
revoke all on function ai_entitlement_state(uuid) from public, anon, authenticated;
revoke all on function ai_config_audit_capture() from public, anon, authenticated;
revoke all on function ai_config_audit_immutable() from public, anon, authenticated;

grant execute on function ai_admit_request(uuid, uuid, text, text, text, text, text, numeric, boolean, text, text, text, int, int, int) to service_role;
grant execute on function ai_finalise_admission(uuid) to service_role;
grant execute on function ai_refund_admission(uuid) to service_role;
grant execute on function ai_entitlement_state(uuid) to service_role;
