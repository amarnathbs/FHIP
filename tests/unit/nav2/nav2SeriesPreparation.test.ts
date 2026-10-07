// NAV2 Stage 1 -- canonical series preparation (spec 6, 7) and the series-level
// parts of Fixture D (correction), Fixture E (identity safety) and Fixture F (gaps).
//
// Matrix rows covered: 6 (direct / regular and growth / IDCW never cross, at series
// level), 7 (future-dated NAV excluded), 8 (wrong-currency NAV excluded), 9 (the
// effective series carries the corrected value, one per date), 10-11 (see
// nav2SchemeReturns for the boundary rule itself), 41 (idempotent / deterministic
// preparation).
//
// NAMED NEGATIVE CONTROLS (each fails if its rule is removed):
//   NC-S1  a future-dated row would become the last NAV and the return if it were not excluded;
//   NC-S2  a wrong-currency row would be used if the currency gate were absent;
//   NC-S3  a foreign-instrument (e.g. regular-plan) row would join the direct-plan series;
//   NC-S4  two different values for one date are withheld, never averaged or picked;
//   NC-S5  a superseded row never counts and the correction does, with or without superseded_by_id.
import { describe, expect, it } from 'vitest';
import { NAV2_POLICY } from '@/lib/config/nav2/metricPolicy';
import { prepareSeries, guardSeries, type RawNavRow } from '@/lib/engines/nav2/series';
import { absoluteReturn } from '@/lib/engines/nav2/schemeReturns';
import { dailyReturns } from '@/lib/engines/nav2/schemeReturns';
import { volatility, sharpeRatio, maxDrawdown, beta, jensenAlpha, correlationBetweenHeldSchemes } from '@/lib/engines/nav2/schemeRisk';
import { sma, ema, roc, navExtremes, navAverage } from '@/lib/engines/nav2/schemeTrend';
import { rollingReturn, pointToPointReturn, cagr } from '@/lib/engines/nav2/schemeReturns';
import { buildSeries, ctxInr, IDENTITY, rowsFor, weekdays } from './support/fixtures';

const DATES = weekdays('2025-01-06', 5); // Mon 06-01 .. Fri 10-01
const NAVS = [100, 102, 101, 105, 103];

describe('prepareSeries: eligibility (spec 6, 7)', () => {
  it('keeps clean rows, ascending, one per date, with first / last / count and a checksum', () => {
    const s = buildSeries([...DATES].reverse(), [...NAVS].reverse()); // supplied descending
    expect(s.observations.map((o) => o.date)).toEqual(DATES);
    expect(s.observations.map((o) => o.value)).toEqual(NAVS);
    expect(s.firstDate).toBe('2025-01-06');
    expect(s.lastDate).toBe('2025-01-10');
    expect(s.count).toBe(5);
    expect(s.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('NC-S1 / matrix 7: a future-dated NAV is excluded (never the latest, never in a return)', () => {
    const rows = [...rowsFor(IDENTITY.instrumentId, DATES, NAVS), { instrumentId: IDENTITY.instrumentId, priceDate: '2026-10-04', price: 999, currencyCode: 'INR' }];
    const s = prepareSeries({ identity: IDENTITY, asOfDate: '2026-10-03', rows }, NAV2_POLICY);
    expect(s.rejected.future_dated).toBe(1);
    expect(s.lastDate).toBe('2025-01-10');
    // Control: the same row dated on/before the as-of date IS used, and would change the answer.
    const used = prepareSeries({ identity: IDENTITY, asOfDate: '2026-10-04', rows }, NAV2_POLICY);
    expect(used.lastDate).toBe('2026-10-04');
    const r = absoluteReturn(s, ctxInr(), '2025-01-06', '2026-10-03');
    expect(r.state).not.toBe('available'); // the 999 never became the end NAV
    const r2 = absoluteReturn(used, ctxInr(), '2025-01-06', '2026-10-04');
    expect(r2.state === 'available' && r2.value.endNav).toBe(999); // control: without the exclusion it WOULD have been
  });

  it('NC-S2 / matrix 8: a wrong-currency NAV is excluded; if that leaves nothing the state is currency_mismatch', () => {
    const mixed = prepareSeries({ identity: IDENTITY, asOfDate: '2026-10-03', rows: [...rowsFor(IDENTITY.instrumentId, DATES, NAVS), { instrumentId: IDENTITY.instrumentId, priceDate: '2025-01-13', price: 50, currencyCode: 'AUD' }] }, NAV2_POLICY);
    expect(mixed.rejected.currency_mismatch).toBe(1);
    expect(mixed.count).toBe(5);
    const onlyWrong = prepareSeries({ identity: IDENTITY, asOfDate: '2026-10-03', rows: rowsFor(IDENTITY.instrumentId, DATES, NAVS, 'AUD') }, NAV2_POLICY);
    expect(onlyWrong.count).toBe(0);
    const g = guardSeries(onlyWrong, ctxInr(), 'volatility');
    expect(g?.state).toBe('currency_mismatch');
    expect(g && 'value' in g).toBe(false);
  });

  it('rejects non-positive, non-finite, impossible-date and quality-flagged rows (counted, never used)', () => {
    const base = { instrumentId: IDENTITY.instrumentId, currencyCode: 'INR' };
    const rows: RawNavRow[] = [
      ...rowsFor(IDENTITY.instrumentId, DATES, NAVS),
      { ...base, priceDate: '2025-01-13', price: 0 },
      { ...base, priceDate: '2025-01-14', price: -5 },
      { ...base, priceDate: '2025-01-15', price: 'abc' },
      { ...base, priceDate: '2025-02-30', price: 100 },
      { ...base, priceDate: '2025-01-16', price: 100, qualityStatus: 'suspicious_jump' },
      { ...base, priceDate: '2025-01-17', price: 100, qualityStatus: 'stale' },
    ];
    const s = prepareSeries({ identity: IDENTITY, asOfDate: '2026-10-03', rows }, NAV2_POLICY);
    expect(s.rejected).toMatchObject({ invalid_price: 3, impossible_date: 1, quality_not_ok: 2 });
    expect(s.count).toBe(5);
  });

  it('accepts a numeric(24,10) price given as a string (the Postgres wire type)', () => {
    const rows: RawNavRow[] = [{ instrumentId: IDENTITY.instrumentId, priceDate: '2025-01-06', price: '123.4567890123', currencyCode: 'INR' }];
    const s = prepareSeries({ identity: IDENTITY, asOfDate: '2026-10-03', rows }, NAV2_POLICY);
    expect(s.observations[0].value).toBeCloseTo(123.4567890123, 10);
  });

  it('exact duplicates collapse to one observation (no double count)', () => {
    const rows = [...rowsFor(IDENTITY.instrumentId, DATES, NAVS), ...rowsFor(IDENTITY.instrumentId, DATES, NAVS).map((r) => ({ ...r, id: `${r.id}-dup` }))];
    const s = prepareSeries({ identity: IDENTITY, asOfDate: '2026-10-03', rows }, NAV2_POLICY);
    expect(s.count).toBe(5);
    expect(s.conflictingDates).toEqual([]);
  });

  it('is deterministic: the same rows in any order give an identical series and checksum (matrix 41 at series level)', () => {
    const a = buildSeries(DATES, NAVS);
    const b = buildSeries([...DATES].reverse(), [...NAVS].reverse());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('Fixture E (series level): identity safety, no cross-series contamination', () => {
  it('NC-S3: rows of another instrument (regular plan, IDCW option, predecessor scheme) never join this series', () => {
    const direct = IDENTITY.instrumentId;
    const rows = [
      ...rowsFor(direct, DATES, NAVS),
      ...rowsFor('inst-regular-growth', DATES, [90, 91, 92, 93, 94]), // deceptively similar name, different series
      ...rowsFor('inst-direct-idcw', DATES, [50, 51, 52, 53, 54]),
      ...rowsFor('inst-merged-predecessor', ['2024-12-31'], [88]),
    ];
    const s = prepareSeries({ identity: IDENTITY, asOfDate: '2026-10-03', rows }, NAV2_POLICY);
    expect(s.rejected.foreign_instrument).toBe(5 + 5 + 1);
    expect(s.observations.map((o) => o.value)).toEqual(NAVS);
    expect(s.firstDate).toBe('2025-01-06'); // the predecessor's 2024-12-31 row did not extend this series
  });

  it('an unresolved identity makes EVERY metric answer identity_unresolved with no value', () => {
    const s = buildSeries(DATES, NAVS, { identity: { resolved: false } });
    const ctx = ctxInr();
    const results = [
      pointToPointReturn(s, ctx, '2025-01-06', '2025-01-10'),
      absoluteReturn(s, ctx, '2025-01-06', '2025-01-10'),
      cagr(s, ctx, '2025-01-06', '2025-01-10'),
      dailyReturns(s, ctx),
      rollingReturn(s, ctx, '1M'),
      volatility(s, ctx),
      sharpeRatio(s, ctx, null),
      maxDrawdown(s, ctx),
      beta(s, ctx, []),
      jensenAlpha(s, ctx, [], null),
      sma(s, ctx, 20),
      ema(s, ctx, 20),
      roc(s, ctx, 1),
      navExtremes(s, ctx),
      navAverage(s, ctx),
    ];
    for (const r of results) {
      expect(r.state).toBe('identity_unresolved');
      expect('value' in r).toBe(false);
    }
    const t = buildSeries(DATES, NAVS, { identity: { instrumentId: 'inst-b', resolved: false } });
    const corr = correlationBetweenHeldSchemes(s, t, ctx, new Set([s.identity.instrumentId, t.identity.instrumentId]));
    expect(corr.state).toBe('identity_unresolved');
  });
});

describe('Fixture D (series level): a correction leaves one effective value per date', () => {
  const id = IDENTITY.instrumentId;
  const original: RawNavRow = { id: 'r-0110', instrumentId: id, priceDate: '2025-01-10', price: 105, currencyCode: 'INR' };
  const corrected: RawNavRow = { id: 'r-0110-c', instrumentId: id, priceDate: '2025-01-10', price: 104, currencyCode: 'INR', correctionOfId: 'r-0110' };
  const others = rowsFor(id, DATES.slice(0, 4), [100, 102, 101, 103]); // 06..09 January

  it('NC-S5: with lineage only (correction_of_id, original not marked) the correction wins and counts once', () => {
    const s = prepareSeries({ identity: IDENTITY, asOfDate: '2026-10-03', rows: [...others, original, corrected] }, NAV2_POLICY);
    expect(s.observations.filter((o) => o.date === '2025-01-10')).toEqual([{ date: '2025-01-10', value: 104 }]);
    expect(s.supersededCount).toBe(1);
    expect(s.conflictingDates).toEqual([]);
  });

  it('NC-S5: with superseded_by_id on the original, the same result', () => {
    const s = prepareSeries({ identity: IDENTITY, asOfDate: '2026-10-03', rows: [...others, { ...original, supersededById: 'r-0110-c' }, { ...corrected, correctionOfId: null }] }, NAV2_POLICY);
    expect(s.observations.find((o) => o.date === '2025-01-10')?.value).toBe(104);
  });

  it('matrix 9: the corrected NAV changes the dependent figure, and the series checksum', () => {
    const before = prepareSeries({ identity: IDENTITY, asOfDate: '2026-10-03', rows: [...others, original] }, NAV2_POLICY);
    const after = prepareSeries({ identity: IDENTITY, asOfDate: '2026-10-03', rows: [...others, original, corrected] }, NAV2_POLICY);
    expect(before.checksum).not.toBe(after.checksum);
    const ctx = ctxInr();
    const rb = absoluteReturn(before, ctx, '2025-01-06', '2025-01-10');
    const ra = absoluteReturn(after, ctx, '2025-01-06', '2025-01-10');
    if (rb.state !== 'available' || ra.state !== 'available') throw new Error('expected available');
    expect(rb.value.absoluteReturn).toBeCloseTo(105 / 100 - 1, 12); // hand: 5%
    expect(ra.value.absoluteReturn).toBeCloseTo(104 / 100 - 1, 12); // hand: 4%
  });

  it('NC-S4: two DIFFERENT effective values for one date with no lineage are quarantined, and a metric over it answers data_quality_hold', () => {
    const conflict: RawNavRow = { id: 'r-0110-x', instrumentId: id, priceDate: '2025-01-10', price: 104, currencyCode: 'INR' };
    const s = prepareSeries({ identity: IDENTITY, asOfDate: '2026-10-03', rows: [...others, original, conflict] }, NAV2_POLICY);
    expect(s.conflictingDates).toEqual(['2025-01-10']);
    expect(s.observations.some((o) => o.date === '2025-01-10')).toBe(false); // neither value is used
    const r = navExtremes(s, ctxInr(), { start: '2025-01-06', end: '2025-01-10' });
    expect(r.state).toBe('data_quality_hold');
    expect(r.state === 'data_quality_hold' && r.reason).toBe('conflicting_nav_values');
  });
});

describe('Fixture F (series level): gaps are recorded, never filled', () => {
  it('records a material gap between consecutive observations and does not add observations for it', () => {
    const dates = ['2025-01-09', '2025-01-10', '2025-02-25', '2025-02-26'];
    const s = buildSeries(dates, [100, 101, 110, 111]);
    expect(s.count).toBe(4); // no forward-fill, no interpolation
    expect(s.gaps).toEqual([{ from: '2025-01-10', to: '2025-02-25', days: 46 }]); // hand: 22 + 24 days
  });
  it('a plain weekend (3 days) is not a material gap', () => {
    const s = buildSeries(['2025-01-10', '2025-01-13'], [100, 101]);
    expect(s.gaps).toEqual([]);
  });
});
