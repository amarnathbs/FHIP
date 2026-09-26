/**
 * Window and coverage (DC-01 / EXP-G3, PO D-02): trailing 3 COMPLETE months in
 * the household's timezone -- never the current calendar month alone; months
 * averaged only when an approved statement fully covers them.
 */
import { describe, expect, it } from 'vitest';

import { computeCoverage, mergeIntervals } from '@/lib/read-models/core/coverage';
import { defaultWindowFor, explicitWindow, localDateInZone, monthEnd, trailingCompleteMonthsWindow } from '@/lib/read-models/core/window';

describe('window', () => {
  it('trailing 3 complete months before the current month -- the current month is never in it', () => {
    const w = trailingCompleteMonthsWindow('2026-09-26');
    expect(w.months).toEqual(['2026-06', '2026-07', '2026-08']);
    expect(w.from).toBe('2026-06-01');
    expect(w.to).toBe('2026-08-31');
    expect(w.months).not.toContain('2026-09');
  });

  it('crosses a year boundary', () => {
    expect(trailingCompleteMonthsWindow('2026-02-03').months).toEqual(['2025-11', '2025-12', '2026-01']);
  });

  it("uses the household's timezone: 31 Aug 20:00 UTC is already 1 Sep in Sydney (window Jun-Aug), still Aug in UTC-land", () => {
    const now = new Date('2026-08-31T20:00:00Z');
    expect(localDateInZone(now, 'Australia/Sydney')).toBe('2026-09-01');
    expect(defaultWindowFor('AU', now).months).toEqual(['2026-06', '2026-07', '2026-08']);
    expect(defaultWindowFor('IN', now).months).toEqual(['2026-06', '2026-07', '2026-08']);
    expect(defaultWindowFor('IN', new Date('2026-08-31T17:00:00Z')).months).toEqual(['2026-05', '2026-06', '2026-07']);
  });

  it('explicit windows list only complete months; month ends are right in leap years', () => {
    expect(explicitWindow('2026-06-15', '2026-09-30').months).toEqual(['2026-07', '2026-08', '2026-09']);
    expect(monthEnd('2028-02')).toBe('2028-02-29');
    expect(monthEnd('2026-02')).toBe('2026-02-28');
  });
});

describe('coverage', () => {
  const w = explicitWindow('2026-06-01', '2026-08-31');

  it('a month is covered only when the union of approved periods contains every day of it', () => {
    const c = computeCoverage([
      { statementUploadId: 'a', accountId: 'acc', periodStart: '2026-05-20', periodEnd: '2026-06-19' },
      { statementUploadId: 'b', accountId: 'acc', periodStart: '2026-06-20', periodEnd: '2026-07-19' },
      { statementUploadId: 'c', accountId: 'acc', periodStart: '2026-08-02', periodEnd: '2026-08-31' },
    ], w);
    expect([...c.covered.get('acc')!]).toEqual(['2026-06']);
    expect([...c.partial.get('acc')!]).toEqual(['2026-07', '2026-08']);
    expect(c.rows.find((r) => r.month === '2026-06')!.statementIds).toEqual(['a', 'b']);
  });

  it('coverage is per account; window-level covered months are the union', () => {
    const c = computeCoverage([
      { statementUploadId: 'x', accountId: 'bank', periodStart: '2026-06-01', periodEnd: '2026-08-31' },
      { statementUploadId: 'y', accountId: 'card', periodStart: '2026-08-01', periodEnd: '2026-08-31' },
    ], w);
    expect(c.covered.get('bank')!.size).toBe(3);
    expect(c.covered.get('card')!.size).toBe(1);
    expect(c.coveredMonths).toEqual(['2026-06', '2026-07', '2026-08']);
  });

  it('with no declared period, the min/max approved transaction dates are a conservative fallback', () => {
    const c = computeCoverage([{ statementUploadId: 'p', accountId: 'acc', periodStart: null, periodEnd: null, fallbackStart: '2026-07-01', fallbackEnd: '2026-07-31' }], w);
    expect(c.coveredMonths).toEqual(['2026-07']);
    const none = computeCoverage([{ statementUploadId: 'q', accountId: 'acc', periodStart: null, periodEnd: null }], w);
    expect(none.rows).toEqual([]);
  });

  it('adjacent intervals merge; gaps do not', () => {
    expect(mergeIntervals([['2026-06-01', '2026-06-15'], ['2026-06-16', '2026-06-30']])).toEqual([['2026-06-01', '2026-06-30']]);
    expect(mergeIntervals([['2026-06-01', '2026-06-14'], ['2026-06-16', '2026-06-30']])).toHaveLength(2);
  });
});
