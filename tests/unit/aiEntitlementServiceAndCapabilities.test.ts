// Module 11.1 — unit tests for the application-side entitlement layer added in
// the full-specification pass.
//
// The DATABASE behaviour (admission, quota, ceilings, kill switches) is
// certified against a real Postgres in
// scripts/db-rebuild-check/module11_1_entitlement_cert.mjs. What is tested here
// is the logic that lives only in TypeScript and therefore has no coverage
// there: the capability resolution (spec section 6), the read-model
// interpretation and its fail-closed behaviour (sections 5, 62), the
// user-facing response allowlist (sections 7, 8), the public error mapping
// (section 19), the admin configuration validation (section 58), and the
// observability counters (section 60).

import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  AI_COACH_PREMIUM,
  AI_SUB_CAPABILITIES,
  AI_CAPABILITY_IMPLEMENTED,
  resolveAICapabilities,
  hasAICapability,
} from '@/lib/ai/entitlement/capabilities';
import {
  DENY_REASON_MESSAGES,
  PUBLIC_ERROR_CODE,
  AI_USAGE_OUTCOMES,
  outcomeConsumesQuota,
  outcomeReachesProvider,
  retryAfterSecondsFor,
  type AdmissionDenyReason,
} from '@/lib/ai/entitlement/types';
import { validateControlsPatch, type AiPlatformControls } from '@/lib/ai/entitlement/platformControls';
import {
  recordAiMetric,
  recordAdmissionMetrics,
  resetAiMetrics,
  getAiMetric,
  getAiMetricTotal,
  snapshotAiMetrics,
} from '@/lib/ai/observability/aiMetrics';

// ---------------------------------------------------------------------------
// Section 6 — feature entitlement + sub-capabilities
// ---------------------------------------------------------------------------
describe('Module 11.1 section 6 — AI feature entitlement codes', () => {
  it('resolves AI_COACH_PREMIUM from the one real plan tier', () => {
    expect(resolveAICapabilities('premium')[AI_COACH_PREMIUM]).toBe(true);
    expect(resolveAICapabilities('free')[AI_COACH_PREMIUM]).toBe(false);
  });

  it('FAILS CLOSED on an undeterminable tier — null grants nothing, and is not coerced to "free"', () => {
    const set = resolveAICapabilities(null);
    expect(set[AI_COACH_PREMIUM]).toBe(false);
    expect(Object.values(set.capabilities).every((v) => v === false)).toBe(true);
  });

  it('declares all eight sub-capabilities named by the specification', () => {
    // Module 11.5 added AI_CONTEXTUAL_EXPLANATIONS as the eighth.
    expect([...AI_SUB_CAPABILITIES].sort()).toEqual([
      'AI_CONTEXTUAL_EXPLANATIONS',
      'AI_CUSTOM_QUESTIONS',
      'AI_INSIGHT_PACK',
      'AI_PERSONALISED_EXPLANATIONS',
      'AI_REPORT_EXPLANATION',
      'AI_SCENARIO_NARRATION',
      'AI_STANDARD_QUESTIONS',
      'AI_TWIN_EXPLANATION',
    ]);
  });

  it('grants a Premium subject ONLY the capabilities that are actually built', () => {
    const set = resolveAICapabilities('premium');
    for (const c of AI_SUB_CAPABILITIES) {
      expect(set.capabilities[c]).toBe(AI_CAPABILITY_IMPLEMENTED[c]);
    }
  });

  it('refuses the still-deferred capabilities even to a Premium subject (sections 1, 44, 45, 46)', () => {
    // An entitlement to a feature nobody built must never read as permission
    // to invoke one. Capabilities leave this list only when the feature they
    // name is genuinely built: AI_INSIGHT_PACK left in Module 11.3,
    // AI_STANDARD_QUESTIONS in Module 11.4, and AI_REPORT_EXPLANATION /
    // AI_TWIN_EXPLANATION in Module 11.5 (which wires the contextual Explain
    // estate to the report and Financial Twin surfaces).
    //
    // PRE-EXISTING FAILURE FIXED HERE (Module 11.5): this list still named
    // AI_STANDARD_QUESTIONS long after Module 11.4 set
    // AI_CAPABILITY_IMPLEMENTED.AI_STANDARD_QUESTIONS = true, so this
    // assertion had been failing on origin/main. The list is now corrected to
    // reality rather than the assertion being weakened — AI_SCENARIO_NARRATION
    // is the only genuinely deferred capability left, and it is still proven
    // to be refused.
    for (const deferred of ['AI_SCENARIO_NARRATION'] as const) {
      expect(hasAICapability('premium', deferred)).toBe(false);
    }
  });

  it('Module 11.5 — grants AI_CONTEXTUAL_EXPLANATIONS to Premium only', () => {
    expect(hasAICapability('premium', 'AI_CONTEXTUAL_EXPLANATIONS')).toBe(true);
    expect(hasAICapability('free', 'AI_CONTEXTUAL_EXPLANATIONS')).toBe(false);
    expect(hasAICapability(null, 'AI_CONTEXTUAL_EXPLANATIONS')).toBe(false);
  });

  it('Module 11.5 — grants the now-built report and Twin explanation capabilities to Premium only', () => {
    for (const cap of ['AI_REPORT_EXPLANATION', 'AI_TWIN_EXPLANATION'] as const) {
      expect(hasAICapability('premium', cap)).toBe(true);
      expect(hasAICapability('free', cap)).toBe(false);
      expect(hasAICapability(null, cap)).toBe(false);
    }
  });

  it('grants the three capabilities the enforcement layer genuinely governs', () => {
    expect(hasAICapability('premium', 'AI_CUSTOM_QUESTIONS')).toBe(true);
    expect(hasAICapability('premium', 'AI_PERSONALISED_EXPLANATIONS')).toBe(true);
    expect(hasAICapability('free', 'AI_CUSTOM_QUESTIONS')).toBe(false);
  });

  it('Module 11.3 — grants AI_INSIGHT_PACK to Premium only, now that the Insight Pack service is built', () => {
    expect(hasAICapability('premium', 'AI_INSIGHT_PACK')).toBe(true);
    expect(hasAICapability('free', 'AI_INSIGHT_PACK')).toBe(false);
    expect(hasAICapability(null, 'AI_INSIGHT_PACK')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Section 16 — usage-outcome accounting
// ---------------------------------------------------------------------------
describe('Module 11.1 section 16 — usage outcome accounting', () => {
  it('declares exactly the eight outcome types', () => {
    expect(AI_USAGE_OUTCOMES).toHaveLength(8);
  });

  it('ONLY LIVE_AI on a custom request consumes the allowance', () => {
    for (const outcome of AI_USAGE_OUTCOMES) {
      expect(outcomeConsumesQuota(outcome, 'custom')).toBe(outcome === 'LIVE_AI');
    }
  });

  it('BATCH_AI never consumes the allowance, in either request class (section 16)', () => {
    expect(outcomeConsumesQuota('BATCH_AI', 'custom')).toBe(false);
    expect(outcomeConsumesQuota('BATCH_AI', 'standard')).toBe(false);
  });

  it('a standard request never consumes the allowance whatever the outcome', () => {
    for (const outcome of AI_USAGE_OUTCOMES) {
      expect(outcomeConsumesQuota(outcome, 'standard')).toBe(false);
    }
  });

  it('identifies exactly the outcomes that reach a provider and therefore cost money', () => {
    const reaching = AI_USAGE_OUTCOMES.filter(outcomeReachesProvider).sort();
    expect(reaching).toEqual(['ADMIN_EVALUATION', 'BATCH_AI', 'LIVE_AI', 'STANDARD_PERSONALISED']);
  });

  it('deterministic, knowledge-base and cached outcomes reach no provider', () => {
    for (const zeroCost of ['DETERMINISTIC', 'KNOWLEDGE_BASE', 'EXACT_CACHE', 'SEMANTIC_CACHE'] as const) {
      expect(outcomeReachesProvider(zeroCost)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Sections 7, 19, 61 — public error mapping
// ---------------------------------------------------------------------------
describe('Module 11.1 section 19 — safe structured errors', () => {
  const allReasons = Object.keys(DENY_REASON_MESSAGES) as AdmissionDenyReason[];

  it('every internal deny reason has a public error code (no reason can fall through unmapped)', () => {
    for (const r of allReasons) expect(PUBLIC_ERROR_CODE[r]).toBeTruthy();
    expect(Object.keys(PUBLIC_ERROR_CODE).sort()).toEqual(allReasons.sort());
  });

  it('every kill switch collapses to ONE public code, so a response cannot map our operational posture', () => {
    for (const r of ['ai_disabled', 'kill_switch_active', 'live_provider_disabled', 'batch_disabled', 'scenario_disabled'] as const) {
      expect(PUBLIC_ERROR_CODE[r]).toBe('ai_temporarily_disabled');
    }
  });

  it('every cost ceiling collapses to ONE public code, so which ceiling was hit is not disclosed', () => {
    for (const r of ['user_cost_ceiling', 'task_monthly_cost_limit', 'provider_cost_limit', 'daily_cost_limit', 'platform_cost_ceiling'] as const) {
      expect(PUBLIC_ERROR_CODE[r]).toBe('cost_limit_reached');
    }
  });

  it('an UNDETERMINABLE entitlement is not reported as premium_required — that would be a false upsell', () => {
    expect(PUBLIC_ERROR_CODE.entitlement_unknown).toBe('ai_temporarily_disabled');
  });

  it('an EXPIRED paid period IS reported as premium_required — resubscribing genuinely resolves it', () => {
    expect(PUBLIC_ERROR_CODE.entitlement_expired).toBe('premium_required');
  });

  it('no user-facing message mentions a dollar amount, a provider, a model, or a ceiling', () => {
    for (const [reason, message] of Object.entries(DENY_REASON_MESSAGES)) {
      expect(message, reason).not.toMatch(/\$|usd|openai|gpt|claude|ceiling|threshold|budget|platform spend/i);
    }
  });

  it('gives a retry hint only where one is safe and meaningful (section 19)', () => {
    expect(retryAfterSecondsFor('rate_limited', 3600)).toBe(3600);
    expect(retryAfterSecondsFor('request_in_progress', 3600)).toBe(5);
    // Not for quota (the wait is up to a month) and never for a ceiling or a
    // kill switch, where the hint would leak how long an incident will last.
    expect(retryAfterSecondsFor('quota_exhausted', 3600)).toBeNull();
    expect(retryAfterSecondsFor('platform_cost_ceiling', 3600)).toBeNull();
    expect(retryAfterSecondsFor('kill_switch_active', 3600)).toBeNull();
    expect(retryAfterSecondsFor('not_premium', 3600)).toBeNull();
  });

  it('does not invent a retry window when none is configured', () => {
    expect(retryAfterSecondsFor('rate_limited', null)).toBeNull();
    expect(retryAfterSecondsFor('rate_limited', 0)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Section 58 — admin configuration validation
// ---------------------------------------------------------------------------
describe('Module 11.1 section 58 — admin configuration validation', () => {
  const base: AiPlatformControls = {
    id: 'global',
    ai_globally_enabled: true,
    custom_ai_enabled: true,
    kill_switch_reason: null,
    standard_requires_premium: true,
    // Module 11.5 feature switch (migration 0126) — defaults on.
    contextual_explanations_enabled: true,
    monthly_custom_question_allowance: 10,
    rate_limit_max_requests: 12,
    rate_limit_window_seconds: 3600,
    per_user_monthly_cost_ceiling_usd: 5,
    platform_monthly_cost_ceiling_usd: 500,
    max_cost_per_request_usd: 0.5,
    live_provider_enabled: true,
    batch_generation_enabled: true,
    scenario_ai_enabled: false,
    max_concurrent_requests_per_subject: 1,
    concurrency_lease_seconds: 120,
    max_context_tokens: 12000,
    max_user_input_tokens: 2000,
    max_output_tokens: 800,
    platform_soft_cost_threshold_usd: 400,
    per_user_soft_cost_threshold_usd: 4,
    daily_live_ai_cost_limit_usd: 50,
    updated_at: '2026-08-31T00:00:00Z',
    updated_by: null,
  };

  it('accepts a safe patch', () => {
    expect(validateControlsPatch(base, { monthly_custom_question_allowance: 20 })).toBeNull();
  });

  it('rejects a negative custom question limit', () => {
    expect(validateControlsPatch(base, { monthly_custom_question_allowance: -1 })).toMatch(/>= 0/);
  });

  it('rejects a zero rate limit — an unsafe state that LOOKS like a working one', () => {
    const msg = validateControlsPatch(base, { rate_limit_max_requests: 0 });
    expect(msg).toMatch(/kill switch/i);
  });

  it('rejects a soft threshold above its hard ceiling (it could never fire)', () => {
    expect(validateControlsPatch(base, { platform_soft_cost_threshold_usd: 600 })).toMatch(/can never fire/);
    expect(validateControlsPatch(base, { per_user_soft_cost_threshold_usd: 6 })).toMatch(/can never fire/);
  });

  it('validates the MERGED result, not the patch: LOWERING a hard ceiling under a stored soft threshold is caught', () => {
    // The patch itself touches only the hard ceiling and looks harmless in
    // isolation. Only the merged view sees that it strands the soft threshold
    // above it.
    expect(validateControlsPatch(base, { platform_monthly_cost_ceiling_usd: 100 })).toMatch(/can never fire/);
  });

  it('rejects a per-user ceiling above the platform ceiling — one subject could exhaust the whole budget', () => {
    expect(validateControlsPatch(base, { per_user_monthly_cost_ceiling_usd: 1000 })).toMatch(/whole platform budget/);
  });

  it('rejects a user-input budget larger than the whole context budget', () => {
    expect(validateControlsPatch(base, { max_user_input_tokens: 99999 })).toMatch(/cannot exceed max_context_tokens/);
  });

  it('rejects zero concurrency, zero lease and zero token budgets', () => {
    expect(validateControlsPatch(base, { max_concurrent_requests_per_subject: 0 })).toBeTruthy();
    expect(validateControlsPatch(base, { concurrency_lease_seconds: 0 })).toBeTruthy();
    expect(validateControlsPatch(base, { max_output_tokens: 0 })).toBeTruthy();
    expect(validateControlsPatch(base, { rate_limit_window_seconds: 0 })).toBeTruthy();
  });

  it('treats a NULL soft threshold as "not configured" rather than zero', () => {
    expect(validateControlsPatch(base, { platform_soft_cost_threshold_usd: null })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Section 60 — observability
// ---------------------------------------------------------------------------
describe('Module 11.1 section 60 — observability counters', () => {
  beforeEach(() => resetAiMetrics());

  it('counts an allowed admission and its quota consumption', () => {
    recordAdmissionMetrics({ allowed: true, denyReason: null, quotaConsumed: true, idempotencyReuse: false, executionState: 'reserved' });
    expect(getAiMetricTotal('ai_entitlement_allowed')).toBe(1);
    expect(getAiMetricTotal('ai_quota_reserved')).toBe(1);
    expect(getAiMetricTotal('ai_quota_consumed')).toBe(1);
  });

  it('maps each denial class onto its named counter', () => {
    const cases: Array<[string, Parameters<typeof getAiMetricTotal>[0]]> = [
      ['quota_exhausted', 'ai_quota_exhausted'],
      ['rate_limited', 'ai_rate_limited'],
      ['request_in_progress', 'ai_concurrency_denied'],
      ['user_cost_ceiling', 'ai_user_cost_blocked'],
      ['platform_cost_ceiling', 'ai_global_cost_blocked'],
      ['provider_disabled', 'ai_provider_disabled'],
      ['model_disabled', 'ai_model_disabled'],
      ['kill_switch_active', 'ai_kill_switch_blocked'],
    ];
    for (const [reason, counter] of cases) {
      resetAiMetrics();
      recordAdmissionMetrics({ allowed: false, denyReason: reason, quotaConsumed: false, idempotencyReuse: false, executionState: null });
      expect(getAiMetricTotal(counter), reason).toBe(1);
      expect(getAiMetricTotal('ai_entitlement_denied'), reason).toBe(1);
    }
  });

  it('counts an idempotency replay', () => {
    recordAdmissionMetrics({ allowed: true, denyReason: null, quotaConsumed: false, idempotencyReuse: true, executionState: 'finalised' });
    expect(getAiMetricTotal('ai_idempotency_reuse')).toBe(1);
  });

  it('a denial never records a quota consumption', () => {
    recordAdmissionMetrics({ allowed: false, denyReason: 'quota_exhausted', quotaConsumed: false, idempotencyReuse: false, executionState: null });
    expect(getAiMetricTotal('ai_quota_consumed')).toBe(0);
    expect(getAiMetricTotal('ai_quota_reserved')).toBe(0);
  });

  it('PRIVACY: drops any label key not on the allowlist — a user id cannot become a metric dimension', () => {
    recordAiMetric('ai_entitlement_allowed', {
      reason: 'ok',
      user_id: 'aaaaaaaa-1111-2222-3333-444444444444',
      email: 'someone@example.com',
      net_worth: 1234567,
      household_id: 'hh-1',
    });
    const [counter] = snapshotAiMetrics();
    expect(Object.keys(counter.labels)).toEqual(['reason']);
  });

  it('PRIVACY: no financial value can survive into a label even under an allowed key name', () => {
    recordAiMetric('ai_entitlement_denied', { reason: 'user_cost_ceiling', balance: 999999 });
    const [counter] = snapshotAiMetrics();
    expect(JSON.stringify(counter.labels)).not.toContain('999999');
  });

  it('bounds label length so a label is a dimension, not a payload', () => {
    recordAiMetric('ai_entitlement_denied', { reason: 'x'.repeat(500) });
    const [counter] = snapshotAiMetrics();
    expect(counter.labels.reason.length).toBe(64);
  });

  it('accumulates counters per distinct label set', () => {
    recordAiMetric('ai_rate_limited', { task_type: 'score_explanation' });
    recordAiMetric('ai_rate_limited', { task_type: 'score_explanation' });
    recordAiMetric('ai_rate_limited', { task_type: 'monthly_summary' });
    expect(getAiMetric('ai_rate_limited', { task_type: 'score_explanation' })).toBe(2);
    expect(getAiMetric('ai_rate_limited', { task_type: 'monthly_summary' })).toBe(1);
    expect(getAiMetricTotal('ai_rate_limited')).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Sections 5, 7, 8, 62 — the entitlement read model and its response shape
// ---------------------------------------------------------------------------
const rpc = vi.fn();
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ rpc }) }));

describe('Module 11.1 sections 5/7/8/62 — AIEntitlementService', () => {
  beforeEach(() => { rpc.mockReset(); });

  const premiumPayload = {
    eligible: true,
    reason: null,
    upgrade_available: false,
    plan_feature: 'AI_COACH_PREMIUM',
    billing_period: '2026-08',
    period_start: '2026-08-01',
    period_end: '2026-08-31',
    custom_questions: { limit: 10, used: 3, remaining: 7 },
  };

  async function load() {
    const mod = await import('@/lib/ai/entitlement/aiEntitlementService');
    return mod;
  }

  it('reports an eligible Premium subject with limit/used/remaining and the period', async () => {
    rpc.mockResolvedValue({ data: premiumPayload, error: null });
    const { AIEntitlementService } = await load();
    const state = await AIEntitlementService.getAIPlanEntitlement('user-1');
    expect(state.eligible).toBe(true);
    expect(state.customQuestions).toEqual({ limit: 10, used: 3, remaining: 7 });
    expect(state.period.periodStart).toBe('2026-08-01');
  });

  it('serialises the section 8 shape and NOTHING else', async () => {
    rpc.mockResolvedValue({ data: premiumPayload, error: null });
    const { AIEntitlementService, toPublicEntitlementResponse } = await load();
    const body = toPublicEntitlementResponse(await AIEntitlementService.getAIPlanEntitlement('user-1'));
    expect(body).toEqual({
      eligible: true,
      plan_feature: 'AI_COACH_PREMIUM',
      personalised_ai_enabled: true,
      custom_questions: { limit: 10, used: 3, remaining: 7, period_start: '2026-08-01', period_end: '2026-08-31' },
    });
    // Section 8/61: none of these may ever appear in a user-facing payload.
    const json = JSON.stringify(body).toLowerCase();
    for (const forbidden of ['cost', 'ceiling', 'threshold', 'provider', 'model', 'rate_limit', 'kill_switch', 'spend', 'budget']) {
      expect(json, forbidden).not.toContain(forbidden);
    }
  });

  it('returns section 7 exact denial shape for a Free subject', async () => {
    rpc.mockResolvedValue({
      data: { ...premiumPayload, eligible: false, reason: 'premium_required', upgrade_available: true },
      error: null,
    });
    const { AIEntitlementService, toPublicEntitlementResponse } = await load();
    const body = toPublicEntitlementResponse(await AIEntitlementService.getAIPlanEntitlement('user-2'));
    expect(body).toEqual({ eligible: false, reason: 'premium_required', upgrade_available: true });
  });

  it('FAILS CLOSED when the RPC errors — denied, and no upgrade is offered for our own outage', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'connection refused' } });
    const { AIEntitlementService } = await load();
    const state = await AIEntitlementService.getAIPlanEntitlement('user-3');
    expect(state.eligible).toBe(false);
    expect(state.reason).toBe('ai_unavailable');
    expect(state.upgradeAvailable).toBe(false);
    expect(state.customQuestions.remaining).toBe(0);
  });

  it('FAILS CLOSED when the RPC throws', async () => {
    rpc.mockRejectedValue(new Error('socket hang up'));
    const { AIEntitlementService } = await load();
    expect((await AIEntitlementService.getAIPlanEntitlement('user-4')).eligible).toBe(false);
  });

  it('FAILS CLOSED on a malformed payload rather than reading a truthy field as an allow', async () => {
    rpc.mockResolvedValue({ data: { eligible: 'yes', custom_questions: { limit: 10 } }, error: null });
    const { AIEntitlementService } = await load();
    const state = await AIEntitlementService.getAIPlanEntitlement('user-5');
    expect(state.eligible).toBe(false);
  });

  it('FAILS CLOSED on an empty user id without calling the database at all', async () => {
    const { AIEntitlementService } = await load();
    expect((await AIEntitlementService.getAIPlanEntitlement('')).eligible).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('never lets a household id influence the answer (section 11 — quota cannot be multiplied)', async () => {
    rpc.mockResolvedValue({ data: premiumPayload, error: null });
    const { AIEntitlementService } = await load();
    await AIEntitlementService.getAIPlanEntitlement('user-1', 'someone-elses-household');
    // The household is not passed to the database at all, so no household
    // value can change the verdict.
    expect(rpc).toHaveBeenCalledWith('ai_entitlement_state', { p_user_id: 'user-1' });
  });

  it('canConsumeCustomQuestion is false at zero remaining, and false for an ineligible subject', async () => {
    const { AIEntitlementService } = await load();
    rpc.mockResolvedValue({ data: { ...premiumPayload, custom_questions: { limit: 10, used: 10, remaining: 0 } }, error: null });
    expect(await AIEntitlementService.canConsumeCustomQuestion('u')).toBe(false);
    rpc.mockResolvedValue({ data: { ...premiumPayload, eligible: false, reason: 'premium_required' }, error: null });
    expect(await AIEntitlementService.canConsumeCustomQuestion('u')).toBe(false);
    rpc.mockResolvedValue({ data: premiumPayload, error: null });
    expect(await AIEntitlementService.canConsumeCustomQuestion('u')).toBe(true);
  });

  it('derives the allowance period from the DATABASE, never from the local clock (section 73)', async () => {
    rpc.mockResolvedValue({ data: { ...premiumPayload, billing_period: '2019-02', period_start: '2019-02-01', period_end: '2019-02-28' }, error: null });
    const { AIEntitlementService } = await load();
    const period = await AIEntitlementService.getCurrentAllowancePeriod('u');
    expect(period).toEqual({ billingPeriod: '2019-02', periodStart: '2019-02-01', periodEnd: '2019-02-28' });
  });
});
