// R4 — Mathematical identity tests (spec section 87). These validate the
// engines WITHOUT any hand-typed expected percentage — the assertion is a
// structural mathematical property that must hold regardless of the
// specific numbers involved.
import { describe, it, expect } from 'vitest';
import { xirr } from '@/lib/engines/investment-intelligence/xirr';
import { pointToPointReturn } from '@/lib/engines/investment-intelligence/navReturn';
import { volatility, maxDrawdown, beta, trackingError, regressionAlpha } from '@/lib/engines/investment-intelligence/riskMetrics';
import { activeReturn } from '@/lib/engines/investment-intelligence/benchmarkEngine';

const d = (s: string) => new Date(s + 'T00:00:00.000Z');

describe('Identity A: a single investment and a single redemption -> XIRR equals the annualised point-to-point return', () => {
  it('holds for an arbitrary start and end value', () => {
    const start = d('2020-01-01');
    const end = d('2021-09-01');
    const x = xirr([
      { date: start, amount: -1000 },
      { date: end, amount: 1300 },
    ]);
    const p2p = pointToPointReturn(1000, start, 1300, end);
    expect(x.status).toBe('ok');
    expect(p2p.status).toBe('ok');
    const years = (end.getTime() - start.getTime()) / (365 * 86_400_000);
    expect(x.rate).toBeCloseTo(Math.pow(1 + p2p.pointToPointReturn!, 1 / years) - 1, 6);
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
    const ar = activeReturn(compoundedFund, compoundedBench, 'POINT_TO_POINT');
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
    const schemeCagr = 0.0734;
    const benchmarkCagr = 0.0734;
    const ar = activeReturn(schemeCagr, benchmarkCagr, 'CAGR');
    expect(ar.status).toBe('ok');
    expect(ar.activeReturn).toBe(0);
  });
});
