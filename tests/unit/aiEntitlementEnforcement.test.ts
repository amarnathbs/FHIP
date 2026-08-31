// Module 11.1 — unit certification of the application-side enforcement layer.
//
// The DB does the deciding (certified separately in
// scripts/db-rebuild-check/module11_1_entitlement_cert.mjs, 130/130 on a real
// Postgres). What is tested HERE is everything the application layer is
// responsible for and the database cannot be:
//   * the gateway consults the gate BEFORE any provider call, and obeys it;
//   * quota is not burned by a request the free certification gates were
//     always going to reject;
//   * a consumed question is refunded when the provider produces no answer;
//   * an unusable/absent/contradictory verdict from the RPC denies rather
//     than allows;
//   * the cost estimate fed to the ceilings is registry-driven, not one
//     hardcoded price for every model.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AIModelGateway } from '@/lib/ai/gateway/aiModelGateway';
import { MockAIProvider } from '@/lib/ai/providers/mockProvider';
import { interpretAdmissionPayload } from '@/lib/ai/entitlement/entitlementService';
import { estimateCallCost } from '@/lib/ai/cost/registryCost';
import { currentBillingPeriod } from '@/lib/ai/billingPeriod';
import { normaliseQuestion, normalisedQuestionHash } from '@/lib/ai/cache/answerCache';
import { DENY_REASON_MESSAGES } from '@/lib/ai/entitlement/types';
import { allowAllGate, denyGate } from '@/tests/unit/support/entitlementGateStubs';
import type { FinancialContextObject } from '@/lib/ai/context/types';
import type { ModelRegistryRow } from '@/lib/ai/modelRegistry';
import type { PromptTemplateRow } from '@/lib/ai/promptRegistry';

const recordAiRun = vi.fn<(input: unknown) => Promise<string>>(async () => 'mock-run-id');
vi.mock('@/lib/ai/audit/aiRuns', () => ({
  recordAiRun: (input: unknown) => recordAiRun(input),
  hashContext: () => 'mock-hash',
}));

function minimalContext(certStatus: FinancialContextObject['meta']['certification_status'] = 'CERTIFIED'): FinancialContextObject {
  return {
    meta: {
      context_version: 'ai-context-1.0.0',
      generated_at: new Date().toISOString(),
      user_scope_identifier: 'usr_test',
      household_scope_identifier: 'usr_test',
      reporting_currency: 'AUD',
      country_of_residence: 'AU',
      data_as_of: '2026-08-01',
      snapshot_id: null,
      source_snapshot_version: 'dashboard-1.0.0',
      calculation_status: 'complete',
      integrity_status: certStatus,
      currency_integrity_status: 'CERTIFIED',
      data_completeness: null,
      certification_status: certStatus,
      request_scope: 'FULL',
    },
    household: null, cash_flow: null, balance_sheet: null, health_score: null,
    financial_dna: null, resilience: null, investments: null, retirement: null,
    insurance: null, goals: [], forecasts: [], financial_twin: null, risks: [],
    recommendations: [], reports: [], cross_border: null,
    data_quality: {
      complete_domains: [], incomplete_domains: [], missing_fields: [],
      confirmed_zero_fields: [], stale_fields: [], rejected_records: [],
      excluded_duplicates: [], valuation_date_issues: [], unsupported_calculations: [],
      unavailable_modules: [], confidence_limitations: [],
    },
    domain_certification: {} as FinancialContextObject['domain_certification'],
    source_references: [],
  } as unknown as FinancialContextObject;
}

const MODEL: ModelRegistryRow = {
  id: 'model-1', provider: 'mock', model_identifier: 'mock-standard-1', internal_tier: 'STANDARD',
  active: true, approved: true, task_types: ['score_explanation'], max_input_tokens: 8000,
  max_output_tokens: 800, supports_structured_output: true, supports_streaming: false,
  supports_batch: false, cost_input_per_1k_usd: 0, cost_output_per_1k_usd: 0,
  effective_from: null, effective_to: null, rollout_percentage: 100, fallback_model_id: null,
  created_by: null, approved_by: null, approved_at: null,
  created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
};

const PROMPT: PromptTemplateRow = {
  id: 'prompt-1', prompt_code: 'PR-AI-001', prompt_name: 'Score Explanation', version: 1,
  task_type: 'score_explanation', system_prompt: 'Explain.', developer_prompt: 'Context: {{context}}',
  context_schema_version: 'ai-context-1.0.0', output_schema_version: 'ai-response-envelope-1.0.0',
  country_scope: null, safety_policy_version: 'safety-policy-1.0.0', status: 'ACTIVE',
  approved_by: null, approved_at: null, effective_from: null, effective_to: null,
  supersedes_prompt_id: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
} as unknown as PromptTemplateRow;

function request(overrides: Record<string, unknown> = {}) {
  return {
    taskType: 'score_explanation' as const,
    systemPrompt: PROMPT.system_prompt,
    userPrompt: PROMPT.developer_prompt,
    prompt: PROMPT,
    model: MODEL,
    context: minimalContext(),
    userId: 'user-1',
    householdId: 'household-1',
    requestClass: 'custom' as const,
    ...overrides,
  };
}

describe('Module 11.1 — the gateway obeys the entitlement gate', () => {
  beforeEach(() => { recordAiRun.mockClear(); });

  it('consults the gate BEFORE any provider call, and never reaches the provider when refused', async () => {
    const provider = new MockAIProvider({ behavior: 'valid' });
    const spy = vi.spyOn(provider, 'generateStructured');
    const gate = denyGate('quota_exhausted');
    const result = await new AIModelGateway(provider, gate).generateExplanation(request());

    expect(result.ok).toBe(false);
    expect(gate.admissions).toHaveLength(1);
    expect(spy).not.toHaveBeenCalled();
  });

  it.each([
    ['quota_exhausted'], ['not_premium'], ['kill_switch_active'], ['rate_limited'],
    ['user_cost_ceiling'], ['platform_cost_ceiling'], ['ai_disabled'],
    ['model_tier_exceeds_task_limit'], ['enforcement_unavailable'], ['entitlement_unknown'],
  ] as const)('refuses with rejected_entitlement and surfaces the specific reason: %s', async (reason) => {
    const result = await new AIModelGateway(new MockAIProvider(), denyGate(reason)).generateExplanation(request());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.executionStatus).toBe('rejected_entitlement');
      expect(result.denyReason).toBe(reason);
      expect(result.reason).toBe(DENY_REASON_MESSAGES[reason]);
    }
  });

  it('audits an entitlement rejection with the SPECIFIC reason in error_code, not the generic status', async () => {
    await new AIModelGateway(new MockAIProvider(), denyGate('quota_exhausted')).generateExplanation(request());
    expect(recordAiRun).toHaveBeenCalledTimes(1);
    const audited = recordAiRun.mock.calls[0][0] as unknown as { executionStatus: string; errorCode: string };
    expect(audited.executionStatus).toBe('rejected_entitlement');
    expect(audited.errorCode).toBe('quota_exhausted');
  });

  it('passes the declared request class and the derived cache-hit flag through unchanged', async () => {
    const gate = allowAllGate();
    await new AIModelGateway(new MockAIProvider(), gate).generateExplanation(request({ requestClass: 'standard', cacheHit: true }));
    expect(gate.admissions[0].requestClass).toBe('standard');
    expect(gate.admissions[0].cacheHit).toBe(true);
  });

  it('defaults cacheHit to false — the quota-CONSUMING direction — when the caller omits it', async () => {
    const gate = allowAllGate();
    await new AIModelGateway(new MockAIProvider(), gate).generateExplanation(request());
    expect(gate.admissions[0].cacheHit).toBe(false);
  });

  it("supplies the model's registry tier so per-task model-tier caps can be enforced", async () => {
    const gate = allowAllGate();
    await new AIModelGateway(new MockAIProvider(), gate).generateExplanation(request());
    expect(gate.admissions[0].internalTier).toBe('STANDARD');
  });

  it('allows the call through when the gate permits it', async () => {
    const result = await new AIModelGateway(new MockAIProvider({ behavior: 'valid' }), allowAllGate()).generateExplanation(request());
    expect(result.ok).toBe(true);
  });
});

describe('Module 11.1 — quota is never burned by a request the free gates were always going to reject', () => {
  beforeEach(() => { recordAiRun.mockClear(); });

  it.each([
    ['no approved model', { model: null }],
    ['no ACTIVE prompt', { prompt: null }],
    ['UNAVAILABLE context', { context: minimalContext('UNAVAILABLE') }],
    ['INVALID context', { context: minimalContext('INVALID') }],
  ])('does not even ask the gate when the request is rejected for %s', async (_label, overrides) => {
    const gate = allowAllGate();
    const result = await new AIModelGateway(new MockAIProvider(), gate).generateExplanation(request(overrides));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.executionStatus).toBe('rejected_certification');
    expect(gate.admissions).toHaveLength(0);
  });
});

describe('Module 11.1 — a failed provider call refunds the consumed question', () => {
  beforeEach(() => { recordAiRun.mockClear(); });

  it.each([
    ['provider outage', 'provider_unavailable'],
    ['timeout', 'timeout'],
    ['malformed response', 'malformed_json'],
    ['schema-invalid response', 'schema_invalid'],
    ['response citing an unknown source', 'unknown_source_ref'],
  ] as const)('refunds after %s', async (_label, behavior) => {
    const gate = allowAllGate(true);
    const result = await new AIModelGateway(new MockAIProvider({ behavior }), gate).generateExplanation(request());
    expect(result.ok).toBe(false);
    expect(gate.refunds).toEqual(['admission-stub-id']);
  });

  it('does NOT refund a successful call — it FINALISES it (spec section 14)', async () => {
    const gate = allowAllGate(true);
    const result = await new AIModelGateway(new MockAIProvider({ behavior: 'valid' }), gate).generateExplanation(request());
    expect(result.ok).toBe(true);
    expect(gate.refunds).toEqual([]);
    // RESERVED -> VALIDATED SUCCESS -> CONSUMED. The credit stands and the
    // concurrency lease is released rather than being left to expire.
    expect(gate.finalisations).toEqual(['admission-stub-id']);
  });

  it('does NOT finalise a failed call', async () => {
    const gate = allowAllGate(true);
    await new AIModelGateway(new MockAIProvider({ behavior: 'timeout' }), gate).generateExplanation(request());
    expect(gate.finalisations).toEqual([]);
  });

  it('releases the reservation on failure even when NO quota was consumed (spec sections 14, 18)', async () => {
    // CHANGED IN THE FULL-SPEC PASS, deliberately. This test previously
    // asserted that the gateway made no refund call at all when nothing had
    // been consumed. That was correct while a refund only ever meant "give the
    // question back", but section 14 added an explicit reservation lifecycle
    // and section 18 added a concurrency limit that COUNTS open reservations.
    //
    // A 'standard' request consumes no quota but still holds a live
    // reservation. Leaving it open after a provider failure would count
    // against the subject's concurrency limit until its lease expired —
    // blocking their next request because of a failure that was ours.
    //
    // So the gateway now always calls refund() on a post-admission failure.
    // ai_refund_admission() releases the reservation unconditionally and
    // returns a question ONLY if one was consumed, which the PGlite
    // certification asserts directly against the real function.
    const gate = allowAllGate(false);
    await new AIModelGateway(new MockAIProvider({ behavior: 'timeout' }), gate).generateExplanation(request({ requestClass: 'standard' }));
    expect(gate.refunds).toEqual(['admission-stub-id']);
    expect(gate.finalisations).toEqual([]);
  });
});

describe('Module 11.1 — the RPC verdict is interpreted fail-closed', () => {
  it.each([
    ['null', null],
    ['a non-object', 'yes'],
    ['an empty object (no `allowed` field)', {}],
    ['allowed as a string rather than a boolean', { allowed: 'true' }],
    ['an unrecognised deny_reason', { allowed: false, deny_reason: 'because_i_said_so' }],
    ['allowed=true carrying a deny reason (the layers disagree)', { allowed: true, deny_reason: 'quota_exhausted' }],
    ['allowed=false with no reason given', { allowed: false, deny_reason: null }],
  ])('denies when the RPC returns %s', (_label, payload) => {
    const result = interpretAdmissionPayload(payload);
    expect(result.allowed).toBe(false);
    expect(result.denyReason).toBe('enforcement_unavailable');
    expect(result.enforcementError).toBeTruthy();
  });

  it('accepts a well-formed allow', () => {
    const result = interpretAdmissionPayload({
      allowed: true, deny_reason: null, admission_id: 'adm-1', billing_period: '2026-08',
      plan_tier: 'premium', quota_consumed: true, quota_allowance: 10, quota_used: 3, quota_remaining: 7,
    });
    expect(result.allowed).toBe(true);
    expect(result.admissionId).toBe('adm-1');
    expect(result.quotaRemaining).toBe(7);
    expect(result.quotaConsumed).toBe(true);
  });

  it('accepts a well-formed denial and preserves the specific reason', () => {
    const result = interpretAdmissionPayload({ allowed: false, deny_reason: 'quota_exhausted' });
    expect(result.allowed).toBe(false);
    expect(result.denyReason).toBe('quota_exhausted');
  });

  it('coerces numeric strings (PostgREST returns numeric as string) without losing the value', () => {
    const result = interpretAdmissionPayload({ allowed: true, deny_reason: null, user_cost_used_usd: '1.250000', quota_used: '4' });
    expect(result.userCostUsedUsd).toBe(1.25);
    expect(result.quotaUsed).toBe(4);
  });

  it('every deny reason has an end-user message that leaks no ceiling or platform figure', () => {
    for (const [reason, message] of Object.entries(DENY_REASON_MESSAGES)) {
      expect(message.length, reason).toBeGreaterThan(10);
      expect(message, reason).not.toMatch(/\$|usd|ceiling|platform_|\d+\.\d+/i);
    }
  });
});

describe('Module 11.1 — cost estimation is registry-driven', () => {
  const provider = new MockAIProvider();

  it('uses the registry per-1k prices when the admin has entered them', () => {
    const priced = { ...MODEL, cost_input_per_1k_usd: 0.15, cost_output_per_1k_usd: 0.6 };
    const est = estimateCallCost(provider, priced, 1000, 500);
    expect(est.source).toBe('registry');
    expect(est.estimatedCostUsd).toBeCloseTo(0.15 + 0.3, 10);
  });

  it('prices two different models differently — the gap Module 11.0 could not express', () => {
    const cheap = { ...MODEL, model_identifier: 'cheap-1', cost_input_per_1k_usd: 0.01, cost_output_per_1k_usd: 0.02 };
    const dear = { ...MODEL, model_identifier: 'dear-1', cost_input_per_1k_usd: 3, cost_output_per_1k_usd: 15 };
    expect(estimateCallCost(provider, dear, 1000, 1000).estimatedCostUsd)
      .toBeGreaterThan(estimateCallCost(provider, cheap, 1000, 1000).estimatedCostUsd);
  });

  it('falls back to the provider estimator when the registry has no price, and says so', () => {
    const unpriced = { ...MODEL, cost_input_per_1k_usd: null, cost_output_per_1k_usd: null };
    expect(estimateCallCost(provider, unpriced, 1000, 500).source).toBe('provider');
  });

  it('treats a partially-priced registry row as unpriced rather than assuming a zero half', () => {
    const half = { ...MODEL, cost_input_per_1k_usd: 0.15, cost_output_per_1k_usd: null };
    expect(estimateCallCost(provider, half, 1000, 500).source).toBe('provider');
  });

  it('never produces a negative or NaN cost from hostile token counts', () => {
    for (const [i, o] of [[-5, 10], [10, -5], [NaN, 10], [10, NaN]] as [number, number][]) {
      const est = estimateCallCost(provider, { ...MODEL, cost_input_per_1k_usd: 1, cost_output_per_1k_usd: 1 }, i, o);
      expect(Number.isFinite(est.estimatedCostUsd)).toBe(true);
      expect(est.estimatedCostUsd).toBeGreaterThanOrEqual(0);
    }
  });

  it('a genuinely zero-priced model (the mock) costs genuinely zero, not approximately zero', () => {
    expect(estimateCallCost(provider, MODEL, 10_000, 10_000).estimatedCostUsd).toBe(0);
  });
});

describe('Module 11.1 — billing period and cache key derivation', () => {
  it('formats the billing period as a zero-padded UTC YYYY-MM', () => {
    expect(currentBillingPeriod(new Date(Date.UTC(2026, 0, 15)))).toBe('2026-01');
    expect(currentBillingPeriod(new Date(Date.UTC(2026, 11, 31)))).toBe('2026-12');
  });

  it('assigns an instant just before UTC midnight on the 1st to the PREVIOUS month', () => {
    expect(currentBillingPeriod(new Date(Date.UTC(2026, 8, 1, 0, 0, 0) - 1))).toBe('2026-08');
    expect(currentBillingPeriod(new Date(Date.UTC(2026, 8, 1, 0, 0, 0)))).toBe('2026-09');
  });

  it('normalises trivially different spellings of the same question to the same cache key', () => {
    const a = normalisedQuestionHash('Why is my savings rate low?');
    expect(normalisedQuestionHash('why   is my SAVINGS rate low')).toBe(a);
    expect(normalisedQuestionHash('  Why is my savings rate low???  ')).toBe(a);
  });

  it('does NOT conflate genuinely different questions (normalisation is textual, never semantic)', () => {
    expect(normalisedQuestionHash('Why is my savings rate low?')).not.toBe(normalisedQuestionHash('Why is my savings rate high?'));
    expect(normaliseQuestion('Why is my savings rate low?')).toBe('why is my savings rate low');
  });
});
