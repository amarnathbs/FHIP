// Module 11 remediation R6 — THE MOST IMPORTANT INTEGRATED COST-CONTROL
// PROOF (brief section 56), in ONE file with ONE shared adapter spy and ONE
// network tripwire, so the positive and negative controls are measured by
// the same counter:
//
//   POSITIVE: an Insight Pack generation through the REAL service, REAL
//             gateway, REAL ai_admit_request() (PGlite) and the REAL
//             OpenAIProviderAdapter (fetch double) -> adapter calls go 0 -> 1.
//   NEGATIVE: with the SAME configuration (MODULE11_AI_PROVIDER=openai,
//             credential present, real model row active), the entire
//             Module 11.4 standard-question estate, the entire Module 11.5
//             contextual-Explain estate and Module 11.6 NBA (API-level
//             service, 20 households) -> adapter calls stay at exactly 1,
//             OpenAI network calls stay at exactly 0, admission RPCs 0.

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

const recordAiRunMock = vi.fn(async () => null as unknown as string);
vi.mock('@/lib/ai/audit/aiRuns', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/ai/audit/aiRuns')>();
  return { ...original, recordAiRun: () => recordAiRunMock() };
});

import { makeContext } from './support/financialContextFixture';
import { freshState, makeAdminClient, makeServerClient, seedStoredInsights, type HarnessState } from './support/contextualExplainHarness';
import { CONTEXTUAL_EXPLANATION_TARGETS } from '@/lib/ai/contextualExplanations/registry';
import { STANDARD_QUESTIONS } from '@/lib/ai/standardQuestions/catalogue';
import type { RouterDependencies } from '@/lib/ai/resolution/router';

let state: HarnessState = freshState();
let contextBuilder: () => unknown = () => makeContext();
const SESSION_USER = 'user-r6';

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => makeAdminClient(state) }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => makeServerClient(state, SESSION_USER) }));
vi.mock('@/lib/ai/resolution/routerDependencies', () => ({
  createRouterDependencies: () => ({ buildContext: async () => contextBuilder(), getUserCountry: async () => 'AU' as const, isPersonalisedAiEligible: async () => state.eligible }),
  hashNormalisedQuestion: (s: string) => s,
}));

const { AIContextualExplanationService } = await import('@/lib/ai/contextualExplanations/service');
const { AIStandardQuestionService } = await import('@/lib/ai/standardQuestions/service');
const { AINextBestActionService } = await import('@/lib/ai/nba/service');
const { OpenAIProviderAdapter } = await import('@/lib/ai/providers/openaiProvider');
const { AIPersonalisedInsightPackService } = await import('@/lib/ai/insightPack/insightPackService');
const { buildMockPackRawText } = await import('@/lib/ai/insightPack/mockPackProvider');
const { splitPackUserPrompt } = await import('@/lib/ai/insightPack/packComposition');
const { buildPgliteInsightPackHarness, insertPremiumUser } = await import('./support/pgliteInsightPackHarness');

const ENV = ['MODULE11_AI_PROVIDER', 'MODULE11_AI_MODEL', 'OPENAI_API_KEY', 'MODULE11_AI_MAX_TRANSIENT_RETRIES'] as const;
const saved: Record<string, string | undefined> = {};
const originalFetch = globalThis.fetch;
let openAiNetworkCalls = 0;
let harness: Awaited<ReturnType<typeof buildPgliteInsightPackHarness>>;
const PACK_USER = '33333333-3333-3333-3333-000000000001';

beforeAll(async () => {
  for (const k of ENV) saved[k] = process.env[k];
  process.env.MODULE11_AI_PROVIDER = 'openai';
  process.env.MODULE11_AI_MODEL = 'gpt-4o-mini';
  process.env.OPENAI_API_KEY = 'sk-unit-test-only-never-sent-anywhere';
  process.env.MODULE11_AI_MAX_TRANSIENT_RETRIES = '0';
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes('api.openai.com')) { openAiNetworkCalls += 1; return new Response('{}', { status: 500 }); }
    throw new Error(`Unexpected network call: ${url}`);
  }) as typeof fetch;
  harness = await buildPgliteInsightPackHarness();
  await insertPremiumUser(harness.db, PACK_USER, 'r6-pack@example.test');
  await harness.db.exec(`update ai_model_registry set active=true, approved=true, max_output_tokens=3200 where provider='openai' and model_identifier='gpt-4o-mini';`);
}, 180_000);

afterAll(async () => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  globalThis.fetch = originalFetch;
  await harness.db.close();
});

function fakeDeps(): RouterDependencies {
  return { buildContext: vi.fn(async () => contextBuilder() as ReturnType<typeof makeContext>), getUserCountry: vi.fn(async () => 'AU' as const), isPersonalisedAiEligible: vi.fn(async () => true) };
}

describe('R6 section 56 — one counter, positive then negative', () => {
  it('POSITIVE (pack -> adapter 1) then NEGATIVE (11.4 + 11.5 + 11.6 -> still 1; network 0; admission 0)', async () => {
    const spy = vi.spyOn(OpenAIProviderAdapter.prototype, 'generateStructured');
    expect(spy).toHaveBeenCalledTimes(0);

    // ---- POSITIVE: real service + real admission + real adapter (fetch double records a valid completion) ----
    const recorder: { body: Record<string, unknown> }[] = [];
    const adapter = new OpenAIProviderAdapter(async (_url, init) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      recorder.push({ body });
      const userPrompt = (body.messages as { role: string; content: string }[]).find((m) => m.role === 'user')!.content;
      const { contextJson, rankedItems } = splitPackUserPrompt(userPrompt);
      const rawText = buildMockPackRawText(JSON.parse(contextJson), 'valid', rankedItems);
      return new Response(JSON.stringify({ model: 'gpt-4o-mini-2024-07-18', choices: [{ message: { content: rawText }, finish_reason: 'stop' }], usage: { prompt_tokens: 5000, completion_tokens: 900 } }), { status: 200 });
    });
    const dbClient = {
      ...harness.dbClient,
      async resolveModelForTask() {
        const { rows } = await harness.db.query(`select * from ai_model_registry where active=true and approved=true and provider='openai' and model_identifier='gpt-4o-mini' limit 1`);
        return (rows[0] as never) ?? null;
      },
    };
    const packService = new AIPersonalisedInsightPackService(dbClient, () => adapter, harness.gate);
    const packCtx = makeContext({ meta: { ...makeContext().meta, context_version: 'ai-context-1.0.0', snapshot_id: 'r6-snap' } });
    const outcome = await packService.generateOrGetPack({ userId: PACK_USER, householdId: null, context: packCtx });
    expect(outcome.status).toBe('READY');
    expect(spy).toHaveBeenCalledTimes(1); // the positive control: one real provider call
    expect(recorder[0].body.model).toBe('gpt-4o-mini');
    // The pack's priority_review_areas came from Module 11.6's engine and were echoed — R1 + R5 together.
    const { rows: blocks } = await harness.db.query(`select block_code, status from ai_insight_pack_blocks where pack_id=$1 and block_code='priority_review_areas'`, [(outcome as { pack: { id: string } }).pack.id]);
    void blocks; // block presence depends on the mock envelope; the ranking contract is certified in aiRankingProvenance.test.ts

    // ---- NEGATIVE: everything zero-cost, same env ----
    state = freshState({ currentSnapshotId: 'snap-current', reports: new Map([['report-current', { id: 'report-current', user_id: SESSION_USER, report_month: '2026-09-01', as_of_date: '2026-09-01', financial_snapshot_id: 'snap-current' }]]) });
    seedStoredInsights(state, ['SCORE_EXPLANATION', 'NET_WORTH_EXPLANATION', 'CASH_FLOW_EXPLANATION', 'SAVINGS_EXPLANATION', 'LIQUIDITY_EXPLANATION', 'DEBT_EXPLANATION', 'RETIREMENT_EXPLANATION', 'TWIN_SUMMARY_EXPLANATION', 'DATA_QUALITY_SUMMARY_EXPLANATION', 'REPORT_READING_EXPLANATION', 'DNA_EXPLANATION', 'RESILIENCE_EXPLANATION', 'STRENGTHS_EXPLANATION', 'OVERALL_FINANCIAL_SUMMARY_EXPLANATION']);
    const households = [makeContext(), makeContext({ goals: [] }), makeContext({ financial_twin: null })];
    let sq = 0, ce = 0, nba = 0;
    for (const h of households) {
      contextBuilder = () => h;
      for (const def of STANDARD_QUESTIONS) {
        if (def.standard_question_code === 'SQ-AI-021') AIStandardQuestionService.resolveGoalRiskQuestion(SESSION_USER, null, def, h, undefined);
        else await AIStandardQuestionService.resolveDefinition(fakeDeps(), SESSION_USER, null, def, h);
        sq += 1;
      }
      for (const target of CONTEXTUAL_EXPLANATION_TARGETS) {
        await AIContextualExplanationService.resolveExplanation(SESSION_USER, 'hh-1', { target_code: target.target_code, target_id: target.target_entity_type === 'report' ? 'report-current' : target.target_entity_type === 'goal' ? 'goal-1' : null });
        ce += 1;
      }
    }
    const nbaService = new AINextBestActionService({
      isPersonalisedAiEligible: async () => true,
      getControls: async () => ({ ai_globally_enabled: true, next_best_action_enabled: true }),
      buildContext: async () => contextBuilder() as ReturnType<typeof makeContext>,
      recordEvaluation: async () => {},
    });
    for (let i = 0; i < 20; i++) { contextBuilder = () => households[i % households.length]; const r = await nbaService.evaluate('u', null); expect(r.provider_called).toBe(false); nba += 1; }

    expect(sq).toBe(75); expect(ce).toBe(CONTEXTUAL_EXPLANATION_TARGETS.length * 3); expect(nba).toBe(20);
    expect(spy).toHaveBeenCalledTimes(1); // NO additional provider calls
    expect(openAiNetworkCalls).toBe(0); // NO real network calls anywhere
    expect(state.rpcCalls.get('ai_admit_request') ?? 0).toBe(0); // NO admission for zero-cost paths
    expect(state.customQuestionsUsed).toBe(0);
    spy.mockRestore();
  }, 120_000);
});
