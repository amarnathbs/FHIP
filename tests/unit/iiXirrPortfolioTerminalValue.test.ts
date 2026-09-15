// App Review 2026-09-15, item 2 — "XIRR must be calculated".
//
// The reviewer's Investment Intelligence (India) → Performance tab showed
//
//   Money-weighted return (XIRR):
//   Could not be calculated — No sign change found for NPV(r) across the
//   search domain.
//
// for a portfolio the review describes as 17 holdings worth ₹8,06,724 as at
// 04-09-2026 with history from 17-12-2007 — i.e. a portfolio that plainly has
// the inputs an XIRR needs.
//
// Part 1 of this file reproduces the failure against the REAL solver and
// pins down exactly which cash-flow shapes cause it (and, just as
// importantly, which do not — so the diagnosis cannot be hand-waved).
// Part 2 proves the portfolio-level construction now produces a number.
import { describe, it, expect } from 'vitest';
import { xirr } from '@/lib/engines/investment-intelligence/xirr';
import { runAnalytics, type AnalyticsDataset, type SchemeDataset } from '@/lib/engines/investment-intelligence/analyticsOrchestrator';

const d = (s: string) => new Date(s + 'T00:00:00Z');

describe('item 2 part 1 — why NPV(r) had no sign change', () => {
  it('a healthy series (purchases, then a terminal valuation) always solves', () => {
    const r = xirr([
      { date: d('2007-12-17'), amount: -200000 },
      { date: d('2015-01-01'), amount: -150000 },
      { date: d('2026-09-04'), amount: 806724 },
    ]);
    expect(r.status).toBe('ok');
    expect(r.rate).toBeGreaterThan(0);
  });

  it('the search domain was never the problem — it already spans -99.9999% to +10,000%', () => {
    // Far wider than the -99%..+1000% the review suggests as a minimum.
    const huge = xirr([
      { date: d('2025-01-01'), amount: -1000 },
      { date: d('2026-01-01'), amount: 90000 }, // +8,900% in a year
    ]);
    expect(huge.status).toBe('ok');
    expect(huge.rate).toBeGreaterThan(80);

    const collapse = xirr([
      { date: d('2025-01-01'), amount: -1000000 },
      { date: d('2026-01-01'), amount: 2000 }, // -99.8% in a year
    ]);
    expect(collapse.status).toBe('ok');
    expect(collapse.rate).toBeLessThan(-0.99);

    // Only a root essentially AT the domain floor (r -> -1, i.e. a total
    // wipeout to a rounding-error residue) is out of reach, and widening the
    // bracket cannot help there — 1/(1+r) diverges. Documented rather than
    // chased: it is not the reviewer's case, which reported a live portfolio
    // worth ₹8,06,724.
    const totalWipeout = xirr([
      { date: d('2025-01-01'), amount: -1000000 },
      { date: d('2026-01-01'), amount: 1 },
    ]);
    expect(totalWipeout.reason).toBe('NOT_BRACKETED');
  });

  it('REPRODUCES the reviewer\'s failure: a series whose LAST flow is money going in', () => {
    // Both signs are present, so ALL_SAME_SIGN does not fire — yet there is
    // genuinely no root: NPV(r) tends to the earliest flow's sign as
    // r -> +inf and to the latest flow's sign as r -> -1+, and here both are
    // negative. This is the shape produced when a purchase is dated after
    // the valuation date that terminates the series.
    const r = xirr([
      { date: d('2007-12-17'), amount: -200000 },
      { date: d('2026-09-04'), amount: 806724 }, // valuation
      { date: d('2026-09-10'), amount: -900000 }, // purchase AFTER it
    ]);
    expect(r.status).toBe('unavailable');
    // Before the fix this returned NOT_BRACKETED with the opaque
    // "No sign change found for NPV(r) across the search domain."
    expect(r.reason).toBe('NO_TERMINAL_VALUE');
    expect(r.detail).toContain('no later valuation');
    expect(r.detail).not.toContain('NPV');
  });

  it('REPRODUCES it for the other route in: no terminal valuation at all', () => {
    const r = xirr([
      { date: d('2007-12-17'), amount: -50000 },
      { date: d('2015-06-01'), amount: 30000 },
      { date: d('2026-01-05'), amount: -40000 },
    ]);
    expect(r.status).toBe('unavailable');
    expect(r.reason).toBe('NO_TERMINAL_VALUE');
  });

  it('still reports ALL_SAME_SIGN when the series genuinely has only one sign', () => {
    // Item 2 requirement 4: "Could not be calculated" is reserved for a
    // series that genuinely lacks one negative and one positive flow.
    expect(
      xirr([
        { date: d('2007-12-17'), amount: -200000 },
        { date: d('2015-01-01'), amount: -150000 },
      ]).reason
    ).toBe('ALL_SAME_SIGN');
  });
});

// ---------------------------------------------------------------------------

const EMPTY_DS = {
  userId: 'u1',
  mappings: [],
  benchmarkSeriesById: {},
  riskFreeSeries: [],
  navDataVersion: null,
  benchmarkDataVersion: null,
  benchmarkMappingVersion: null,
};

/** One scheme, built the way analyticsRepository builds them. */
function scheme(
  id: string,
  purchases: { date: string; amount: number }[],
  currentValue: number,
  valuationDate: string
): SchemeDataset {
  const real = purchases.map((p) => ({ date: d(p.date), amount: -Math.abs(p.amount) }));
  const terminal = { date: d(valuationDate), amount: currentValue };
  return {
    instrumentId: id,
    instrumentName: `Scheme ${id}`,
    currencyCode: 'INR',
    countryOfDomicile: 'IN',
    historyCompleteness: 'complete',
    optionType: null,
    hasDistributionAdjustment: false,
    cashFlows: [...real, terminal],
    externalCashFlows: [...real, terminal],
    externalCashFlowsExcludingTerminal: real,
    currentValue,
    currentValueDate: d(valuationDate),
    navSeries: [],
    valuationSeries: [{ date: d(valuationDate), value: currentValue }],
  };
}

describe("item 2 part 2 — the reviewer's own portfolio shape now produces a number", () => {
  // Mirrors the review's description: history from 17-12-2007, a valuation of
  // ₹8,06,724 as at 04-09-2026, and — the condition that broke it — statements
  // of differing vintage, so one scheme's purchase falls after another
  // scheme's valuation date.
  const schemes: SchemeDataset[] = [
    scheme(
      'A',
      [
        { date: '2007-12-17', amount: 100000 },
        { date: '2012-06-01', amount: 50000 },
        { date: '2019-04-15', amount: 75000 },
      ],
      500000,
      '2026-06-30' // older statement
    ),
    scheme(
      'B',
      [
        { date: '2015-03-01', amount: 80000 },
        { date: '2026-08-20', amount: 60000 }, // AFTER scheme A's valuation date
      ],
      306724,
      '2026-09-04' // newest statement — the portfolio's own as-at date
    ),
  ];

  const ds: AnalyticsDataset = {
    ...EMPTY_DS,
    asOfDate: d('2026-09-04'),
    periodStart: d('2007-12-17'),
    schemes,
  };

  it('computes a portfolio XIRR instead of "Could not be calculated"', () => {
    const result = runAnalytics(ds);
    const inr = result.portfolios.find((p) => p.currencyCode === 'INR')!;
    expect(inr.portfolioXirr.status).toBe('CALCULATED');
    expect(inr.portfolioXirr.value!.rate).toBeTypeOf('number');
    expect(Number.isFinite(inr.portfolioXirr.value!.rate)).toBe(true);
  });

  it('the rate is a plausible annualised return, not a numerical artefact', () => {
    const result = runAnalytics(ds);
    const rate = result.portfolios[0].portfolioXirr.value!.rate;
    // 365,000 invested between 2007 and 2026, now worth 806,724.
    expect(rate).toBeGreaterThan(0);
    expect(rate).toBeLessThan(0.5);
  });

  it('is reconcilable against an independent hand-built series', () => {
    // Every purchase as a dated outflow; the whole portfolio's current value
    // as ONE inflow on the portfolio valuation date — exactly the
    // construction the review specifies.
    const independent = xirr([
      { date: d('2007-12-17'), amount: -100000 },
      { date: d('2012-06-01'), amount: -50000 },
      { date: d('2019-04-15'), amount: -75000 },
      { date: d('2015-03-01'), amount: -80000 },
      { date: d('2026-08-20'), amount: -60000 },
      { date: d('2026-09-04'), amount: 500000 + 306724 },
    ]);
    expect(independent.status).toBe('ok');
    const engine = runAnalytics(ds).portfolios[0].portfolioXirr.value!.rate;
    expect(engine).toBeCloseTo(independent.rate!, 9);
  });

  it('reports the total value it terminated on, so the number is checkable', () => {
    const result = runAnalytics(ds);
    expect(result.portfolios[0].totalValue).toBe(806724);
  });

  it('still refuses to invent a return for a portfolio with no current value', () => {
    const valueless: AnalyticsDataset = {
      ...ds,
      schemes: [scheme('C', [{ date: '2020-01-01', amount: 10000 }], 0, '2026-09-04')],
    };
    const inr = runAnalytics(valueless).portfolios[0];
    expect(inr.portfolioXirr.status).not.toBe('CALCULATED');
  });
});
