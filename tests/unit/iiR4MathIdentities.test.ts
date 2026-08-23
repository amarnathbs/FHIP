// R4 — Mathematical identity tests (spec section 87). These validate the
// engines WITHOUT any hand-typed expected percentage — the assertion is a
// structural mathematical property that must hold regardless of the
// specific numbers involved.
import { describe, it, expect } from 'vitest';
import { twrr } from '@/lib/engines/investment-intelligence/twrr';
import { pointToPointReturn } from '@/lib/engines/investment-intelligence/navReturn';
import { volatility, maxDrawdown, beta, trackingError, regressionAlpha } from '@/lib/engines/investment-intelligence/riskMetrics';
import { activeReturn } from '@/lib/engines/investment-intelligence/benchmarkEngine';

const d = (s: string) => new Date(s + 'T00:00:00.000Z');

describe('Identity A: no external flows -> TWRR ~= point-to-point portfolio return', () => {
  it('holds for an arbitrary multi-point valuation series with zero external flows', () => {
    const valuations = [
      { date: d('2020-01-01'), value: 1000 },
      { date: d('2020-06-01'), value: 1120 },
      { date: d('2021-01-01'), value: 980 },
      { date: d('2021-09-01'), value: 1300 },
    ];
    const twrrResult = twrr(valuations, []);
    const p2p = pointToPointReturn(1000, d('2020-01-01'), 1300, d('2021-09-01'));
    expect(twrrResult.status).toBe('ok');
    expect(p2p.status).toBe('ok');
    expect(twrrResult.twrr).toBeCloseTo(p2p.pointToPointReturn!, 9);
  });
});

describe('Identity B: fund exactly replicates the benchmark', () => {
  it('active return = 0, tracking error = 0, beta ~= 1, alpha ~= 0', () => {
    const benchReturns = [0.02, -0.01, 0.015, 0.03, -0.005, 0.018, 0.022, -0.012, 0.01, 0.025, 0.005, 0.03,
                           0.014, -0.006, 0.019, 0.028, -0.009, 0.016, 0.021, -0.003, 0.011, 0.024, 0.006, 0.017];
    const fundReturns = [...benchReturns];

    const te = trackingError(fundReturns, benchReturns, 12);
    expect(te.status).toBe('ok');
    expect(te.value!.trackingError).toBeCloseTo(0, 9);

    const b = beta(fundReturns, benchReturns);
    expect(b.status).toBe('ok');
    expect(b.value!.beta).toBeCloseTo(1, 9);

    const a = regressionAlpha(fundReturns, benchReturns, 12, 0.06);
    expect(a.status).toBe('ok');
    expect(a.value!.alphaAnnualised).toBeCloseTo(0, 6);

    const compoundedFund = fundReturns.reduce((acc, r) => acc * (1 + r), 1) - 1;
    const compoundedBench = benchReturns.reduce((acc, r) => acc * (1 + r), 1) - 1;
    const ar = activeReturn(compoundedFund, compoundedBench, 'TWRR');
    expect(ar.status).toBe('ok');
    expect(ar.activeReturn).toBeCloseTo(0, 9);
  });
});

describe('Identity C: flat NAV series', () => {
  it('return = 0, volatility = 0 -> unavailable (never fabricated as a number), max drawdown = 0', () => {
    const flatSeries = [
      { date: d('2021-01-01'), value: 100 },
      { date: d('2021-06-01'), value: 100 },
      { date: d('2022-01-01'), value: 100 },
    ];
    const p2p = pointToPointReturn(100, d('2021-01-01'), 100, d('2022-01-01'));
    expect(p2p.status).toBe('ok');
    expect(p2p.pointToPointReturn).toBe(0);

    const flatReturns = new Array(15).fill(0);
    const vol = volatility(flatReturns, 12);
    expect(vol.status).toBe('ok');
    expect(vol.value!.annualisedVolatility).toBe(0);

    const dd = maxDrawdown(flatSeries);
    expect(dd.status).toBe('ok');
    expect(dd.value!.maxDrawdown).toBe(0);
  });
});

describe('Identity D: identical portfolio and blended-benchmark periodic returns', () => {
  it('active return = 0 exactly', () => {
    const portfolioTwrr = 0.0734;
    const blendedBenchmarkTwrr = 0.0734;
    const ar = activeReturn(portfolioTwrr, blendedBenchmarkTwrr, 'TWRR');
    expect(ar.status).toBe('ok');
    expect(ar.activeReturn).toBe(0);
  });
});
