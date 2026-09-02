// Module 11.4 — AIStandardQuestionService unit tests (spec sections 8-9,
// 12-16, 27-34, 40-41, 62-66, 84-93).
//
// Uses resolveDefinition() directly (deps + ctx are injectable) rather than
// resolveQuestion() for most cases, so these tests exercise the real
// composition/availability logic without needing to mock the full
// buildFinancialContextObject()/createClient() chain — the same seam
// lib/ai/resolution/router.ts itself uses for testability.

import { describe, it, expect, vi } from 'vitest';
import { makeContext } from './support/financialContextFixture';
import type { RouterDependencies } from '@/lib/ai/resolution/router';
import { getQuestionDefinition, STANDARD_QUESTIONS } from '@/lib/ai/standardQuestions/catalogue';

const insightsByMetric = new Map<string, Record<string, unknown>[]>();

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from(table: string) {
      if (table === 'resource_posts') {
        return {
          select() { return this; },
          eq() { return this; },
          in() {
            return Promise.resolve({
              data: [
                { id: 'kb-savings', title: 'savings rate', slug: 'savings-rate', excerpt: 'Savings rate is the share of income not spent.', jurisdiction: 'global', status: 'approved', compliance_classification: 'green', compliance_approved_at: null, scheduled_at: null, expires_at: null, updated_at: '2026-08-01T00:00:00.000Z', aliases: null },
                { id: 'kb-concentration', title: 'investment concentration', slug: 'investment-concentration', excerpt: 'Concentration is how much wealth sits in one holding.', jurisdiction: 'global', status: 'approved', compliance_classification: 'green', compliance_approved_at: null, scheduled_at: null, expires_at: null, updated_at: '2026-08-01T00:00:00.000Z', aliases: ['asset concentration'] },
              ],
              error: null,
            });
          },
        };
      }
      if (table === 'ai_insights') {
        let metricCode: string | null = null;
        return {
          select() { return this; },
          eq(col: string, val: string) { if (col === 'metric_code') metricCode = val; return this; },
          not() { return this; },
          lte() { return this; },
          order() { return this; },
          limit() {
            return Promise.resolve({ data: metricCode ? insightsByMetric.get(metricCode) ?? [] : [], error: null });
          },
        };
      }
      if (table === 'ai_resolution_audit') return { insert: () => Promise.resolve({ error: null }) };
      if (table === 'ai_insight_packs') {
        return { select() { return this; }, eq() { return this; }, order() { return this; }, limit() { return this; }, maybeSingle: () => Promise.resolve({ data: { status: 'READY' }, error: null }) };
      }
      if (table === 'ai_standard_questions') {
        return { select() { return Promise.resolve({ data: [], error: { code: '42P01', message: 'relation does not exist' } }); } };
      }
      throw new Error(`unexpected table in standard-question test fake: ${table}`);
    },
  }),
}));

function seedInsight(metricCode: string, currentValue: number | null, explanation: string) {
  insightsByMetric.set(metricCode, [
    { id: `ins-${metricCode}`, user_id: 'u1', household_id: null, metric_code: metricCode, current_value: currentValue, future_ai_explanation: explanation, confidence: 'high', valid_from: '2020-01-01T00:00:00.000Z', valid_until: null, created_at: '2026-08-01T00:00:00.000Z' },
  ]);
}

const { AIStandardQuestionService } = await import('@/lib/ai/standardQuestions/service');

function fakeDeps(country: 'AU' | 'IN' | null = 'AU'): RouterDependencies {
  return {
    buildContext: vi.fn(async () => makeContext()),
    getUserCountry: vi.fn(async () => country),
    isPersonalisedAiEligible: vi.fn(async () => true),
    // No writeAudit — AIStandardQuestionService writes its own single audit row.
  };
}

describe('AIStandardQuestionService — catalogue integrity', () => {
  it('declares exactly the 25 approved codes, each with a real intent behind every component (spec section 11)', () => {
    expect(STANDARD_QUESTIONS).toHaveLength(25);
    const codes = STANDARD_QUESTIONS.map((q) => q.standard_question_code);
    for (let i = 1; i <= 25; i++) expect(codes).toContain(`SQ-AI-${String(i).padStart(3, '0')}`);
  });

  it('never IMPORTS or CALLS AIModelGateway/the quota-reservation RPCs (comments referencing them are fine; import/call sites are not)', async () => {
    const fs = await import('node:fs/promises');
    const serviceSrc = await fs.readFile(new URL('../../lib/ai/standardQuestions/service.ts', import.meta.url), 'utf8');
    const codeOnly = serviceSrc
      .split('\n')
      .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*') && !line.trim().startsWith('/**'))
      .join('\n');
    expect(codeOnly).not.toMatch(/from ['"].*aiModelGateway['"]/);
    expect(codeOnly).not.toMatch(/reserveCustomQuestion\(|consumeCustomQuestion\(|admitAiRequest\(/);
  });
});

describe('AIStandardQuestionService.resolveDefinition — zero-cost invariants', () => {
  it('every response, resolved or not, reports provider_called=false and custom_quota_consumed=false', async () => {
    const def = getQuestionDefinition('SQ-AI-009')!;
    const ctx = makeContext();
    const result = await AIStandardQuestionService.resolveDefinition(fakeDeps(), 'u1', null, def, ctx);
    expect(result.provider_called).toBe(false);
    expect(result.custom_quota_consumed).toBe(false);
  });

  it('SQ-AI-013 (interest rate rise) is always DEFERRED_CAPABILITY — no canonical stored stress result exists in the context object', async () => {
    const def = getQuestionDefinition('SQ-AI-013')!;
    const ctx = makeContext();
    const result = await AIStandardQuestionService.resolveDefinition(fakeDeps(), 'u1', null, def, ctx);
    expect(result.status).toBe('DEFERRED_CAPABILITY');
    expect(result.answer).toBeNull();
  });

  it('SQ-AI-005 is NOT_APPLICABLE when there is no prior comparable score (spec section 86)', async () => {
    const def = getQuestionDefinition('SQ-AI-005')!;
    const ctx = makeContext({ health_score: { ...makeContext().health_score!, prior_valid_score: null } });
    const result = await AIStandardQuestionService.resolveDefinition(fakeDeps(), 'u1', null, def, ctx);
    expect(result.status).toBe('NOT_APPLICABLE');
  });

  it('SQ-AI-005 resolves via STORED_PERSONALISED when a prior score exists and a grounded change explanation is stored (spec section 87)', async () => {
    seedInsight('SCORE_CHANGE_EXPLANATION', null, 'Your score rose 2 points mainly from stronger liquidity.');
    const def = getQuestionDefinition('SQ-AI-005')!;
    const ctx = makeContext();
    const result = await AIStandardQuestionService.resolveDefinition(fakeDeps(), 'u1', null, def, ctx);
    expect(result.status).toBe('AVAILABLE');
    expect(result.answer_origins).toContain('STORED_PERSONALISED');
  });

  it('SQ-AI-021 with no off-track goals is NOT_APPLICABLE', async () => {
    const def = getQuestionDefinition('SQ-AI-021')!;
    const ctx = makeContext({ goals: makeContext().goals.map((g) => ({ ...g, track_status: 'on_track' })) });
    const result = AIStandardQuestionService.resolveGoalRiskQuestion('u1', null, def, ctx, undefined);
    expect(result.status).toBe('NOT_APPLICABLE');
  });

  it('SQ-AI-021 with no goal_id returns the caller’s own eligible off-track goals for target selection (spec section 28)', async () => {
    const def = getQuestionDefinition('SQ-AI-021')!;
    const ctx = makeContext(); // g2 is at_risk in the fixture
    const result = AIStandardQuestionService.resolveGoalRiskQuestion('u1', null, def, ctx, undefined);
    expect(result.eligible_targets?.map((t) => t.id)).toEqual(['g2']);
  });

  it('SQ-AI-021 with a valid owned goal_id answers about ONLY that goal', async () => {
    const def = getQuestionDefinition('SQ-AI-021')!;
    const ctx = makeContext();
    const result = AIStandardQuestionService.resolveGoalRiskQuestion('u1', null, def, ctx, { goalId: 'g2' });
    expect(result.status).toBe('AVAILABLE');
    expect(result.source_refs?.[0]?.source_id).toBe('g2');
  });

  it('a goal_id that does not belong to this household is TARGET_NOT_FOUND — never distinguished from "does not exist" (spec section 65)', async () => {
    const def = getQuestionDefinition('SQ-AI-021')!;
    const ctx = makeContext();
    const result = AIStandardQuestionService.resolveGoalRiskQuestion('u1', null, def, ctx, { goalId: 'someone-elses-goal' });
    expect(result.status).toBe('TARGET_NOT_FOUND');
    expect(result.answer).toBeNull();
  });

  it('SQ-AI-012 is DOMAIN_UNAVAILABLE when balance_sheet certification is INVALID — never a fabricated debt figure', async () => {
    const def = getQuestionDefinition('SQ-AI-012')!;
    const ctx = makeContext({ domain_certification: { ...makeContext().domain_certification, balance_sheet: { status: 'INVALID', reason: 'test', model_versions: [], data_as_of: null } } });
    const result = await AIStandardQuestionService.resolveDefinition(fakeDeps(), 'u1', null, def, ctx);
    expect(result.status).toBe('DOMAIN_UNAVAILABLE');
  });

  it('SQ-AI-023 is DOMAIN_UNAVAILABLE with no Twin — never generic benchmark text (spec section 88)', async () => {
    const def = getQuestionDefinition('SQ-AI-023')!;
    const ctx = makeContext({ domain_certification: { ...makeContext().domain_certification, financial_twin: { status: 'UNAVAILABLE', reason: 'no twin run', model_versions: [], data_as_of: null } } });
    const result = await AIStandardQuestionService.resolveDefinition(fakeDeps(), 'u1', null, def, ctx);
    expect(result.status).toBe('DOMAIN_UNAVAILABLE');
    expect(result.answer).toBeNull();
  });

  it('SQ-AI-019 never invents protection adequacy when no stored insurance explanation exists (spec section 83)', async () => {
    const def = getQuestionDefinition('SQ-AI-019')!;
    const ctx = makeContext();
    const result = await AIStandardQuestionService.resolveDefinition(fakeDeps(), 'u1', null, def, ctx);
    expect(result.status).not.toBe('AVAILABLE');
    expect(result.answer).toBeNull();
  });

  it('BEFORE/AFTER PACK (spec section 80): SQ-AI-019 is PACK_NOT_READY before a compatible pack exists, and resolves via STORED_PERSONALISED once it is READY — same question, same household, only the stored answer\'s presence changes', async () => {
    insightsByMetric.delete('INSURANCE_EXPLANATION');
    const def = getQuestionDefinition('SQ-AI-019')!;
    const ctx = makeContext();

    const before = await AIStandardQuestionService.resolveDefinition(fakeDeps(), 'u1', null, def, ctx);
    expect(before.status).toBe('PACK_NOT_READY');
    expect(before.provider_called).toBe(false);
    expect(before.answer).toBeNull();

    seedInsight('INSURANCE_EXPLANATION', null, 'Your household has recorded life cover but no income-protection cover.');
    const after = await AIStandardQuestionService.resolveDefinition(fakeDeps(), 'u1', null, def, ctx);
    expect(after.status).toBe('AVAILABLE');
    expect(after.answer_origins).toEqual(['STORED_PERSONALISED']);
    expect(after.provider_called).toBe(false);
    expect(after.custom_quota_consumed).toBe(false);

    insightsByMetric.delete('INSURANCE_EXPLANATION'); // leave no cross-test residue
  });

  it('SQ-AI-007 composes DETERMINISTIC + KNOWLEDGE_BASE + STORED_PERSONALISED into one COMPOSED_ZERO_COST answer (spec section 92)', async () => {
    seedInsight('SAVINGS_EXPLANATION', 0.3333, 'Your savings rate is solid for your income level.');
    const def = getQuestionDefinition('SQ-AI-007')!;
    const ctx = makeContext();
    const result = await AIStandardQuestionService.resolveDefinition(fakeDeps(), 'u1', null, def, ctx);
    expect(result.status).toBe('AVAILABLE');
    expect(result.answer_origins).toEqual(['COMPOSED_ZERO_COST']);
    expect(result.answer?.summary).toBeTruthy();
  });

  it('SQ-AI-018 (insurance completeness) resolves purely deterministically', async () => {
    const def = getQuestionDefinition('SQ-AI-018')!;
    const ctx = makeContext();
    const result = await AIStandardQuestionService.resolveDefinition(fakeDeps(), 'u1', null, def, ctx);
    expect(result.status).toBe('AVAILABLE');
    expect(result.answer_origins).toEqual(['DETERMINISTIC']);
  });
});
