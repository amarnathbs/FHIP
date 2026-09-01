// Module 11.2 — DeterministicAnswerResolver unit tests (spec sections 12-20,
// 99, 103, 108-110).
import { describe, it, expect } from 'vitest';
import { resolveDeterministic } from '@/lib/ai/resolution/deterministicResolver';
import { makeContext, allCertified } from './support/financialContextFixture';

describe('resolveDeterministic', () => {
  it('resolves net worth from the certified balance sheet, exactly, without recomputing (spec section 103)', () => {
    const ctx = makeContext();
    const attempt = resolveDeterministic({ intentCode: 'CURRENT_NET_WORTH', context: ctx });
    expect(attempt.hit).toBe(true);
    expect(attempt.answer!.headline).toContain('600,000');
    expect(attempt.answer!.requires_live_ai).toBe(false);
    expect(attempt.answer!.consumes_custom_quota).toBe(false);
    expect(attempt.answer!.source_refs.length).toBeGreaterThan(0);
  });

  it('resolves monthly surplus exactly (spec section 103)', () => {
    const ctx = makeContext();
    const attempt = resolveDeterministic({ intentCode: 'MONTHLY_SURPLUS', context: ctx });
    expect(attempt.answer!.headline).toContain('3,000');
  });

  it('resolves the Financial Health Score from the persisted certified value, not a recalculation (spec section 103)', () => {
    const ctx = makeContext();
    const attempt = resolveDeterministic({ intentCode: 'FINANCIAL_HEALTH_SCORE', context: ctx });
    expect(attempt.answer!.headline).toContain('72');
  });

  it('resolves Financial DNA primary profile (spec section 103)', () => {
    const ctx = makeContext();
    const attempt = resolveDeterministic({ intentCode: 'DNA_PRIMARY_PROFILE', context: ctx });
    expect(attempt.answer!.headline).toContain('BUILDER');
  });

  it('resolves emergency-fund coverage from the certified resilience output (spec section 103)', () => {
    const ctx = makeContext();
    const attempt = resolveDeterministic({ intentCode: 'EMERGENCY_FUND_MONTHS', context: ctx });
    expect(attempt.answer!.headline).toContain('3.5 months');
  });

  // -------------------------------------------------------------------
  // Zero vs missing vs unavailable (spec section 18, 108).
  // -------------------------------------------------------------------
  it('reports a genuine ₹0/$0 liability as zero, not missing', () => {
    const ctx = makeContext({ balance_sheet: { ...makeContext().balance_sheet!, total_liabilities: 0 } });
    const attempt = resolveDeterministic({ intentCode: 'TOTAL_LIABILITIES', context: ctx });
    expect(attempt.hit).toBe(true);
    expect(attempt.answer!.headline).toMatch(/\$0\.00|\$0\b/);
  });

  it('does NOT answer with a fabricated value when the balance sheet is INVALID (spec section 108)', () => {
    const dc = allCertified();
    dc.balance_sheet = { status: 'INVALID', reason: 'currency mismatch', model_versions: [], data_as_of: null };
    const ctx = makeContext({ balance_sheet: null, domain_certification: dc });
    const attempt = resolveDeterministic({ intentCode: 'CURRENT_NET_WORTH', context: ctx });
    expect(attempt.hit).toBe(false);
    expect(attempt.miss_reason).toBe('certification_invalid');
  });

  it('does NOT answer when the domain is UNAVAILABLE (no fabricated zero)', () => {
    const dc = allCertified();
    dc.balance_sheet = { status: 'UNAVAILABLE', reason: 'no data', model_versions: [], data_as_of: null };
    const ctx = makeContext({ balance_sheet: null, domain_certification: dc });
    const attempt = resolveDeterministic({ intentCode: 'TOTAL_LIABILITIES', context: ctx });
    expect(attempt.hit).toBe(false);
    expect(attempt.miss_reason).toBe('certification_unavailable');
  });

  it('answers with a stale limitation when the domain is STALE rather than refusing outright (spec section 19)', () => {
    const dc = allCertified();
    dc.balance_sheet = { status: 'STALE', reason: 'old snapshot', model_versions: ['dashboard-1.0.0'], data_as_of: '2026-01-01' };
    const ctx = makeContext({ domain_certification: dc });
    const attempt = resolveDeterministic({ intentCode: 'CURRENT_NET_WORTH', context: ctx });
    expect(attempt.hit).toBe(true);
    expect(attempt.answer!.limitations.length).toBeGreaterThan(0);
    expect(attempt.answer!.confidence).toBe('MEDIUM');
  });

  it('total database outage (whole-context INVALID) fails closed for a meta-level intent too', () => {
    const ctx = makeContext({ meta: { ...makeContext().meta, certification_status: 'INVALID' } });
    const attempt = resolveDeterministic({ intentCode: 'SNAPSHOT_DATE', context: ctx });
    expect(attempt.hit).toBe(false);
  });

  // -------------------------------------------------------------------
  // Goal counting (spec section 39) — reuses each goal's own certified
  // track_status, never recomputes a forecast.
  // -------------------------------------------------------------------
  it('counts goals on track and at risk from the existing per-goal track_status', () => {
    const ctx = makeContext();
    expect(resolveDeterministic({ intentCode: 'GOAL_COUNT', context: ctx }).answer!.headline).toContain('2');
    expect(resolveDeterministic({ intentCode: 'GOALS_ON_TRACK_COUNT', context: ctx }).answer!.headline).toContain('1');
    expect(resolveDeterministic({ intentCode: 'GOALS_AT_RISK_COUNT', context: ctx }).answer!.headline).toContain('1');
  });

  // -------------------------------------------------------------------
  // WHY-explanation boundary (spec sections 34-36, 106): the driver lists
  // available today do not constitute a causal explanation, so these must
  // always miss rather than fabricate one.
  // -------------------------------------------------------------------
  it('does not fabricate a causal explanation for a WHY-question intent (spec section 106 anti-test)', () => {
    const ctx = makeContext();
    const attempt = resolveDeterministic({ intentCode: 'SCORE_EXPLANATION', context: ctx });
    expect(attempt.hit).toBe(false);
  });

  it('formats a currency value using the household reporting currency (INR) via the shared money formatter (spec section 70)', () => {
    const ctx = makeContext({ meta: { ...makeContext().meta, reporting_currency: 'INR' } });
    const attempt = resolveDeterministic({ intentCode: 'CURRENT_NET_WORTH', context: ctx });
    expect(attempt.answer!.headline).toMatch(/₹/);
  });
});
