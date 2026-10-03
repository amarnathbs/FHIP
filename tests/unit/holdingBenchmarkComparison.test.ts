// Holding-period, money-weighted benchmark comparison: engine tests with NAMED NEGATIVE CONTROLS.
//
// EVIDENCE LABEL: these are code-level fixtures with closed-form expected values
// (an independent bisection XIRR oracle written in this file, not the engine's own
// solver). They prove arithmetic and refusal behaviour. They do not prove a licence,
// real index data, live coverage or anything seen in a browser.
//
// A "negative control" here is an alternative implementation that is WRONG for the
// rule under test; each is asserted to fail (to behave differently) so a green rule
// test cannot be one that never bites.
import { describe, it, expect } from 'vitest';
import {
  compareHoldingToBenchmark,
  describeDuration,
  holdingPeriodLabel,
  isUnderOneYear,
  splitTerminalFlow,
  BENCHMARK_UNAVAILABLE_TITLE,
  type BenchmarkSegmentInput,
  type HoldingComparisonInput,
} from '@/lib/engines/investment-intelligence/holdingBenchmarkComparison';
import { benchmarkWindowReturn, type SeriesPoint } from '@/lib/engines/investment-intelligence/benchmarkService';
import { xirr } from '@/lib/engines/investment-intelligence/xirr';

const D = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const DAY = 86_400_000;
const addDays = (iso: string, n: number) => new Date(D(iso).getTime() + n * DAY).toISOString().slice(0, 10);

/** One point per calendar day from..to inclusive with level(date) given in closed form. */
function daily(from: string, to: string, level: (iso: string) => number): SeriesPoint[] {
  const out: SeriesPoint[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push({ date: D(d), value: level(d) });
  return out;
}
const daysBetween = (a: string, b: string) => Math.round((D(b).getTime() - D(a).getTime()) / DAY);

/** Independent oracle: plain bisection on NPV with the 365-day convention (NOT the engine's solver). */
function oracleXirr(flows: Array<{ date: string; amount: number }>): number {
  const t0 = flows[0].date;
  const npv = (r: number) => flows.reduce((s, f) => s + f.amount / Math.pow(1 + r, daysBetween(t0, f.date) / 365), 0);
  let lo = -0.99;
  let hi = 10;
  for (let i = 0; i < 300; i++) {
    const mid = (lo + hi) / 2;
    if (npv(lo) * npv(mid) <= 0) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

// 10% a year, exactly, on a 365-day convention (so a single lump sum has XIRR = 0.10).
const expo = (base: string, rate: number) => (iso: string) => 100 * Math.pow(1 + rate, daysBetween(base, iso) / 365);

function segment(over: Partial<BenchmarkSegmentInput> & Pick<BenchmarkSegmentInput, 'series'>): BenchmarkSegmentInput {
  return {
    benchmarkId: 'bm-1',
    benchmarkKey: 'IN_NIFTY_100_TRI',
    label: 'NIFTY 100 TRI',
    returnType: 'TRI',
    effectiveFrom: D('2015-01-01'),
    effectiveTo: null,
    catalogueVerified: true,
    entitled: true,
    ...over,
  };
}

function input(over: Partial<HoldingComparisonInput> & Pick<HoldingComparisonInput, 'flows' | 'segments'>): HoldingComparisonInput {
  return { terminalValue: 0, asOfDate: D('2026-01-01'), currencyCode: 'INR', ...over };
}

const SERIES_2023_2026 = daily('2022-12-01', '2026-01-10', expo('2023-01-01', 0.1));

describe('period wording and the one-year rule (day-first, never ISO)', () => {
  it('describes whole years and months, and days only under a month', () => {
    expect(describeDuration('2025-03-12', '2026-09-12')).toBe('1 year 6 months');
    expect(describeDuration('2024-01-01', '2026-01-01')).toBe('2 years');
    expect(describeDuration('2025-10-01', '2026-01-01')).toBe('3 months');
    expect(describeDuration('2025-12-09', '2026-01-01')).toBe('23 days');
    expect(describeDuration('2025-12-31', '2026-01-01')).toBe('1 day');
  });
  it('INR gives dd-mm-yyyy and AUD dd/mm/yyyy; no ISO year-first text appears', () => {
    expect(holdingPeriodLabel('2025-03-12', '2026-09-12', 'INR')).toBe('Since 12-03-2025, 1 year 6 months');
    expect(holdingPeriodLabel('2025-03-12', '2026-09-12', 'AUD')).toBe('Since 12/03/2025, 1 year 6 months');
    expect(holdingPeriodLabel('2025-03-12', '2026-09-12', 'INR')).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });
  it('under one year is decided by calendar months, so exactly one year is annualised', () => {
    expect(isUnderOneYear('2025-01-01', '2025-12-31')).toBe(true);
    expect(isUnderOneYear('2025-01-01', '2026-01-01')).toBe(false);
  });
});

describe('money-weighted replication (same cash flows, same dates, into the benchmark)', () => {
  // Level rises linearly 100 -> 200 across 2024, then stays flat at 200 through 2026.
  const level = (iso: string) => (iso <= '2024-01-01' ? 100 : iso >= '2025-01-01' ? 200 : 100 + (100 * daysBetween('2024-01-01', iso)) / daysBetween('2024-01-01', '2025-01-01'));
  const series = daily('2023-12-01', '2026-01-10', level);

  it('two purchases buy benchmark units on their own dates; the ending value and XIRR match a closed-form oracle', () => {
    const r = compareHoldingToBenchmark(
      input({
        flows: [
          { date: D('2024-01-01'), amount: -10000 }, // 100 units @ 100
          { date: D('2025-01-01'), amount: -10000 }, // 50 units @ 200
        ],
        terminalValue: 36000,
        segments: [segment({ series })],
      })
    );
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.basis).toBe('annualised_xirr');
    expect(r.benchmarkEndingValue).toBeCloseTo(150 * 200, 6); // 30,000
    expect(r.benchmarkReturn).toBeCloseTo(oracleXirr([{ date: '2024-01-01', amount: -10000 }, { date: '2025-01-01', amount: -10000 }, { date: '2026-01-01', amount: 30000 }]), 5);
    expect(r.holdingReturn).toBeCloseTo(oracleXirr([{ date: '2024-01-01', amount: -10000 }, { date: '2025-01-01', amount: -10000 }, { date: '2026-01-01', amount: 36000 }]), 5);
    expect(r.difference).toBeCloseTo(r.holdingReturn - r.benchmarkReturn, 12);
  });

  it('NEGATIVE CONTROL: replaying only the FIRST purchase as a lump sum (the old point-to-point idea) gives a different, wrong benchmark ending value', () => {
    const lumpSumEnding = (10000 / 100) * 200 * 2; // both amounts bought at the first date's level = 200 units * 200
    expect(lumpSumEnding).not.toBeCloseTo(30000, 0);
  });

  it('a redemption SELLS benchmark units on its own date for the same amount', () => {
    const r = compareHoldingToBenchmark(
      input({
        flows: [
          { date: D('2024-01-01'), amount: -10000 }, // 100 units
          { date: D('2025-01-01'), amount: 5000 }, // sells 25 units @ 200
        ],
        terminalValue: 16000,
        segments: [segment({ series })],
      })
    );
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.benchmarkEndingValue).toBeCloseTo(75 * 200, 6); // 15,000
    expect(r.benchmarkReturn).toBeCloseTo(oracleXirr([{ date: '2024-01-01', amount: -10000 }, { date: '2025-01-01', amount: 5000 }, { date: '2026-01-01', amount: 15000 }]), 5);
  });

  it('refuses (no number) when a redemption is larger than the same money would be worth in the benchmark', () => {
    const r = compareHoldingToBenchmark(
      input({
        flows: [
          { date: D('2024-01-01'), amount: -10000 }, // 100 units
          { date: D('2025-01-01'), amount: 30000 }, // would need 150 units
        ],
        terminalValue: 1000,
        segments: [segment({ series })],
      })
    );
    expect(r).toMatchObject({ status: 'unavailable', reason: 'REPLICATION_NEEDS_NEGATIVE_UNITS' });
    expect(JSON.stringify(r)).not.toMatch(/holdingReturn|benchmarkReturn/);
  });

  it('refuses when transactions are dated after the valuation date', () => {
    const r = compareHoldingToBenchmark(input({ flows: [{ date: D('2024-01-01'), amount: -10000 }, { date: D('2026-02-01'), amount: -500 }], terminalValue: 20000, segments: [segment({ series })] }));
    expect(r).toMatchObject({ status: 'unavailable', reason: 'FLOWS_AFTER_VALUATION' });
  });
});

describe('RULE: different holding periods give different comparisons (named negative control: a fixed window)', () => {
  const series = SERIES_2023_2026;
  const FUND_INCEPTION = '2023-01-01'; // the fund's own NAV history starts here
  const asOf = D('2026-01-01');
  const holdingFor = (startIso: string, gross: number) =>
    compareHoldingToBenchmark(
      input({
        flows: [{ date: D(startIso), amount: -10000 }],
        terminalValue: 10000 * Math.pow(1 + gross, daysBetween(startIso, '2026-01-01') / 365),
        asOfDate: asOf,
        segments: [segment({ series })],
      })
    );

  const longHeld = holdingFor('2024-01-02', 0.15); // just under 2 years
  const shortHeld = holdingFor('2025-10-01', 0.15); // 3 months

  it('two holdings of the same fund with different start dates get different windows, labels and bases', () => {
    expect(longHeld.status).toBe('ok');
    expect(shortHeld.status).toBe('ok');
    if (longHeld.status !== 'ok' || shortHeld.status !== 'ok') return;
    expect(longHeld.windowStart).toBe('2024-01-02');
    expect(shortHeld.windowStart).toBe('2025-10-01');
    expect(longHeld.windowStart).not.toBe(shortHeld.windowStart);
    expect(longHeld.periodLabel).toBe('Since 02-01-2024, 1 year 11 months');
    expect(shortHeld.periodLabel).toBe('Since 01-10-2025, 3 months');
    expect(longHeld.basis).toBe('annualised_xirr');
    expect(shortHeld.basis).toBe('absolute_not_annualised');
    expect(longHeld.benchmarkReturn).not.toBeCloseTo(shortHeld.benchmarkReturn, 3);
  });

  it('NEGATIVE CONTROL: the previous since-inception comparison (fixed window from the fund\'s own start) cannot tell the two holders apart, so the rule test above would FAIL against it', () => {
    const fixedForLong = benchmarkWindowReturn(series, D(FUND_INCEPTION), asOf);
    const fixedForShort = benchmarkWindowReturn(series, D(FUND_INCEPTION), asOf);
    expect(fixedForLong).toEqual(fixedForShort); // identical regardless of who is asking
    // ...whereas the holding-period engine's two answers differ (asserted above):
    if (longHeld.status === 'ok' && shortHeld.status === 'ok') {
      expect(longHeld.benchmarkReturn).not.toBe(shortHeld.benchmarkReturn);
    }
  });

  it('NEGATIVE CONTROL: a fixed 1y / 3y / 5y horizon also gives one answer to both holders', () => {
    const fixed3y = benchmarkWindowReturn(series, D('2023-01-01'), asOf); // "3 years" for everyone
    const sameForBoth = [fixed3y, fixed3y];
    expect(sameForBoth[0]).toEqual(sameForBoth[1]);
  });
});

describe('RULE: under one year is NOT annualised', () => {
  const series = SERIES_2023_2026;
  const flows = [{ date: D('2025-07-01'), amount: -10000 }];
  const level = expo('2023-01-01', 0.1);
  const r = compareHoldingToBenchmark(input({ flows, terminalValue: 10500, segments: [segment({ series })] }));

  it('shows the absolute gain for fund and benchmark over exactly the same dates, with the plain label', () => {
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.basis).toBe('absolute_not_annualised');
    expect(r.basisLabel).toBe('Less than a year, not annualised');
    expect(r.holdingReturn).toBeCloseTo(0.05, 12);
    expect(r.benchmarkReturn).toBeCloseTo(level('2026-01-01') / level('2025-07-01') - 1, 9);
    expect(r.periodLabel).toBe('Since 01-07-2025, 6 months');
  });

  it('NEGATIVE CONTROL: annualising the same six months would print a very different figure than the one shown', () => {
    if (r.status !== 'ok') throw new Error('expected ok');
    const annualised = xirr([{ date: D('2025-07-01'), amount: -10000 }, { date: D('2026-01-01'), amount: 10500 }]);
    expect(annualised.status).toBe('ok');
    expect(Math.abs((annualised.rate ?? 0) - r.holdingReturn)).toBeGreaterThan(0.03);
  });
});

describe('RULE: no number without a mapping, a verified entry, an entitlement or a total-return series', () => {
  const flows = [{ date: D('2024-01-01'), amount: -10000 }];
  const base = { flows, terminalValue: 12000, segments: [segment({ series: SERIES_2023_2026 })] };
  const noNumber = (r: ReturnType<typeof compareHoldingToBenchmark>) => {
    expect(r.status).toBe('unavailable');
    if (r.status !== 'unavailable') return;
    expect(r.title).toBe(BENCHMARK_UNAVAILABLE_TITLE);
    expect(JSON.stringify(r)).not.toMatch(/holdingReturn|benchmarkReturn|difference|benchmarkEndingValue/);
  };

  it('control: the same input with every gate satisfied produces a number', () => {
    expect(compareHoldingToBenchmark(input(base)).status).toBe('ok');
  });
  it('no mapping at all', () => {
    const r = compareHoldingToBenchmark(input({ ...base, segments: [] }));
    noNumber(r);
    expect(r).toMatchObject({ reason: 'NO_MAPPING' });
  });
  it('no entitlement => unavailable with the entitlement reason, never a number (NEGATIVE CONTROL: entitled=true is the only difference to the control above)', () => {
    const r = compareHoldingToBenchmark(input({ ...base, segments: [segment({ series: SERIES_2023_2026, entitled: false, entitlementDetail: 'NIFTY 100 TRI: no approved entitlement covers this benchmark, so no comparison is shown.' })] }));
    noNumber(r);
    expect(r).toMatchObject({ reason: 'NOT_ENTITLED' });
    expect((r as { detail: string }).detail).toMatch(/entitlement/);
  });
  it('no series', () => {
    const r = compareHoldingToBenchmark(input({ ...base, segments: [segment({ series: [] })] }));
    noNumber(r);
    expect(r).toMatchObject({ reason: 'NO_SERIES' });
  });
  it('unverified catalogue entry (NEGATIVE CONTROL: verified=true is the only difference to the control)', () => {
    const r = compareHoldingToBenchmark(input({ ...base, segments: [segment({ series: SERIES_2023_2026, catalogueVerified: false })] }));
    noNumber(r);
    expect(r).toMatchObject({ reason: 'CATALOGUE_NOT_VERIFIED' });
  });
  it('a PRICE index is never substituted for a total-return benchmark (NEGATIVE CONTROL: returnType TRI is the only difference)', () => {
    const r = compareHoldingToBenchmark(input({ ...base, segments: [segment({ series: SERIES_2023_2026, returnType: 'PRI' })] }));
    noNumber(r);
    expect(r).toMatchObject({ reason: 'PRICE_INDEX_NOT_TOTAL_RETURN' });
  });
  it('a series of unknown return type is not used either', () => {
    noNumber(compareHoldingToBenchmark(input({ ...base, segments: [segment({ series: SERIES_2023_2026, returnType: 'OTHER' })] })));
  });
  it('no mapping in force on the first investment date', () => {
    const r = compareHoldingToBenchmark(input({ ...base, segments: [segment({ series: SERIES_2023_2026, effectiveFrom: D('2025-06-01') })] }));
    noNumber(r);
    expect(r).toMatchObject({ reason: 'NO_MAPPING_FOR_START' });
  });
  it('the mapping ended before the valuation date', () => {
    const r = compareHoldingToBenchmark(input({ ...base, segments: [segment({ series: SERIES_2023_2026, effectiveTo: D('2025-06-30') })] }));
    noNumber(r);
    expect(r).toMatchObject({ reason: 'NO_MAPPING_FOR_END' });
  });
});

describe('RULE: never extrapolate benchmark history', () => {
  const flows = [{ date: D('2024-01-01'), amount: -10000 }];

  it('history starting after the investment date => "does not go back to your investment date", with the date it starts', () => {
    const series = daily('2024-06-01', '2026-01-10', expo('2023-01-01', 0.1));
    const r = compareHoldingToBenchmark(input({ flows, terminalValue: 12000, segments: [segment({ series })] }));
    expect(r).toMatchObject({ status: 'unavailable', reason: 'HISTORY_STARTS_AFTER_INVESTMENT' });
    expect((r as { detail: string }).detail).toMatch(/does not go back to your investment date/);
    expect((r as { detail: string }).detail).toMatch(/01-06-2024/); // day-first
    expect(JSON.stringify(r)).not.toMatch(/benchmarkReturn/);
  });

  it('a series that stops long before the valuation date is not carried forward; NEGATIVE CONTROL: the previous last-point-on-or-before rule happily returns a stale number for the same series', () => {
    const series = daily('2023-01-01', '2025-06-01', expo('2023-01-01', 0.1)); // ends 7 months early
    const r = compareHoldingToBenchmark(input({ flows, terminalValue: 12000, segments: [segment({ series })] }));
    expect(r).toMatchObject({ status: 'unavailable', reason: 'HISTORY_ENDS_BEFORE_VALUATION' });
    const legacy = benchmarkWindowReturn(series, D('2024-01-01'), D('2026-01-01'));
    expect(legacy.status).toBe('ok'); // the control would have printed a figure from a stale end level
  });

  it('a gap larger than the alignment window around a transaction => unavailable, not interpolated', () => {
    const pts = daily('2023-01-01', '2026-01-10', expo('2023-01-01', 0.1)).filter((p) => {
      const iso = p.date.toISOString().slice(0, 10);
      return iso < '2023-12-20' || iso > '2024-02-15';
    });
    const r = compareHoldingToBenchmark(input({ flows, terminalValue: 12000, segments: [segment({ series: pts })] }));
    expect(r).toMatchObject({ status: 'unavailable', reason: 'HISTORY_GAP' });
  });

  it('a transaction on a non-trading day executes at the next published level within the alignment window', () => {
    const pts = daily('2023-01-01', '2026-01-10', expo('2023-01-01', 0.1)).filter((p) => p.date.toISOString().slice(0, 10) !== '2024-01-01');
    const r = compareHoldingToBenchmark(input({ flows, terminalValue: 12000, segments: [segment({ series: pts })] }));
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    const lv = expo('2023-01-01', 0.1);
    expect(r.benchmarkEndingValue).toBeCloseTo((10000 / lv('2024-01-02')) * lv('2026-01-01'), 6);
  });
});

describe('RULE: a benchmark change inside the holding period is replayed segment by segment', () => {
  // Benchmark A rises linearly; B is a different index on a different scale.
  const levelA = (iso: string) => 100 + daysBetween('2023-01-01', iso) * 0.1;
  const levelB = (iso: string) => 5000 + daysBetween('2023-01-01', iso) * 2;
  const seriesA = daily('2023-01-01', '2026-01-10', levelA); // A's data continues past the change
  const seriesB = daily('2024-06-01', '2026-01-10', levelB);
  const change = '2025-01-01';
  const A = segment({ benchmarkId: 'a', benchmarkKey: 'IN_BSE_100_TRI', label: 'BSE 100 TRI', series: seriesA, effectiveFrom: D('2015-01-01'), effectiveTo: D('2024-12-31') });
  const B = segment({ benchmarkId: 'b', benchmarkKey: 'IN_NIFTY_100_TRI', label: 'NIFTY 100 TRI', series: seriesB, effectiveFrom: D(change), effectiveTo: null });
  const flows = [{ date: D('2024-01-01'), amount: -10000 }];

  it('holds A until the change date, converts the value into B at that date, then holds B to the end', () => {
    const r = compareHoldingToBenchmark(input({ flows, terminalValue: 12000, segments: [A, B] }));
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    const unitsA = 10000 / levelA('2024-01-01');
    const valueAtChange = unitsA * levelA(change);
    const unitsB = valueAtChange / levelB(change);
    expect(r.benchmarkEndingValue).toBeCloseTo(unitsB * levelB('2026-01-01'), 6);
    expect(r.segmentsUsed.map((s) => s.benchmarkKey)).toEqual(['IN_BSE_100_TRI', 'IN_NIFTY_100_TRI']);
    expect(r.notes.join(' ')).toMatch(/benchmark changed/);
    expect(r.notes.join(' ')).toMatch(/01-01-2025/); // day-first
  });

  it('NEGATIVE CONTROL: ignoring the change (using the first benchmark for the whole period) would give a different ending value', () => {
    const unitsA = 10000 / levelA('2024-01-01');
    const ignoringChange = unitsA * levelA('2026-01-01');
    const r = compareHoldingToBenchmark(input({ flows, terminalValue: 12000, segments: [A, B] }));
    if (r.status !== 'ok') throw new Error('expected ok');
    expect(Math.abs(ignoringChange - r.benchmarkEndingValue)).toBeGreaterThan(100);
  });

  it('says it cannot when the new benchmark has no data at the change date (no extrapolation)', () => {
    const lateB = segment({ benchmarkId: 'b', benchmarkKey: 'IN_NIFTY_100_TRI', label: 'NIFTY 100 TRI', series: daily('2025-06-01', '2026-01-10', levelB), effectiveFrom: D(change) });
    const r = compareHoldingToBenchmark(input({ flows, terminalValue: 12000, segments: [A, lateB] }));
    expect(r.status).toBe('unavailable');
    expect(JSON.stringify(r)).not.toMatch(/benchmarkReturn/);
  });

  it('refuses a gap or an overlap between the two mappings', () => {
    const gapB = { ...B, effectiveFrom: D('2025-03-01') };
    expect(compareHoldingToBenchmark(input({ flows, terminalValue: 12000, segments: [A, gapB] }))).toMatchObject({ reason: 'MAPPING_GAP' });
    const overlapA = { ...A, effectiveTo: D('2025-02-01') };
    expect(compareHoldingToBenchmark(input({ flows, terminalValue: 12000, segments: [overlapA, B] }))).toMatchObject({ reason: 'MAPPING_OVERLAP' });
  });

  it('a holding that started AFTER the change uses only the benchmark in force (no change note)', () => {
    const r = compareHoldingToBenchmark(input({ flows: [{ date: D('2025-03-03'), amount: -10000 }], terminalValue: 11000, segments: [A, B] }));
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.segmentsUsed).toHaveLength(1);
    expect(r.segmentsUsed[0].benchmarkKey).toBe('IN_NIFTY_100_TRI');
    expect(r.notes).toHaveLength(0);
  });
});

describe('splitTerminalFlow', () => {
  it('removes exactly the one synthetic terminal flow (by date and amount) and nothing else', () => {
    const flows = [
      { date: D('2024-01-01'), amount: -10000 },
      { date: D('2025-01-01'), amount: 12000 }, // a real redemption of the SAME amount on a different date
      { date: D('2026-01-01'), amount: 12000 }, // the terminal valuation flow
    ];
    const r = splitTerminalFlow(flows, 12000, D('2026-01-01'));
    expect(r.terminalValue).toBe(12000);
    expect(r.flows).toHaveLength(2);
    expect(r.flows[1].date.toISOString().slice(0, 10)).toBe('2025-01-01');
  });
  it('a fully redeemed holding has no terminal flow to remove', () => {
    const flows = [{ date: D('2024-01-01'), amount: -10000 }, { date: D('2025-01-01'), amount: 11000 }];
    expect(splitTerminalFlow(flows, 0, D('2026-01-01'))).toEqual({ flows, terminalValue: 0 });
  });
});
