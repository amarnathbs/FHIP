/**
 * Document2 defect D-2 follow-up (PO decision 2026-10-03: the time-weighted
 * return is removed; only XIRR is shown).
 *
 * The old defect: a fully redeemed / switched-out scheme left a phantom value in
 * the PORTFOLIO TWRR (offline: 23.24% vs the correct 20.16%), while XIRR was
 * right. With the TWRR calculation deleted that number no longer exists, so the
 * defect is moot. What must still hold -- and is asserted here against an
 * INDEPENDENT oracle -- is that XIRR for a household that holds a fully
 * redeemed fund next to an open one is correct, at both scheme and portfolio level.
 *
 * Evidence label: unit-tested against a hand-built oracle (bisection on NPV,
 * actual/365). Not run against production data or a browser.
 */
import { describe, it, expect } from 'vitest';
import { runAnalytics, type AnalyticsDataset, type SchemeDataset } from '@/lib/engines/investment-intelligence/analyticsOrchestrator';

const d = (s: string) => new Date(s + 'T00:00:00.000Z');

/** Independent XIRR oracle: bisection on NPV with actual/365 year fractions. No production code. */
function oracleXirr(flows: Array<{ date: string; amount: number }>): number {
  const t0 = d(flows[0].date).getTime();
  const npv = (r: number) => flows.reduce((s, f) => s + f.amount / Math.pow(1 + r, (d(f.date).getTime() - t0) / (365 * 86_400_000)), 0);
  let lo = -0.99;
  let hi = 10;
  for (let i = 0; i < 300; i++) {
    const mid = (lo + hi) / 2;
    if (npv(lo) * npv(mid) <= 0) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

const OPEN_FLOWS = [
  { date: '2020-01-01', amount: -1000 },
  { date: '2022-01-01', amount: 1500 }, // terminal current value, position still open
];
const REDEEMED_FLOWS = [
  { date: '2020-01-01', amount: -1000 },
  { date: '2021-01-01', amount: 1200 }, // full redemption; nothing left afterwards
];

function openScheme(): SchemeDataset {
  return {
    instrumentId: 'open-fund',
    instrumentName: 'Open Fund',
    currencyCode: 'INR',
    countryOfDomicile: 'IN',
    historyCompleteness: 'complete_from_inception',
    optionType: null,
    hasDistributionAdjustment: false,
    cashFlows: OPEN_FLOWS.map((f) => ({ date: d(f.date), amount: f.amount })),
    externalCashFlows: OPEN_FLOWS.map((f) => ({ date: d(f.date), amount: f.amount })),
    externalCashFlowsExcludingTerminal: [{ date: d('2020-01-01'), amount: -1000 }],
    currentValue: 1500,
    currentValueDate: d('2022-01-01'),
    navSeries: [],
    valuationSeries: [
      { date: d('2020-01-01'), value: 1000 },
      { date: d('2022-01-01'), value: 1500 },
    ],
  };
}

function redeemedScheme(): SchemeDataset {
  return {
    instrumentId: 'redeemed-fund',
    instrumentName: 'Redeemed Fund',
    currencyCode: 'INR',
    countryOfDomicile: 'IN',
    historyCompleteness: 'complete_from_inception',
    optionType: null,
    hasDistributionAdjustment: false,
    cashFlows: REDEEMED_FLOWS.map((f) => ({ date: d(f.date), amount: f.amount })),
    externalCashFlows: REDEEMED_FLOWS.map((f) => ({ date: d(f.date), amount: f.amount })),
    externalCashFlowsExcludingTerminal: REDEEMED_FLOWS.map((f) => ({ date: d(f.date), amount: f.amount })),
    currentValue: 0,
    currentValueDate: d('2021-01-01'),
    navSeries: [],
    valuationSeries: [
      { date: d('2020-01-01'), value: 1000 },
      { date: d('2021-01-01'), value: 0 },
    ],
  };
}

function dataset(schemes: SchemeDataset[]): AnalyticsDataset {
  return {
    userId: 'user-1',
    asOfDate: d('2022-01-01'),
    periodStart: d('2020-01-01'),
    schemes,
    mappings: [],
    benchmarkSeriesById: {},
    riskFreeSeries: [],
    navDataVersion: 'nav-v1',
    benchmarkDataVersion: 'bench-v1',
    benchmarkMappingVersion: 'map-v1',
    frequency: 'monthly',
  };
}

describe('XIRR with a fully redeemed fund beside an open one (D-2 follow-up)', () => {
  const rs = runAnalytics(dataset([openScheme(), redeemedScheme()]));
  const portfolio = rs.portfolios[0];

  it('the fully redeemed fund keeps its own correct XIRR', () => {
    const redeemed = rs.schemes.find((s) => s.instrumentId === 'redeemed-fund')!;
    expect(redeemed.investorXirr.status).toBe('CALCULATED');
    expect(redeemed.investorXirr.value!.rate).toBeCloseTo(oracleXirr(REDEEMED_FLOWS), 6);
  });

  it('the open fund is unaffected by the redeemed one', () => {
    const open = rs.schemes.find((s) => s.instrumentId === 'open-fund')!;
    expect(open.investorXirr.value!.rate).toBeCloseTo(oracleXirr(OPEN_FLOWS), 6);
  });

  it('the portfolio XIRR equals the oracle over the combined real flows plus ONE terminal value', () => {
    const combined = [
      { date: '2020-01-01', amount: -2000 },
      { date: '2021-01-01', amount: 1200 },
      { date: '2022-01-01', amount: 1500 },
    ];
    expect(portfolio.portfolioXirr.status).toBe('CALCULATED');
    expect(portfolio.portfolioXirr.value!.rate).toBeCloseTo(oracleXirr(combined), 6);
  });

  it('NEGATIVE CONTROL: the oracle is not trivially equal to the answer for a different cash-flow set (a wrong portfolio XIRR is detectable)', () => {
    // If the redeemed fund's redemption were dropped from the portfolio flows the figure would be this -- clearly different.
    const withoutRedemption = oracleXirr([
      { date: '2020-01-01', amount: -2000 },
      { date: '2022-01-01', amount: 1500 },
    ]);
    expect(Math.abs(withoutRedemption - portfolio.portfolioXirr.value!.rate)).toBeGreaterThan(0.01);
  });

  it('the result carries no time-weighted return of any kind', () => {
    expect(JSON.stringify(rs)).not.toMatch(/twr|time.?weighted/i);
    expect('portfolioTwrr' in portfolio).toBe(false);
  });
});
