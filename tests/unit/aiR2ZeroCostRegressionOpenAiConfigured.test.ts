// Module 11 remediation R2 — ZERO-COST REGRESSION WITH OPENAI CONNECTED
// (brief section 21; re-run under R6 section 56 as the integrated negative
// control).
//
// "Connecting OpenAI must not cause previously zero-cost features to begin
// spending money." This file configures the environment EXACTLY as a
// real-provider deployment would (MODULE11_AI_PROVIDER=openai, a credential
// present, the configured model set), installs a network-level tripwire on
// the global fetch AND a spy on the real adapter, then executes:
//
//   * the entire Module 11.4 standard-question estate (all 25 codes, several
//     synthetic households, two passes), and
//   * the entire Module 11.5 contextual-explanation estate (every registered
//     target, several households, two passes),
//
// and asserts: zero calls to api.openai.com, zero adapter invocations, zero
// admission RPCs (so zero quota movement). A positive control first proves
// the tripwire fires when the real adapter IS invoked, so a zero here is a
// measured zero rather than a vacuous one.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { makeContext } from './support/financialContextFixture';
import { freshState, makeAdminClient, makeServerClient, seedStoredInsights, type HarnessState } from './support/contextualExplainHarness';
import { CONTEXTUAL_EXPLANATION_TARGETS } from '@/lib/ai/contextualExplanations/registry';
import { STANDARD_QUESTIONS } from '@/lib/ai/standardQuestions/catalogue';
import type { RouterDependencies } from '@/lib/ai/resolution/router';

let state: HarnessState = freshState();
let contextBuilder: () => unknown = () => makeContext();
const SESSION_USER = 'user-zero-cost';

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => makeAdminClient(state) }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => makeServerClient(state, SESSION_USER) }));
vi.mock('@/lib/ai/resolution/routerDependencies', () => ({
  createRouterDependencies: () => ({
    buildContext: async () => contextBuilder(),
    getUserCountry: async () => 'AU' as const,
    isPersonalisedAiEligible: async () => state.eligible,
  }),
  hashNormalisedQuestion: (s: string) => s,
}));

const { AIContextualExplanationService } = await import('@/lib/ai/contextualExplanations/service');
const { AIStandardQuestionService } = await import('@/lib/ai/standardQuestions/service');
const { OpenAIProviderAdapter } = await import('@/lib/ai/providers/openaiProvider');

const ENV_KEYS = ['MODULE11_AI_PROVIDER', 'MODULE11_AI_MODEL', 'OPENAI_API_KEY'] as const;
const saved: Record<string, string | undefined> = {};
const originalFetch = globalThis.fetch;
const openAiCalls: string[] = [];

function fakeDeps(): RouterDependencies {
  return {
    buildContext: vi.fn(async () => contextBuilder() as ReturnType<typeof makeContext>),
    getUserCountry: vi.fn(async () => 'AU' as const),
    isPersonalisedAiEligible: vi.fn(async () => true),
  };
}

beforeAll(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.MODULE11_AI_PROVIDER = 'openai';
  process.env.MODULE11_AI_MODEL = 'gpt-4o-mini';
  process.env.OPENAI_API_KEY = 'sk-unit-test-only-never-sent-anywhere';
  // Network tripwire: any attempt to reach OpenAI is recorded and refused.
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes('api.openai.com')) {
      openAiCalls.push(url);
      return new Response('{"error":{"message":"tripwire"}}', { status: 500 });
    }
    throw new Error(`Unexpected network call in zero-cost regression: ${url}`);
  }) as typeof fetch;
});

afterAll(() => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  globalThis.fetch = originalFetch;
});

beforeEach(() => {
  openAiCalls.length = 0;
  state = freshState({
    currentSnapshotId: 'snap-current',
    reports: new Map([[ 'report-current', { id: 'report-current', user_id: SESSION_USER, report_month: '2026-09-01', as_of_date: '2026-09-01', financial_snapshot_id: 'snap-current' } ]]),
  });
  seedStoredInsights(state, [
    'SCORE_EXPLANATION', 'SCORE_CHANGE_EXPLANATION', 'NET_WORTH_EXPLANATION', 'CASH_FLOW_EXPLANATION',
    'SAVINGS_EXPLANATION', 'LIQUIDITY_EXPLANATION', 'DEBT_EXPLANATION', 'FORECAST_SUMMARY_EXPLANATION',
    'RETIREMENT_EXPLANATION', 'TWIN_SUMMARY_EXPLANATION', 'DATA_QUALITY_SUMMARY_EXPLANATION',
    'REPORT_READING_EXPLANATION', 'DNA_EXPLANATION', 'RESILIENCE_EXPLANATION', 'PRIORITY_REVIEW_AREAS_EXPLANATION',
  ]);
  contextBuilder = () => makeContext();
});

describe('R2 section 21 — zero-cost paths stay at provider=0 with OpenAI configured', () => {
  it('POSITIVE CONTROL: the tripwire and the adapter spy both fire when the real adapter is actually invoked', async () => {
    const spy = vi.spyOn(OpenAIProviderAdapter.prototype, 'generateStructured');
    const adapter = new OpenAIProviderAdapter(); // default fetch = the tripwire
    await expect(adapter.generateStructured({ systemPrompt: 's', userPrompt: 'u', taskType: 'monthly_insight_pack', model: 'gpt-4o-mini', maxOutputTokens: 10, responseSchema: 'insight_pack_envelope' })).rejects.toThrow();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(openAiCalls.length).toBeGreaterThanOrEqual(1);
    spy.mockRestore();
  });

  it('Module 11.4 standard questions: 25 codes x 3 households x 2 passes -> openai calls = 0, adapter calls = 0, admission RPCs = 0', async () => {
    const spy = vi.spyOn(OpenAIProviderAdapter.prototype, 'generateStructured');
    const contexts = [
      makeContext(),
      makeContext({ goals: [] }),
      makeContext({ domain_certification: { ...makeContext().domain_certification, investments: { status: 'UNAVAILABLE', reason: 'none', model_versions: [], data_as_of: null } } }),
    ];
    let resolved = 0;
    for (let pass = 0; pass < 2; pass++) {
      for (const ctx of contexts) {
        contextBuilder = () => ctx;
        for (const def of STANDARD_QUESTIONS) {
          if (def.standard_question_code === 'SQ-AI-021') {
            AIStandardQuestionService.resolveGoalRiskQuestion(SESSION_USER, null, def, ctx, undefined);
          } else {
            await AIStandardQuestionService.resolveDefinition(fakeDeps(), SESSION_USER, null, def, ctx);
          }
          resolved += 1;
        }
      }
    }
    expect(resolved).toBe(150);
    expect(openAiCalls).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
    expect(state.rpcCalls.get('ai_admit_request') ?? 0).toBe(0);
    spy.mockRestore();
  });

  it('Module 11.5 contextual Explain: every target x 5 households x 2 passes -> openai calls = 0, adapter calls = 0, admission RPCs = 0', async () => {
    const spy = vi.spyOn(OpenAIProviderAdapter.prototype, 'generateStructured');
    const households: (() => unknown)[] = [
      () => makeContext(),
      () => makeContext({ goals: [] }),
      () => makeContext({ financial_twin: null }),
      () => makeContext({ financial_dna: null }),
      () => makeContext({ health_score: { ...makeContext().health_score!, prior_valid_score: null, score_movement: null } }),
    ];
    let executed = 0;
    for (let pass = 0; pass < 2; pass++) {
      for (const build of households) {
        contextBuilder = build;
        for (const target of CONTEXTUAL_EXPLANATION_TARGETS) {
          const targetId = target.target_entity_type === 'report' ? 'report-current' : target.target_entity_type === 'goal' ? 'goal-1' : null;
          await AIContextualExplanationService.resolveExplanation(SESSION_USER, 'hh-1', { target_code: target.target_code, target_id: targetId });
          executed += 1;
        }
      }
    }
    expect(executed).toBe(CONTEXTUAL_EXPLANATION_TARGETS.length * 10);
    expect(openAiCalls).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
    expect(state.rpcCalls.get('ai_admit_request') ?? 0).toBe(0);
    expect(state.customQuestionsUsed).toBe(0);
    spy.mockRestore();
  });
});
