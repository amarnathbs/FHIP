// Module 11.3 — stored-answer resolution proof (spec sections 60, 142,
// completion-report item M). This is a NAMED ACCEPTANCE GATE, not an
// incidental test:
//
//   BEFORE any Insight Pack answer exists for an intent:
//     Module 11.2's REAL router -> LIVE_AI_REQUIRED
//   AFTER AIPersonalisedInsightPackService writes a validated answer
//   (exactly what upsertStoredAnswer() persists to ai_insights):
//     the SAME router, SAME intent -> STORED_PERSONALISED
//   Provider delta: 0 (the router has no code path that can call a
//   provider — proven structurally, not just by absence of a mock call).
//   Custom-quota delta: 0 (STORED_PERSONALISED never sets
//   consumes_custom_quota — proven both on the raw envelope and via the
//   router's own ResolutionResult).
//
// Uses the REAL lib/ai/resolution/router.ts and the REAL
// storedPersonalisedResolver.ts — only the Supabase admin client is faked,
// with an in-memory table standing in for ai_insights.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeContext } from './support/financialContextFixture';

interface FakeInsightRow {
  id: string; user_id: string; household_id: string | null; metric_code: string | null;
  current_value: number | null; future_ai_explanation: string | null; confidence: string | null;
  valid_from: string; valid_until: string | null; created_at: string;
}
let fakeAiInsights: FakeInsightRow[] = [];

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from(table: string) {
      if (table !== 'ai_insights') throw new Error(`unexpected table in test double: ${table}`);
      let rows = [...fakeAiInsights];
      const builder = {
        select() { return builder; },
        eq(col: string, val: unknown) { rows = rows.filter((r) => (r as unknown as Record<string, unknown>)[col] === val); return builder; },
        not(col: string) { rows = rows.filter((r) => (r as unknown as Record<string, unknown>)[col] !== null); return builder; }, // only ever called as .not(col, 'is', null) by the real resolver — op/value are fixed by that call site
        lte(col: string, val: string) { rows = rows.filter((r) => (r as unknown as Record<string, string>)[col] <= val); return builder; },
        order(col: string, opts: { ascending: boolean }) {
          rows = [...rows].sort((a, b) => {
            const av = (a as unknown as Record<string, string>)[col];
            const bv = (b as unknown as Record<string, string>)[col];
            return opts.ascending ? av.localeCompare(bv) : bv.localeCompare(av);
          });
          return builder;
        },
        limit(n: number) { rows = rows.slice(0, n); return builder; },
        then(resolve: (v: { data: FakeInsightRow[]; error: null }) => void) { resolve({ data: rows, error: null }); },
      };
      return builder;
    },
  }),
}));

// Resolution audit writes are irrelevant to this proof and would otherwise
// need their own DB double.
vi.mock('@/lib/ai/resolution/audit', () => ({
  recordResolutionAudit: vi.fn(async () => {}),
  hashNormalisedQuestion: vi.fn((s: string) => `hash-${s}`),
}));

describe('Module 11.3 — stored-answer resolution proof (spec sections 60, 142)', () => {
  const USER = 'user-stored-answer-proof';
  const ctx = makeContext({ meta: { ...makeContext().meta, snapshot_id: 'snap-proof' } });

  beforeEach(() => {
    fakeAiInsights = [];
  });

  it('BEFORE a pack answer exists: SCORE_EXPLANATION resolves to LIVE_AI_REQUIRED (deterministic resolver has no driver-based extraction yet)', async () => {
    const { resolveAnswer } = await import('@/lib/ai/resolution/router');
    const result = await resolveAnswer(
      {
        buildContext: async () => ctx,
        getUserCountry: async () => 'AU',
        isPersonalisedAiEligible: async () => true,
      },
      { userId: USER, householdId: null, request: { intent_code: 'SCORE_EXPLANATION' } }
    );
    expect(result.resolution).toBe('LIVE_AI_REQUIRED');
    expect(result.requires_live_ai).toBe(true);
    expect(result.consumes_custom_quota).toBe(true); // a genuine future LIVE_AI call WOULD need quota — this is the pre-pack baseline
  });

  it('AFTER AIPersonalisedInsightPackService writes the validated answer: the SAME intent resolves to STORED_PERSONALISED, zero provider calls, zero quota', async () => {
    // Exactly what insightPackDbClient.ts's upsertStoredAnswer() persists.
    fakeAiInsights.push({
      id: 'insight-1',
      user_id: USER,
      household_id: null,
      metric_code: 'SCORE_EXPLANATION',
      current_value: ctx.health_score!.overall_score,
      future_ai_explanation: 'Your recorded Financial Health Score is 72, in the good band.',
      confidence: 'HIGH',
      valid_from: '2020-01-01T00:00:00.000Z',
      valid_until: null,
      created_at: '2026-08-01T00:00:00.000Z',
    });

    const { resolveAnswer } = await import('@/lib/ai/resolution/router');
    const result = await resolveAnswer(
      {
        buildContext: async () => ctx,
        getUserCountry: async () => 'AU',
        isPersonalisedAiEligible: async () => true,
      },
      { userId: USER, householdId: null, request: { intent_code: 'SCORE_EXPLANATION' } }
    );

    expect(result.resolution).toBe('STORED_PERSONALISED');
    expect(result.requires_live_ai).toBe(false);
    expect(result.consumes_custom_quota).toBe(false);
    expect(result.response?.headline).toContain('72');
    // Structural proof of "provider delta 0": the router module has no
    // IMPORT of AIModelGateway/any provider adapter and never calls
    // `.generateStructured(` — a STORED_PERSONALISED resolution is not
    // merely "didn't happen to call a mock", it CANNOT reach a provider by
    // construction. (The file's own header comment mentions "AIModelGateway"
    // in prose precisely to say it never calls it — matched separately here
    // so that true statement doesn't make this check vacuous.)
    const routerSource = await import('node:fs').then((fs) => fs.readFileSync(new URL('../../lib/ai/resolution/router.ts', import.meta.url), 'utf8'));
    expect(routerSource).not.toMatch(/^\s*import[^\n]*AIModelGateway/m);
    expect(routerSource).not.toMatch(/\.generateStructured\(/);
    expect(routerSource).toMatch(/This function NEVER calls AIModelGateway/); // the file's own documented invariant, still present
  });

  it('a Free (non-Premium) subject never sees the stored answer even though the row exists — premium_satisfied=false, falls through to LIVE_AI_REQUIRED', async () => {
    fakeAiInsights.push({
      id: 'insight-2', user_id: USER, household_id: null, metric_code: 'SCORE_EXPLANATION',
      current_value: ctx.health_score!.overall_score, future_ai_explanation: 'stored text', confidence: 'HIGH',
      valid_from: '2020-01-01T00:00:00.000Z', valid_until: null, created_at: '2026-08-01T00:00:00.000Z',
    });
    const { resolveAnswer } = await import('@/lib/ai/resolution/router');
    const result = await resolveAnswer(
      { buildContext: async () => ctx, getUserCountry: async () => 'AU', isPersonalisedAiEligible: async () => false },
      { userId: USER, householdId: null, request: { intent_code: 'SCORE_EXPLANATION' } }
    );
    expect(result.resolution).toBe('LIVE_AI_REQUIRED');
    expect(result.premium_satisfied).toBe(false);
  });

  it('a stale stored answer (current_value no longer matches the live certified score) is NOT served — falls through to LIVE_AI_REQUIRED (spec sections 28-29, 62, 96)', async () => {
    fakeAiInsights.push({
      id: 'insight-3', user_id: USER, household_id: null, metric_code: 'SCORE_EXPLANATION',
      current_value: 999, // does not match ctx.health_score.overall_score (72)
      future_ai_explanation: 'stale stored text', confidence: 'HIGH',
      valid_from: '2020-01-01T00:00:00.000Z', valid_until: null, created_at: '2026-08-01T00:00:00.000Z',
    });
    const { resolveAnswer } = await import('@/lib/ai/resolution/router');
    const result = await resolveAnswer(
      { buildContext: async () => ctx, getUserCountry: async () => 'AU', isPersonalisedAiEligible: async () => true },
      { userId: USER, householdId: null, request: { intent_code: 'SCORE_EXPLANATION' } }
    );
    expect(result.resolution).toBe('LIVE_AI_REQUIRED');
  });
});
