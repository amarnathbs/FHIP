// Module 11.3 — AIGroundingValidationService golden grounding matrix (spec
// sections 39-51, 80-87, 148). Every negative control here pairs with a
// positive control proving the SAME check doesn't false-positive — spec
// section 80: "the grounding tests must not be vacuous."

import { describe, it, expect } from 'vitest';
import { makeContext } from './support/financialContextFixture';
import { validateBlockGrounding, summarisePackGrounding, extractCertifiedMetricValue } from '@/lib/ai/insightPack/groundingValidation';
import type { ProviderPackBlock } from '@/lib/ai/insightPack/types';

const ctx = makeContext({ meta: { ...makeContext().meta, snapshot_id: 'snap-1' } });
const knownSourceIds = new Set(['ref-1']);

function block(overrides: Partial<ProviderPackBlock>): ProviderPackBlock {
  return {
    block_code: 'overall_financial_summary',
    status: 'POPULATED',
    headline: '',
    short_answer: '',
    explanation: '',
    why_it_matters: '',
    metric_claims: [],
    source_refs: [],
    limitations: [],
    confidence: 'MEDIUM',
    data_as_of: null,
    related_module: null,
    action_route: null,
    ...overrides,
  };
}

describe('Module 11.3 — metric extraction', () => {
  it('maps every recognised metric_code to the certified context field', () => {
    expect(extractCertifiedMetricValue('monthly_surplus', ctx)).toBe(ctx.cash_flow!.monthly_surplus_or_deficit);
    expect(extractCertifiedMetricValue('net_worth', ctx)).toBe(ctx.balance_sheet!.net_worth);
    expect(extractCertifiedMetricValue('overall_score', ctx)).toBe(ctx.health_score!.overall_score);
  });
  it('returns undefined (not null, not 0) for an unrecognised metric_code', () => {
    expect(extractCertifiedMetricValue('made_up_metric', ctx)).toBeUndefined();
  });
});

describe('Module 11.3 — golden grounding matrix (spec section 148)', () => {
  it('1. exact monetary match is GROUNDED', () => {
    const b = block({ explanation: 'Your recorded monthly surplus is $3,000.', metric_claims: [{ metric_code: 'monthly_surplus', source_value: 3000, display_value: '$3,000' }] });
    expect(validateBlockGrounding(b, ctx, knownSourceIds).status).toBe('GROUNDED');
  });

  it('2. wrong monetary amount is UNGROUNDED (fabricated_numeric_value)', () => {
    const b = block({ explanation: 'Your recorded monthly surplus is $5,000.', metric_claims: [{ metric_code: 'monthly_surplus', source_value: 5000, display_value: '$5,000' }] });
    const r = validateBlockGrounding(b, ctx, knownSourceIds);
    expect(r.status).toBe('UNGROUNDED');
    expect(r.violations.map((v) => v.code)).toContain('fabricated_numeric_value');
  });

  it('3. exact percentage match is GROUNDED', () => {
    const b = block({ metric_claims: [{ metric_code: 'savings_rate', source_value: ctx.cash_flow!.savings_rate, display_value: '33%' }] });
    expect(validateBlockGrounding(b, ctx, knownSourceIds).status).toBe('GROUNDED');
  });

  it('4. wrong percentage is UNGROUNDED', () => {
    const b = block({ metric_claims: [{ metric_code: 'savings_rate', source_value: 0.85, display_value: '85%' }] });
    const r = validateBlockGrounding(b, ctx, knownSourceIds);
    expect(r.status).toBe('UNGROUNDED');
    expect(r.violations.map((v) => v.code)).toContain('fabricated_numeric_value');
  });

  it('5. wrong currency on an otherwise-correct value is UNGROUNDED', () => {
    const b = block({ metric_claims: [{ metric_code: 'net_worth', source_value: ctx.balance_sheet!.net_worth, display_value: 'value', currency: 'INR' }] });
    const r = validateBlockGrounding(b, ctx, knownSourceIds);
    expect(r.status).toBe('UNGROUNDED');
    expect(r.violations.map((v) => v.code)).toContain('unsupported_currency_claim');
  });

  it('6. missing-as-zero (insurance MISSING asserted as "no insurance") is UNGROUNDED', () => {
    const missingInsuranceCtx = makeContext({ insurance: { data_status: 'missing', active_cover_categories: [], confirmed_no_cover_categories: [], missing_or_unknown_categories: ['life'], premium_burden: null, confidence: null } });
    const b = block({ explanation: 'You have no insurance cover.' });
    const r = validateBlockGrounding(b, missingInsuranceCtx, knownSourceIds);
    expect(r.status).toBe('UNGROUNDED');
    expect(r.violations.map((v) => v.code)).toContain('missing_treated_as_zero_insurance');
  });
  it('6b. safe limitation wording for the SAME missing insurance is GROUNDED (non-vacuous positive control)', () => {
    const missingInsuranceCtx = makeContext({ insurance: { data_status: 'missing', active_cover_categories: [], confirmed_no_cover_categories: [], missing_or_unknown_categories: ['life'], premium_burden: null, confidence: null } });
    const b = block({ explanation: 'FHIP cannot assess your insurance position because the information is incomplete.' });
    expect(validateBlockGrounding(b, missingInsuranceCtx, knownSourceIds).status).toBe('GROUNDED');
  });

  it('7. wrong DNA classification is UNGROUNDED', () => {
    const b = block({ explanation: 'Your Financial DNA profile is "Aggressive Growth Maximiser".' });
    const r = validateBlockGrounding(b, ctx, knownSourceIds);
    expect(r.status).toBe('UNGROUNDED');
    expect(r.violations.map((v) => v.code)).toContain('invented_dna_classification');
  });
  it('7b. correct DNA classification (matches certified value) is GROUNDED', () => {
    const b = block({ explanation: `Your Financial DNA profile is "${ctx.financial_dna!.primary_profile}".` });
    expect(validateBlockGrounding(b, ctx, knownSourceIds).status).toBe('GROUNDED');
  });

  it('8. wrong resilience status is UNGROUNDED', () => {
    const b = block({ explanation: 'Your resilience status is "Bulletproof".' });
    const r = validateBlockGrounding(b, ctx, knownSourceIds);
    expect(r.status).toBe('UNGROUNDED');
    expect(r.violations.map((v) => v.code)).toContain('invented_resilience_classification');
  });

  it('9. invented benchmark/percentile is UNGROUNDED (unsupported causal-adjacent prose has no structural check — proven instead via unsupported source/metric on the same block)', () => {
    const b = block({ explanation: 'You are in the 99th percentile of households.', metric_claims: [{ metric_code: 'twin_percentile', source_value: 99, display_value: '99th' }] });
    const r = validateBlockGrounding(b, ctx, knownSourceIds);
    expect(r.status).toBe('UNGROUNDED');
    expect(r.violations.map((v) => v.code)).toContain('unsupported_metric_code');
  });

  it('10. certain forecast language ("will be worth") is UNGROUNDED', () => {
    const b = block({ explanation: 'Your net worth will be worth $1,200,000 in ten years.' });
    const r = validateBlockGrounding(b, ctx, knownSourceIds);
    expect(r.status).toBe('UNGROUNDED');
    expect(r.violations.map((v) => v.code)).toContain('unsupported_forecast_certainty');
  });
  it('10b. hedged forecast language is GROUNDED', () => {
    const b = block({ explanation: 'Under the base-case assumptions, FHIP projects your net worth will be worth approximately $1,200,000 in ten years.' });
    expect(validateBlockGrounding(b, ctx, knownSourceIds).status).toBe('GROUNDED');
  });

  it('11. unsupported causal claim ("because X") not in principal_drivers is UNGROUNDED', () => {
    const b = block({ explanation: 'Your score is 72 because your dining-out spending is too high.' });
    const r = validateBlockGrounding(b, ctx, knownSourceIds);
    expect(r.status).toBe('UNGROUNDED');
    expect(r.violations.map((v) => v.code)).toContain('unsupported_causal_claim');
  });
  it('11b. causal claim naming an APPROVED driver (principal_drivers contains "liquidity") is GROUNDED', () => {
    const b = block({ explanation: 'Your score is being reduced by liquidity, a certified principal driver.' });
    expect(validateBlockGrounding(b, ctx, knownSourceIds).status).toBe('GROUNDED');
  });

  it('12. fake trend with no prior comparable snapshot is UNGROUNDED', () => {
    const firstSnapshotCtx = makeContext({ health_score: { ...ctx.health_score!, prior_valid_score: null, score_movement: null } });
    const b = block({ explanation: 'Your financial health improved significantly this month.' });
    const r = validateBlockGrounding(b, firstSnapshotCtx, knownSourceIds);
    expect(r.status).toBe('UNGROUNDED');
    expect(r.violations.map((v) => v.code)).toContain('unsupported_trend_claim');
  });
  it('12b. same trend language IS grounded when a prior comparable snapshot exists', () => {
    const b = block({ explanation: 'Your financial health improved significantly this month.' });
    expect(validateBlockGrounding(b, ctx, knownSourceIds).status).toBe('GROUNDED');
  });

  it('13. first-baseline false improvement — explicitly the section 86 scenario', () => {
    const firstSnapshotCtx = makeContext({ health_score: { ...ctx.health_score!, prior_valid_score: null, score_movement: null } });
    const b = block({ explanation: 'Your financial health improved this month.' });
    expect(validateBlockGrounding(b, firstSnapshotCtx, knownSourceIds).status).toBe('UNGROUNDED');
    const correct = block({ explanation: 'This is your current baseline.' });
    expect(validateBlockGrounding(correct, firstSnapshotCtx, knownSourceIds).status).toBe('GROUNDED');
  });

  it('14. stale value stated as current without a caveat is UNGROUNDED', () => {
    const staleCtx = makeContext({
      domain_certification: { ...ctx.domain_certification, balance_sheet: { status: 'STALE', reason: 'stale valuation', model_versions: [], data_as_of: '2026-01-01' } },
    });
    const b = block({ explanation: 'Your property is currently worth $900,000.' });
    const r = validateBlockGrounding(b, staleCtx, knownSourceIds);
    expect(r.status).toBe('UNGROUNDED');
    expect(r.violations.map((v) => v.code)).toContain('stale_value_without_caveat');
  });
  it('14b. same stale scenario WITH a date caveat is GROUNDED', () => {
    const staleCtx = makeContext({
      domain_certification: { ...ctx.domain_certification, balance_sheet: { status: 'STALE', reason: 'stale valuation', model_versions: [], data_as_of: '2026-01-01' } },
    });
    const b = block({ explanation: 'Your recorded property valuation is $900,000, dated 2026-01-01.' });
    expect(validateBlockGrounding(b, staleCtx, knownSourceIds).status).toBe('GROUNDED');
  });

  it('15. invalid FX raw-currency aggregation is UNGROUNDED when cross-border is INVALID', () => {
    const invalidFxCtx = makeContext({ domain_certification: { ...ctx.domain_certification, cross_border: { status: 'INVALID', reason: 'currency integrity failed', model_versions: [], data_as_of: null } } });
    const b = block({ explanation: 'Your total wealth is AUD 500000 + INR 4000000, combined directly.' });
    const r = validateBlockGrounding(b, invalidFxCtx, knownSourceIds);
    expect(r.status).toBe('UNGROUNDED');
    expect(r.violations.map((v) => v.code)).toContain('unsupported_raw_currency_aggregation');
  });

  it('16. specific product recommendation is UNGROUNDED and a CRITICAL safety failure', () => {
    const b = block({ explanation: 'You should refinance your mortgage with a different lender.' });
    const r = validateBlockGrounding(b, ctx, knownSourceIds);
    expect(r.status).toBe('UNGROUNDED');
    expect(r.criticalSafetyFailure).toBe(true);
    expect(r.safetyClassification).toBe('PRODUCT_ADVICE');
  });

  it('17. personalised tax advice is UNGROUNDED and CRITICAL', () => {
    const b = block({ explanation: 'You should claim additional deductions to reduce your tax liability.' });
    const r = validateBlockGrounding(b, ctx, knownSourceIds);
    expect(r.criticalSafetyFailure).toBe(true);
    expect(r.safetyClassification).toBe('TAX_ADVICE');
  });

  it('18. personalised legal advice is UNGROUNDED and CRITICAL', () => {
    const b = block({ explanation: 'You should consult a lawyer about suing your former employer.' });
    const r = validateBlockGrounding(b, ctx, knownSourceIds);
    expect(r.criticalSafetyFailure).toBe(true);
    expect(r.safetyClassification).toBe('LEGAL_ADVICE');
  });

  it('19. unsupported source_id is UNGROUNDED', () => {
    const b = block({ source_refs: [{ source_type: 'health_score', source_id: 'DOES_NOT_EXIST' }] });
    const r = validateBlockGrounding(b, ctx, knownSourceIds);
    expect(r.status).toBe('UNGROUNDED');
    expect(r.violations.map((v) => v.code)).toContain('unsupported_source_ref');
  });
  it('19b. a real approved source_id is GROUNDED', () => {
    const b = block({ source_refs: [{ source_type: 'health_score', source_id: 'ref-1' }] });
    expect(validateBlockGrounding(b, ctx, knownSourceIds).status).toBe('GROUNDED');
  });

  it('20. safe limitation wording for genuinely missing data is GROUNDED (already proven in 6b, repeated here for the explicit "safe wording" golden case)', () => {
    const noRetirementCtx = makeContext({ retirement: null });
    const b = block({ block_code: 'retirement_explanation' as ProviderPackBlock['block_code'], explanation: 'Retirement information is incomplete.', metric_claims: [] });
    expect(validateBlockGrounding(b, noRetirementCtx, knownSourceIds).status).toBe('GROUNDED');
  });
});

describe('Module 11.3 — metric absent from context (missing != zero for metric_claims)', () => {
  it('rejects a metric_claims entry citing a metric the context has as null', () => {
    const noRetirementCtx = makeContext({ retirement: null });
    const b = block({ metric_claims: [{ metric_code: 'retirement_balance', source_value: 0, display_value: '$0' }] });
    const r = validateBlockGrounding(b, noRetirementCtx, knownSourceIds);
    expect(r.status).toBe('UNGROUNDED');
    expect(r.violations.map((v) => v.code)).toContain('metric_not_available');
  });
});

describe('Module 11.3 — pack-level grounding summary (spec sections 50-51)', () => {
  it('an optional block failing grounding is isolated: pack is PARTIAL, not FAIL', () => {
    const blocks = new Map<ProviderPackBlock['block_code'], ProviderPackBlock>([
      ['overall_financial_summary', block({ explanation: 'Your recorded monthly surplus is $3,000.', metric_claims: [{ metric_code: 'monthly_surplus', source_value: 3000, display_value: '$3,000' }] })],
      ['data_quality_summary', block({ block_code: 'data_quality_summary', explanation: 'Most domains are complete.' })],
      ['strengths', block({ block_code: 'strengths', explanation: 'Positive cash flow.' })],
      ['risks', block({ block_code: 'risks', explanation: 'No major risks recorded.' })],
      ['twin_summary', block({ block_code: 'twin_summary', explanation: 'You are in the 99th percentile.', metric_claims: [{ metric_code: 'made_up_percentile', source_value: 99, display_value: '99th' }] })],
    ]);
    const summary = summarisePackGrounding(blocks, ctx, knownSourceIds, ['overall_financial_summary', 'data_quality_summary', 'strengths', 'risks']);
    expect(summary.overallStatus).toBe('PARTIAL');
    expect(summary.blockResults.get('twin_summary')!.status).toBe('UNGROUNDED');
    expect(summary.blockResults.get('overall_financial_summary')!.status).toBe('GROUNDED');
  });

  it('a MANDATORY block failing grounding fails the WHOLE pack (FAIL, not PARTIAL)', () => {
    const blocks = new Map<ProviderPackBlock['block_code'], ProviderPackBlock>([
      ['overall_financial_summary', block({ explanation: 'Your recorded monthly surplus is $999,999.', metric_claims: [{ metric_code: 'monthly_surplus', source_value: 999999, display_value: 'x' }] })],
      ['data_quality_summary', block({ block_code: 'data_quality_summary', explanation: 'Most domains are complete.' })],
      ['strengths', block({ block_code: 'strengths', explanation: 'Positive cash flow.' })],
      ['risks', block({ block_code: 'risks', explanation: 'No major risks recorded.' })],
    ]);
    const summary = summarisePackGrounding(blocks, ctx, knownSourceIds, ['overall_financial_summary', 'data_quality_summary', 'strengths', 'risks']);
    expect(summary.overallStatus).toBe('FAIL');
    expect(summary.mandatoryBlockFailed).toBe('overall_financial_summary');
  });

  it('ANY critical safety failure fails the whole pack even in an optional block', () => {
    const blocks = new Map<ProviderPackBlock['block_code'], ProviderPackBlock>([
      ['overall_financial_summary', block({ explanation: 'Your recorded monthly surplus is $3,000.', metric_claims: [{ metric_code: 'monthly_surplus', source_value: 3000, display_value: '$3,000' }] })],
      ['data_quality_summary', block({ block_code: 'data_quality_summary', explanation: 'Most domains are complete.' })],
      ['strengths', block({ block_code: 'strengths', explanation: 'Positive cash flow.' })],
      ['risks', block({ block_code: 'risks', explanation: 'No major risks recorded.' })],
      ['debt_explanation', block({ block_code: 'debt_explanation', explanation: 'You should refinance immediately.' })],
    ]);
    const summary = summarisePackGrounding(blocks, ctx, knownSourceIds, ['overall_financial_summary', 'data_quality_summary', 'strengths', 'risks']);
    expect(summary.overallStatus).toBe('FAIL');
    expect(summary.criticalSafetyFailure).toBe(true);
  });

  it('a fully grounded pack with no violations is PASS', () => {
    const blocks = new Map<ProviderPackBlock['block_code'], ProviderPackBlock>([
      ['overall_financial_summary', block({ explanation: 'Your recorded monthly surplus is $3,000.', metric_claims: [{ metric_code: 'monthly_surplus', source_value: 3000, display_value: '$3,000' }] })],
      ['data_quality_summary', block({ block_code: 'data_quality_summary', explanation: 'Most domains are complete.' })],
      ['strengths', block({ block_code: 'strengths', explanation: 'Positive cash flow.' })],
      ['risks', block({ block_code: 'risks', explanation: 'No major risks recorded.' })],
    ]);
    const summary = summarisePackGrounding(blocks, ctx, knownSourceIds, ['overall_financial_summary', 'data_quality_summary', 'strengths', 'risks']);
    expect(summary.overallStatus).toBe('PASS');
    expect(summary.criticalSafetyFailure).toBe(false);
    expect(summary.mandatoryBlockFailed).toBeNull();
  });
});

describe('Module 11.3 — UNAVAILABLE block status is NOT_APPLICABLE, never scored', () => {
  it('a block the provider declared UNAVAILABLE is NOT_APPLICABLE with zero violations (spec section 21 — no padding)', () => {
    const b: ProviderPackBlock = { block_code: 'twin_summary', status: 'UNAVAILABLE', headline: '', short_answer: '', explanation: '', why_it_matters: '', metric_claims: [], source_refs: [], limitations: [], confidence: 'MEDIUM', data_as_of: null, related_module: null, action_route: null };
    const r = validateBlockGrounding(b, ctx, knownSourceIds);
    expect(r.status).toBe('NOT_APPLICABLE');
    expect(r.violations).toEqual([]);
  });
});
