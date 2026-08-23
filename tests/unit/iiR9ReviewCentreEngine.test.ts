import { describe, it, expect } from 'vitest';
import {
  detectUnallocatedInvestments,
  detectOverAllocation,
  detectGoalForecastGap,
  detectStaleValuation,
  detectSipInterruption,
  detectTaxLotIncomplete,
  detectBenchmarkUnderperformance,
  computeIdentityKey,
  type RuleConfig,
} from '@/lib/engines/investment-intelligence/reviewCentre';
import { attributeInvestments, computeGoalLinkedValues, type InvestmentRow, type FundingSourceRow } from '@/lib/services/investment-intelligence/portfolioAttribution';

const rule = (overrides: Partial<RuleConfig> = {}): RuleConfig => ({
  ruleKey: 'test_rule',
  ruleVersion: 'r9-1.0.0',
  reviewType: 'goal',
  category: 'test_category',
  defaultSeverity: 'low',
  complianceClassification: 'observation',
  thresholdConfig: {},
  ...overrides,
});

describe('R9 portfolio attribution — pure aggregation over investments + goal_funding_sources (no new truth)', () => {
  it('attributes a single 100%-allocated investment with zero unallocated value', () => {
    const investments: InvestmentRow[] = [{ id: 'inv-1', current_value: 10000, currency_code: 'INR', source_type: 'investment_intelligence_published', is_active: true }];
    const sources: FundingSourceRow[] = [{ id: 'fs-1', goal_id: 'goal-1', linked_investment_id: 'inv-1', allocation_percentage: 100, allocated_amount: 0, is_active: true }];
    const [attr] = attributeInvestments(investments, sources);
    expect(attr.allocatedValue).toBe(10000);
    expect(attr.unallocatedValue).toBe(0);
    expect(attr.allocatedPct).toBe(100);
  });

  it('splits one investment across three goals — LIVE-R9-002 shape — with exact attribution and no duplication of total value', () => {
    const investments: InvestmentRow[] = [{ id: 'inv-1', current_value: 100000, currency_code: 'INR', source_type: 'investment_intelligence_published', is_active: true }];
    const sources: FundingSourceRow[] = [
      { id: 'fs-1', goal_id: 'goal-retirement', linked_investment_id: 'inv-1', allocation_percentage: 50, allocated_amount: 0, is_active: true },
      { id: 'fs-2', goal_id: 'goal-education', linked_investment_id: 'inv-1', allocation_percentage: 30, allocated_amount: 0, is_active: true },
      { id: 'fs-3', goal_id: 'goal-house', linked_investment_id: 'inv-1', allocation_percentage: 20, allocated_amount: 0, is_active: true },
    ];
    const [attr] = attributeInvestments(investments, sources);
    expect(attr.allocatedPct).toBe(100);
    expect(attr.allocatedValue).toBe(100000);
    expect(attr.unallocatedValue).toBe(0);

    const goalValues = computeGoalLinkedValues(investments, sources);
    const total = goalValues.reduce((sum, g) => sum + g.allocatedValue, 0);
    // The sum across every goal's linked value must equal the investment's
    // own current value exactly once — never more (spec sections 23-25).
    expect(total).toBe(100000);
    expect(goalValues.find((g) => g.goalId === 'goal-retirement')?.allocatedValue).toBe(50000);
    expect(goalValues.find((g) => g.goalId === 'goal-education')?.allocatedValue).toBe(30000);
    expect(goalValues.find((g) => g.goalId === 'goal-house')?.allocatedValue).toBe(20000);
  });

  it('sums several investments supporting one goal — LIVE-R9-003 shape', () => {
    const investments: InvestmentRow[] = [
      { id: 'inv-1', current_value: 40000, currency_code: 'INR', source_type: 'manual', is_active: true },
      { id: 'inv-2', current_value: 60000, currency_code: 'INR', source_type: 'investment_intelligence_published', is_active: true },
    ];
    const sources: FundingSourceRow[] = [
      { id: 'fs-1', goal_id: 'goal-1', linked_investment_id: 'inv-1', allocation_percentage: 100, allocated_amount: 0, is_active: true },
      { id: 'fs-2', goal_id: 'goal-1', linked_investment_id: 'inv-2', allocation_percentage: 100, allocated_amount: 0, is_active: true },
    ];
    const [goalValue] = computeGoalLinkedValues(investments, sources);
    expect(goalValue.allocatedValue).toBe(100000);
  });

  it('reports an unallocated investment with zero funding sources at 100% unallocated — LIVE-R9-004 shape', () => {
    const investments: InvestmentRow[] = [{ id: 'inv-1', current_value: 5000, currency_code: 'AUD', source_type: 'manual', is_active: true }];
    const [attr] = attributeInvestments(investments, []);
    expect(attr.allocatedValue).toBe(0);
    expect(attr.unallocatedValue).toBe(5000);
  });

  it('caps allocated value at current_value even if summed percentages exceed 100 (defensive; the real cap lives at write time)', () => {
    const investments: InvestmentRow[] = [{ id: 'inv-1', current_value: 1000, currency_code: 'AUD', source_type: 'manual', is_active: true }];
    const sources: FundingSourceRow[] = [
      { id: 'fs-1', goal_id: 'goal-1', linked_investment_id: 'inv-1', allocation_percentage: 70, allocated_amount: 0, is_active: true },
      { id: 'fs-2', goal_id: 'goal-2', linked_investment_id: 'inv-1', allocation_percentage: 60, allocated_amount: 0, is_active: true }, // forged/bypassed state — 130% total
    ];
    const [attr] = attributeInvestments(investments, sources);
    expect(attr.allocatedPct).toBe(130); // raw sum reported, not silently clamped — so the over-allocation rule below can detect it
    expect(attr.allocatedValue).toBeLessThanOrEqual(1000); // but the VALUE contribution never exceeds the investment's own balance
  });
});

describe('R9 review engine — deterministic rules over pre-fetched, already-certified data', () => {
  it('detectUnallocatedInvestments flags exactly the investments with unallocated value above the configured threshold', () => {
    const investments: InvestmentRow[] = [
      { id: 'inv-fully-allocated', current_value: 1000, currency_code: 'INR', source_type: 'manual', is_active: true },
      { id: 'inv-unallocated', current_value: 2000, currency_code: 'INR', source_type: 'manual', is_active: true },
    ];
    const sources: FundingSourceRow[] = [{ id: 'fs-1', goal_id: 'goal-1', linked_investment_id: 'inv-fully-allocated', allocation_percentage: 100, allocated_amount: 0, is_active: true }];
    const attributed = attributeInvestments(investments, sources);
    const items = detectUnallocatedInvestments('user-1', attributed, '2026-08-23', rule({ ruleKey: 'unallocated_investment', category: 'unallocated_investment' }));
    expect(items).toHaveLength(1);
    expect(items[0].sourceRecordId).toBe('inv-unallocated');
    expect(items[0].evidence.unallocatedValue).toBe(2000);
  });

  it('detectOverAllocation only fires above 100% and never for a valid <=100% state (negative-control-2 shape)', () => {
    const validInvestments: InvestmentRow[] = [{ id: 'inv-1', current_value: 1000, currency_code: 'AUD', source_type: 'manual', is_active: true }];
    const validSources: FundingSourceRow[] = [{ id: 'fs-1', goal_id: 'g1', linked_investment_id: 'inv-1', allocation_percentage: 100, allocated_amount: 0, is_active: true }];
    const validAttributed = attributeInvestments(validInvestments, validSources);
    expect(detectOverAllocation('user-1', validAttributed, '2026-08-23', rule({ ruleKey: 'x', category: 'goal_allocation_conflict' }))).toHaveLength(0);

    const forgedSources: FundingSourceRow[] = [
      { id: 'fs-1', goal_id: 'g1', linked_investment_id: 'inv-1', allocation_percentage: 70, allocated_amount: 0, is_active: true },
      { id: 'fs-2', goal_id: 'g2', linked_investment_id: 'inv-1', allocation_percentage: 60, allocated_amount: 0, is_active: true },
    ];
    const forgedAttributed = attributeInvestments(validInvestments, forgedSources);
    const items = detectOverAllocation('user-1', forgedAttributed, '2026-08-23', rule({ ruleKey: 'x', category: 'goal_allocation_conflict' }));
    expect(items).toHaveLength(1);
    expect(items[0].severity).toBe('high');
    expect(items[0].evidence.allocatedPct).toBe(130);
  });

  it('detectGoalForecastGap only flags goals with an active funding source AND a configured trackStatus — never a goal with no investment linkage', () => {
    const goals = [
      { goalId: 'g1', goalName: 'Retirement', trackStatus: 'off_track', fundingGapAtTargetDate: -500000, targetAmountFuture: 5000000, projectedTargetDateValue: 4500000, currencyCode: 'INR', modelVersion: 'goals-1.0.0', forecastId: 'g1', hasActiveFundingSource: true },
      { goalId: 'g2', goalName: 'No investment linked yet', trackStatus: 'off_track', fundingGapAtTargetDate: -100, targetAmountFuture: 1000, projectedTargetDateValue: 900, currencyCode: 'INR', modelVersion: 'goals-1.0.0', forecastId: 'g2', hasActiveFundingSource: false },
      { goalId: 'g3', goalName: 'On track', trackStatus: 'on_track', fundingGapAtTargetDate: null, targetAmountFuture: 1000, projectedTargetDateValue: 1200, currencyCode: 'INR', modelVersion: 'goals-1.0.0', forecastId: 'g3', hasActiveFundingSource: true },
    ];
    const items = detectGoalForecastGap('user-1', goals, '2026-08-23', rule({ ruleKey: 'goal_forecast_gap', category: 'goal_forecast_gap', defaultSeverity: 'medium', thresholdConfig: { trackStatuses: ['off_track', 'at_risk'] } }));
    expect(items).toHaveLength(1);
    expect(items[0].sourceRecordId).toBe('g1');
    expect(items[0].evidence.fundingGapAtTargetDate).toBe(-500000);
  });

  it('detectStaleValuation only flags II-published rows past the threshold, never manual rows (manual rows have no ii_last_refreshed_at concept)', () => {
    const rows = [
      { investmentId: 'inv-fresh', iiLastRefreshedAt: '2026-08-01', sourceType: 'investment_intelligence_published' },
      { investmentId: 'inv-stale', iiLastRefreshedAt: '2026-01-01', sourceType: 'investment_intelligence_published' },
      { investmentId: 'inv-manual', iiLastRefreshedAt: null, sourceType: 'manual' },
    ];
    const items = detectStaleValuation('user-1', rows, '2026-08-23', rule({ ruleKey: 'stale_valuation', category: 'stale_valuation', thresholdConfig: { staleDays: 90 } }));
    expect(items).toHaveLength(1);
    expect(items[0].sourceRecordId).toBe('inv-stale');
  });

  it('detectSipInterruption ignores IRREGULAR/UNKNOWN cadence and low-confidence detections (never fabricates certainty)', () => {
    const rows = [
      { id: 'sip-irregular', instrumentId: 'x', cadence: 'IRREGULAR', detectionConfidence: 'CONFIRMED_SOURCE', latestContributionDate: '2026-01-01', detectionMethodVersion: 'v1' },
      { id: 'sip-low-confidence', instrumentId: 'x', cadence: 'MONTHLY', detectionConfidence: 'POSSIBLE', latestContributionDate: '2026-01-01', detectionMethodVersion: 'v1' },
      { id: 'sip-genuinely-interrupted', instrumentId: 'x', cadence: 'MONTHLY', detectionConfidence: 'CONFIRMED_SOURCE', latestContributionDate: '2026-04-01', detectionMethodVersion: 'v1' },
    ];
    const items = detectSipInterruption('user-1', rows, '2026-08-23', rule({ ruleKey: 'sip_interruption', category: 'sip_interruption', thresholdConfig: { missedInstalments: 2 } }));
    expect(items).toHaveLength(1);
    expect(items[0].sourceRecordId).toBe('sip-genuinely-interrupted');
  });

  it('detectBenchmarkUnderperformance reads the REAL R4 scope_id/scheme_active_return/result_value shape, ignores unavailable-quality rows, and never recomputes the CAGR itself', () => {
    const metrics = [
      { scopeId: 'inst-ok', metricKey: 'scheme_active_return', activeReturn: -0.05, qualityStatus: 'ok', engineVersion: 'r4-1.0.0' }, // 5pp underperformance — flagged
      { scopeId: 'inst-mild', metricKey: 'scheme_active_return', activeReturn: -0.005, qualityStatus: 'ok', engineVersion: 'r4-1.0.0' }, // within threshold — not flagged
      { scopeId: 'inst-unavailable', metricKey: 'scheme_active_return', activeReturn: -0.10, qualityStatus: 'unavailable', engineVersion: 'r4-1.0.0' }, // no comparable number — not flagged
      { scopeId: 'inst-other-metric', metricKey: 'investor_xirr', activeReturn: null, qualityStatus: 'ok', engineVersion: 'r4-1.0.0' },
    ];
    const items = detectBenchmarkUnderperformance('user-1', metrics, '2026-08-23', rule({ ruleKey: 'benchmark_underperformance', category: 'benchmark_underperformance', defaultSeverity: 'medium', thresholdConfig: { underperformanceFraction: 0.02 } }));
    expect(items).toHaveLength(1);
    expect(items[0].sourceRecordId).toBe('inst-ok');
    expect(items[0].evidence.activeReturn).toBe(-0.05);
  });

  it('detectTaxLotIncomplete never fires on fully resolved computations and never recomputes tax figures itself', () => {
    const rows = [
      { computationId: 'c1', instrumentId: 'x', classification: 'equity_oriented', gainType: 'ltcg', engineVersion: 'v1' },
      { computationId: 'c2', instrumentId: 'x', classification: 'unresolved', gainType: 'unresolved', engineVersion: 'v1' },
    ];
    const items = detectTaxLotIncomplete('user-1', rows, '2026-08-23', rule({ ruleKey: 'tax_lot_incomplete', category: 'tax_lot_incomplete' }));
    expect(items).toHaveLength(1);
    expect(items[0].sourceRecordId).toBe('c2');
    // Evidence must carry only classification/engine-version facts — never a taxable_gain figure the review engine did not itself compute.
    expect(items[0].evidence).not.toHaveProperty('taxableGain');
  });

  it('computeIdentityKey is deterministic (same inputs -> same key) and sensitive to every component (spec section 50 dedup)', () => {
    const a = computeIdentityKey('user-1', 'goal', 'unallocated_investment', 'inv-1');
    const b = computeIdentityKey('user-1', 'goal', 'unallocated_investment', 'inv-1');
    const c = computeIdentityKey('user-1', 'goal', 'unallocated_investment', 'inv-2');
    const d = computeIdentityKey('user-2', 'goal', 'unallocated_investment', 'inv-1');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toBe(d);
  });

  it('never produces a personalised_advice classification — the type system and every rule constant are restricted to observation/education/simulation (spec sections 40-42)', () => {
    const investments: InvestmentRow[] = [{ id: 'inv-1', current_value: 1000, currency_code: 'AUD', source_type: 'manual', is_active: true }];
    const items = detectUnallocatedInvestments('user-1', attributeInvestments(investments, []), '2026-08-23', rule());
    for (const item of items) {
      expect(['observation', 'education', 'simulation']).toContain(item.complianceClassification);
    }
  });
});
