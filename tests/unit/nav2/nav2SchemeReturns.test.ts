// NAV2 Stage 1 -- scheme-performance RETURNS against independently computed
// values (scripts/nav2_independent_oracle.py, 50-digit Decimal). Fixture A
// (growth scheme: absolute, CAGR on actual days, daily / log, rolling) and
// Fixture F (weekends, holidays, a long missing interval, a known coverage gap).
//
// Matrix rows: 10, 11, 12, 13, 14, 15 (and 7 / 8 in nav2SeriesPreparation).
//
// NAMED NEGATIVE CONTROLS
//   NC-R1  CAGR uses actual elapsed days, not a trading-day or whole-year assumption: the
//          exponent changes if one day is added, and the result differs from actual/365;
//   NC-R2  a boundary on a weekend uses the PREVIOUS valid NAV (never the next), and says so;
//   NC-R3  a boundary inside a long gap yields insufficient_history, never an interpolated NAV;
//   NC-R4  a single trailing return is not a rolling series: its summary statistics are withheld;
//   NC-R5  log returns are converted back (exp(sum) - 1) and equal the simple cumulative return;
//          adding log returns and calling it a percentage would be wrong (control computed below);
//   NC-R6  a window that contains a material gap is not turned into a periodic measure.
import { describe, expect, it } from 'vitest';
import { NAV2_POLICY, withPolicyOverrides } from '@/lib/config/nav2/metricPolicy';
import { absoluteReturn, cagr, dailyReturns, pointToPointReturn, rollingReturn } from '@/lib/engines/nav2/schemeReturns';
import { volatility } from '@/lib/engines/nav2/schemeRisk';
import { allStrings, buildSeries, ctxAud, ctxInr, expectClose, ISO_DATE_IN_TEXT, weekdays } from './support/fixtures';

describe('Fixture A1 -- spec worked example 1 (verbatim): 100 on 1 January 2023, 121 on 1 January 2025', () => {
  const s = buildSeries(['2023-01-01', '2025-01-01'], [100, 121]);

  it('absolute return = 21% (matrix 12)', () => {
    const r = absoluteReturn(s, ctxInr(), '2023-01-01', '2025-01-01');
    if (r.state !== 'available') throw new Error(r.state);
    expect(r.value.absoluteReturn).toBeCloseTo(0.21, 14);
    expect(r.value.startDate).toBe('2023-01-01');
    expect(r.value.endDate).toBe('2025-01-01');
    expect(r.value.boundarySubstituted).toBe(false);
  });

  it('CAGR uses the exact elapsed days: 731 days, 1.21^(365.2425/731) - 1 = 0.09992614035000286 (matrix 13)', () => {
    const r = cagr(s, ctxInr(), '2023-01-01', '2025-01-01');
    if (r.state !== 'available') throw new Error(r.state);
    expect(r.value.actualDays).toBe(731); // 365 (2023) + 366 (2024, a leap year): hand count
    expectClose(r.value.cagr, 0.099926140350002860); // oracle, 50-digit Decimal
    expectClose(r.value.yearsElapsed, 731 / 365.2425);
    expect(r.value.basis).toBe('scheme_nav_series');
    // "approximately 10% per year, subject to leap-year day count" (spec example 1)
    expect(r.value.cagr).toBeGreaterThan(0.0999);
    expect(r.value.cagr).toBeLessThan(0.1);
  });

  it('NC-R1: the figure depends on the actual day count (one more day changes it) and differs from the R4 actual/365 value', () => {
    const plusOne = buildSeries(['2023-01-01', '2025-01-02'], [100, 121]);
    const a = cagr(s, ctxInr(), '2023-01-01', '2025-01-01');
    const b = cagr(plusOne, ctxInr(), '2023-01-01', '2025-01-02');
    if (a.state !== 'available' || b.state !== 'available') throw new Error('available expected');
    expect(b.value.actualDays).toBe(732);
    expect(b.value.cagr).toBeLessThan(a.value.cagr);
    // R4's convention (actual/365) gives 0.09985658773828725 on the same input: the two conventions are DIFFERENT numbers.
    expect(Math.abs(a.value.cagr - 0.099856587738287252)).toBeGreaterThan(5e-5);
    // and the provenance names the convention used
    expect(a.provenance.convention.daysPerYear).toBe(365.2425);
  });

  it('under one year only the absolute return is shown (matrix 13: CAGR is not annualised for short periods)', () => {
    const short = buildSeries(['2025-01-01', '2025-07-01'], [100, 106]);
    const c = cagr(short, ctxInr(), '2025-01-01', '2025-07-01');
    expect(c.state).toBe('not_applicable');
    expect(c.state === 'not_applicable' && c.reason).toBe('period_under_one_year');
    const p = pointToPointReturn(short, ctxInr(), '2025-01-01', '2025-07-01');
    if (p.state !== 'available') throw new Error(p.state);
    expect(p.value.cagr).toBeNull();
    expect(p.value.absoluteReturn).toBeCloseTo(0.06, 14);
    expect(p.disclosures.map((d) => d.code)).toContain('cagr_not_shown_under_one_year');
  });
});

describe('Fixture A2 -- twelve weekday NAVs: daily simple and log returns (matrix 15)', () => {
  const dates = weekdays('2025-01-06', 12);
  const navs = [100, 102, 101, 105, 103, 107, 110, 108, 112, 111, 115, 120];
  const s = buildSeries(dates, navs);
  // oracle: simple_t = P_t / P_(t-1) - 1; log_t = ln(P_t / P_(t-1))
  const SIMPLE = [0.02, -0.0098039215686274510, 0.039603960396039604, -0.019047619047619048, 0.038834951456310680, 0.028037383177570093, -0.018181818181818182, 0.037037037037037037, -0.0089285714285714286, 0.036036036036036036, 0.043478260869565217];
  const LOG = [0.019802627296179713, -0.0098522964430116302, 0.038839833316263920, -0.019231361927887600, 0.038099846232270403, 0.027651531330510055, -0.018349138668196535, 0.036367644170874850, -0.0089686699827604070, 0.035401927050915930, 0.042559614418795929];

  it('returns are between CONSECUTIVE observations and match the oracle', () => {
    const r = dailyReturns(s, ctxInr());
    if (r.state !== 'available') throw new Error(r.state);
    expect(r.value.count).toBe(11);
    r.value.returns.forEach((row, i) => {
      expectClose(row.simple, SIMPLE[i], 1e-13);
      expectClose(row.log, LOG[i], 1e-13);
    });
    expect(r.value.returns[0]).toMatchObject({ startDate: '2025-01-06', date: '2025-01-07', intervalDays: 1 });
    expect(r.value.returns[4]).toMatchObject({ startDate: '2025-01-10', date: '2025-01-13', intervalDays: 3 }); // Friday to Monday: one return, three days, no synthetic Saturday / Sunday
  });

  it('NC-R5: log returns reconcile with simple returns (log = ln(1 + simple)) and exp(sum) - 1 equals the cumulative simple return 0.2', () => {
    const r = dailyReturns(s, ctxInr());
    if (r.state !== 'available') throw new Error(r.state);
    for (const row of r.value.returns) expectClose(row.log, Math.log(1 + row.simple), 1e-14);
    expectClose(r.value.cumulativeSimpleReturn, 0.2, 1e-13); // 120 / 100 - 1
    expectClose(r.value.cumulativeFromLogReturns, 0.2, 1e-13);
    // Control: the SUM of log returns is NOT the percentage return (0.18232155679395462 = ln 1.2).
    const sumLog = r.value.returns.reduce((a, x) => a + x.log, 0);
    expect(Math.abs(sumLog - 0.2)).toBeGreaterThan(0.01);
  });

  it('needs two observations; one is insufficient_history, never an empty "0%"', () => {
    const one = buildSeries(['2025-01-06'], [100]);
    const r = dailyReturns(one, ctxInr());
    expect(r.state).toBe('insufficient_history');
    expect('value' in r).toBe(false);
  });
});

describe('Fixture A4 -- thirteen month-start NAVs: rolling returns (matrix 14)', () => {
  const dates = ['2024-01-01', '2024-02-01', '2024-03-01', '2024-04-01', '2024-05-01', '2024-06-01', '2024-07-01', '2024-08-01', '2024-09-01', '2024-10-01', '2024-11-01', '2024-12-01', '2025-01-01'];
  const navs = [100, 102, 101, 105, 107, 104, 110, 112, 111, 115, 118, 117, 120];
  const s = buildSeries(dates, navs);
  const lowMin = withPolicyOverrides({ minimums: { rollingSummaryMinWindows: 3 } }, 'test-rolling-summary-3');

  it('1M windows: one per end date with a start a calendar month earlier; summary matches the oracle', () => {
    const r = rollingReturn(s, ctxInr(lowMin), '1M', { start: null, end: null }, { includeWindows: true });
    if (r.state !== 'available') throw new Error(r.state);
    const v = r.value;
    expect(v.windowCount).toBe(12);
    expect(v.measure).toBe('absolute'); // under 12 months: absolute, not annualised
    expect(v.firstEndpoint).toBe('2024-02-01');
    expect(v.lastEndpoint).toBe('2025-01-01');
    expect(v.endpointsBeforeFirstWindow).toBe(1); // 2024-01-01 has no earlier NAV: the history starts there
    expect(v.endpointsSkippedInside).toBe(0);
    expect(v.completeness).toBe('complete');
    const ORACLE = [0.02, -0.0098039215686274510, 0.039603960396039604, 0.019047619047619048, -0.028037383177570093, 0.057692307692307692, 0.018181818181818182, -0.0089285714285714286, 0.036036036036036036, 0.026086956521739130, -0.0084745762711864407, 0.025641025641025641];
    v.windows!.forEach((w, i) => expectClose(w.value, ORACLE[i], 1e-13));
    expect(v.windows![0]).toMatchObject({ startDate: '2024-01-01', endDate: '2024-02-01', startNav: 100, endNav: 102 });
    expect(v.summary).not.toBeNull();
    expectClose(v.summary!.min, -0.028037383177570093, 1e-13);
    expectClose(v.summary!.max, 0.057692307692307692, 1e-13);
    expectClose(v.summary!.mean, 0.015587105922552493, 1e-13);
    expectClose(v.summary!.median, 0.019523809523809524, 1e-13); // mean of the 6th and 7th ordered values
    expectClose(v.summary!.positiveWindowShare, 8 / 12, 1e-14); // 8 of 12 windows are positive (hand count)
  });

  it('3M windows match the oracle', () => {
    const r = rollingReturn(s, ctxInr(lowMin), '3M', { start: null, end: null }, { includeWindows: true });
    if (r.state !== 'available') throw new Error(r.state);
    const ORACLE = [0.05, 0.049019607843137255, 0.029702970297029703, 0.047619047619047619, 0.046728971962616822, 0.067307692307692308, 0.045454545454545455, 0.053571428571428571, 0.054054054054054054, 0.043478260869565217];
    expect(r.value.windowCount).toBe(10);
    r.value.windows!.forEach((w, i) => expectClose(w.value, ORACLE[i], 1e-13));
  });

  it('NC-R4: a single trailing return is NOT a rolling series -- the 1Y horizon has exactly one window and its summary is withheld', () => {
    const r = rollingReturn(s, ctxInr(), '1Y');
    if (r.state !== 'available') throw new Error(r.state);
    expect(r.value.windowCount).toBe(1);
    expect(r.value.measure).toBe('annualised_cagr');
    expect(r.value.summary).toBeNull();
    expect(r.disclosures.map((d) => d.code)).toContain('rolling_summary_withheld');
    // the one window: 2024-01-01 -> 2025-01-01 is 366 days; oracle 1.2^(365.2425/366) - 1
    const one = rollingReturn(s, ctxInr(), '1Y', { start: null, end: null }, { includeWindows: true });
    if (one.state !== 'available') throw new Error('available');
    expectClose(one.value.windows![0].value, 0.19954727040918235, 1e-13);
  });

  it('with the default policy (summary needs 60 windows) the 1M summary is withheld too; windows are still reported', () => {
    const r = rollingReturn(s, ctxInr(), '1M');
    if (r.state !== 'available') throw new Error(r.state);
    expect(r.value.windowCount).toBe(12);
    expect(r.value.summary).toBeNull();
  });

  it('a horizon with no complete window is insufficient_history; an unknown horizon is unsupported', () => {
    expect(rollingReturn(s, ctxInr(), '3Y').state).toBe('insufficient_history');
    const bad = rollingReturn(s, ctxInr(), '7Y');
    expect(bad.state).toBe('not_applicable');
    expect(bad.state === 'not_applicable' && bad.reason).toBe('unsupported_period');
  });
});

// ---------------------------------------------------------------------------
// Fixture F -- boundaries and gaps
// ---------------------------------------------------------------------------
const F_DATES = ['2025-01-01', '2025-01-02', '2025-01-03', '2025-01-06', '2025-01-07', '2025-01-08', '2025-01-09', '2025-01-10', '2025-02-25', '2025-02-26', '2025-02-27', '2025-02-28', '2025-03-03'];
const F_NAVS = [100, 101, 102, 103, 104, 105, 106, 107, 110, 111, 112, 113, 114];

describe('Fixture F -- weekends, a long missing interval, no interpolation', () => {
  it('NC-R2 / matrix 10: a Saturday start uses the previous valid NAV (Friday), discloses the actual date, dd-mm-yyyy for INR', () => {
    const s = buildSeries(F_DATES, F_NAVS);
    const r = pointToPointReturn(s, ctxInr(), '2025-01-04', '2025-02-25'); // 04-01-2025 is a Saturday
    if (r.state !== 'available') throw new Error(r.state);
    expect(r.value.startDate).toBe('2025-01-03');
    expect(r.value.startNav).toBe(102);
    expect(r.value.startOffsetDays).toBe(1);
    expect(r.value.endDate).toBe('2025-02-25');
    expect(r.value.boundarySubstituted).toBe(true);
    expect(r.value.actualDays).toBe(53); // 03-01 to 25-02: 28 + 25 days (hand count)
    expectClose(r.value.absoluteReturn, 0.078431372549019608, 1e-13); // 110 / 102 - 1
    expect(r.value.cagr).toBeNull();
    const sub = r.disclosures.find((d) => d.code === 'boundary_substitution');
    expect(sub?.detail).toContain('04-01-2025');
    expect(sub?.detail).toContain('03-01-2025');
    // and for an Australian context the same dates are dd/mm/yyyy
    const aud = pointToPointReturn(s, ctxAud(), '2025-01-04', '2025-02-25');
    expect(aud.disclosures.find((d) => d.code === 'boundary_substitution')?.detail).toContain('04/01/2025');
  });

  it('NC-R2 control: the NEXT valid NAV (Monday 103) is never used for a Saturday start', () => {
    const s = buildSeries(F_DATES, F_NAVS);
    const r = pointToPointReturn(s, ctxInr(), '2025-01-04', '2025-02-25');
    expect(r.state === 'available' && r.value.startNav).not.toBe(103);
  });

  it('NC-R3 / matrix 11: a boundary inside the 46-day gap has NO NAV within the lookup window: insufficient_history, no number', () => {
    const s = buildSeries(F_DATES, F_NAVS);
    const r = pointToPointReturn(s, ctxInr(), '2025-02-10', '2025-03-03');
    expect(r.state).toBe('insufficient_history');
    expect(r.state === 'insufficient_history' && r.reason).toBe('boundary_not_found');
    expect('value' in r).toBe(false);
    expect(r.state !== 'available' && r.detail).toContain('10-02-2025');
    // the same request while the fund's history is still being fetched answers history_hydrating
    const hydrating = buildSeries(F_DATES, F_NAVS, { hydrating: true });
    expect(pointToPointReturn(hydrating, ctxInr(), '2025-02-10', '2025-03-03').state).toBe('history_hydrating');
  });

  it('the lookup window is exactly boundaryLookupDays: 10 days back is found, 11 is not', () => {
    const s = buildSeries(['2025-01-01', '2025-02-01'], [100, 110]);
    const ok = pointToPointReturn(s, ctxInr(), '2025-01-01', '2025-02-11'); // 10 days after the last NAV
    const no = pointToPointReturn(s, ctxInr(), '2025-01-01', '2025-02-12'); // 11 days
    expect(ok.state).toBe('available');
    expect(no.state).toBe('insufficient_history');
  });

  it('daily returns mark the return that spans the gap (46 days) and say so; nothing is filled in', () => {
    const s = buildSeries(F_DATES, F_NAVS);
    const r = dailyReturns(s, ctxInr());
    if (r.state !== 'available') throw new Error(r.state);
    expect(r.value.count).toBe(12);
    const spanning = r.value.returns.filter((x) => x.spansMaterialGap);
    expect(spanning).toHaveLength(1);
    expect(spanning[0]).toMatchObject({ startDate: '2025-01-10', date: '2025-02-25', intervalDays: 46 });
    expectClose(spanning[0].simple, 110 / 107 - 1, 1e-13);
    expect(r.disclosures.map((d) => d.code)).toContain('material_gap_disclosed');
  });

  it('NC-R6: a periodic measure over a window containing the gap is insufficient_history (material_gap_in_window), but the same measure before the gap works', () => {
    const s = buildSeries(F_DATES, F_NAVS);
    const lenient = withPolicyOverrides({ minimums: { volatilityReturns: 3 } }, 'test-vol-3');
    const across = volatility(s, ctxInr(lenient), { start: '2025-01-01', end: '2025-03-03' });
    expect(across.state).toBe('insufficient_history');
    expect(across.state === 'insufficient_history' && across.reason).toBe('material_gap_in_window');
    expect(across.state !== 'available' && across.detail).toContain('46 days');
    const before = volatility(s, ctxInr(lenient), { start: '2025-01-01', end: '2025-01-10' });
    expect(before.state).toBe('available');
    // control: the DEFAULT policy needs 30 returns, so even a clean 7-return stretch is refused
    expect(volatility(s, ctxInr(), { start: '2025-01-01', end: '2025-01-10' }).state).toBe('insufficient_history');
  });

  it('a requested window the history does not reach is window_not_covered, never a shorter window under the requested label', () => {
    const s = buildSeries(F_DATES, F_NAVS);
    const lenient = withPolicyOverrides({ minimums: { volatilityReturns: 3 } }, 'test-vol-3');
    const r = volatility(s, ctxInr(lenient), { start: '2024-06-01', end: '2025-01-10' });
    expect(r.state).toBe('insufficient_history');
    expect(r.state === 'insufficient_history' && r.reason).toBe('window_not_covered');
  });

  it('the known-source-gap style (an unrecoverable AMFI / TIGZIG period) is disclosed when the window overlaps it, with day-first dates', () => {
    const s = buildSeries(F_DATES, F_NAVS, { gaps: [{ from: '2025-01-11', to: '2025-02-24', reasonCode: 'fund_house_transition' }] });
    const r = pointToPointReturn(s, ctxInr(), '2025-01-03', '2025-02-25');
    if (r.state !== 'available') throw new Error(r.state);
    const d = r.disclosures.find((x) => x.code === 'unrecoverable_history_period');
    expect(d?.detail).toContain('11-01-2025');
    expect(d?.detail).toContain('24-02-2025');
    // a window entirely after the gap carries no such disclosure
    const clean = pointToPointReturn(s, ctxInr(), '2025-02-26', '2025-03-03');
    if (clean.state !== 'available') throw new Error(clean.state);
    expect(clean.disclosures.map((x) => x.code)).not.toContain('unrecoverable_history_period');
  });

  it('IDCW / dividend options carry the NAV-only disclosure on a return; a growth option does not', () => {
    const idcw = buildSeries(['2025-01-01', '2025-01-31'], [100, 101], { identity: { optionType: 'idcw' } });
    const growth = buildSeries(['2025-01-01', '2025-01-31'], [100, 101]);
    expect(pointToPointReturn(idcw, ctxInr(), '2025-01-01', '2025-01-31').disclosures.map((d) => d.code)).toContain('nav_only_distribution_option');
    expect(pointToPointReturn(growth, ctxInr(), '2025-01-01', '2025-01-31').disclosures.map((d) => d.code)).not.toContain('nav_only_distribution_option');
  });
});

describe('user-visible text never carries an ISO date', () => {
  it('every sentence the returns engine produces (details, disclosures) is dd-mm-yyyy for INR and dd/mm/yyyy for AUD', () => {
    const s = buildSeries(F_DATES, F_NAVS, { gaps: [{ from: '2025-01-11', to: '2025-02-24', reasonCode: 'x' }] });
    const outputs = [
      pointToPointReturn(s, ctxInr(), '2025-01-04', '2025-02-25'),
      pointToPointReturn(s, ctxInr(), '2025-02-10', '2025-03-03'),
      pointToPointReturn(s, ctxAud(), '2025-01-04', '2025-02-25'),
      dailyReturns(s, ctxInr()),
      volatility(s, ctxInr(), { start: '2025-01-01', end: '2025-03-03' }),
    ];
    for (const o of outputs) {
      const texts = [...(o.state === 'available' ? [] : [o.detail]), ...o.disclosures.map((d) => d.detail)];
      for (const t of texts) expect(t, t).not.toMatch(ISO_DATE_IN_TEXT);
    }
    // negative control: the detector does flag an ISO date
    expect(ISO_DATE_IN_TEXT.test('history starts on 2025-01-06')).toBe(true);
    expect(allStrings({ a: ['x', { b: 'y' }] })).toEqual(['x', 'y']);
    expect(NAV2_POLICY.boundaryLookupDays).toBe(10);
  });
});
