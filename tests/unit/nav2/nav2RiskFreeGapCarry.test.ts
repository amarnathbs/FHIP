// NAV2 Stage 2 (PO decision 04-10-2026) -- documented RBI gaps and window-level availability of the risk-free rate.
//
// THE RULES UNDER TEST
//   1. A GAP row means "no cut-off exists for that date". A weekly rate carries forward across documented gap rows for at most
//      policy.riskFreeGaps.maxCarryAcrossDocumentedGapDays (35) calendar days from the last VALUE observation, and only while the records
//      (the value, each gap row, the date) are no more than documentedGapMaxRecordSpacingDays (14) apart. It is labelled "carried across a
//      documented RBI gap". An undocumented hole never carries; beyond the limit the date has no rate. The 21-day staleness window stays
//      the general rule.
//   2. A ratio no longer fails because ONE date has no rate. It is computed over the return observations that have a rate, provided at
//      least policy.riskFreeGaps.minWindowCoverageShare (95%) of the window's return observations do; otherwise risk_free_missing. The
//      count of left-out observations is disclosed and stored in the provenance. (Before this change the first date without a rate made
//      the whole ratio risk_free_missing.)
//
// NAMED NEGATIVE CONTROLS
//   NC-G1  a documented gap carries the last value (and the same stretch WITHOUT the gap rows does not): the carry is caused by the gap rows;
//   NC-G2  an undocumented hole inside the stretch does not carry, even when a gap row exists elsewhere in it;
//   NC-G3  the 35-day limit holds: day 35 carries, day 36 does not, however many gap rows exist;
//   NC-G4  a gap row is never used as a value: the carried observation is the last real one;
//   NC-G5  a long window with 2 dates lacking a rate still computes, over the others, with the exclusion disclosed and a hand-computed value;
//   NC-G6  coverage of exactly 95% computes, 94% is risk_free_missing (the boundary is inclusive and exact);
//   NC-G7  Sortino and alpha follow the same rule on the same observations.
import { describe, expect, it } from 'vitest';
import { NAV2_POLICY, withPolicyOverrides } from '@/lib/config/nav2/metricPolicy';
import { matchRiskFree, periodicRiskFreeReturn, riskFreeObservationOn, type RiskFreeLookupRule } from '@/lib/engines/nav2/riskFree';
import { jensenAlpha, sharpeRatio, sortinoRatio } from '@/lib/engines/nav2/schemeRisk';
import { buildReturns } from '@/lib/engines/nav2/series';
import { addDays, buildSeries, ctxInr, expectClose, pathFromReturns, weekdays } from './support/fixtures';
import { dataset, fixtureB, obs } from './support/riskFreeFixtures';

const gap = (date: string, reason: 'no_accepted_bids' | 'no_auction_held' | 'no_row_in_source' = 'no_row_in_source') => ({ ...obs(date, 0), yieldPercent: null, kind: 'gap' as const, gapReason: reason });
const RULE = (gapDates: string[]): RiskFreeLookupRule => ({
  cadence: 'weekly_auction',
  maxStalenessDays: 21,
  verifiedThroughDate: null,
  gapCarry: { gapDates, maxCarryDays: 35, maxRecordSpacingDays: 14 },
});
const values = [obs('2025-01-01', 6.5), obs('2025-02-05', 6.0)];
const weeklyGaps = ['2025-01-08', '2025-01-15', '2025-01-22', '2025-01-29'];

describe('the policy constants are named and versioned', () => {
  it('35 days, 14 days between records, 95% coverage', () => {
    expect(NAV2_POLICY.riskFreeGaps).toEqual({ maxCarryAcrossDocumentedGapDays: 35, documentedGapMaxRecordSpacingDays: 14, minWindowCoverageShare: 0.95 });
    expect(withPolicyOverrides({ riskFreeGaps: { minWindowCoverageShare: 0.9 } }, 'unit').riskFreeGaps).toEqual({ maxCarryAcrossDocumentedGapDays: 35, documentedGapMaxRecordSpacingDays: 14, minWindowCoverageShare: 0.9 });
  });
});

describe('lookup across documented gaps', () => {
  it('NC-G1: day 33 after the last value carries across the documented gap rows; without the gap rows the same date is stale', () => {
    const withGaps = riskFreeObservationOn([values[0]], '2025-02-03', RULE(weeklyGaps));
    expect(withGaps).toMatchObject({ ok: true, ageDays: 33, carriedAcrossGapDates: weeklyGaps });
    if (withGaps.ok) expect(withGaps.observation.observationDate).toBe('2025-01-01');
    expect(riskFreeObservationOn([values[0]], '2025-02-03', RULE([]))).toEqual({ ok: false, reason: 'stale' });
    expect(riskFreeObservationOn([values[0]], '2025-02-03', { ...RULE([]), gapCarry: undefined })).toEqual({ ok: false, reason: 'stale' });
  });

  it('within the 21-day staleness window nothing is flagged as carried (the general rule is unchanged)', () => {
    const r = riskFreeObservationOn([values[0]], '2025-01-22', RULE(weeklyGaps));
    expect(r).toMatchObject({ ok: true, ageDays: 21 });
    expect(r.ok && r.carriedAcrossGapDates).toBeUndefined();
  });

  it('NC-G2: an undocumented hole does not carry, even with a gap row elsewhere in the stretch', () => {
    // value 01-01, one gap row 01-08, nothing documented after it: 01-30 is 22 days past the last record
    expect(riskFreeObservationOn([values[0]], '2025-01-30', RULE(['2025-01-08']))).toEqual({ ok: false, reason: 'stale' });
    // a hole in the MIDDLE: 01-08 and 01-29 documented, 01-15 and 01-22 not
    expect(riskFreeObservationOn([values[0]], '2025-02-03', RULE(['2025-01-08', '2025-01-29']))).toEqual({ ok: false, reason: 'stale' });
    // control: documenting the whole stretch makes the same date carry
    expect(riskFreeObservationOn([values[0]], '2025-01-30', RULE(weeklyGaps)).ok).toBe(true);
  });

  it('NC-G3: day 35 carries, day 36 does not, however many gap rows exist', () => {
    const many = [...weeklyGaps, '2025-02-05', '2025-02-12'];
    expect(riskFreeObservationOn([values[0]], '2025-02-05', RULE(many)).ok).toBe(true); // 35 days
    expect(riskFreeObservationOn([values[0]], '2025-02-06', RULE(many))).toEqual({ ok: false, reason: 'stale' }); // 36 days
  });

  it('a date after the last record is still covered while it is within 14 days of it (the next auction is simply not yet known)', () => {
    expect(riskFreeObservationOn([values[0]], '2025-01-31', RULE(weeklyGaps)).ok).toBe(true); // 2 days after the last gap row
    expect(riskFreeObservationOn([values[0]], '2025-02-04', RULE(['2025-01-08', '2025-01-15', '2025-01-22'])).ok).toBe(true); // 13 days past the last gap row, 34 days old: within both limits
    expect(riskFreeObservationOn([values[0]], '2025-02-02', RULE(['2025-01-08', '2025-01-15'])).ok).toBe(false); // 18 days past the last gap row: an undocumented stretch
  });

  it('NC-G4: the carried observation is the last real value, never a gap row, and a gap row alone never provides a rate', () => {
    const only = riskFreeObservationOn([], '2025-01-10', RULE(['2025-01-08']));
    expect(only).toEqual({ ok: false, reason: 'none_on_or_before' });
  });
});

describe('matching a window: provenance and disclosure of a carry', () => {
  it('says the rate was carried across a documented RBI gap, with the count, the dates and the limit', () => {
    const ds = dataset({ observations: [values[0], ...weeklyGaps.map((d) => gap(d)), values[1], obs('2025-02-12', 6.0), obs('2025-02-19', 6.0)] });
    const ret = buildReturns(weekdays('2025-01-31', 12).map((date, i) => ({ date, value: 100 + i })));
    const m = matchRiskFree(ret, ds, ctxInr(), 'sharpe_ratio', {}, 'daily');
    expect(m.ok).toBe(true);
    if (!m.ok) throw new Error('unreachable');
    expect(m.provenance.periodsCarriedAcrossDocumentedGap).toBe(3); // starts 31-01 (30 days old), 03-02 (33) and 04-02 (34); 05-02 has its own value
    expect(m.provenance.documentedGapDatesCrossed).toEqual(weeklyGaps);
    expect(m.provenance.maxCarryAcrossDocumentedGapDays).toBe(35);
    expect(m.provenance.disclosureText).toContain('carried across a documented RBI gap');
    const d = m.disclosures.find((x) => x.code === 'risk_free_carried_across_documented_gap');
    expect(d?.detail).toMatch(/carried across a documented RBI gap/);
    expect(d?.detail).toMatch(/08-01-2025/);
    expect(d?.detail).toMatch(/at most 35 days/);
    expect(d?.detail).not.toMatch(/\b\d{4}-\d{2}-\d{2}\b/);
    expect(m.provenance.periodsExcluded).toBe(0);
  });
});

/** An independent hand computation: the rate in force is the latest value observation on or before the date, none older than 21 days. */
function handSharpe(dates: string[], navs: number[], observations: Array<{ d: string; y: number }>): { sharpe: number; kept: number } {
  const excess: number[] = [];
  for (let i = 1; i < dates.length; i++) {
    const start = dates[i - 1];
    const inForce = [...observations].filter((o) => o.d <= start).sort((a, b) => (a.d < b.d ? 1 : -1))[0];
    if (!inForce || (Date.parse(`${start}T00:00:00Z`) - Date.parse(`${inForce.d}T00:00:00Z`)) / 86_400_000 > 21) continue;
    excess.push(navs[i] / navs[i - 1] - 1 - (Math.pow(1 + inForce.y / 100, 1 / 252) - 1));
  }
  const mean = excess.reduce((s, x) => s + x, 0) / excess.length;
  const sd = Math.sqrt(excess.reduce((s, x) => s + (x - mean) ** 2, 0) / (excess.length - 1));
  return { sharpe: (mean / sd) * Math.sqrt(252), kept: excess.length };
}

/** Weekly values on every Wednesday from `from` to `to`, except those in `skip`. */
function weeklyValues(from: string, to: string, y: (d: string) => number, skip: string[] = []) {
  const out: Array<{ d: string; y: number }> = [];
  for (let d = from; d <= to; d = addDays(d, 7)) if (!skip.includes(d)) out.push({ d, y: y(d) });
  return out;
}

describe('window-level availability (NC-G5, NC-G6)', () => {
  const dates = weekdays('2024-12-02', 420); // Mon 02-12-2024 onward
  const navs = pathFromReturns(100, Array.from({ length: dates.length - 1 }, (_, i) => 0.0004 + 0.008 * Math.sin(i * 0.37) * Math.cos(i * 0.11)));
  const series = buildSeries(dates, navs);
  const toDs = (list: Array<{ d: string; y: number }>, extra = [] as ReturnType<typeof gap>[]) => dataset({ retrievedOn: '2026-10-03', observations: [...list.map((o) => obs(o.d, o.y, { retrievedOn: '2026-10-03' })), ...extra] });
  const yOf = (d: string) => 5 + (Date.parse(`${d}T00:00:00Z`) % 7) * 0.1; // varies week to week, deterministic

  it('NC-G5: a long window with 2 dates lacking a rate still computes over the others, discloses the 2 left out, and matches the hand computation', () => {
    // Wednesday 05-03-2025 is the last value before a 26-day hole; the next value is Monday 31-03-2025: 27-03 and 28-03 (Thu, Fri) have no rate
    const list = weeklyValues('2024-11-27', '2026-07-01', yOf, ['2025-03-12', '2025-03-19', '2025-03-26']).concat([{ d: '2025-03-31', y: yOf('2025-03-31') }]).sort((a, b) => (a.d < b.d ? -1 : 1));
    const r = sharpeRatio(series, ctxInr(), toDs(list), { start: null, end: null }, 'daily');
    expect(r.state).toBe('available');
    if (r.state !== 'available') throw new Error(r.state);
    const rf = r.provenance.riskFree!;
    expect(rf.periodsExcluded).toBe(2);
    expect(rf.excludedDates).toEqual(['2025-03-27', '2025-03-28']);
    expect(rf.windowReturnCount).toBe(dates.length - 1);
    expect(rf.windowCoverageShare).toBeCloseTo((dates.length - 3) / (dates.length - 1), 12);
    expect(r.value.returnCount).toBe(dates.length - 3);
    const hand = handSharpe(dates, navs, list);
    expect(hand.kept).toBe(dates.length - 3);
    expectClose(r.value.annualisedRatio, hand.sharpe, 1e-10);
    const note = r.disclosures.find((d) => d.code === 'risk_free_periods_excluded');
    expect(note?.detail).toMatch(/2 of 419 return periods/);
    expect(note?.detail).toMatch(/27-03-2025/);
    expect(note?.detail).not.toMatch(/\b\d{4}-\d{2}-\d{2}\b/);
  });

  it('NC-G6: exactly 95% of the window computes; 94% is risk_free_missing, with the counts in the sentence', () => {
    const ds100 = weekdays('2025-01-06', 101); // 100 returns
    const n100 = pathFromReturns(100, Array.from({ length: 100 }, (_, i) => 0.0005 + 0.007 * Math.sin(i * 0.5)));
    const s100 = buildSeries(ds100, n100);
    // value 01-01, then the next value after N weekday starts without a rate (21-day staleness ends 22-01), then weekly values to the end
    const make = (unavailableStarts: number) => {
      const weekdaysAfter = weekdays('2025-01-23', unavailableStarts + 1); // 23-01, 24-01, ...
      const next = weekdaysAfter[unavailableStarts]; // the (N+1)th weekday: a value is published on it
      return weeklyValues('2025-01-01', '2025-01-01', yOf).concat([{ d: next, y: yOf(next) }], weeklyValues(addDays(next, 7), '2025-07-30', yOf));
    };
    const ok = sharpeRatio(s100, ctxInr(), toDs(make(5)), { start: null, end: null }, 'daily');
    expect(ok.state).toBe('available');
    expect(ok.state === 'available' && ok.provenance.riskFree).toMatchObject({ periodsExcluded: 5, windowReturnCount: 100 });
    expect(ok.state === 'available' && ok.provenance.riskFree!.windowCoverageShare).toBe(0.95);
    const bad = sharpeRatio(s100, ctxInr(), toDs(make(6)), { start: null, end: null }, 'daily');
    expect(bad.state).toBe('risk_free_missing');
    expect(bad.state === 'risk_free_missing' && bad.reason).toBe('risk_free_stale');
    expect(bad.state !== 'available' && bad.detail).toContain('Only 94 of 100 return periods (94%)');
    expect(bad.state !== 'available' && bad.detail).toContain('at least 95% are needed');
    expect('value' in bad).toBe(false);
  });

  it('a window whose dates ALL lack a rate, or the data that starts after it, is still risk_free_missing (nothing assumed)', () => {
    const none = sharpeRatio(series, ctxInr(), toDs([{ d: '2027-01-06', y: 6 }]), { start: null, end: null }, 'daily');
    expect(none.state).toBe('risk_free_missing');
    const stale = sharpeRatio(series, ctxInr(), toDs([{ d: '2024-01-03', y: 6 }]), { start: null, end: null }, 'daily');
    expect(stale.state === 'risk_free_missing' && stale.reason).toBe('risk_free_stale');
  });

  it('a documented gap across the same hole removes the exclusion: nothing left out, the carry disclosed instead', () => {
    // value 05-03-2025, documented no-row Wednesdays 12-03, 19-03, 26-03 (spacing 7), next value 02-04-2025: 28 days, within 35
    const list = weeklyValues('2024-11-27', '2026-07-01', yOf, ['2025-03-12', '2025-03-19', '2025-03-26']);
    const gaps = ['2025-03-12', '2025-03-19', '2025-03-26'].map((d) => gap(d));
    const r = sharpeRatio(series, ctxInr(), toDs(list, gaps), { start: null, end: null }, 'daily');
    expect(r.state).toBe('available');
    if (r.state !== 'available') throw new Error(r.state);
    // ages 22 to 27 days (weekdays 27-03 to 01-04) would be stale under the general rule: here they carry
    expect(r.provenance.riskFree!.periodsExcluded).toBe(0);
    expect(r.provenance.riskFree!.periodsCarriedAcrossDocumentedGap).toBeGreaterThanOrEqual(4);
    expect(r.provenance.riskFree!.documentedGapDatesCrossed).toEqual(['2025-03-12', '2025-03-19', '2025-03-26']);
    expect(r.disclosures.some((d) => d.code === 'risk_free_carried_across_documented_gap')).toBe(true);
    // control: the SAME hole without the gap rows excludes exactly those dates
    const bare = sharpeRatio(series, ctxInr(), toDs(list), { start: null, end: null }, 'daily');
    expect(bare.state === 'available' && bare.provenance.riskFree!.periodsExcluded).toBeGreaterThanOrEqual(4);
    expect(bare.state === 'available' && bare.provenance.riskFree!.periodsCarriedAcrossDocumentedGap).toBe(0);
  });
});

describe('Sortino and alpha follow the same rule (NC-G7)', () => {
  it('Sortino over the observations that have a rate; the exclusion is disclosed', () => {
    const { scheme } = fixtureB(); // 61 weekdays from 06-01-2025: 60 returns
    // value 01-01, hole after 22-01, value on Monday 27-01: starts 23-01 and 24-01 have no rate (2 of 60 = 96.7%)
    const rest = weeklyValues('2025-01-29', '2025-04-30', () => 6.0);
    const ds = dataset({ retrievedOn: '2026-10-03', observations: [obs('2025-01-01', 6.0, { retrievedOn: '2026-10-03' }), obs('2025-01-27', 6.0, { retrievedOn: '2026-10-03' }), ...rest.map((o) => obs(o.d, o.y, { retrievedOn: '2026-10-03' }))] });
    const r = sortinoRatio(scheme, ctxInr(), ds, { start: null, end: null }, 'daily');
    expect(r.state).toBe('available');
    expect(r.state === 'available' && r.value.returnCount).toBe(58);
    expect(r.state === 'available' && r.provenance.riskFree!.periodsExcluded).toBe(2);
    expect(r.state === 'available' && r.disclosures.some((d) => d.code === 'risk_free_periods_excluded')).toBe(true);
    expectClose(periodicRiskFreeReturn(6.0, 252), 0.00023, 2e-4); // sanity of the constant rate used
  });

  it('alpha is computed over the same kept observations (common returns reduced by the excluded ones) and discloses them', () => {
    const { scheme, benchmarks } = fixtureB();
    const rest = weeklyValues('2025-01-29', '2025-04-30', () => 6.0);
    const ds = dataset({ retrievedOn: '2026-10-03', observations: [obs('2025-01-01', 6.0, { retrievedOn: '2026-10-03' }), obs('2025-01-27', 6.0, { retrievedOn: '2026-10-03' }), ...rest.map((o) => obs(o.d, o.y, { retrievedOn: '2026-10-03' }))] });
    const r = jensenAlpha(scheme, ctxInr(), benchmarks, ds, { start: null, end: null }, 'daily');
    expect(r.state).toBe('available');
    if (r.state !== 'available') throw new Error(r.state);
    expect(r.value.commonReturnCount).toBe(58);
    expect(r.provenance.riskFree!.periodsExcluded).toBe(2);
    expect(r.provenance.riskFree!.windowReturnCount).toBe(60);
  });
});
