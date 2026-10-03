/**
 * Redeemed-fund phantom value (PO decision 2026-10-03, follow-up to Document2 D-2).
 *
 * THE DEFECT. Every reader of a scheme's valuation series takes "the latest
 * point on or before the date". A fully redeemed scheme's series simply stopped
 * at its last pre-exit point (the unit-ledger reconstruction skipped zero-balance
 * dates), so that last value was carried forward for ever: a phantom position in
 * the Performance header total, the drawdown and growth-of-100 series, and the
 * benchmark blend weights. Probe shape: an open fund worth 1,500 and a fund
 * redeemed in full, last valued 1,190 before exit -> header total 2,690.
 *
 * THE FIX. (1) unitWeightedValuation writes an explicit 0 on the redemption date;
 * (2) analyticsOrchestrator.closeRedeemedSeries is the safety net for a series
 * that does not end on a zero (e.g. a lone pre-exit statement snapshot).
 *
 * ORACLE. Expected figures are computed in this file from first principles
 * (hand-built value-on-date function, hand-chained blend) -- no engine code for
 * the arithmetic under test.
 *
 * NEGATIVE CONTROLS: a faithful copy of the pre-fix aggregation (carry-forward,
 * zero dates skipped) is run on the same inputs and MUST disagree with the oracle
 * -- the 2,690 header total, a wrong blend, and a missing-zero series.
 */
import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  runAnalytics,
  closeRedeemedSeries,
  type AnalyticsDataset,
  type SchemeDataset,
} from '@/lib/engines/investment-intelligence/analyticsOrchestrator';
import { buildUnitWeightedValuationSeries } from '@/lib/services/investment-intelligence/unitWeightedValuation';
import { loadAnalyticsDataset } from '@/lib/services/investment-intelligence/analyticsRepository';
import type { BenchmarkMapping } from '@/lib/engines/investment-intelligence/benchmarkEngine';

const d = (s: string) => new Date(s + 'T00:00:00.000Z');
const iso = (x: Date) => x.toISOString().slice(0, 10);
type Pt = { date: Date; value: number };

const monthEnd = (y: number, m0: number) => new Date(Date.UTC(y, m0 + 1, 0));

/** Independent value-on-date: latest point on or before `date`, 0 if none. */
function oracleValueAt(points: Pt[], date: Date): number {
  let best: Pt | undefined;
  for (const p of points) if (p.date <= date && (!best || p.date > best.date)) best = p;
  return best ? best.value : 0;
}

// -------------------------------------------------------------------------
// Fixture: monthly series, 2020-01 .. 2022-12
// -------------------------------------------------------------------------
const MONTHS: Date[] = [];
for (let i = 0; i < 36; i++) MONTHS.push(monthEnd(2020, i));
const EXIT = d('2021-07-15'); // full redemption of the redeemed fund
const LAST_REDEEMED_POINT = d('2021-06-30'); // stale statement-style series stops here

const openSeries: Pt[] = MONTHS.map((date, i) => ({ date, value: Math.round(1000 * Math.pow(1.01, i) * 100) / 100 }));
const redeemedSeriesRaw: Pt[] = MONTHS.filter((m) => m <= LAST_REDEEMED_POINT).map((date, i) => ({ date, value: Math.round(2000 * Math.pow(1.05, i) * 100) / 100 }));
const openLast = openSeries[openSeries.length - 1].value;
const redeemedLast = redeemedSeriesRaw[redeemedSeriesRaw.length - 1].value;

const mapping = (instrumentId: string, benchmarkId: string): BenchmarkMapping => ({
  instrumentId,
  benchmarkId,
  benchmarkKey: benchmarkId,
  returnType: 'TRI',
  effectiveFrom: d('2019-01-01'),
  effectiveTo: null,
});

function bench(monthly: number): Pt[] {
  let level = 100;
  const out: Pt[] = [];
  for (const date of MONTHS) {
    out.push({ date, value: level });
    level *= 1 + monthly;
  }
  return out;
}

function openScheme(): SchemeDataset {
  const flows = [
    { date: d('2020-01-31'), amount: -1000 },
    { date: d('2022-12-31'), amount: openLast },
  ];
  return {
    instrumentId: 'open-fund', instrumentName: 'Open Fund', currencyCode: 'INR', countryOfDomicile: 'IN',
    historyCompleteness: 'complete_from_inception', optionType: null, hasDistributionAdjustment: false,
    cashFlows: flows, externalCashFlows: flows, externalCashFlowsExcludingTerminal: [flows[0]],
    currentValue: openLast, currentValueDate: d('2022-12-31'), navSeries: [], valuationSeries: openSeries,
  };
}

function redeemedScheme(series: Pt[] = redeemedSeriesRaw): SchemeDataset {
  const flows = [
    { date: d('2020-01-31'), amount: -2000 },
    { date: EXIT, amount: redeemedLast },
  ];
  return {
    instrumentId: 'redeemed-fund', instrumentName: 'Redeemed Fund', currencyCode: 'INR', countryOfDomicile: 'IN',
    historyCompleteness: 'complete_from_inception', optionType: null, hasDistributionAdjustment: false,
    cashFlows: flows, externalCashFlows: flows, externalCashFlowsExcludingTerminal: flows,
    currentValue: 0, currentValueDate: EXIT, navSeries: [], valuationSeries: series,
  };
}

function dataset(schemes: SchemeDataset[]): AnalyticsDataset {
  return {
    userId: 'u', asOfDate: d('2022-12-31'), periodStart: d('2020-01-31'), schemes,
    mappings: [mapping('open-fund', 'b-open'), mapping('redeemed-fund', 'b-red')],
    benchmarkSeriesById: { 'b-open': bench(0.01), 'b-red': bench(0.05) },
    riskFreeSeries: [], navDataVersion: null, benchmarkDataVersion: null, benchmarkMappingVersion: null, frequency: 'monthly',
  };
}

/** Oracle for what the redeemed fund is worth on a date: its series, and exactly 0 from the exit onward. */
const redeemedOracleAt = (date: Date) => (date >= EXIT ? 0 : oracleValueAt(redeemedSeriesRaw, date));
const portfolioOracleAt = (date: Date) => oracleValueAt(openSeries, date) + redeemedOracleAt(date);

/** FAITHFUL COPY of the pre-fix aggregation: plain carry-forward over each scheme's raw series. */
const legacyPortfolioAt = (date: Date) => oracleValueAt(openSeries, date) + oracleValueAt(redeemedSeriesRaw, date);

describe('probe shape: open fund + fund redeemed in full (series stops before exit)', () => {
  const rs = runAnalytics(dataset([openScheme(), redeemedScheme()]));
  const p = rs.portfolios[0];

  it('header total value is the open fund only -- 1,500-style, not open + phantom', () => {
    expect(p.totalValue).toBeCloseTo(openLast, 6);
    expect(p.totalValue).toBeCloseTo(portfolioOracleAt(d('2022-12-31')), 6);
  });

  it('every point of the drawdown series carries the oracle MONEY value (no phantom after exit)', () => {
    // The drawdown / growth-of-100 figures themselves are flow-adjusted since 2026-10-03
    // and are proven against an oracle in iiRiskCardsFlowAdjusted.test.ts.
    for (const pt of p.drawdownSeries) expect(pt.value, pt.date).toBeCloseTo(portfolioOracleAt(d(pt.date)), 6);
  });

  it('the growth-of-100 line starts at 100', () => {
    expect(p.performanceVsBenchmarkSeries[0].portfolio).toBe(100);
  });

  it('blended benchmark return equals an independent chain-linked monthly blend with the redeemed fund weighted 0 from its exit', () => {
    // Independent oracle: weights at each month start from oracle values; benchmark returns from the two level series.
    const dates: Date[] = [d('2020-01-31'), ...MONTHS.filter((m) => m > d('2020-01-31')), d('2022-12-31')];
    const uniq = [...new Set(dates.map((x) => x.getTime()))].sort((a, b) => a - b).map((t) => new Date(t));
    const levelAt = (series: Pt[], date: Date) => oracleValueAt(series, date);
    let chained = 1;
    for (let i = 0; i < uniq.length - 1; i++) {
      const a = uniq[i];
      const b = uniq[i + 1];
      const wOpen = oracleValueAt(openSeries, a);
      const wRed = redeemedOracleAt(a);
      const rOpen = levelAt(bench(0.01), b) / levelAt(bench(0.01), a) - 1;
      const rRed = levelAt(bench(0.05), b) / levelAt(bench(0.05), a) - 1;
      chained *= 1 + (wOpen * rOpen + wRed * rRed) / (wOpen + wRed);
    }
    expect(p.blendedBenchmarkReturn.status).toBe('CALCULATED');
    expect(p.blendedBenchmarkReturn.value!.blendedReturn).toBeCloseTo(chained - 1, 9);
  });

  it('the redeemed fund keeps its own scheme-level XIRR and the portfolio XIRR is unchanged by this fix', () => {
    expect(rs.schemes.find((s) => s.instrumentId === 'redeemed-fund')!.investorXirr.status).toBe('CALCULATED');
    expect(p.portfolioXirr.status).toBe('CALCULATED');
  });
});

describe('NEGATIVE CONTROL: the pre-fix aggregation disagrees with the oracle on the same inputs', () => {
  it('legacy header total is open + phantom (the reported 2,690-style over-statement)', () => {
    const legacyTotal = legacyPortfolioAt(d('2022-12-31'));
    expect(legacyTotal).toBeCloseTo(openLast + redeemedLast, 6);
    expect(legacyTotal - portfolioOracleAt(d('2022-12-31'))).toBeCloseTo(redeemedLast, 6);
    expect(redeemedLast).toBeGreaterThan(0);
  });

  it('legacy portfolio value is wrong at EVERY date after the exit (so drawdown and growth-of-100 were wrong too)', () => {
    const after = MONTHS.filter((m) => m >= EXIT);
    expect(after.length).toBeGreaterThan(10);
    for (const m of after) expect(Math.abs(legacyPortfolioAt(m) - portfolioOracleAt(m))).toBeGreaterThan(1);
  });

  it('legacy blend weights would still include the redeemed fund after exit, so the blended return differs from the oracle', () => {
    const dates = MONTHS.filter((m) => m >= d('2020-01-31'));
    let withPhantom = 1;
    let correct = 1;
    for (let i = 0; i < dates.length - 1; i++) {
      const a = dates[i];
      const b = dates[i + 1];
      const rOpen = oracleValueAt(bench(0.01), b) / oracleValueAt(bench(0.01), a) - 1;
      const rRed = oracleValueAt(bench(0.05), b) / oracleValueAt(bench(0.05), a) - 1;
      const wo = oracleValueAt(openSeries, a);
      const phantom = oracleValueAt(redeemedSeriesRaw, a);
      const real = redeemedOracleAt(a);
      withPhantom *= 1 + (wo * rOpen + phantom * rRed) / (wo + phantom);
      correct *= 1 + (wo * rOpen + real * rRed) / (wo + real);
    }
    expect(Math.abs(withPhantom - correct)).toBeGreaterThan(0.005);
  });

  it('the raw series really does end without a closing zero (this is what the safety net and the reconstruction fix address)', () => {
    expect(redeemedSeriesRaw[redeemedSeriesRaw.length - 1].value).toBeGreaterThan(0);
  });
});

describe('closeRedeemedSeries (safety net)', () => {
  const held = { currentValue: 500, currentValueDate: d('2022-01-01') };
  const closed = { currentValue: 0, currentValueDate: d('2021-07-15') };

  it('a scheme still holding value is returned untouched (same array)', () => {
    expect(closeRedeemedSeries(openSeries, held)).toBe(openSeries);
  });

  it('a series that already ends on a zero is returned untouched (idempotent): a scheme whose balance is truly zero on the as-of date adds no point', () => {
    const endsZero: Pt[] = [{ date: d('2021-01-01'), value: 100 }, { date: d('2021-03-01'), value: 0 }];
    expect(closeRedeemedSeries(endsZero, closed)).toBe(endsZero);
  });

  it('a closed scheme whose series ends positive gets exactly one closing zero, at the later of its zero-valuation date and the day after its last point', () => {
    const out = closeRedeemedSeries(redeemedSeriesRaw, closed);
    expect(out).toHaveLength(redeemedSeriesRaw.length + 1);
    expect(iso(out[out.length - 1].date)).toBe('2021-07-15');
    expect(out[out.length - 1].value).toBe(0);
    const early = closeRedeemedSeries([{ date: d('2021-09-01'), value: 10 }], { currentValue: 0, currentValueDate: d('2021-01-01') });
    expect(iso(early[early.length - 1].date)).toBe('2021-09-02');
  });

  it('never mutates its input and ignores an empty series', () => {
    const copy = redeemedSeriesRaw.map((p) => ({ ...p }));
    closeRedeemedSeries(redeemedSeriesRaw, closed);
    expect(redeemedSeriesRaw).toEqual(copy);
    expect(closeRedeemedSeries([], closed)).toEqual([]);
  });
});

describe('redeemed THEN re-bought: zero in the gap, positive again afterwards', () => {
  it('portfolio total follows the oracle through the exit and the re-purchase', () => {
    // fund R: held to 2021-06-30, fully redeemed 2021-07-15 (explicit zero), re-bought 2022-02-10 (positive again from the next month-end)
    const pts: Pt[] = [
      ...redeemedSeriesRaw,
      { date: EXIT, value: 0 },
      ...MONTHS.filter((m) => m >= d('2022-02-28')).map((date, i) => ({ date, value: 700 + i })),
    ];
    const reb = redeemedScheme(pts);
    reb.currentValue = pts[pts.length - 1].value;
    reb.currentValueDate = d('2022-12-31');
    const rs = runAnalytics(dataset([openScheme(), reb]));
    const oracleAt = (date: Date) => oracleValueAt(openSeries, date) + oracleValueAt(pts, date);
    for (const pt of rs.portfolios[0].drawdownSeries) expect(pt.value, pt.date).toBeCloseTo(oracleAt(d(pt.date)), 6);
    // in the gap (after the exit, before the re-purchase) only the open fund counts
    const gap = rs.portfolios[0].drawdownSeries.find((x) => x.date === '2021-12-31')!;
    expect(gap.value).toBeCloseTo(oracleValueAt(openSeries, d('2021-12-31')), 6);
    expect(rs.portfolios[0].totalValue).toBeCloseTo(openLast + pts[pts.length - 1].value, 6);
  });
});

describe('partially redeemed scheme stays correct', () => {
  it('a scheme still holding units keeps contributing its own remaining value', () => {
    const partial = redeemedScheme(redeemedSeriesRaw.map((p) => ({ ...p, value: p.value * 0.4 })));
    partial.currentValue = 300;
    partial.currentValueDate = d('2022-12-31');
    const rs = runAnalytics(dataset([openScheme(), partial]));
    // last-known partial value 0.4 x redeemedLast is carried (it is still held)
    expect(rs.portfolios[0].totalValue).toBeCloseTo(openLast + redeemedLast * 0.4, 6);
  });
});

describe('unit-ledger reconstruction writes the closing zero (root fix)', () => {
  const navs = [d('2020-01-01'), d('2020-01-02'), d('2020-01-03'), d('2020-01-04'), d('2020-01-05')].map((date) => ({ date, value: 10 }));

  it('NEGATIVE CONTROL shape: the legacy output (zero dates dropped) has no zero point; the fixed output has one on the exit date', () => {
    const tx = [
      { date: d('2020-01-01'), transactionType: 'purchase' as const, units: 100 },
      { date: d('2020-01-03'), transactionType: 'redemption' as const, units: 100 },
    ];
    const fixed = buildUnitWeightedValuationSeries(tx, navs);
    const legacy = fixed.filter((p) => p.value > 0); // exactly what the old function returned
    expect(legacy.map((p) => iso(p.date))).toEqual(['2020-01-01', '2020-01-02']);
    expect(oracleValueAt(legacy, d('2020-01-05'))).toBe(1000); // phantom
    expect(fixed.map((p) => [iso(p.date), p.value])).toEqual([['2020-01-01', 1000], ['2020-01-02', 1000], ['2020-01-03', 0]]);
    expect(oracleValueAt(fixed, d('2020-01-05'))).toBe(0);
  });

  it('end to end through the real repository: a bought-and-fully-redeemed fund contributes 0 after its exit', async () => {
    const tables = repoTables();
    const { dataset: ds } = await loadAnalyticsDataset(mockSupabase(tables), 'user-r');
    const red = ds!.schemes.find((s) => s.instrumentId === 'inst-red')!;
    const last = red.reconstructedValuationSeries![red.reconstructedValuationSeries!.length - 1];
    expect(last.value).toBe(0);
    expect(iso(last.date)).toBe('2020-02-20');
    const rs = runAnalytics(ds!);
    const open = ds!.schemes.find((s) => s.instrumentId === 'inst-open')!;
    const expectedTotal = open.currentValue; // oracle: only the open fund is held at the end
    expect(rs.portfolios[0].totalValue).toBeCloseTo(expectedTotal, 6);
    for (const pt of rs.portfolios[0].drawdownSeries) {
      const date = d(pt.date);
      const openVal = oracleValueAt(open.reconstructedValuationSeries!, date);
      const redVal = date >= d('2020-02-20') ? 0 : oracleValueAt(red.reconstructedValuationSeries!, date);
      expect(pt.value, pt.date).toBeCloseTo(openVal + redVal, 6);
    }
  });
});

// ---- minimal hermetic Supabase mock (same shape as the other repository tests) ----
type Row = Record<string, unknown>;
function mockSupabase(tables: Record<string, Row[]>): SupabaseClient {
  const builder = (rows: Row[]) => {
    let filtered = rows;
    const order: Array<{ col: string; asc: boolean }> = [];
    const sorted = () => {
      const r = [...filtered];
      for (let i = order.length - 1; i >= 0; i--) {
        const { col, asc } = order[i];
        r.sort((a, b) => (a[col] as string) < (b[col] as string) ? (asc ? -1 : 1) : (a[col] as string) > (b[col] as string) ? (asc ? 1 : -1) : 0);
      }
      return r;
    };
    const b = {
      select: () => b,
      eq: (c: string, v: unknown) => ((filtered = filtered.filter((r) => r[c] === v)), b),
      in: (c: string, vs: unknown[]) => ((filtered = filtered.filter((r) => new Set(vs).has(r[c]))), b),
      order: (c: string, o?: { ascending?: boolean }) => (order.push({ col: c, asc: o?.ascending !== false }), b),
      range: (f: number, t: number) => Promise.resolve({ data: sorted().slice(f, t + 1), error: null }),
      then: (res: (v: { data: Row[]; error: null }) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve({ data: sorted(), error: null }).then(res, rej),
    };
    return b;
  };
  return { from: (t: string) => builder(tables[t] ?? []) } as unknown as SupabaseClient;
}

function repoTables(): Record<string, Row[]> {
  const userId = 'user-r';
  const day = (n: number) => new Date(Date.UTC(2020, 0, 1 + n)).toISOString().slice(0, 10);
  const nav = (inst: string) => Array.from({ length: 90 }, (_, i) => ({ id: `${inst}-nav-${String(i).padStart(4, '0')}`, instrument_id: inst, price_date: day(i), price: 10 + i * 0.02, data_version: 'v1', quality_status: 'ok' }));
  const truth = (inst: string, acc: string) => ({ instrument_id: inst, account_id: acc, history_completeness: 'complete_from_inception', status: 'certified', user_id: userId, unit_variance_within_tolerance: true });
  const purchase = (id: string, inst: string, date: string) => ({ id, user_id: userId, instrument_id: inst, transaction_type: 'purchase', transaction_date: date, gross_amount: 1000, currency_code: 'INR', status: 'parsed', units: 100 });
  return {
    ii_portfolio_truth_status: [truth('inst-open', 'acc-1'), truth('inst-red', 'acc-1')],
    ii_transactions: [
      purchase('tx-o', 'inst-open', day(0)),
      purchase('tx-r', 'inst-red', day(0)),
      { id: 'tx-r2', user_id: userId, instrument_id: 'inst-red', transaction_type: 'redemption', transaction_date: '2020-02-20', gross_amount: 1100, currency_code: 'INR', status: 'parsed', units: 100 },
    ],
    ii_holding_snapshots: [
      { id: 'snap-o', user_id: userId, instrument_id: 'inst-open', as_of_date: day(89), units: 100, value: 100 * (10 + 89 * 0.02), currency_code: 'INR', quality_status: 'certified' },
      { id: 'snap-r', user_id: userId, instrument_id: 'inst-red', as_of_date: '2020-02-20', units: 0, value: 0, currency_code: 'INR', quality_status: 'certified' },
    ],
    ii_instruments: [
      { id: 'inst-open', instrument_name: 'Open Fund', base_currency: 'INR', country_of_domicile: 'IN' },
      { id: 'inst-red', instrument_name: 'Redeemed Fund', base_currency: 'INR', country_of_domicile: 'IN' },
    ],
    ii_prices_nav: [...nav('inst-open'), ...nav('inst-red')],
    ii_instrument_benchmarks: [], ii_benchmark_series: [], ii_risk_free_rates: [],
  };
}
