// NAV2 Stage 1 -- SMA / EMA / ROC, highest / lowest / mean / median NAV, and the
// ranking among HELD schemes, against hand-derived and oracle values (Fixture A2
// twelve weekday NAVs 100, 102, 101, 105, 103, 107, 110, 108, 112, 111, 115, 120
// from 06-01-2025; scripts/nav2_independent_oracle.py section A2).
//
// Matrix rows: 23, 24, 26, 27.
//
// NAMED NEGATIVE CONTROLS
//   NC-T1  no SMA / EMA value exists before the N-observation warm-up (insufficient_history);
//   NC-T2  periods are OBSERVATIONS: a gap in the calendar does not stretch the average (control: same
//          NAVs on irregular dates give the same SMA), and only approved periods are accepted;
//   NC-T3  EMA is seeded with the SMA of the first N observations (not with the first price);
//   NC-T4  ties for the highest / lowest NAV report the EARLIEST date, deterministically;
//   NC-T5  ranking: no market ranking -- the label is "Your held schemes", schemes in different
//          categories / plans / options / horizons are never ranked together, a lone scheme is "not
//          comparable", unavailable metrics are excluded not ranked, ties break by instrument id.
import { describe, expect, it } from 'vitest';
import { NAV2_METRICS, withPolicyOverrides } from '@/lib/config/nav2/metricPolicy';
import { HELD_RANKING_LABEL, rankHeldSchemes, type RankingCandidate } from '@/lib/engines/nav2/heldRanking';
import { ema, navAverage, navExtremes, roc, sma } from '@/lib/engines/nav2/schemeTrend';
import { buildSeries, ctxInr, expectClose, weekdays } from './support/fixtures';

const DATES = weekdays('2025-01-06', 12);
const NAVS = [100, 102, 101, 105, 103, 107, 110, 108, 112, 111, 115, 120];
const small = withPolicyOverrides({ movingAveragePeriods: [3, 5] }, 'test-ma-3-5');
const s = buildSeries(DATES, NAVS);

describe('SMA (matrix 23)', () => {
  it('SMA3 over 12 observations: ten points from the third observation, matching the oracle', () => {
    const r = sma(s, ctxInr(small), 3);
    if (r.state !== 'available') throw new Error(r.state);
    const ORACLE = [101, 102.66666666666667, 103, 105, 106.66666666666667, 108.33333333333333, 110, 110.33333333333333, 112.66666666666667, 115.33333333333333];
    expect(r.value.pointCount).toBe(10);
    r.value.points.forEach((p, i) => expectClose(p.value, ORACLE[i], 1e-13));
    expect(r.value.points[0].date).toBe(DATES[2]);
    expect(r.value.latest).toEqual({ date: '2025-01-21', value: r.value.latest.value });
    expect(r.value.firstDefinedDate).toBe(DATES[2]);
    expect(r.value.basis).toBe('observations');
    expect(r.provenance.convention.label).toBe('observations_not_calendar_days');
  });

  it('SMA5 latest = (107 + 108 + 112 + 111 + 115 + 120 ... last five) = 113.2 (hand: 108 + 112 + 111 + 115 + 120 = 566; / 5)', () => {
    const r = sma(s, ctxInr(small), 5);
    if (r.state !== 'available') throw new Error(r.state);
    expectClose(r.value.latest.value, 113.2, 1e-13);
  });

  it('NC-T1: before the warm-up there is no SMA: 2 observations cannot give SMA3, and 12 cannot give the default SMA20', () => {
    const two = buildSeries(DATES.slice(0, 2), NAVS.slice(0, 2));
    const r = sma(two, ctxInr(small), 3);
    expect(r.state).toBe('insufficient_history');
    expect('value' in r).toBe(false);
    expect(sma(s, ctxInr(), 20).state).toBe('insufficient_history'); // approved period, not enough observations
  });

  it('NC-T2: only approved periods are accepted (default 20 / 50 / 100 / 200); 21 is unsupported', () => {
    const r = sma(s, ctxInr(), 21);
    expect(r.state).toBe('not_applicable');
    expect(r.state === 'not_applicable' && r.reason).toBe('unsupported_period');
  });

  it('NC-T2: observations, not calendar days -- the same NAVs on irregular dates give the same SMA', () => {
    const irregular = buildSeries(['2025-01-06', '2025-01-08', '2025-01-20', '2025-01-21', '2025-02-10', '2025-02-11'], [100, 102, 101, 105, 103, 107]);
    const regular = buildSeries(weekdays('2025-01-06', 6), [100, 102, 101, 105, 103, 107]);
    const a = sma(irregular, ctxInr(small), 3);
    const b = sma(regular, ctxInr(small), 3);
    if (a.state !== 'available' || b.state !== 'available') throw new Error('available expected');
    expect(a.value.points.map((p) => p.value)).toEqual(b.value.points.map((p) => p.value));
  });

  it('closed form with the DEFAULT policy: SMA20 of 100 + i for 25 observations ends at 100 + (5 + 24)/2 = 114.5', () => {
    const d = weekdays('2025-01-06', 25);
    const r = sma(buildSeries(d, d.map((_, i) => 100 + i)), ctxInr(), 20);
    if (r.state !== 'available') throw new Error(r.state);
    expectClose(r.value.latest.value, 114.5, 1e-13);
    expect(r.value.pointCount).toBe(6);
    expect(r.value.firstDefinedDate).toBe(d[19]);
  });

  it('computes over the whole series but returns only the requested window (warm-up uses earlier data)', () => {
    const r = sma(s, ctxInr(small), 3, { start: '2025-01-14', end: '2025-01-21' });
    if (r.state !== 'available') throw new Error(r.state);
    expect(r.value.points.map((p) => p.date)).toEqual(DATES.slice(6)); // 14-01 .. 21-01
    expectClose(r.value.points[0].value, 320 / 3, 1e-13); // hand: the third SMA3 point ending 14-01 is (103 + 107 + 110) / 3 = 106.667
  });
});

describe('EMA (matrix 23)', () => {
  it('EMA3: multiplier 2/(3+1) = 0.5, seeded with the SMA of the first three observations (101), matching the oracle', () => {
    const r = ema(s, ctxInr(small), 3);
    if (r.state !== 'available') throw new Error(r.state);
    // hand: seed 101 at obs 3; then 105 x .5 + 101 x .5 = 103; 103; 107 -> 105; 110 -> 107.5; 108 -> 107.75; 112 -> 109.875; 111 -> 110.4375; 115 -> 112.71875; 120 -> 116.359375
    const ORACLE = [101, 103, 103, 105, 107.5, 107.75, 109.875, 110.4375, 112.71875, 116.359375];
    expect(r.value.points.map((p) => p.value)).toEqual(ORACLE);
    expect(r.value.points[0].date).toBe(DATES[2]);
    expect(r.provenance.convention).toMatchObject({ multiplier: 0.5, seed: 'sma_of_first_n_observations', period: 3 });
  });

  it('NC-T3: seeding with the first PRICE (100) instead of the SMA of the first N would give a different series (control, EMA5)', () => {
    const r = ema(s, ctxInr(small), 5);
    if (r.state !== 'available') throw new Error(r.state);
    const m = 2 / 6;
    // hand: seed = SMA5 of (100, 102, 101, 105, 103) = 102.2 at the fifth observation
    expectClose(r.value.points[0].value, 102.2, 1e-13);
    let wrong = 100; // the wrong seed: the first price, recursed from the second observation
    for (let i = 1; i < 12; i++) wrong = NAVS[i] * m + wrong * (1 - m);
    expect(Math.abs(r.value.latest.value - wrong)).toBeGreaterThan(0.01); // the seed's influence decays but is still visible; the exact first point (102.2) is the sharper check
  });

  it('NC-T1: no EMA before the N-observation warm-up', () => {
    const two = buildSeries(DATES.slice(0, 2), NAVS.slice(0, 2));
    expect(ema(two, ctxInr(small), 3).state).toBe('insufficient_history');
  });
});

describe('ROC (matrix 24)', () => {
  it('ROC5 = P_t / P_(t-5) - 1 on observations, matching the oracle; first value at the sixth observation', () => {
    const r = roc(s, ctxInr(), 5);
    if (r.state !== 'available') throw new Error(r.state);
    const ORACLE = [0.07, 0.078431372549019608, 0.069306930693069307, 0.066666666666666667, 0.077669902912621359, 0.074766355140186916, 0.090909090909090909];
    expect(r.value.points.map((p) => p.value).length).toBe(7);
    r.value.points.forEach((p, i) => expectClose(p.value, ORACLE[i], 1e-13));
    expect(r.value.points[0].date).toBe(DATES[5]);
    expect(r.value.basis).toBe('observations'); // N is a count of valid observations, not calendar days
  });

  it('needs N + 1 observations; N must be a whole number from 1', () => {
    expect(roc(buildSeries(DATES.slice(0, 5), NAVS.slice(0, 5)), ctxInr(), 5).state).toBe('insufficient_history'); // 5 observations, ROC5 needs 6
    expect(roc(s, ctxInr(), 0).state).toBe('not_applicable');
    expect(roc(s, ctxInr(), 1.5).state).toBe('not_applicable');
    expect(roc(s, ctxInr(), 1).state).toBe('available');
  });
});

describe('highest / lowest / mean / median NAV (matrix 27)', () => {
  it('high 120 on 21-01-2025, low 100 on 06-01-2025, mean 107.8333, median 107.5 (mean of the 6th and 7th ordered values), 12 observations', () => {
    const e = navExtremes(s, ctxInr());
    const a = navAverage(s, ctxInr());
    if (e.state !== 'available' || a.state !== 'available') throw new Error('available expected');
    expect(e.value).toMatchObject({ highestNav: 120, highestNavDate: '2025-01-21', lowestNav: 100, lowestNavDate: '2025-01-06', observationCount: 12, periodStart: '2025-01-06', periodEnd: '2025-01-21' });
    expectClose(a.value.meanNav, 107.83333333333333, 1e-13);
    expect(a.value.medianNav).toBe(107.5);
    expect(a.value.observationCount).toBe(12);
    expect(a.value.observationFrequency).toBe('daily');
    expect(e.disclosures.map((d) => d.code)).toContain('not_a_recommendation');
    expect(e.disclosures.find((d) => d.code === 'not_a_recommendation')?.detail).toContain('lower NAV does not mean a cheaper');
  });

  it('NC-T4: ties report the EARLIEST occurrence, deterministically (and an odd count has a single middle value)', () => {
    const d = weekdays('2025-01-06', 7);
    const tied = buildSeries(d, [100, 105, 105, 100, 99, 99, 105]);
    const e = navExtremes(tied, ctxInr());
    if (e.state !== 'available') throw new Error(e.state);
    expect(e.value.highestNavDate).toBe(d[1]);
    expect(e.value.lowestNavDate).toBe(d[4]);
    const a = navAverage(tied, ctxInr());
    expect(a.state === 'available' && a.value.medianNav).toBe(100); // sorted 99 99 100 100 105 105 105 -> 4th value
    expect(JSON.stringify(navExtremes(tied, ctxInr()))).toBe(JSON.stringify(e)); // deterministic
  });

  it('respects the window: the extremes of a sub-period are those of that sub-period', () => {
    const e = navExtremes(s, ctxInr(), { start: '2025-01-06', end: '2025-01-10' });
    if (e.state !== 'available') throw new Error(e.state);
    expect(e.value).toMatchObject({ highestNav: 105, highestNavDate: '2025-01-09', lowestNav: 100, observationCount: 5 });
  });
});

describe('ranking among HELD schemes only (matrix 26)', () => {
  const cand = (id: string, over: Partial<RankingCandidate> = {}): RankingCandidate => ({
    instrumentId: id,
    category: 'large_cap',
    planType: 'direct',
    optionType: 'growth',
    horizonId: '1Y',
    metricId: 'cagr',
    metricDefinitionVersion: NAV2_METRICS.cagr.version,
    state: 'available',
    value: 0.1,
    ...over,
  });

  it('NC-T5: ranks only comparable schemes, labelled "Your held schemes", with population and as-of date; others are not comparable / excluded', () => {
    const r = rankHeldSchemes(
      [
        cand('lc-1', { value: 0.15 }),
        cand('lc-2', { value: 0.12 }),
        cand('liquid-1', { category: 'liquid', value: 0.07 }), // alone in its category
        cand('lc-idcw', { optionType: 'idcw', value: 0.2 }), // same category, different option: never compared with growth
        cand('lc-regular', { planType: 'regular', value: 0.18 }), // regular plan: never compared with direct
        cand('lc-3y', { horizonId: '3Y', value: 0.11 }), // different horizon
        cand('lc-unavail', { state: 'insufficient_history', value: null }),
        cand('no-category', { category: null, value: 0.3 }),
      ],
      '2026-10-03',
      ctxInr()
    );
    if (r.state !== 'available') throw new Error(r.state);
    expect(r.value.label).toBe('Your held schemes');
    expect(r.value.label).toBe(HELD_RANKING_LABEL);
    expect(r.value.asOfDate).toBe('2026-10-03');
    expect(r.value.populationSize).toBe(8);
    expect(r.value.groups).toHaveLength(1); // only the two direct-growth large-cap 1Y CAGR schemes are comparable
    expect(r.value.groups[0].rows.map((x) => [x.instrumentId, x.rank])).toEqual([['lc-1', 1], ['lc-2', 2]]);
    expect(r.value.groups[0].populationSize).toBe(2);
    expect(r.value.notComparable).toEqual([
      { instrumentId: 'lc-3y', reason: 'no_comparable_peer' },
      { instrumentId: 'lc-idcw', reason: 'no_comparable_peer' },
      { instrumentId: 'lc-regular', reason: 'no_comparable_peer' },
      { instrumentId: 'liquid-1', reason: 'no_comparable_peer' },
      { instrumentId: 'no-category', reason: 'category_unknown' },
    ]);
    expect(r.value.excluded).toEqual([{ instrumentId: 'lc-unavail', state: 'insufficient_history' }]);
    // never a market ranking
    expect(JSON.stringify(r)).not.toMatch(/market ranking|best funds|top funds/i);
  });

  it('an equity fund is never ranked against a debt or liquid fund: with no comparable peer at all the result is not_applicable', () => {
    const r = rankHeldSchemes([cand('eq', { category: 'large_cap' }), cand('debt', { category: 'corporate_bond' }), cand('liq', { category: 'liquid' })], '2026-10-03', ctxInr());
    expect(r.state).toBe('not_applicable');
    expect(r.state === 'not_applicable' && r.reason).toBe('no_comparable_peer');
    expect('value' in r).toBe(false);
  });

  it('ties break deterministically by instrument id and are flagged; the order does not depend on input order', () => {
    const a = rankHeldSchemes([cand('b', { value: 0.1 }), cand('a', { value: 0.1 }), cand('c', { value: 0.2 })], '2026-10-03', ctxInr());
    const b = rankHeldSchemes([cand('c', { value: 0.2 }), cand('a', { value: 0.1 }), cand('b', { value: 0.1 })], '2026-10-03', ctxInr());
    if (a.state !== 'available' || b.state !== 'available') throw new Error('available expected');
    expect(a.value.groups[0].rows).toEqual([
      { rank: 1, instrumentId: 'c', value: 0.2, tied: false },
      { rank: 2, instrumentId: 'a', value: 0.1, tied: true },
      { rank: 3, instrumentId: 'b', value: 0.1, tied: true },
    ]);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('a different metric definition version is a different group (never ranks values from two definitions together)', () => {
    const r = rankHeldSchemes([cand('a', { value: 0.1 }), cand('b', { value: 0.2, metricDefinitionVersion: 'cagr-other-v2' })], '2026-10-03', ctxInr());
    expect(r.state).toBe('not_applicable');
  });
});
