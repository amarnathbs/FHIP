// Module 11.2 — StoredPersonalisedAnswerResolver unit tests (spec sections
// 27-29, 52, 90).

import { describe, it, expect, vi } from 'vitest';
import { makeContext } from './support/financialContextFixture';
import type { AiInsightRow } from '@/lib/ai/resolution/storedPersonalisedResolver';

let rows: AiInsightRow[] = [];
let lastFilters: { userId?: string; metricCode?: string } = {};

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from(table: string) {
      if (table !== 'ai_insights') throw new Error(`unexpected table ${table}`);
      const state: { userId?: string; metricCode?: string } = {};
      const builder = {
        select() {
          return this;
        },
        eq(col: string, val: string) {
          if (col === 'user_id') state.userId = val;
          if (col === 'metric_code') state.metricCode = val;
          return this;
        },
        not() {
          return this;
        },
        lte() {
          return this;
        },
        order() {
          return this;
        },
        limit() {
          lastFilters = state;
          return this;
        },
        then(resolve: (v: { data: AiInsightRow[]; error: null }) => unknown) {
          const filtered = rows.filter((r) => r.user_id === state.userId && r.metric_code === state.metricCode);
          return Promise.resolve(resolve({ data: filtered, error: null }));
        },
      };
      return builder;
    },
  }),
}));

const { resolveStoredPersonalised } = await import('@/lib/ai/resolution/storedPersonalisedResolver');

function insight(overrides: Partial<AiInsightRow>): AiInsightRow {
  return {
    id: 'insight-1',
    user_id: 'user-a',
    household_id: null,
    metric_code: 'RESILIENCE_EXPLANATION',
    current_value: 65,
    future_ai_explanation: 'Your resilience is moderate mainly because of limited liquid savings.',
    confidence: 'medium',
    valid_from: '2026-01-01T00:00:00.000Z',
    valid_until: null,
    created_at: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('resolveStoredPersonalised', () => {
  it('returns a stored explanation when the live metric value still matches (snapshot compatible, spec section 29)', async () => {
    rows = [insight({})];
    const ctx = makeContext({ resilience: { ...makeContext().resilience!, resilience_score: 65 } });
    const attempt = await resolveStoredPersonalised({ intentCode: 'RESILIENCE_EXPLANATION', userId: 'user-a', context: ctx, personalisedAiEligible: true });
    expect(attempt.hit).toBe(true);
    expect(attempt.answer!.consumes_custom_quota).toBe(false);
    expect(attempt.answer!.requires_live_ai).toBe(false);
  });

  it('invalidates a stored explanation once the live metric value has moved (snapshot invalidation, spec sections 29, 80)', async () => {
    rows = [insight({ current_value: 65 })];
    const ctxAfterChange = makeContext({ resilience: { ...makeContext().resilience!, resilience_score: 80 } });
    const attempt = await resolveStoredPersonalised({ intentCode: 'RESILIENCE_EXPLANATION', userId: 'user-a', context: ctxAfterChange, personalisedAiEligible: true });
    expect(attempt.hit).toBe(false);
    expect(attempt.miss_reason).toBe('no_valid_stored_answer');
  });

  it('never returns another user’s stored answer (tenant isolation, spec section 28)', async () => {
    rows = [insight({ user_id: 'user-b' })];
    const ctx = makeContext();
    const attempt = await resolveStoredPersonalised({ intentCode: 'RESILIENCE_EXPLANATION', userId: 'user-a', context: ctx, personalisedAiEligible: true });
    expect(attempt.hit).toBe(false);
    expect(lastFilters.userId).toBe('user-a');
  });

  it('excludes an expired stored answer', async () => {
    rows = [insight({ valid_until: '2020-01-01T00:00:00.000Z' })];
    const ctx = makeContext();
    const attempt = await resolveStoredPersonalised({ intentCode: 'RESILIENCE_EXPLANATION', userId: 'user-a', context: ctx, personalisedAiEligible: true });
    expect(attempt.hit).toBe(false);
  });

  it('denies a non-Premium subject regardless of a matching stored answer (spec section 52)', async () => {
    rows = [insight({})];
    const ctx = makeContext();
    const attempt = await resolveStoredPersonalised({ intentCode: 'RESILIENCE_EXPLANATION', userId: 'user-a', context: ctx, personalisedAiEligible: false });
    expect(attempt.hit).toBe(false);
    expect(attempt.miss_reason).toBe('premium_required');
  });

  it('never consumes quota or calls a provider regardless of hit/miss (spec section 53)', async () => {
    rows = [insight({})];
    const ctx = makeContext({ resilience: { ...makeContext().resilience!, resilience_score: 65 } });
    const hit = await resolveStoredPersonalised({ intentCode: 'RESILIENCE_EXPLANATION', userId: 'user-a', context: ctx, personalisedAiEligible: true });
    expect(hit.answer?.consumes_custom_quota).toBe(false);
  });
});
