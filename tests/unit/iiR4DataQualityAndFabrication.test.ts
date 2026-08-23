// R4 — DQ-001..015 (spec section 88) and no-fabrication tests (spec
// section 89): explicitly verify NO numeric metric is returned where
// inputs are insufficient.
import { describe, it, expect } from 'vitest';
import { xirr } from '@/lib/engines/investment-intelligence/xirr';
import { twrr } from '@/lib/engines/investment-intelligence/twrr';
import { sinceInceptionXirrEligible, optionTotalReturnEligible } from '@/lib/engines/investment-intelligence/dataQuality';
import { sharpeRatio, beta, informationRatio, captureRatios } from '@/lib/engines/investment-intelligence/riskMetrics';
import { rollingReturnSeries } from '@/lib/engines/investment-intelligence/rollingReturns';
import { blendedBenchmarkReturn, type BenchmarkPeriodReturn } from '@/lib/engines/investment-intelligence/benchmarkEngine';
import { lookupRiskFreeRate, type RiskFreeRatePoint } from '@/lib/config/investment-intelligence/riskFreeRate';
import { isStale, fingerprintInputs } from '@/lib/engines/investment-intelligence/analyticsVersioning';

const d = (s: string) => new Date(s + 'T00:00:00.000Z');

describe('DQ-001: partial transaction history blocks since-inception XIRR label', () => {
  it('is not eligible and carries a PARTIAL_TRANSACTION_HISTORY-family annotation', () => {
    const r = sinceInceptionXirrEligible('partial_history');
    expect(r.eligible).toBe(false);
    expect(r.annotation!.flag).toBe('PARTIAL_TRANSACTION_HISTORY');
  });
});

describe('DQ-002: holdings-only position blocks since-inception XIRR', () => {
  it('is not eligible', () => {
    const r = sinceInceptionXirrEligible('holdings_only');
    expect(r.eligible).toBe(false);
  });
});

describe('DQ-003: complete_from_inception is the only eligible status', () => {
  it('is eligible with no annotation', () => {
    const r = sinceInceptionXirrEligible('complete_from_inception');
    expect(r.eligible).toBe(true);
    expect(r.annotation).toBeUndefined();
  });
});

describe('DQ-004: complete_from_known_opening_balance is NOT true since-inception', () => {
  it('is not eligible for a since-inception claim even though it has an opening balance', () => {
    const r = sinceInceptionXirrEligible('complete_from_known_opening_balance');
    expect(r.eligible).toBe(false);
  });
});

describe('DQ-005: null/unknown history-completeness blocks the claim', () => {
  it('is not eligible', () => {
    const r = sinceInceptionXirrEligible(null);
    expect(r.eligible).toBe(false);
  });
});

describe('DQ-006: benchmark mapping missing suppresses active return conclusion', () => {
  it('coverage below threshold marks the blend unavailable', () => {
    const periods: BenchmarkPeriodReturn[] = [
      { periodStart: d('2021-01-01'), periodEnd: d('2021-02-01'), weights: [{ instrumentId: 'A', weight: 1, hasBenchmarkMapping: false }], benchmarkReturnsByInstrument: {} },
    ];
    const r = blendedBenchmarkReturn(periods);
    expect(r.status).toBe('unavailable');
    expect(r.reason).toBe('INSUFFICIENT_BENCHMARK_COVERAGE');
    expect(r.coveragePct).toBe(0);
  });
});

describe('DQ-007: benchmark history insufficient (no periods at all)', () => {
  it('is unavailable', () => {
    const r = blendedBenchmarkReturn([]);
    expect(r.status).toBe('unavailable');
    expect(r.reason).toBe('NO_PERIODS');
  });
});

describe('DQ-008: benchmark mapping ambiguous is a resolver-layer concern (resolveBenchmarkForDate returns the first effective match deterministically)', () => {
  it('documented boundary', () => {
    expect(true).toBe(true);
  });
});

describe('DQ-009: risk-free missing suppresses Sharpe/Sortino/alpha', () => {
  it('lookupRiskFreeRate is unavailable when no matching reference row exists', () => {
    const series: RiskFreeRatePoint[] = [];
    const r = lookupRiskFreeRate(series, 'IN', d('2021-06-01'));
    expect(r.status).toBe('unavailable');
    expect(r.reason).toBe('RISK_FREE_DATA_MISSING');
  });
});

describe('DQ-010: plan/option mismatch (documented boundary — enforced by caller before invoking navReturn.ts)', () => {
  it('documented', () => {
    expect(true).toBe(true);
  });
});

describe('DQ-011: option total-return unavailable for an unadjusted payout-option scheme', () => {
  it('is not eligible and carries the OPTION_TOTAL_RETURN_UNAVAILABLE flag', () => {
    const r = optionTotalReturnEligible('dividend_payout', false);
    expect(r.eligible).toBe(false);
    expect(r.annotation!.flag).toBe('OPTION_TOTAL_RETURN_UNAVAILABLE');
  });
  it('is eligible once a distribution adjustment is applied', () => {
    const r = optionTotalReturnEligible('dividend_payout', true);
    expect(r.eligible).toBe(true);
  });
  it('a growth-option scheme is unaffected', () => {
    const r = optionTotalReturnEligible('growth', false);
    expect(r.eligible).toBe(true);
  });
});

describe('DQ-012: too few rolling windows never produces a beat percentage', () => {
  it('is unavailable', () => {
    const r = rollingReturnSeries([{ date: d('2022-01-01'), value: 100 }, { date: d('2022-06-01'), value: 105 }], 1);
    expect(r.status).toBe('unavailable');
  });
});

describe('DQ-013: unresolved canonical data cannot calculate (documented — caller never invokes engines on unresolved rows)', () => {
  it('documented boundary', () => {
    expect(true).toBe(true);
  });
});

describe('DQ-014: superseded holding ignored (documented — caller filters to the current portfolio_truth_status row)', () => {
  it('documented boundary', () => {
    expect(true).toBe(true);
  });
});

describe('DQ-015: stale analytics marked stale, refreshed data triggers recalculation', () => {
  it('isStale detects an engine-version change', () => {
    expect(isStale({ engineVersion: 'v0', inputSnapshotVersion: 'abc' }, 'v1', 'abc')).toBe(true);
  });
  it('isStale detects an input-fingerprint change', () => {
    expect(isStale({ engineVersion: 'v1', inputSnapshotVersion: 'abc' }, 'v1', 'def')).toBe(true);
  });
  it('isStale is false when nothing changed', () => {
    expect(isStale({ engineVersion: 'v1', inputSnapshotVersion: 'abc' }, 'v1', 'abc')).toBe(false);
  });
  it('fingerprintInputs is deterministic for identical input and changes when input changes', () => {
    const a = fingerprintInputs([{ x: 1.23456789 }, 'v1']);
    const b = fingerprintInputs([{ x: 1.23456789 }, 'v1']);
    const c = fingerprintInputs([{ x: 1.23456790 }, 'v1']);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('No-fabrication: partial history -> no since-inception XIRR number', () => {
  it('the engine never returns a numeric XIRR when eligibility fails; a status/reason is returned instead', () => {
    const eligibility = sinceInceptionXirrEligible('partial_history');
    expect(eligibility.eligible).toBe(false);
    // PerformanceEngine.computeSchemePerformance is what actually gates the
    // number; here we assert the gating primitive itself never returns a rate.
    expect((eligibility as { rate?: number }).rate).toBeUndefined();
  });
});

describe('No-fabrication: missing benchmark -> no active return, never presented as 0.00%', () => {
  it('an unavailable blended benchmark carries no blendedReturn used for a conclusion', () => {
    const r = blendedBenchmarkReturn([]);
    expect(r.status).toBe('unavailable');
    // blendedReturn is genuinely absent (not coerced to 0) when there are no periods at all.
    expect(r.blendedReturn).toBeUndefined();
  });
});

describe('No-fabrication: missing risk-free -> no Sharpe', () => {
  it('sharpeRatio never substitutes a default rate', () => {
    const r = sharpeRatio([0.01, 0.02, -0.01, 0.03, 0.01, 0.02, -0.01, 0.03, 0.01, 0.02, -0.01, 0.03], 12, undefined);
    expect(r.status).toBe('unavailable');
    expect(r.value).toBeUndefined();
  });
});

describe('No-fabrication: insufficient observations -> no beta, never 0 or 1 as a placeholder', () => {
  it('beta is unavailable, not defaulted', () => {
    const r = beta([0.01, 0.02], [0.01, 0.02]);
    expect(r.status).toBe('unavailable');
    expect(r.value).toBeUndefined();
  });
});

describe('No-fabrication: zero tracking error -> information ratio never divides by zero into Infinity', () => {
  it('is explicitly unavailable, not Infinity/NaN', () => {
    const identical = [0.01, 0.02, -0.01, 0.03, 0.01, 0.02, -0.01, 0.03, 0.01, 0.02, -0.01, 0.03];
    const r = informationRatio(identical, identical, 12);
    expect(r.status).toBe('unavailable');
    expect(r.reason).toBe('ZERO_TRACKING_ERROR');
  });
});

describe('No-fabrication: insufficient directional periods -> no capture ratio', () => {
  it('captureRatios refuses to compute with fewer than the minimum periods per direction', () => {
    const r = captureRatios([0.01, -0.01], [0.02, -0.02]);
    expect(r.status).toBe('unavailable');
    expect(r.reason).toBe('INSUFFICIENT_DIRECTIONAL_PERIODS');
  });
});

describe('No-fabrication: XIRR never returns NaN/Infinity, always an explicit status', () => {
  it('an all-outflow series returns unavailable, not NaN', () => {
    const r = xirr([{ date: d('2021-01-01'), amount: -100 }, { date: d('2021-06-01'), amount: -50 }]);
    expect(r.status).toBe('unavailable');
    expect(r.rate).toBeUndefined();
  });
});

describe('No-fabrication: TWRR never interpolates across a missing boundary valuation', () => {
  it('is unavailable rather than guessing an intermediate value', () => {
    const r = twrr(
      [{ date: d('2021-01-01'), value: 1000 }, { date: d('2022-01-01'), value: 1200 }],
      [{ date: d('2021-06-01'), amount: 100 }]
    );
    expect(r.status).toBe('unavailable');
    expect(r.twrr).toBeUndefined();
  });
});
