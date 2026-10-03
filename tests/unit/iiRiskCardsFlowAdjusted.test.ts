/**
 * Portfolio risk cards run on a FLOW-ADJUSTED INDEX, not on raw money value
 * (PO decision 2026-10-03, option A).
 *
 * Cards covered: maximum drawdown, the drawdown series / peak-to-date, volatility,
 * downside deviation, beta, tracking error, Calmar, the rolling-return windows and
 * the "beat benchmark" share, and the growth-of-100 line. The portfolio TOTAL VALUE
 * stays money value. Users still see XIRR only; the index is internal.
 *
 * ORACLE. Every expected figure below is computed in this file from first
 * principles on the observation dates (end-of-day flows): r_i = (V_i - C_i)/V_{i-1} - 1,
 * chained from 100; sample standard deviation x sqrt(12); peak-to-date drawdown. No
 * engine arithmetic is reused.
 *
 * NEGATIVE CONTROLS. A faithful copy of the previous computation (periodic returns
 * and drawdown taken straight from the raw money value series) is run through the
 * SAME assertion helpers and MUST fail them: a deposit changes its volatility and a
 * redemption creates a drawdown.
 */
import { describe, it, expect } from 'vitest';
import { runAnalytics, type AnalyticsDataset, type SchemeDataset } from '@/lib/engines/investment-intelligence/analyticsOrchestrator';
import { buildFlowAdjustedIndex, portfolioContributionFlows } from '@/lib/engines/investment-intelligence/flowAdjustedIndexSeries';
import type { BenchmarkMapping } from '@/lib/engines/investment-intelligence/benchmarkEngine';

const d = (s: string) => new Date(s + 'T00:00:00.000Z');
const iso = (x: Date) => x.toISOString().slice(0, 10);
type Pt = { date: Date; value: number };

const monthEnd = (k: number) => new Date(Date.UTC(2020, k + 1, 0)); // k=0 -> 2020-01-31
const dateAt = (k: number) => monthEnd(k);

// ---------------------------------------------------------------- oracle
const sampleSd = (xs: number[]) => {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
};
const retsFromLevels = (lv: number[]) => lv.slice(1).map((v, i) => v / lv[i] - 1);
/** Oracle: flow-adjusted index at observation dates, flows at the end of the day of the observation. */
function oracleIndex(values: number[], contributionAt: number[]): number[] {
  const out = [100];
  for (let i = 1; i < values.length; i++) {
    const r = values[i - 1] > 0 ? (values[i] - (contributionAt[i] ?? 0)) / values[i - 1] - 1 : 0;
    out.push(out[i - 1] * (1 + r));
  }
  return out;
}
function oracleDrawdowns(levels: number[]): number[] {
  let peak = -Infinity;
  return levels.map((v) => ((peak = Math.max(peak, v)), v / peak - 1));
}
const oracleVol = (levels: number[]) => sampleSd(retsFromLevels(levels)) * Math.sqrt(12);
const minOf = (xs: number[]) => Math.min(...xs);

// ---------------------------------------------------------------- fixtures
function scheme(id: string, points: Pt[], realFlows: Array<{ date: Date; amount: number }>, currentValue: number, currentValueDate: Date): SchemeDataset {
  return {
    instrumentId: id, instrumentName: id, currencyCode: 'INR', countryOfDomicile: 'IN',
    historyCompleteness: 'complete_from_inception', optionType: null, hasDistributionAdjustment: false,
    cashFlows: realFlows, externalCashFlows: realFlows, externalCashFlowsExcludingTerminal: realFlows,
    currentValue, currentValueDate, navSeries: [], valuationSeries: points,
  };
}
function dataset(schemes: SchemeDataset[], lastK: number, mappings: BenchmarkMapping[] = [], bench: Record<string, Pt[]> = {}): AnalyticsDataset {
  return {
    userId: 'u', asOfDate: dateAt(lastK), periodStart: dateAt(0), schemes, mappings, benchmarkSeriesById: bench,
    riskFreeSeries: [], navDataVersion: null, benchmarkDataVersion: null, benchmarkMappingVersion: null, frequency: 'monthly',
  };
}

const RISING = [0.012, 0.02, 0.008, 0.015, 0.011, 0.03, 0.007, 0.018, 0.022, 0.009, 0.014, 0.025, 0.01, 0.016, 0.013, 0.019, 0.006, 0.021, 0.017, 0.012, 0.024, 0.01, 0.015, 0.02]; // 24 months, all up
const MIXED = [0.03, -0.04, 0.02, 0.05, -0.02, 0.01, -0.06, 0.04, 0.03, -0.01, 0.02, 0.05, -0.03, 0.02, 0.01, -0.05, 0.06, 0.02, -0.02, 0.04, 0.01, -0.03, 0.05, 0.02];

/** One fund, monthly returns R, an optional deposit (money in) at observation k. */
function singleFundWithDeposit(R: number[], depositAt: number | null, deposit: number) {
  const values = [1000];
  const contrib = [0];
  for (let k = 1; k <= R.length; k++) {
    const dep = depositAt === k ? deposit : 0;
    values.push(values[k - 1] * (1 + R[k - 1]) + dep);
    contrib.push(dep);
  }
  const points = values.map((v, k) => ({ date: dateAt(k), value: v }));
  const flows = [{ date: dateAt(0), amount: -1000 }, ...(depositAt ? [{ date: dateAt(depositAt), amount: -deposit }] : [])];
  return { values, contrib, ds: dataset([scheme('f', points, flows, values[values.length - 1], dateAt(R.length))], R.length) };
}

// -------- the computations under test, as adapters (engine) and legacy copies
interface Cards { vol: number; maxDd: number; drawdowns: number[] }
function engineCards(ds: AnalyticsDataset): Cards {
  const p = runAnalytics(ds).portfolios[0];
  return { vol: p.risk.volatility.value!.annualisedVolatility, maxDd: p.risk.maxDrawdown.value!.maxDrawdown, drawdowns: p.drawdownSeries.map((x) => x.drawdown) };
}
/** FAITHFUL COPY of the previous behaviour: returns and drawdown straight from the raw money value series. */
function legacyCards(values: number[]): Cards {
  const dd = oracleDrawdowns(values);
  return { vol: sampleSd(retsFromLevels(values)) * Math.sqrt(12), maxDd: minOf(dd), drawdowns: dd };
}

function assertDepositNeutral(withDeposit: Cards, withoutDeposit: Cards) {
  if (Math.abs(withDeposit.vol - withoutDeposit.vol) > 1e-9) throw new Error(`volatility moved: ${withDeposit.vol} vs ${withoutDeposit.vol}`);
  if (Math.abs(withDeposit.maxDd - withoutDeposit.maxDd) > 1e-9) throw new Error('max drawdown moved');
}
function assertNoDrawdown(c: Cards) {
  if (c.maxDd < -1e-12) throw new Error(`max drawdown ${c.maxDd}`);
  if (c.drawdowns.some((x) => x < -1e-12)) throw new Error('drawdown series dips');
}

// ================================================================ (a)
describe('(a) a pure deposit changes nothing', () => {
  const base = singleFundWithDeposit(MIXED, null, 0);
  const dep = singleFundWithDeposit(MIXED, 12, 5000);
  const baseRising = singleFundWithDeposit(RISING, null, 0);
  const depRising = singleFundWithDeposit(RISING, 12, 5000);

  it('volatility and max drawdown with a deposit equal the same returns without it, and equal the oracle', () => {
    const a = engineCards(dep.ds);
    const b = engineCards(base.ds);
    expect(() => assertDepositNeutral(a, b)).not.toThrow();
    expect(a.vol).toBeCloseTo(sampleSd(MIXED) * Math.sqrt(12), 9);
    expect(a.maxDd).toBeCloseTo(minOf(oracleDrawdowns(oracleIndex(dep.values, dep.contrib))), 9);
  });

  it('a deposit into an always-rising portfolio gives a drawdown of exactly 0 on every date', () => {
    const c = engineCards(depRising.ds);
    expect(() => assertNoDrawdown(c)).not.toThrow();
    expect(c.drawdowns.every((x) => x === 0)).toBe(true);
    expect(engineCards(baseRising.ds).vol).toBeCloseTo(c.vol, 9);
  });

  it('growth-of-100 is unmoved by the deposit: same line as without it, and equal to the oracle index', () => {
    const line = (ds: AnalyticsDataset) => runAnalytics(ds).portfolios[0].performanceVsBenchmarkSeries.map((x) => x.portfolio);
    const withDep = line(dep.ds);
    const without = line(base.ds);
    expect(withDep).toHaveLength(without.length);
    withDep.forEach((v, i) => expect(v).toBeCloseTo(without[i], 6));
    const oracle = oracleIndex(dep.values, dep.contrib);
    withDep.forEach((v, i) => expect(v, `obs ${i}`).toBeCloseTo(oracle[i], 6));
    expect(withDep[0]).toBe(100);
  });

  it('the header total stays MONEY value (the deposit is in it)', () => {
    expect(runAnalytics(dep.ds).portfolios[0].totalValue).toBeCloseTo(dep.values[dep.values.length - 1], 6);
    expect(runAnalytics(dep.ds).portfolios[0].totalValue).toBeGreaterThan(runAnalytics(base.ds).portfolios[0].totalValue + 4000);
  });

  it('NEGATIVE CONTROL: the raw-value computation FAILS the deposit-neutrality assertion', () => {
    expect(() => assertDepositNeutral(legacyCards(dep.values), legacyCards(base.values))).toThrow(/volatility moved/);
  });
});

// ================================================================ (b)
describe('(b) a partial and a full redemption create no drawdown', () => {
  // Fund A: rising, with a partial redemption of 3,000 at observation 10.
  // Fund B: rising, redeemed IN FULL at observation 15 (explicit closing zero).
  const N = 24;
  const aVals = [4000];
  const aContrib = [0];
  for (let k = 1; k <= N; k++) {
    const red = k === 10 ? 3000 : 0;
    aVals.push(aVals[k - 1] * (1 + RISING[k - 1]) - red);
    aContrib.push(-red);
  }
  const bGrow: number[] = [2500];
  for (let k = 1; k <= 14; k++) bGrow.push(bGrow[k - 1] * (1 + RISING[k - 1] * 1.5));
  const bPre15 = bGrow[14] * (1 + RISING[14] * 1.5);
  const bVals = [...bGrow, 0]; // observations 0..15, zero at 15
  const aPoints = aVals.map((v, k) => ({ date: dateAt(k), value: v }));
  const bPoints = bVals.map((v, k) => ({ date: dateAt(k), value: v }));
  const ds = dataset(
    [
      scheme('A', aPoints, [{ date: dateAt(0), amount: -4000 }, { date: dateAt(10), amount: 3000 }], aVals[N], dateAt(N)),
      scheme('B', bPoints, [{ date: dateAt(0), amount: -2500 }, { date: dateAt(15), amount: bPre15 }], 0, dateAt(15)),
    ],
    N
  );
  // portfolio money value and contributions at each observation
  const total = aVals.map((v, k) => v + (k < bVals.length ? bVals[k] : 0));
  const contrib = aContrib.map((c, k) => c + (k === 15 ? -bPre15 : 0));

  it('the drawdown series is 0 everywhere and max drawdown is 0', () => {
    const c = engineCards(ds);
    expect(() => assertNoDrawdown(c)).not.toThrow();
    expect(c.drawdowns.every((x) => Math.abs(x) < 1e-12)).toBe(true);
  });

  it('volatility and the growth-of-100 line equal the oracle index', () => {
    const oracle = oracleIndex(total, contrib);
    expect(minOf(oracleDrawdowns(oracle))).toBeCloseTo(0, 12);
    const p = runAnalytics(ds).portfolios[0];
    expect(p.risk.volatility.value!.annualisedVolatility).toBeCloseTo(oracleVol(oracle), 9);
    p.performanceVsBenchmarkSeries.forEach((x, i) => expect(x.portfolio, iso(d(x.date))).toBeCloseTo(oracle[i], 6));
  });

  it('the header total is money value and carries no phantom of the redeemed fund', () => {
    expect(runAnalytics(ds).portfolios[0].totalValue).toBeCloseTo(aVals[N], 6);
  });

  it('NEGATIVE CONTROL: the raw-value computation FAILS the no-drawdown assertion (redemptions looked like losses)', () => {
    const legacy = legacyCards(total);
    expect(legacy.maxDd).toBeLessThan(-0.3);
    expect(() => assertNoDrawdown(legacy)).toThrow(/max drawdown/);
  });
});

// ================================================================ (c) probe shape
describe('(c) probe shape: open fund + fund redeemed in full on 15-07-2021, 36 months, redeemed fund benchmark +5%/month', () => {
  const MONTHS: Date[] = [];
  for (let i = 0; i < 36; i++) MONTHS.push(new Date(Date.UTC(2020, i + 1, 0)));
  const EXIT = d('2021-07-15');
  const openSeries: Pt[] = MONTHS.map((date, i) => ({ date, value: Math.round(1000 * Math.pow(1.01, i) * 100) / 100 }));
  const redRaw: Pt[] = MONTHS.filter((m) => m <= d('2021-06-30')).map((date, i) => ({ date, value: Math.round(2000 * Math.pow(1.05, i) * 100) / 100 }));
  const redLast = redRaw[redRaw.length - 1].value;
  const openLast = openSeries[openSeries.length - 1].value;
  const bench = (g: number): Pt[] => {
    let l = 100;
    return MONTHS.map((date) => {
      const p = { date, value: l };
      l *= 1 + g;
      return p;
    });
  };
  const map = (i: string, b: string): BenchmarkMapping => ({ instrumentId: i, benchmarkId: b, benchmarkKey: b, returnType: 'TRI', effectiveFrom: d('2019-01-01'), effectiveTo: null });
  const openFlows = [{ date: d('2020-01-31'), amount: -1000 }];
  const redFlows = [{ date: d('2020-01-31'), amount: -2000 }, { date: EXIT, amount: redLast }];
  const ds: AnalyticsDataset = {
    userId: 'u', asOfDate: d('2022-12-31'), periodStart: d('2020-01-31'),
    schemes: [
      scheme('open-fund', openSeries, openFlows, openLast, d('2022-12-31')),
      scheme('redeemed-fund', redRaw, redFlows, 0, EXIT),
    ],
    mappings: [map('open-fund', 'b-open'), map('redeemed-fund', 'b-red')],
    benchmarkSeriesById: { 'b-open': bench(0.01), 'b-red': bench(0.05) },
    riskFreeSeries: [], navDataVersion: null, benchmarkDataVersion: null, benchmarkMappingVersion: null, frequency: 'monthly',
  };
  const p = runAnalytics(ds).portfolios[0];

  // independent oracle on the month-end grid (the exit date is also an observation)
  const valAt = (pts: Pt[], date: Date) => {
    let b: Pt | undefined;
    for (const x of pts) if (x.date <= date && (!b || x.date > b.date)) b = x;
    return b ? b.value : 0;
  };
  const redAt = (date: Date) => (date >= EXIT ? 0 : valAt(redRaw, date));
  const grid = [...MONTHS, EXIT].sort((a, b) => a.getTime() - b.getTime());
  const vals = grid.map((g) => valAt(openSeries, g) + redAt(g));
  const contribs = grid.map((g) => (g.getTime() === EXIT.getTime() ? -redLast : 0));
  const idx = oracleIndex(vals, contribs);
  const monthEndIdx = MONTHS.map((m) => idx[grid.findIndex((g) => g.getTime() === m.getTime())]);
  const fundRets = retsFromLevels(monthEndIdx);
  // independent blended benchmark monthly returns (weights at period start; redeemed fund weight 0 from exit)
  const benchRets: number[] = [];
  for (let i = 0; i < MONTHS.length - 1; i++) {
    const a = MONTHS[i];
    const b = MONTHS[i + 1];
    const wo = valAt(openSeries, a);
    const wr = redAt(a);
    const ro = valAt(bench(0.01), b) / valAt(bench(0.01), a) - 1;
    const rr = valAt(bench(0.05), b) / valAt(bench(0.05), a) - 1;
    benchRets.push((wo * ro + wr * rr) / (wo + wr));
  }
  const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const cov = (x: number[], y: number[]) => {
    const mx = mean(x);
    const my = mean(y);
    return x.reduce((s, v, i) => s + (v - mx) * (y[i] - my), 0) / (x.length - 1);
  };

  it('max drawdown, drawdown series, growth-of-100 equal the oracle', () => {
    const dds = oracleDrawdowns(idx);
    expect(p.risk.maxDrawdown.value!.maxDrawdown).toBeCloseTo(minOf(oracleDrawdowns(idx)), 9);
    p.drawdownSeries.forEach((x, i) => expect(x.drawdown, x.date).toBeCloseTo(dds[i], 9));
    p.performanceVsBenchmarkSeries.forEach((x, i) => expect(x.portfolio, x.date).toBeCloseTo(idx[i], 6));
  });

  it('volatility, downside deviation and beta / tracking error equal the oracle', () => {
    expect(p.risk.volatility.value!.annualisedVolatility).toBeCloseTo(sampleSd(fundRets) * Math.sqrt(12), 9);
    expect(p.risk.beta.value!.beta).toBeCloseTo(cov(fundRets, benchRets) / cov(benchRets, benchRets), 9);
    expect(p.risk.trackingError.value!.trackingError).toBeCloseTo(sampleSd(fundRets.map((r, i) => r - benchRets[i])) * Math.sqrt(12), 9);
  });

  it('Calmar is undefined when the drawdown is 0 and equals annualised return / |max drawdown| otherwise', () => {
    const maxDd = minOf(oracleDrawdowns(idx));
    if (Math.abs(maxDd) < 1e-12) expect(p.risk.calmarRatio.status).not.toBe('CALCULATED');
    else {
      const days = (MONTHS[35].getTime() - d('2020-01-31').getTime()) / 86_400_000;
      expect(p.risk.calmarRatio.status).toBe('CALCULATED');
      expect(p.risk.calmarRatio.value!.calmar).toBeCloseTo((Math.pow(idx[idx.length - 1] / 100, 365.25 / days) - 1) / Math.abs(maxDd), 6);
    }
  });

  it('rolling 1-year windows and the beat-benchmark share equal the oracle', () => {
    const win = (lv: number[]) => lv.slice(12).map((v, i) => v / lv[i] - 1);
    const fundW = win(monthEndIdx);
    let bl = 100;
    const benchLv = [100, ...benchRets.map((r) => (bl *= 1 + r))];
    const benchW = win(benchLv);
    const h1 = p.rolling.horizons.find((h) => h.windowYears === 1)!;
    expect(h1.series.status).toBe('CALCULATED');
    expect(h1.series.value!.min).toBeCloseTo(minOf(fundW), 9);
    expect(h1.series.value!.max).toBeCloseTo(Math.max(...fundW), 9);
    expect(h1.beat.status).toBe('CALCULATED');
    expect(h1.beat.value!.beatPct).toBeCloseTo(fundW.filter((w, i) => w > benchW[i]).length / fundW.length, 9);
  });

  it('header total is money value (open fund only) and portfolio XIRR is untouched by this change', () => {
    expect(p.totalValue).toBeCloseTo(openLast, 6);
    expect(p.portfolioXirr.status).toBe('CALCULATED');
  });

  it('NEGATIVE CONTROL: the raw-value series shows a large drawdown for this shape, the index shows none caused by the redemption', () => {
    const raw = oracleDrawdowns(vals);
    expect(minOf(raw)).toBeLessThan(-0.5);
    expect(p.risk.maxDrawdown.value!.maxDrawdown).toBeGreaterThan(-0.05);
  });
});

// ================================================================ edge rules
describe('buildFlowAdjustedIndex edge rules', () => {
  const pts = (vs: number[]) => vs.map((v, k) => ({ date: dateAt(k), value: v }));

  it('first observation is base 100', () => {
    expect(buildFlowAdjustedIndex(pts([500, 550]), [])[0].value).toBe(100);
    expect(buildFlowAdjustedIndex([], [])).toEqual([]);
  });

  it('a flow on a NON-observation date uses a flow-weighted base: (1700-1000-500)/(1000+0.5x500) = 16%', () => {
    const a = d('2020-01-01');
    const b = d('2020-01-11');
    const out = buildFlowAdjustedIndex([{ date: a, value: 1000 }, { date: b, value: 1700 }], [{ date: d('2020-01-06'), contribution: 500 }]);
    expect(out[1].value).toBeCloseTo(116, 9);
  });

  it('several flows on the same day equal one flow of their sum', () => {
    const v = [{ date: dateAt(0), value: 1000 }, { date: dateAt(1), value: 2100 }];
    const split = buildFlowAdjustedIndex(v, [{ date: dateAt(1), contribution: 600 }, { date: dateAt(1), contribution: 400 }]);
    const one = buildFlowAdjustedIndex(v, [{ date: dateAt(1), contribution: 1000 }]);
    expect(split[1].value).toBeCloseTo(one[1].value, 12);
    expect(split[1].value).toBeCloseTo(110, 9);
  });

  it('redeemed in full, a zero gap, then re-bought: the index continues from its last pre-exit level and never divides by zero', () => {
    // 1000 -> 1100 (+10%) -> 0 (full redemption of 1100) -> 0 gap -> 2000 deposited -> 2200 (+10%)
    const v = pts([1000, 1100, 0, 0, 2000, 2200]);
    const flows = [
      { date: dateAt(2), contribution: -1100 },
      { date: dateAt(4), contribution: 2000 },
    ];
    const out = buildFlowAdjustedIndex(v, flows).map((x) => x.value);
    expect(out.every(Number.isFinite)).toBe(true);
    expect(out[1]).toBeCloseTo(110, 9);
    expect(out[2]).toBeCloseTo(110, 9); // the redemption is not a loss
    expect(out[3]).toBeCloseTo(110, 9); // zero gap: flat
    expect(out[4]).toBeCloseTo(110, 9); // a re-purchase is not a gain
    expect(out[5]).toBeCloseTo(121, 9); // +10% on the re-bought money continues from 110
  });

  it('a very small residual balance is not used as a base (no amplified rounding noise)', () => {
    const v = pts([1_000_000, 0.001, 5_000_000]);
    const flows = [{ date: dateAt(1), contribution: -999_999.999 }, { date: dateAt(2), contribution: 4_999_999 }];
    const out = buildFlowAdjustedIndex(v, flows).map((x) => x.value);
    expect(out[2]).toBeCloseTo(out[1], 9);
    expect(out.every((x) => x > 0 && Number.isFinite(x))).toBe(true);
  });

  it('flows on or before the first observation, or after the last, move nothing', () => {
    const v = pts([1000, 1100]);
    const withStray = buildFlowAdjustedIndex(v, [{ date: dateAt(0), contribution: 700 }, { date: new Date(dateAt(1).getTime() + 86_400_000), contribution: 900 }]);
    expect(withStray[1].value).toBeCloseTo(110, 9);
  });

  it('a scheme with units but no valuation series contributes neither value nor flows; one that starts being valued mid-history enters as a contribution, not a gain', () => {
    const noSeries = portfolioContributionFlows([{ series: [], realFlows: [{ date: dateAt(1), amount: -9999 }] }]);
    expect(noSeries).toEqual([]);
    // A is valued from obs 0; B first valued at obs 3 with value 1000 and a purchase on obs 2 (before its first point -> ignored)
    const a = [1000, 1010, 1020, 1030, 1040];
    const b = [0, 0, 0, 1000, 1010];
    const total = a.map((x, i) => x + b[i]);
    const flows = portfolioContributionFlows([
      { series: a.map((v, k) => ({ date: dateAt(k), value: v })), realFlows: [{ date: dateAt(0), amount: -1000 }] },
      { series: [3, 4].map((k) => ({ date: dateAt(k), value: b[k] })), realFlows: [{ date: dateAt(2), amount: -1000 }] },
    ]);
    const out = buildFlowAdjustedIndex(total.map((v, k) => ({ date: dateAt(k), value: v })), flows).map((x) => x.value);
    // B's arrival (1000) is a contribution at obs 3: index return at obs 3 equals A's own return (1030/1020 - 1)
    expect(out[3] / out[2] - 1).toBeCloseTo(1030 / 1020 - 1, 9);
  });

  it('missing benchmark: benchmark-based cards stay not available while own-value cards are produced', () => {
    const { ds } = singleFundWithDeposit(RISING, 12, 5000);
    const p = runAnalytics(ds).portfolios[0];
    expect(p.risk.volatility.status).toBe('CALCULATED');
    for (const o of [p.risk.beta, p.risk.trackingError, p.risk.informationRatio, p.risk.alpha, p.risk.captureRatios]) expect(o.status).not.toBe('CALCULATED');
    for (const h of p.rolling.horizons) expect(h.beat.status).not.toBe('CALCULATED');
    expect(p.blendedBenchmarkReturn.status).not.toBe('CALCULATED');
  });
});
