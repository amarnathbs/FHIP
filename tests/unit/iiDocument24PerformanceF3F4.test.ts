/**
 * Document2 (4) F3 and F4 (Product Owner live review, 20-10-2026): Investment Intelligence > Performance.
 *
 * F3  "no update of NAV ... and no xirr calculated": the header said `17 holdings, 7,84,383, 17-12-2007 to 04-09-2026` (the
 *     STATEMENT date) while daily NAVs ran to 16-10-2026, and the portfolio XIRR read "Not enough history: begins and ends
 *     with money coming out".
 * F4  "growth of 100 and drawdown both wrong": the line fell to about zero and stayed on zero (drawdown -100%) to the end.
 *
 * ORACLES. Everything expected below is computed in THIS file from first principles: units x latest NAV for the value, an
 * independent Actual/365 bisection for the XIRR, and a plain period-return chain for the index. No engine arithmetic is reused.
 * NEGATIVE CONTROLS. A faithful copy of the previous construction is run on the same fixture and MUST show the PO's symptom,
 * otherwise this test would be green for the wrong reason.
 */
import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { loadAnalyticsDataset } from '@/lib/services/investment-intelligence/analyticsRepository';
import { runAnalytics, schemeLacksOpeningInvestment, type AnalyticsDataset, type SchemeDataset } from '@/lib/engines/investment-intelligence/analyticsOrchestrator';
import { buildFlowAdjustedIndex, portfolioContributionFlows } from '@/lib/engines/investment-intelligence/flowAdjustedIndexSeries';
import { xirr } from '@/lib/engines/investment-intelligence/xirr';

type Row = Record<string, unknown>;

// ---- hermetic Supabase mock (same shape as iiNavMarkToMarket.test.ts) -----------------------------------------------------
function makeBuilder(rows: Row[]) {
  let filtered = rows;
  const order: Array<{ col: string; asc: boolean }> = [];
  const sorted = () => {
    const out = [...filtered];
    for (let i = order.length - 1; i >= 0; i--) {
      const { col, asc } = order[i];
      out.sort((a, b) => ((a[col] as string) < (b[col] as string) ? (asc ? -1 : 1) : (a[col] as string) > (b[col] as string) ? (asc ? 1 : -1) : 0));
    }
    return out;
  };
  const b = {
    select: () => b,
    eq: (c: string, v: unknown) => ((filtered = filtered.filter((r) => r[c] === v)), b),
    in: (c: string, vs: unknown[]) => ((filtered = filtered.filter((r) => new Set(vs).has(r[c]))), b),
    is: (c: string, v: unknown) => ((filtered = filtered.filter((r) => (r[c] ?? null) === v)), b),
    order: (c: string, o?: { ascending?: boolean }) => (order.push({ col: c, asc: o?.ascending !== false }), b),
    range: (f: number, t: number) => Promise.resolve({ data: sorted().slice(f, t + 1), error: null }),
    then: (res: (v: { data: Row[]; error: null }) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve({ data: sorted().slice(0, 1000), error: null }).then(res, rej),
  };
  return b;
}
const client = (tables: Record<string, Row[]>) => ({ from: (t: string) => makeBuilder(tables[t] ?? []) }) as unknown as SupabaseClient;

const userId = 'u-doc24';
const A = 'inst-a';
const B = 'inst-b';
const tx = (instrument: string, type: string, date: string, gross: number, units: number, n: number): Row => ({
  id: `t${n}`, user_id: userId, instrument_id: instrument, account_id: `acc-${instrument}`, transaction_type: type, transaction_date: date, gross_amount: gross, units, currency_code: 'INR', status: 'confirmed',
});
const snap = (instrument: string, asOf: string, units: number, value: number, n: number): Row => ({
  id: `s${n}`, user_id: userId, instrument_id: instrument, account_id: `acc-${instrument}`, as_of_date: asOf, units, value, currency_code: 'INR', quality_status: 'certified',
});
const nav = (instrument: string, date: string, price: number, n: number): Row => ({ id: `n${n}`, instrument_id: instrument, price_date: date, price, data_version: 'v1', quality_status: 'ok', currency_code: 'INR' });

// ---- independent XIRR oracle: Actual/365 from the first flow, plain bisection ------------------------------------------------
function oracleXirr(flows: Array<{ date: string; amount: number }>): number {
  const t0 = Date.parse(flows[0].date);
  const npv = (r: number) => flows.reduce((s, f) => s + f.amount / Math.pow(1 + r, (Date.parse(f.date) - t0) / 86_400_000 / 365), 0);
  let lo = -0.99;
  let hi = 10;
  for (let i = 0; i < 300; i++) {
    const mid = (lo + hi) / 2;
    if (npv(lo) * npv(mid) <= 0) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

describe('F3: the portfolio is valued as units x the latest eligible NAV, and as at that NAV date', () => {
  // A: two purchases, statement of 04-09-2026 (150 units), NAV 16-10-2026 = 250  -> 37,500 now (the statement said 30,000)
  // B: only a REDEMPTION on file (cost not on file), statement of 04-09-2026 (50 units), NAV 16-10-2026 = 110 -> 5,500 now
  const tables = {
    ii_instruments: [
      { id: A, instrument_name: 'Fund A', base_currency: 'INR', country_of_domicile: 'IN' },
      { id: B, instrument_name: 'Fund B', base_currency: 'INR', country_of_domicile: 'IN' },
    ],
    ii_transactions: [
      tx(A, 'purchase', '2020-01-10', 10000, 100, 1),
      tx(A, 'purchase', '2022-03-10', 5000, 50, 2),
      tx(B, 'redemption', '2019-05-02', 500, 5, 3),
    ],
    ii_holding_snapshots: [snap(A, '2026-09-04', 150, 30000, 1), snap(B, '2026-09-04', 50, 5000, 2)],
    ii_prices_nav: [
      nav(A, '2026-09-04', 200, 1), nav(A, '2026-10-16', 250, 2),
      nav(B, '2026-09-04', 100, 3), nav(B, '2026-10-16', 110, 4),
    ],
  };
  const TODAY = new Date('2026-10-20T00:00:00.000Z');
  const load = () => loadAnalyticsDataset(client(tables), userId, { asOfDate: TODAY });

  it('the as-at date is the NAV date, not the statement date, and no stale-data notice is raised', async () => {
    const { dataset, warnings } = await load();
    expect(dataset!.asOfDate.toISOString().slice(0, 10)).toBe('2026-10-16'); // the old code said 2026-09-04
    expect(warnings.find((w) => w.scope === 'data_currency')).toBeUndefined();
  });

  it('the header total equals the sum of units x latest eligible NAV (37,500 + 5,500), not the statement total (35,000)', async () => {
    const { dataset } = await load();
    const rs = runAnalytics(dataset!);
    expect(rs.portfolios[0].totalValue).toBe(150 * 250 + 50 * 110);
    expect(rs.portfolios[0].totalValue).not.toBe(30000 + 5000);
    expect(rs.asOfDate).toBe('2026-10-16');
  });

  it('the XIRR is calculated (not "Not enough history") and equals the independent oracle over the holdings whose cost is on file', async () => {
    const { dataset } = await load();
    const rs = runAnalytics(dataset!);
    const x = rs.portfolios[0].portfolioXirr;
    expect(x.status).toBe('CALCULATED');
    const expected = oracleXirr([
      { date: '2020-01-10', amount: -10000 },
      { date: '2022-03-10', amount: -5000 },
      { date: '2026-10-16', amount: 150 * 250 },
    ]);
    expect(x.value!.rate).toBeCloseTo(expected, 6);
  });

  it('the holding with no recorded purchase is named, with what to do, and is left out of the XIRR only', async () => {
    const { dataset } = await load();
    const rs = runAnalytics(dataset!);
    const note = rs.portfolios[0].annotations.find((a) => /Fund B/.test(a.detail));
    expect(note).toBeDefined();
    expect(note!.detail).toMatch(/no recorded purchase before its first redemption/);
    expect(note!.detail).toMatch(/Upload the statement that covers the first purchase/);
    // still in the value: B is counted in the total above
    expect(rs.portfolios[0].schemeCount).toBe(2);
  });

  it('NEGATIVE CONTROL: the old construction (every scheme in the XIRR) fails with the Product Owner\'s exact message', async () => {
    const { dataset } = await load();
    const [a, b] = ['inst-a', 'inst-b'].map((id) => dataset!.schemes.find((s) => s.instrumentId === id)!);
    const oldFlows = [...(a.externalCashFlowsExcludingTerminal ?? []), ...(b.externalCashFlowsExcludingTerminal ?? [])].sort((x, y) => x.date.getTime() - y.date.getTime());
    oldFlows.push({ date: new Date('2026-10-16T00:00:00.000Z'), amount: a.currentValue + b.currentValue });
    const r = xirr(oldFlows);
    expect(r.status).toBe('unavailable');
    expect(r.reason).toBe('NO_TERMINAL_VALUE');
    expect(r.detail).toMatch(/begins and ends with money coming out/);
    expect(schemeLacksOpeningInvestment(b)).toBe(true);
    expect(schemeLacksOpeningInvestment(a)).toBe(false);
  });

  it('when NO holding has its cost on file the message names the missing prerequisite instead of "Not enough history"', async () => {
    const only = { ...tables, ii_instruments: [tables.ii_instruments[1]], ii_transactions: [tables.ii_transactions[2]], ii_holding_snapshots: [tables.ii_holding_snapshots[1]], ii_prices_nav: tables.ii_prices_nav.slice(2) };
    const { dataset } = await loadAnalyticsDataset(client(only), userId, { asOfDate: TODAY });
    const x = runAnalytics(dataset!).portfolios[0].portfolioXirr;
    expect(x.status).not.toBe('CALCULATED');
    expect(x.detail).toMatch(/no recorded purchase before its first redemption or payout \(Fund B\)/);
    expect(x.detail).toMatch(/Upload the statement that covers the first purchase, or add the investment date/);
  });

  it('a genuinely stale portfolio (nothing newer than 04-09-2026 anywhere) still raises the notice, in plain words with a way to fix it', async () => {
    const stale = { ...tables, ii_prices_nav: [] };
    const { warnings } = await loadAnalyticsDataset(client(stale), userId, { asOfDate: TODAY });
    const w = warnings.find((x) => x.scope === 'data_currency');
    expect(w).toBeDefined();
    expect(w!.detail).toMatch(/04-09-2026/);
    expect(w!.detail).toMatch(/Upload a newer statement/);
    expect(w!.detail).not.toMatch(/certified valuation/);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------
// F4
// ------------------------------------------------------------------------------------------------------------------------------
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const monthEnds = (fromY: number, fromM: number, n: number) => Array.from({ length: n }, (_, i) => new Date(Date.UTC(fromY, fromM + i + 1, 0)));

/** A faithful copy of the PREVIOUS flow-adjusted index (no empty-portfolio rule). Used only as the negative control. */
function previousIndex(values: Array<{ date: Date; value: number }>, flows: Array<{ date: Date; contribution: number }>) {
  const MIN_BASE_FRACTION = 1e-4;
  const obs = [...values].sort((x, y) => x.date.getTime() - y.date.getTime());
  const out = [{ date: obs[0].date, value: 100 }];
  let level = 100;
  let largest = Math.max(0, obs[0].value);
  let fi = 0;
  const sf = [...flows].sort((x, y) => x.date.getTime() - y.date.getTime());
  while (fi < sf.length && sf[fi].date.getTime() <= obs[0].date.getTime()) fi++;
  for (let i = 1; i < obs.length; i++) {
    const a = obs[i - 1];
    const b = obs[i];
    const span = b.date.getTime() - a.date.getTime();
    let contributed = 0;
    let weighted = 0;
    while (fi < sf.length && sf[fi].date.getTime() <= b.date.getTime()) {
      contributed += sf[fi].contribution;
      weighted += (span > 0 ? (b.date.getTime() - sf[fi].date.getTime()) / span : 0) * sf[fi].contribution;
      fi++;
    }
    largest = Math.max(largest, a.value, b.value);
    const base = a.value + weighted;
    let r = 0;
    if (base > Math.max(1e-9, MIN_BASE_FRACTION * largest)) {
      r = (b.value - a.value - contributed) / base;
      if (!Number.isFinite(r)) r = 0;
      if (r < -0.9999) r = -0.9999;
    }
    level *= 1 + r;
    out.push({ date: b.date, value: level });
  }
  return out;
}

describe('F4: switching out of a fund into another must not collapse the growth-of-100 line or the drawdown', () => {
  // Fund A: bought 31-01-2020, value drifts up, SWITCHED OUT IN FULL on 31-12-2020 into fund B (zero point on that date, as the
  // unit-ledger reconstruction writes it). Fund B: valued from 31-12-2020 with the switched-in money, then a steady climb.
  const aDates = monthEnds(2020, 0, 11); // 31-01-2020 .. 30-11-2020
  const aVals = [1000, 1010, 990, 1020, 1040, 1030, 1060, 1070, 1050, 1080, 1100];
  const bDates = monthEnds(2020, 11, 13); // 31-12-2020 .. 31-12-2021
  const bVals = Array.from({ length: 13 }, (_, i) => 1110 * Math.pow(1.01, i));
  const SWITCH = d('2020-12-31');
  const aSeries = [...aDates.map((date, i) => ({ date, value: aVals[i] })), { date: SWITCH, value: 0 }];
  const bSeries = bDates.map((date, i) => ({ date, value: bVals[i] }));

  const aCash = [
    { date: d('2020-01-31'), amount: -1000 },
    { date: SWITCH, amount: 1110 }, // switch_out leg
  ];
  const bCash = [{ date: SWITCH, amount: -1110 }]; // switch_in leg
  const aTerminalFree = [aCash[0]]; // external flows exclude the switch legs
  const schemeA: SchemeDataset = {
    instrumentId: 'A', instrumentName: 'Fund A', currencyCode: 'INR', countryOfDomicile: 'IN', historyCompleteness: 'complete_from_inception', optionType: null, hasDistributionAdjustment: false,
    cashFlows: aCash, externalCashFlows: aTerminalFree, externalCashFlowsExcludingTerminal: aTerminalFree, indexFlows: aCash,
    currentValue: 0, currentValueDate: SWITCH, navSeries: [], valuationSeries: aSeries,
  };
  const bLast = bVals[bVals.length - 1];
  const schemeB: SchemeDataset = {
    instrumentId: 'B', instrumentName: 'Fund B', currencyCode: 'INR', countryOfDomicile: 'IN', historyCompleteness: 'complete_from_inception', optionType: null, hasDistributionAdjustment: false,
    cashFlows: [...bCash, { date: d('2021-12-31'), amount: bLast }], externalCashFlows: [{ date: d('2021-12-31'), amount: bLast }], externalCashFlowsExcludingTerminal: [], indexFlows: bCash,
    currentValue: bLast, currentValueDate: d('2021-12-31'), navSeries: [], valuationSeries: bSeries,
  };
  const ds = (schemes: SchemeDataset[]): AnalyticsDataset => ({
    userId: 'u', asOfDate: d('2021-12-31'), periodStart: d('2020-01-31'), schemes, mappings: [], benchmarkSeriesById: {}, riskFreeSeries: [], navDataVersion: null, benchmarkDataVersion: null, benchmarkMappingVersion: null, frequency: 'monthly',
  });

  // ORACLE: the portfolio index chained from first principles. The only external money is the 1,000 put in on 31-01-2020, which is
  // the first observation (a flow on the first date moves nothing). The switch moves value between funds and is NOT a flow.
  const dates = [...aDates, SWITCH, ...bDates.slice(1)];
  const value = (date: Date): number => {
    const a = date.getTime() >= SWITCH.getTime() ? 0 : aVals[aDates.findIndex((x) => x.getTime() === date.getTime())];
    const bi = bDates.findIndex((x) => x.getTime() === date.getTime());
    return (a ?? 0) + (bi >= 0 ? bVals[bi] : 0);
  };
  const oracleLevels = (() => {
    const out = [100];
    for (let i = 1; i < dates.length; i++) out.push(out[i - 1] * (value(dates[i]) / value(dates[i - 1])));
    return out;
  })();
  const oracleDrawdown = (() => {
    let peak = -Infinity;
    return oracleLevels.map((v) => ((peak = Math.max(peak, v)), v / peak - 1));
  })();

  it('the growth-of-100 line follows the oracle on every date and never collapses', () => {
    const rs = runAnalytics(ds([schemeA, schemeB]));
    const line = rs.portfolios[0].performanceVsBenchmarkSeries;
    expect(line.map((p) => p.date)).toEqual(dates.map((x) => x.toISOString().slice(0, 10)));
    line.forEach((p, i) => expect(p.portfolio, p.date).toBeCloseTo(oracleLevels[i], 6));
    expect(Math.min(...line.map((p) => p.portfolio))).toBeGreaterThan(95);
    expect(line[line.length - 1].portfolio).toBeGreaterThan(110);
  });

  it('the drawdown series follows the oracle and is nowhere near -100%', () => {
    const rs = runAnalytics(ds([schemeA, schemeB]));
    const dd = rs.portfolios[0].drawdownSeries;
    dd.forEach((p, i) => expect(p.drawdown, p.date).toBeCloseTo(oracleDrawdown[i], 6));
    expect(Math.min(...dd.map((p) => p.drawdown))).toBeGreaterThan(-0.1);
  });

  it('NEGATIVE CONTROL: the previous rules (switch legs left out, no empty-portfolio rule) reproduce the Product Owner\'s chart: about -100% and stuck there', () => {
    const rs = runAnalytics(ds([schemeA, schemeB]));
    const values = rs.portfolios[0].drawdownSeries.map((p) => ({ date: d(p.date), value: p.value }));
    const oldFlows = portfolioContributionFlows([
      { series: aSeries, realFlows: aTerminalFree },
      { series: bSeries, realFlows: [] },
    ]);
    const old = previousIndex(values, oldFlows);
    const oldMin = Math.min(...old.map((p) => p.value));
    expect(oldMin).toBeLessThan(1); // collapsed to about zero
    expect(old[old.length - 1].value).toBeLessThan(1); // and never recovered, however the fund then performed
  });
});

describe('flow-adjusted index: an emptied portfolio with no recorded proceeds is an exit, not a total loss', () => {
  const v = (s: string, value: number) => ({ date: d(s), value });
  it('value goes to zero with no flow, then another fund starts: the index stays level instead of falling to zero for good', () => {
    const idx = buildFlowAdjustedIndex([v('2020-01-31', 100), v('2020-02-29', 110), v('2020-03-31', 120), v('2020-04-30', 0), v('2020-05-31', 0), v('2020-06-30', 500), v('2020-07-31', 550)], []);
    const levels = idx.map((p) => p.value);
    expect(levels[3]).toBeCloseTo(levels[2], 9); // the exit moved nothing
    expect(Math.min(...levels)).toBeGreaterThan(99);
    // the later 10% month is a real 10% for the new money
    expect(levels[6] / levels[5]).toBeCloseTo(1.1, 9);
  });

  it('a redemption that IS recorded is still an ordinary period return (the rule does not swallow it)', () => {
    // 1000 -> 1100 in the month, all of it taken out on the last day: return = +10%
    const idx = buildFlowAdjustedIndex([v('2020-01-31', 1000), v('2020-02-29', 0)], [{ date: d('2020-02-29'), contribution: -1100 }]);
    expect(idx[1].value).toBeCloseTo(110, 9);
  });
});
