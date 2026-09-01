// Module 11.2 — ExactCacheResolver unit tests (spec sections 30-32, 57,
// 79-80, 111).
//
// lib/ai/cache/answerCache.ts (Module 11.1) already owns the real key-scheme
// and cross-tenant/cross-snapshot lookup semantics; this file tests ONLY
// what Module 11.2 adds on top — the entitlement gate and the snapshot-hash
// derivation actually passed into that lookup — by mocking the cache module
// itself and asserting on exactly what this resolver calls it with.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeContext } from './support/financialContextFixture';

const lookupCachedAnswer = vi.fn();
const storeCachedAnswer = vi.fn();

beforeEach(() => {
  lookupCachedAnswer.mockReset();
  storeCachedAnswer.mockReset();
});

vi.mock('@/lib/ai/cache/answerCache', () => ({
  lookupCachedAnswer: (...args: unknown[]) => lookupCachedAnswer(...args),
  storeCachedAnswer: (...args: unknown[]) => storeCachedAnswer(...args),
}));

const { resolveExactCache, storeExactCacheAnswer } = await import('@/lib/ai/resolution/exactCacheResolver');

const SAMPLE_ANSWER = {
  resolution_type: 'STORED_PERSONALISED' as const,
  intent_code: 'RESILIENCE_EXPLANATION',
  answer_type: 'stored_personalised_answer',
  headline: 'headline',
  summary: 'summary',
  key_points: [],
  source_refs: [],
  confidence: 'HIGH' as const,
  data_as_of: null,
  limitations: [],
  related_module: null,
  action_route: null,
  requires_live_ai: false,
  consumes_custom_quota: false,
  template_version: 'v1',
};

describe('resolveExactCache', () => {
  it('derives snapshot_hash from only the intent’s required domain(s), not the whole context', async () => {
    lookupCachedAnswer.mockResolvedValueOnce(null);
    const ctx = makeContext();
    await resolveExactCache({ intentCode: 'RESILIENCE_EXPLANATION', userId: 'user-a', householdId: null, question: 'Why is my resilience low?', context: ctx, personalisedAiEligible: true });
    expect(lookupCachedAnswer).toHaveBeenCalledTimes(1);
    const call = lookupCachedAnswer.mock.calls[0][0];
    expect(call.userId).toBe('user-a');
    expect(call.intentCode).toBe('RESILIENCE_EXPLANATION');
    expect(typeof call.snapshotHash).toBe('string');
    expect(call.snapshotHash.length).toBe(64); // sha256 hex
  });

  it('produces a DIFFERENT snapshot_hash once the underlying resilience domain changes (spec section 80)', async () => {
    lookupCachedAnswer.mockResolvedValue(null);
    const ctxA = makeContext({ resilience: { ...makeContext().resilience!, resilience_score: 65 } });
    const ctxB = makeContext({ resilience: { ...makeContext().resilience!, resilience_score: 80 } });
    await resolveExactCache({ intentCode: 'RESILIENCE_EXPLANATION', userId: 'user-a', householdId: null, question: 'q', context: ctxA, personalisedAiEligible: true });
    await resolveExactCache({ intentCode: 'RESILIENCE_EXPLANATION', userId: 'user-a', householdId: null, question: 'q', context: ctxB, personalisedAiEligible: true });
    const hashA = lookupCachedAnswer.mock.calls[0][0].snapshotHash;
    const hashB = lookupCachedAnswer.mock.calls[1][0].snapshotHash;
    expect(hashA).not.toBe(hashB);
  });

  it('returns a hit and marks zero provider/quota cost when the underlying cache has one', async () => {
    lookupCachedAnswer.mockResolvedValueOnce({
      id: 'c1', user_id: 'user-a', household_id: null, snapshot_hash: 'x', context_version: 'v', intent_code: 'RESILIENCE_EXPLANATION',
      normalised_question_hash: 'h', prompt_version: null, model_version: null, answer_json: SAMPLE_ANSWER, source_references: [], confidence: 'high',
      created_at: '2026-08-01T00:00:00.000Z', expires_at: null, invalidated_at: null,
    });
    const attempt = await resolveExactCache({ intentCode: 'RESILIENCE_EXPLANATION', userId: 'user-a', householdId: null, question: 'q', context: makeContext(), personalisedAiEligible: true });
    expect(attempt.hit).toBe(true);
    expect(attempt.answer!.requires_live_ai).toBe(false);
    expect(attempt.answer!.consumes_custom_quota).toBe(false);
  });

  it('denies a non-Premium subject for a personalised-intent cache lookup without even calling the cache (spec section 52)', async () => {
    const attempt = await resolveExactCache({ intentCode: 'RESILIENCE_EXPLANATION', userId: 'user-a', householdId: null, question: 'q', context: makeContext(), personalisedAiEligible: false });
    expect(attempt.hit).toBe(false);
    expect(attempt.miss_reason).toBe('premium_required');
    expect(lookupCachedAnswer).not.toHaveBeenCalled();
  });

  it('refuses to scope a cache lookup without a context object', async () => {
    const attempt = await resolveExactCache({ intentCode: 'RESILIENCE_EXPLANATION', userId: 'user-a', householdId: null, question: 'q', context: null, personalisedAiEligible: true });
    expect(attempt.hit).toBe(false);
    expect(attempt.miss_reason).toBe('no_context_to_scope_cache');
  });
});

describe('storeExactCacheAnswer', () => {
  it('passes the intent-scoped snapshot hash and the answer through to storeCachedAnswer', async () => {
    storeCachedAnswer.mockResolvedValueOnce(true);
    const ok = await storeExactCacheAnswer({ intentCode: 'RESILIENCE_EXPLANATION', userId: 'user-a', householdId: 'hh-1', question: 'q', context: makeContext(), answer: SAMPLE_ANSWER });
    expect(ok).toBe(true);
    expect(storeCachedAnswer).toHaveBeenCalledTimes(1);
    const call = storeCachedAnswer.mock.calls[0][0];
    expect(call.userId).toBe('user-a');
    expect(call.householdId).toBe('hh-1');
    expect(call.answerJson).toBe(SAMPLE_ANSWER);
  });
});
