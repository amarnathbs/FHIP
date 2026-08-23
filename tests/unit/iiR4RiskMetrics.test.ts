// R4 — RISK-001..020 (spec section 86).
import { describe, it, expect } from 'vitest';
import {
  volatility,
  downsideDeviation,
  maxDrawdown,
  sharpeRatio,
  sortinoRatio,
  beta,
  regressionAlpha,
  trackingError,
  informationRatio,
  captureRatios,
  calmarRatio,
} from '@/lib/engines/investment-intelligence/riskMetrics';

const d = (s: string) => new Date(s + 'T00:00:00.000Z');

// 24 monthly observations, mildly noisy so variance/covariance are well-defined.
const fundReturns = [0.02, -0.01, 0.03, 0.015, -0.02, 0.04, 0.01, -0.005, 0.025, 0.03, -0.015, 0.02,
                      0.018, -0.008, 0.028, 0.012, -0.022, 0.038, 0.009, -0.004, 0.024, 0.031, -0.016, 0.021];
const benchReturns = [0.015, -0.008, 0.025, 0.01, -0.015, 0.03, 0.008, -0.003, 0.02, 0.022, -0.01, 0.015,
                       0.014, -0.006, 0.021, 0.009, -0.017, 0.028, 0.007, -0.002, 0.018, 0.023, -0.011, 0.016];

describe('RISK-001: volatility (annualised, monthly, sample stdev)', () => {
  it('is a positive finite number for a real return series', () => {
    const r = volatility(fundReturns, 12);
    expect(r.status).toBe('ok');
    expect(r.value!.annualisedVolatility).toBeGreaterThan(0);
  });
  it('is unavailable for too few observations', () => {
    const r = volatility(fundReturns.slice(0, 5), 12);
    expect(r.status).toBe('unavailable');
    expect(r.reason).toBe('INSUFFICIENT_HISTORY');
  });
});

describe('RISK-002: downside deviation', () => {
  it('only penalises returns below the MAR (default 0)', () => {
    const r = downsideDeviation(fundReturns, 12);
    expect(r.status).toBe('ok');
    expect(r.value!.annualisedDownsideDeviation).toBeGreaterThan(0);
    expect(r.value!.marPerPeriod).toBe(0);
  });
});

describe('RISK-003: max drawdown', () => {
  it('finds the worst peak-to-trough decline', () => {
    const series = [
      { date: d('2021-01-01'), value: 100 },
      { date: d('2021-02-01'), value: 110 }, // new peak
      { date: d('2021-03-01'), value: 90 },  // trough: -18.18%
      { date: d('2021-04-01'), value: 95 },
      { date: d('2021-05-01'), value: 115 }, // recovery beyond old peak
    ];
    const r = maxDrawdown(series);
    expect(r.status).toBe('ok');
    expect(r.value!.maxDrawdown).toBeCloseTo(90 / 110 - 1, 9);
    expect(r.value!.peakValue).toBe(110);
    expect(r.value!.troughValue).toBe(90);
    expect(r.value!.recoveryDate).toEqual(d('2021-05-01'));
  });
});

describe('RISK-004: drawdown recovery', () => {
  it('is null when the series has not recovered to the prior peak by the end', () => {
    const series = [
      { date: d('2021-01-01'), value: 100 },
      { date: d('2021-02-01'), value: 80 },
      { date: d('2021-03-01'), value: 85 },
    ];
    const r = maxDrawdown(series);
    expect(r.status).toBe('ok');
    expect(r.value!.recoveryDate).toBeNull();
    expect(r.value!.recoveryDurationDays).toBeNull();
  });
});

describe('RISK-005: Sharpe ratio', () => {
  it('computes a finite Sharpe with a supplied risk-free rate', () => {
    const r = sharpeRatio(fundReturns, 12, 0.06);
    expect(r.status).toBe('ok');
    expect(Number.isFinite(r.value!.sharpe)).toBe(true);
  });
  it('is unavailable without a risk-free rate (never fabricated)', () => {
    const r = sharpeRatio(fundReturns, 12, undefined);
    expect(r.status).toBe('unavailable');
    expect(r.reason).toBe('MISSING_RISK_FREE_DATA');
  });
});

describe('RISK-006: Sortino ratio', () => {
  it('computes a finite Sortino using downside deviation, not ordinary volatility', () => {
    const r = sortinoRatio(fundReturns, 12, 0.06);
    expect(r.status).toBe('ok');
    expect(Number.isFinite(r.value!.sortino)).toBe(true);
  });
});

describe('RISK-007: beta ~= 1 (fund tracks benchmark closely)', () => {
  it('a fund identical to the benchmark has beta very close to 1', () => {
    const r = beta(benchReturns, benchReturns);
    expect(r.status).toBe('ok');
    expect(r.value!.beta).toBeCloseTo(1, 9);
  });
});

describe('RISK-008: beta < 1 (defensive fund)', () => {
  it('a fund with half the benchmark\'s moves has beta ~ 0.5', () => {
    const halfBenchReturns = benchReturns.map((r) => r * 0.5);
    const r = beta(halfBenchReturns, benchReturns);
    expect(r.status).toBe('ok');
    expect(r.value!.beta).toBeCloseTo(0.5, 6);
  });
});

describe('RISK-009: beta > 1 (leveraged/aggressive fund)', () => {
  it('a fund with 1.5x the benchmark\'s moves has beta ~ 1.5', () => {
    const leveraged = benchReturns.map((r) => r * 1.5);
    const r = beta(leveraged, benchReturns);
    expect(r.status).toBe('ok');
    expect(r.value!.beta).toBeCloseTo(1.5, 6);
  });
});

describe('RISK-010: negative-beta synthetic series', () => {
  it('a fund that moves opposite to the benchmark has negative beta', () => {
    const inverse = benchReturns.map((r) => -1 * r);
    const r = beta(inverse, benchReturns);
    expect(r.status).toBe('ok');
    expect(r.value!.beta).toBeCloseTo(-1, 6);
  });
});

describe('RISK-011: regression alpha (never fund_return - benchmark_return)', () => {
  it('an index-identical fund has alpha ~ 0', () => {
    const r = regressionAlpha(benchReturns, benchReturns, 12, 0.06);
    expect(r.status).toBe('ok');
    expect(r.value!.alphaAnnualised).toBeCloseTo(0, 6);
    expect(r.value!.betaUsed).toBeCloseTo(1, 9);
  });
});

describe('RISK-012: tracking error', () => {
  it('is 0 for an index-identical fund', () => {
    const r = trackingError(benchReturns, benchReturns, 12);
    expect(r.status).toBe('ok');
    expect(r.value!.trackingError).toBeCloseTo(0, 9);
  });
  it('is positive for a genuinely different fund series', () => {
    const r = trackingError(fundReturns, benchReturns, 12);
    expect(r.status).toBe('ok');
    expect(r.value!.trackingError).toBeGreaterThan(0);
  });
});

describe('RISK-013: information ratio', () => {
  it('is unavailable (zero tracking error) for an index-identical fund', () => {
    const r = informationRatio(benchReturns, benchReturns, 12);
    expect(r.status).toBe('unavailable');
    expect(r.reason).toBe('ZERO_TRACKING_ERROR');
  });
  it('is finite for a genuinely active fund', () => {
    const r = informationRatio(fundReturns, benchReturns, 12);
    expect(r.status).toBe('ok');
    expect(Number.isFinite(r.value!.informationRatio)).toBe(true);
  });
});

describe('RISK-014: upside capture', () => {
  it('a fund earning exactly double the benchmark in every up period has ~200% upside capture', () => {
    const doubled = benchReturns.map((r) => (r > 0 ? r * 2 : r));
    const r = captureRatios(doubled, benchReturns);
    expect(r.status).toBe('ok');
    expect(r.value!.upsideCapture!).toBeGreaterThan(1.5);
  });
});

describe('RISK-015: downside capture', () => {
  it('a fund earning half the benchmark decline in every down period has ~50% downside capture', () => {
    const halved = benchReturns.map((r) => (r < 0 ? r * 0.5 : r));
    const r = captureRatios(halved, benchReturns);
    expect(r.status).toBe('ok');
    expect(r.value!.downsideCapture!).toBeGreaterThan(0);
    expect(r.value!.downsideCapture!).toBeLessThan(1);
  });
});

describe('RISK-016: zero volatility', () => {
  it('a perfectly flat return series triggers ZERO_VOLATILITY for Sharpe', () => {
    const flat = new Array(15).fill(0.01);
    const r = sharpeRatio(flat, 12, 0.06);
    expect(r.status).toBe('unavailable');
    expect(r.reason).toBe('ZERO_VOLATILITY');
  });
});

describe('RISK-017: zero benchmark variance', () => {
  it('a flat benchmark makes beta unavailable (ZERO_BENCHMARK_VARIANCE)', () => {
    const flatBench = new Array(15).fill(0.01);
    const r = beta(fundReturns.slice(0, 15), flatBench);
    expect(r.status).toBe('unavailable');
    expect(r.reason).toBe('ZERO_BENCHMARK_VARIANCE');
  });
});

describe('RISK-018: insufficient observations', () => {
  it('beta refuses fewer than the configured minimum', () => {
    const r = beta(fundReturns.slice(0, 3), benchReturns.slice(0, 3));
    expect(r.status).toBe('unavailable');
    expect(r.reason).toBe('INSUFFICIENT_HISTORY');
  });
});

describe('RISK-019: missing risk-free data', () => {
  it('Sortino is unavailable without a target/risk-free rate', () => {
    const r = sortinoRatio(fundReturns, 12, undefined);
    expect(r.status).toBe('unavailable');
    expect(r.reason).toBe('MISSING_RISK_FREE_DATA');
  });
});

describe('RISK-020: Calmar ratio', () => {
  it('computes Annualised Return / |Max Drawdown| with sufficient history', () => {
    const dd = maxDrawdown([
      { date: d('2019-01-01'), value: 100 },
      { date: d('2019-06-01'), value: 120 },
      { date: d('2019-12-01'), value: 90 },
      { date: d('2020-06-01'), value: 130 },
    ]);
    expect(dd.status).toBe('ok');
    const r = calmarRatio(0.1, dd.value!, 400);
    expect(r.status).toBe('ok');
    expect(r.value!.calmar).toBeCloseTo(0.1 / Math.abs(dd.value!.maxDrawdown), 9);
  });
  it('is unavailable for zero drawdown', () => {
    const flatSeries = [{ date: d('2021-01-01'), value: 100 }, { date: d('2022-01-01'), value: 110 }];
    const dd = maxDrawdown(flatSeries);
    const r = calmarRatio(0.1, dd.value!, 400);
    expect(r.status).toBe('unavailable');
    expect(r.reason).toBe('ZERO_DRAWDOWN');
  });
  it('is unavailable for insufficient history (<1Y)', () => {
    const dd = maxDrawdown([{ date: d('2021-01-01'), value: 100 }, { date: d('2021-03-01'), value: 90 }]);
    const r = calmarRatio(0.1, dd.value!, 60);
    expect(r.status).toBe('unavailable');
    expect(r.reason).toBe('INSUFFICIENT_HISTORY');
  });
});
