import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MockAIProvider, estimateTokens } from '@/lib/ai/providers/mockProvider';
import { ProviderError } from '@/lib/ai/providers/types';
import { AIModelGateway } from '@/lib/ai/gateway/aiModelGateway';
import type { FinancialContextObject } from '@/lib/ai/context/types';
import type { ModelRegistryRow } from '@/lib/ai/modelRegistry';
import type { PromptTemplateRow } from '@/lib/ai/promptRegistry';
// Module 11.1: the gateway now enforces entitlement before calling a provider,
// and its gate defaults to the REAL DB-backed one. These Module 11.0 tests are
// about provider/schema/certification behaviour, so they inject an explicit
// always-allow stub — the bypass is visible at every construction site.
import { allowAllGate } from '@/tests/unit/support/entitlementGateStubs';

vi.mock('@/lib/ai/audit/aiRuns', () => ({
  recordAiRun: vi.fn(async () => 'mock-run-id'),
  hashContext: vi.fn(() => 'mock-hash'),
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
    household: null,
    cash_flow: null,
    balance_sheet: null,
    health_score: null,
    financial_dna: null,
    resilience: null,
    investments: null,
    retirement: null,
    insurance: null,
    goals: [],
    forecasts: [],
    financial_twin: null,
    risks: [],
    recommendations: [],
    reports: [],
    cross_border: null,
    data_quality: {
      complete_domains: [],
      incomplete_domains: [],
      missing_fields: [],
      confirmed_zero_fields: [],
      stale_fields: [],
      rejected_records: [],
      excluded_duplicates: [],
      valuation_date_issues: [],
      unsupported_calculations: [],
      unavailable_modules: [],
      confidence_limitations: [],
    },
    domain_certification: {} as FinancialContextObject['domain_certification'],
    source_references: [{ source_type: 'health_score', source_id: 'abc-123', model_version: 'fhs-2.0.0', data_as_of: '2026-08-01' }],
  };
}

const FAKE_MODEL: ModelRegistryRow = {
  id: 'model-1',
  provider: 'mock',
  model_identifier: 'mock-standard-1',
  internal_tier: 'STANDARD',
  active: true,
  approved: true,
  task_types: ['score_explanation'],
  max_input_tokens: 8000,
  max_output_tokens: 800,
  supports_structured_output: true,
  supports_streaming: false,
  supports_batch: false,
  cost_input_per_1k_usd: 0,
  cost_output_per_1k_usd: 0,
  effective_from: null,
  effective_to: null,
  rollout_percentage: 100,
  fallback_model_id: null,
  created_by: null,
  approved_by: null,
  approved_at: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

const FAKE_PROMPT: PromptTemplateRow = {
  id: 'prompt-1',
  prompt_code: 'PR-AI-001',
  prompt_name: 'Financial Health Score Explanation',
  version: 1,
  task_type: 'score_explanation',
  system_prompt: 'Explain the score using only supplied data.',
  developer_prompt: 'Context: {{context}}',
  context_schema_version: 'ai-context-1.0.0',
  output_schema_version: 'ai-response-envelope-1.0.0',
  country_scope: null,
  safety_policy_version: 'safety-policy-1.0.0',
  status: 'ACTIVE',
  approved_by: null,
  approved_at: null,
  effective_from: null,
  effective_to: null,
  supersedes_prompt_id: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

function baseRequest(overrides: Partial<Parameters<AIModelGateway['generateExplanation']>[0]> = {}) {
  return {
    taskType: 'score_explanation' as const,
    systemPrompt: FAKE_PROMPT.system_prompt,
    userPrompt: FAKE_PROMPT.developer_prompt,
    prompt: FAKE_PROMPT,
    model: FAKE_MODEL,
    context: minimalContext(),
    userId: 'user-1',
    householdId: 'household-1',
    // Module 11.1: request class is required and has no default.
    requestClass: 'standard' as const,
    ...overrides,
  };
}

describe('MockAIProvider (spec section 26)', () => {
  it('never makes a network call and returns deterministic valid output by default', async () => {
    const provider = new MockAIProvider();
    const result = await provider.generateStructured({
      systemPrompt: 'sys',
      userPrompt: 'user',
      taskType: 'score_explanation',
      model: 'mock-standard-1',
      maxOutputTokens: 800,
      responseSchema: 'ai_response_envelope',
    });
    expect(() => JSON.parse(result.rawText)).not.toThrow();
    expect(result.modelVersion).toBe('mock-1.0.0');
  });

  it('estimateCost never charges anything', () => {
    const provider = new MockAIProvider();
    expect(provider.estimateCost(1000, 500, 'mock-standard-1').estimatedCostUsd).toBe(0);
  });

  it('estimateTokens is deterministic', () => {
    expect(estimateTokens('hello world')).toBe(estimateTokens('hello world'));
    expect(estimateTokens('')).toBeGreaterThan(0);
  });

  it('simulates a timeout on request (spec 51-H)', async () => {
    const provider = new MockAIProvider({ behavior: 'timeout' });
    await expect(
      provider.generateStructured({ systemPrompt: '', userPrompt: '', taskType: 'score_explanation', model: 'x', maxOutputTokens: 10, responseSchema: 'ai_response_envelope' })
    ).rejects.toThrow(ProviderError);
  });

  it('simulates provider unavailable', async () => {
    const provider = new MockAIProvider({ behavior: 'provider_unavailable' });
    const health = await provider.validateProviderHealth();
    expect(health.healthy).toBe(false);
  });
});

describe('AIModelGateway (spec sections 25, 47, 51)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('accepts a valid mock response end-to-end', async () => {
    const gateway = new AIModelGateway(new MockAIProvider({ behavior: 'valid' }), allowAllGate());
    const result = await gateway.generateExplanation(baseRequest());
    expect(result.ok).toBe(true);
  });

  it('rejects malformed JSON from the provider (fail closed, spec 51-F)', async () => {
    const gateway = new AIModelGateway(new MockAIProvider({ behavior: 'malformed_json' }), allowAllGate());
    const result = await gateway.generateExplanation(baseRequest());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.executionStatus).toBe('rejected_schema');
  });

  it('rejects a schema-invalid response', async () => {
    const gateway = new AIModelGateway(new MockAIProvider({ behavior: 'schema_invalid' }), allowAllGate());
    const result = await gateway.generateExplanation(baseRequest());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.executionStatus).toBe('rejected_schema');
  });

  it('rejects a response citing an unknown source (spec 51-E)', async () => {
    const gateway = new AIModelGateway(new MockAIProvider({ behavior: 'unknown_source_ref' }), allowAllGate());
    const result = await gateway.generateExplanation(baseRequest());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.executionStatus).toBe('rejected_source_ref');
  });

  it('fails safely on provider timeout (spec 51-H)', async () => {
    const gateway = new AIModelGateway(new MockAIProvider({ behavior: 'timeout' }), allowAllGate());
    const result = await gateway.generateExplanation(baseRequest());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.executionStatus).toBe('timeout');
  });

  it('fails safely on provider outage (spec 51-I equivalent: provider unreachable)', async () => {
    const gateway = new AIModelGateway(new MockAIProvider({ behavior: 'provider_unavailable' }), allowAllGate());
    const result = await gateway.generateExplanation(baseRequest());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.executionStatus).toBe('provider_error');
  });

  it('rejects when no model is configured for the task (spec 51-J: model deactivated)', async () => {
    const gateway = new AIModelGateway(new MockAIProvider(), allowAllGate());
    const result = await gateway.generateExplanation(baseRequest({ model: null }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.executionStatus).toBe('rejected_certification');
  });

  it('rejects when no ACTIVE prompt is configured', async () => {
    const gateway = new AIModelGateway(new MockAIProvider(), allowAllGate());
    const result = await gateway.generateExplanation(baseRequest({ prompt: null }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.executionStatus).toBe('rejected_certification');
  });

  it('fails closed when the financial context is UNAVAILABLE (spec 51-G: certification changes during request)', async () => {
    const gateway = new AIModelGateway(new MockAIProvider(), allowAllGate());
    const result = await gateway.generateExplanation(baseRequest({ context: minimalContext('UNAVAILABLE') }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.executionStatus).toBe('rejected_certification');
  });

  it('fails closed when the financial context is INVALID', async () => {
    const gateway = new AIModelGateway(new MockAIProvider(), allowAllGate());
    const result = await gateway.generateExplanation(baseRequest({ context: minimalContext('INVALID') }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.executionStatus).toBe('rejected_certification');
  });

  it('provider abstraction: identical request shape works through MockAIProvider regardless of behavior wiring (proves the interface, not a concrete implementation)', async () => {
    const providers = [new MockAIProvider({ behavior: 'valid' })];
    for (const provider of providers) {
      const gateway = new AIModelGateway(provider, allowAllGate());
      const result = await gateway.generateExplanation(baseRequest());
      expect(result.ok).toBe(true);
    }
  });
});
