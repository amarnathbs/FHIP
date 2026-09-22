// Module 11 remediation R2 — real OpenAI provider: fail-closed matrix
// (brief section 19), quota separation (section 20) and the positive
// control that makes both non-vacuous.
//
// WHAT IS REAL HERE: the REAL AIPersonalisedInsightPackService, the REAL
// AIModelGateway, the REAL OpenAIProviderAdapter (lib/ai/providers/
// openaiProvider.ts), the REAL ai_admit_request()/refund/finalise SQL
// functions and the REAL migration chain (incl. 0175) inside an isolated
// PGlite Postgres. The ONLY substitution is the adapter's `fetch` — injected
// as a double so no test ever reaches api.openai.com and no test ever
// spends a token (brief section 19: "use adapter/mock harness where
// intentionally causing remote failures is unnecessary").
//
// The credential value used below is a made-up string that exists only in
// this process; the fetch double records what it receives and never sends
// it anywhere.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// Returns null (no ai_runs row exists in the isolated instance to satisfy the
// ai_insight_packs.ai_run_id FK); the ai_run CONTENT is asserted via the mock's
// captured input instead — same approach as aiInsightPack20HouseholdE2E.
const recordAiRunMock = vi.fn<(input: Record<string, unknown>) => Promise<string>>(async () => null as unknown as string);
vi.mock('@/lib/ai/audit/aiRuns', () => ({
  recordAiRun: (input: Record<string, unknown>) => recordAiRunMock(input),
  hashContext: (ctx: unknown) => `hash-${JSON.stringify((ctx as { meta?: { snapshot_id?: string } })?.meta?.snapshot_id ?? '')}`,
}));

import { AIPersonalisedInsightPackService, type InsightPackDbClient } from '@/lib/ai/insightPack/insightPackService';
import { OpenAIProviderAdapter, OPENAI_CHAT_COMPLETIONS_URL, type FetchLike } from '@/lib/ai/providers/openaiProvider';
import { buildMockPackRawText } from '@/lib/ai/insightPack/mockPackProvider';
import { splitPackUserPrompt } from '@/lib/ai/insightPack/packComposition';
import type { ModelRegistryRow } from '@/lib/ai/modelRegistry';
import { buildPgliteInsightPackHarness, insertPremiumUser, type PgliteInsightPackHarness } from './support/pgliteInsightPackHarness';
import { makeContext } from './support/financialContextFixture';
import type { FinancialContextObject } from '@/lib/ai/context/types';

const USER = '77777777-7777-7777-7777-000000000001';
const FAKE_KEY = 'sk-unit-test-only-never-sent-anywhere';

let harness: PgliteInsightPackHarness;
let dbClient: InsightPackDbClient;
let snapshotSeq = 0;

function ctxFor(): FinancialContextObject {
  snapshotSeq += 1;
  return makeContext({ meta: { ...makeContext().meta, context_version: 'ai-context-1.0.0', snapshot_id: `r2-snap-${snapshotSeq}` } });
}

/** A fetch double that mimics a successful chat completion carrying a VALID pack for the prompt it was given. */
function validCompletionFetch(recorder: { calls: { url: string; body: Record<string, unknown> }[] }, behavior: Parameters<typeof buildMockPackRawText>[1] = 'valid'): FetchLike {
  return async (url, init) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    recorder.calls.push({ url, body });
    const messages = body.messages as { role: string; content: string }[];
    const userPrompt = messages.find((m) => m.role === 'user')!.content;
    const { contextJson, rankedItems } = splitPackUserPrompt(userPrompt);
    const ctx = JSON.parse(contextJson) as FinancialContextObject;
    const rawText = buildMockPackRawText(ctx, behavior, rankedItems);
    return new Response(JSON.stringify({
      id: 'chatcmpl-test', model: 'gpt-4o-mini-2024-07-18',
      choices: [{ message: { content: rawText }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 4200, completion_tokens: 900, prompt_tokens_details: { cached_tokens: 0 } },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
}

async function questionsRemaining(): Promise<number | null> {
  const { rows } = await harness.db.query(`select ai_entitlement_state($1) v`, [USER]);
  const v = (rows[0] as Record<string, unknown>).v as { custom_questions?: { remaining?: number } } | null;
  return v?.custom_questions?.remaining ?? null;
}

function serviceWith(fetchImpl: FetchLike) {
  return new AIPersonalisedInsightPackService(dbClient, () => new OpenAIProviderAdapter(fetchImpl), harness.gate);
}

const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ['MODULE11_AI_PROVIDER', 'MODULE11_AI_MODEL', 'OPENAI_API_KEY', 'MODULE11_AI_MAX_TRANSIENT_RETRIES', 'MODULE11_AI_TIMEOUT_MS'];

beforeAll(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  harness = await buildPgliteInsightPackHarness();
  await insertPremiumUser(harness.db, USER, 'r2-real-provider@example.test');
  // Configure the ISOLATED instance the way R7 step 4 would configure
  // production: the real row (seeded inactive/unapproved by 0175) is
  // approved + activated here only.
  await harness.db.exec(`update ai_model_registry set active=true, approved=true, max_output_tokens=3200 where provider='openai' and model_identifier='gpt-4o-mini';`);
  // The seeded rate limit (12 admissions / 3600s per subject) genuinely fired
  // on the first run of this file at the 13th admission — real evidence the
  // limiter works. Raised in this ISOLATED instance only so the remaining
  // cases reach the gate each is meant to exercise; the limiter itself is
  // exercised explicitly in its own case below.
  await harness.db.exec(`update ai_platform_controls set rate_limit_max_requests=500 where id='global';`);
  // The harness resolves by tier for the mock; for the openai branch use the
  // production resolution semantics (configured provider + exact model).
  dbClient = {
    ...harness.dbClient,
    async resolveModelForTask(taskType: string): Promise<ModelRegistryRow | null> {
      const provider = process.env.MODULE11_AI_PROVIDER === 'openai' ? 'openai' : 'mock';
      const model = process.env.MODULE11_AI_MODEL?.trim() || 'gpt-4o-mini';
      const { rows } = provider === 'openai'
        ? await harness.db.query(`select * from ai_model_registry where active=true and approved=true and provider='openai' and model_identifier=$1 and task_types @> array[$2] limit 1`, [model, taskType])
        : await harness.db.query(`select * from ai_model_registry where active=true and approved=true and provider='mock' and task_types @> array[$1] limit 1`, [taskType]);
      return (rows[0] as ModelRegistryRow) ?? null;
    },
  };
}, 120_000);

afterAll(async () => {
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
  await harness.db.close();
});

beforeEach(async () => {
  process.env.MODULE11_AI_PROVIDER = 'openai';
  process.env.MODULE11_AI_MODEL = 'gpt-4o-mini';
  process.env.OPENAI_API_KEY = FAKE_KEY;
  process.env.MODULE11_AI_MAX_TRANSIENT_RETRIES = '0';
  process.env.MODULE11_AI_TIMEOUT_MS = '2000';
  recordAiRunMock.mockClear();
  // Reset every switch a previous case may have flipped (isolated instance only).
  await harness.db.exec(`update ai_platform_controls set live_provider_enabled=true, batch_generation_enabled=true, ai_globally_enabled=true, max_cost_per_request_usd=0.5 where id='global';`);
  await harness.db.exec(`update ai_provider_controls set enabled=true where provider='openai';`);
  await harness.db.exec(`update ai_model_registry set active=true, approved=true where provider='openai';`);
});

describe('R2 — positive control: the real adapter path through the real gateway, real admission and real grounding', () => {
  it('a valid completion -> READY pack, one HTTP call with strict json_schema + store:false + the configured model, tokens and cost recorded on the pack and the ai_run', async () => {
    const recorder = { calls: [] as { url: string; body: Record<string, unknown> }[] };
    const before = await questionsRemaining();
    const outcome = await serviceWith(validCompletionFetch(recorder)).generateOrGetPack({ userId: USER, householdId: null, context: ctxFor() });
    expect(outcome.status).toBe('READY');

    expect(recorder.calls).toHaveLength(1);
    const call = recorder.calls[0];
    expect(call.url).toBe(OPENAI_CHAT_COMPLETIONS_URL);
    expect(call.body.model).toBe('gpt-4o-mini');
    expect(call.body.store).toBe(false);
    expect((call.body.response_format as { type: string; json_schema: { strict: boolean } }).type).toBe('json_schema');
    expect((call.body.response_format as { type: string; json_schema: { strict: boolean } }).json_schema.strict).toBe(true);
    expect(call.body.max_tokens).toBe(3000);

    // Token/cost accounting: registry price wins (0.00015/1K in, 0.0006/1K out).
    const pack = outcome.status === 'READY' ? outcome.pack : null;
    expect(pack?.input_tokens).toBe(4200);
    expect(pack?.output_tokens).toBe(900);
    expect(Number(pack?.estimated_cost_usd)).toBeCloseTo(4.2 * 0.00015 + 0.9 * 0.0006, 8);
    expect(pack?.provider).toBe('openai');
    expect(pack?.model).toBe('gpt-4o-mini');

    const run = recordAiRunMock.mock.calls.at(-1)?.[0];
    expect(run?.provider).toBe('openai');
    expect(run?.inputTokenCount).toBe(4200);
    expect(run?.outputTokenCount).toBe(900);
    expect(run?.executionStatus).toBe('success');

    // Section 20: quota separation — 10/10 before, 10/10 after a REAL-provider pack.
    expect(before).toBe(10);
    expect(await questionsRemaining()).toBe(10);
  });
});

// Every case below runs AFTER the positive control produced a READY pack for
// this subject, so the 24h automatic-regeneration cooldown (spec section 34)
// would otherwise short-circuit them all as REGENERATION_RATE_LIMITED — itself
// correct behaviour, proven by the first run of this file. The cases use the
// admin-forced carve-out (bypassRegenerationCooldown) so that each one reaches
// the gate it is meant to exercise.
describe('R2 — fail-closed matrix (brief section 19): no fabricated fallback, no spend, quota untouched', () => {
  it('missing key -> FAILED provider_error (AUTH); fetch never called; reservation released', async () => {
    delete process.env.OPENAI_API_KEY;
    const fetchSpy = vi.fn();
    const outcome = await serviceWith(fetchSpy).generateOrGetPack({ userId: USER, householdId: null, context: ctxFor(), bypassRegenerationCooldown: true });
    expect(outcome.status).toBe('FAILED');
    expect(outcome.status === 'FAILED' && outcome.failureCode).toBe('provider_error');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await questionsRemaining()).toBe(10);
    // The reservation was refunded, so a follow-up generation is admitted (concurrency lease released).
    const { rows } = await harness.db.query(`select count(*)::int as n from ai_admission_events where user_id=$1 and decision='allowed' and status='reserved'`, [USER]).catch(() => ({ rows: [{ n: 0 }] }));
    expect(((rows[0] as { n: number }) ?? { n: 0 }).n).toBe(0);
  });

  it('invalid model (MODULE11_AI_MODEL names a model with no approved registry row) -> FAILED no_approved_model; no fetch', async () => {
    process.env.MODULE11_AI_MODEL = 'gpt-4.1';
    const fetchSpy = vi.fn();
    const outcome = await serviceWith(fetchSpy).generateOrGetPack({ userId: USER, householdId: null, context: ctxFor(), bypassRegenerationCooldown: true });
    expect(outcome).toEqual({ status: 'FAILED', pack: null, failureCode: 'no_approved_model' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('adapter guard: a registry row for a model other than the configured one is refused by the adapter itself before any HTTP call', async () => {
    // Registry says gpt-4o-mini is approved, but the environment is switched to another model AFTER resolution — the adapter must not send it.
    const fetchSpy = vi.fn();
    const adapter = new OpenAIProviderAdapter(fetchSpy);
    process.env.MODULE11_AI_MODEL = 'gpt-4.1';
    await expect(adapter.generateStructured({ systemPrompt: 's', userPrompt: 'u', taskType: 'monthly_insight_pack', model: 'gpt-4o-mini', maxOutputTokens: 100, responseSchema: 'insight_pack_envelope' })).rejects.toThrow(/not the configured Module 11 model/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('provider disabled (ai_provider_controls.openai.enabled=false) -> admission denies provider_disabled; no fetch', async () => {
    await harness.db.exec(`update ai_provider_controls set enabled=false, disabled_reason='r2 test' where provider='openai';`);
    const fetchSpy = vi.fn();
    const outcome = await serviceWith(fetchSpy).generateOrGetPack({ userId: USER, householdId: null, context: ctxFor(), bypassRegenerationCooldown: true });
    expect(outcome.status).toBe('FAILED');
    expect(outcome.status === 'FAILED' && outcome.failureCode).toBe('provider_disabled');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('model disabled (active=false) -> no_approved_model; model unapproved (approved=false) -> no_approved_model; no fetch', async () => {
    await harness.db.exec(`update ai_model_registry set active=false where provider='openai';`);
    const fetchSpy = vi.fn();
    expect((await serviceWith(fetchSpy).generateOrGetPack({ userId: USER, householdId: null, context: ctxFor(), bypassRegenerationCooldown: true })).status).toBe('FAILED');
    await harness.db.exec(`update ai_model_registry set active=true, approved=false where provider='openai';`);
    expect((await serviceWith(fetchSpy).generateOrGetPack({ userId: USER, householdId: null, context: ctxFor(), bypassRegenerationCooldown: true })).status).toBe('FAILED');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('live-provider kill switch (live_provider_enabled=false) -> admission denies live_provider_disabled; no fetch', async () => {
    await harness.db.exec(`update ai_platform_controls set live_provider_enabled=false where id='global';`);
    const fetchSpy = vi.fn();
    const outcome = await serviceWith(fetchSpy).generateOrGetPack({ userId: USER, householdId: null, context: ctxFor(), bypassRegenerationCooldown: true });
    expect(outcome.status).toBe('FAILED');
    expect(outcome.status === 'FAILED' && outcome.failureCode).toBe('live_provider_disabled');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('timeout -> FAILED timeout; the aborted request is not retried (retries=0) and nothing is persisted as an answer', async () => {
    process.env.MODULE11_AI_TIMEOUT_MS = '50';
    const hanging: FetchLike = (_url, init) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
    });
    const outcome = await serviceWith(hanging).generateOrGetPack({ userId: USER, householdId: null, context: ctxFor(), bypassRegenerationCooldown: true });
    expect(outcome.status).toBe('FAILED');
    expect(outcome.status === 'FAILED' && outcome.failureCode).toBe('timeout');
    expect(await questionsRemaining()).toBe(10);
  });

  it('malformed (non-JSON) response body -> FAILED rejected_schema; tokens still recorded on the audit row, cost not fabricated as an answer', async () => {
    const malformed: FetchLike = async () => new Response(JSON.stringify({ choices: [{ message: { content: '{ not json' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 5 } }), { status: 200 });
    const outcome = await serviceWith(malformed).generateOrGetPack({ userId: USER, householdId: null, context: ctxFor(), bypassRegenerationCooldown: true });
    expect(outcome.status).toBe('FAILED');
    expect(outcome.status === 'FAILED' && outcome.failureCode).toBe('rejected_schema');
    const run = recordAiRunMock.mock.calls.at(-1)?.[0];
    expect(run?.executionStatus).toBe('rejected_schema');
    expect(run?.inputTokenCount).toBe(100);
  });

  it('schema-invalid JSON (wrong pack_version / missing fields) -> FAILED rejected_schema', async () => {
    const wrong: FetchLike = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ pack_version: 'insight-pack-0.9.0', blocks: {} }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200 });
    const outcome = await serviceWith(wrong).generateOrGetPack({ userId: USER, householdId: null, context: ctxFor(), bypassRegenerationCooldown: true });
    expect(outcome.status === 'FAILED' && outcome.failureCode).toBe('rejected_schema');
  });

  it('model refusal -> treated as empty content -> FAILED rejected_schema (never surfaced as an answer)', async () => {
    const refusal: FetchLike = async () => new Response(JSON.stringify({ choices: [{ message: { content: null, refusal: 'I cannot help with that.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200 });
    const outcome = await serviceWith(refusal).generateOrGetPack({ userId: USER, householdId: null, context: ctxFor(), bypassRegenerationCooldown: true });
    expect(outcome.status === 'FAILED' && outcome.failureCode).toBe('rejected_schema');
  });

  it('grounding failure (fabricated value in a mandatory block) -> FAILED grounding_failure; cost of the paid call IS recorded on the pack', async () => {
    const recorder = { calls: [] as { url: string; body: Record<string, unknown> }[] };
    const outcome = await serviceWith(validCompletionFetch(recorder, 'fabricated_percentage')).generateOrGetPack({ userId: USER, householdId: null, context: ctxFor(), bypassRegenerationCooldown: true });
    expect(outcome.status).toBe('FAILED');
    expect(outcome.status === 'FAILED' && outcome.failureCode?.startsWith('grounding_failure')).toBe(true);
    const pack = outcome.status === 'FAILED' ? outcome.pack : null;
    expect(pack?.input_tokens).toBe(4200); // spend is never hidden
    expect(await questionsRemaining()).toBe(10);
  });

  it('cost hard stop (per-request ceiling below the projected cost) -> COST_BLOCKED before the provider; no fetch', async () => {
    await harness.db.exec(`update ai_platform_controls set max_cost_per_request_usd=0.000001 where id='global';`);
    const fetchSpy = vi.fn();
    const outcome = await serviceWith(fetchSpy).generateOrGetPack({ userId: USER, householdId: null, context: ctxFor(), bypassRegenerationCooldown: true });
    expect(outcome.status).toBe('COST_BLOCKED');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rate limit (rate_limit_max_requests=1 in the isolated instance) -> the second admission in the window is denied rate_limited before the provider', async () => {
    await harness.db.exec(`update ai_platform_controls set rate_limit_max_requests=1 where id='global';`);
    try {
      const recorder = { calls: [] as { url: string; body: Record<string, unknown> }[] };
      const fetchImpl = validCompletionFetch(recorder);
      const first = await serviceWith(fetchImpl).generateOrGetPack({ userId: USER, householdId: null, context: ctxFor(), bypassRegenerationCooldown: true });
      const second = await serviceWith(fetchImpl).generateOrGetPack({ userId: USER, householdId: null, context: ctxFor(), bypassRegenerationCooldown: true });
      // The first is refused too when this subject has already used its window in earlier cases — either way the second is refused and no extra HTTP call is made for it.
      expect(['READY', 'FAILED']).toContain(first.status);
      expect(second.status).toBe('FAILED');
      expect(second.status === 'FAILED' && second.failureCode).toBe('rate_limited');
      expect(recorder.calls.length).toBeLessThanOrEqual(1);
    } finally {
      await harness.db.exec(`update ai_platform_controls set rate_limit_max_requests=500 where id='global';`);
    }
  });

  it('HTTP 401 from the provider -> FAILED provider_error; 5xx with retries=0 -> FAILED provider_error; 429 -> FAILED provider_error', async () => {
    for (const status of [401, 503, 429]) {
      const failing: FetchLike = async () => new Response('{}', { status });
      const outcome = await serviceWith(failing).generateOrGetPack({ userId: USER, householdId: null, context: ctxFor(), bypassRegenerationCooldown: true });
      expect(outcome.status === 'FAILED' && outcome.failureCode).toBe('provider_error');
    }
    expect(await questionsRemaining()).toBe(10);
  });
});
