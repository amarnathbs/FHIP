// Module 11.4 — proves the additive ZERO_COST_ONLY router policy (spec
// section 9) without weakening Module 11.2's existing (default) behaviour.

import { describe, it, expect, vi } from 'vitest';
import { makeContext } from './support/financialContextFixture';
import type { RouterDependencies } from '@/lib/ai/resolution/router';

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from(table: string) {
      if (table === 'resource_posts') return { select() { return this; }, eq() { return this; }, in() { return { data: [], error: null }; } };
      if (table === 'ai_insights') return { select() { return this; }, eq() { return this; }, not() { return this; }, lte() { return this; }, order() { return this; }, limit() { return Promise.resolve({ data: [], error: null }); } };
      if (table === 'ai_resolution_audit') return { insert: () => Promise.resolve({ error: null }) };
      throw new Error(`unexpected table: ${table}`);
    },
  }),
}));

const { resolveAnswer } = await import('@/lib/ai/resolution/router');

function fakeDeps(overrides: Partial<RouterDependencies> = {}): RouterDependencies {
  return {
    buildContext: vi.fn(async () => makeContext()),
    getUserCountry: vi.fn(async (): Promise<'AU' | 'IN' | null> => 'AU'),
    isPersonalisedAiEligible: vi.fn(async () => true),
    writeAudit: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('ZERO_COST_ONLY policy (Module 11.4, spec section 9)', () => {
  it('an unmatched free-text question is LIVE_AI_REQUIRED under STANDARD policy (unchanged 11.2 behaviour)', async () => {
    const result = await resolveAnswer(fakeDeps(), { userId: 'u1', householdId: null, request: { question: 'some totally unmatched free text question here' } });
    expect(result.resolution).toBe('LIVE_AI_REQUIRED');
    expect(result.requires_live_ai).toBe(true);
  });

  it('the SAME unmatched question under ZERO_COST_ONLY becomes UNAVAILABLE with every escalation field forced false', async () => {
    const result = await resolveAnswer(fakeDeps(), {
      userId: 'u1',
      householdId: null,
      request: { question: 'some totally unmatched free text question here' },
      policy: 'ZERO_COST_ONLY',
    });
    expect(result.resolution).toBe('UNAVAILABLE');
    expect(result.requires_live_ai).toBe(false);
    expect(result.consumes_custom_quota).toBe(false);
    expect(result.answer_available).toBe(false);
    expect(result.response).toBeNull();
  });

  it('a genuine DETERMINISTIC hit is completely unaffected by ZERO_COST_ONLY', async () => {
    const standard = await resolveAnswer(fakeDeps(), { userId: 'u1', householdId: null, request: { intent_code: 'CURRENT_NET_WORTH' } });
    const zeroCost = await resolveAnswer(fakeDeps(), { userId: 'u1', householdId: null, request: { intent_code: 'CURRENT_NET_WORTH' }, policy: 'ZERO_COST_ONLY' });
    expect(zeroCost.resolution).toBe('DETERMINISTIC');
    // request_id/latency_ms are per-call (uuid/timing) — every OTHER field
    // (including the full response envelope and resolver_trace) must match.
    expect({ ...zeroCost, request_id: '', latency_ms: 0 }).toEqual({ ...standard, request_id: '', latency_ms: 0 });
  });

  it('a boundary intent (SCENARIO_REQUEST) is unaffected by ZERO_COST_ONLY — it never carried requires_live_ai=true', async () => {
    const result = await resolveAnswer(fakeDeps(), { userId: 'u1', householdId: null, request: { intent_code: 'SCENARIO_REQUEST' }, policy: 'ZERO_COST_ONLY' });
    expect(['UNSUPPORTED', 'BLOCKED']).toContain(result.resolution);
    expect(result.requires_live_ai).toBe(false);
    expect(result.consumes_custom_quota).toBe(false);
  });
});
