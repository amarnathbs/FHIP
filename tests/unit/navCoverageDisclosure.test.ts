// NAV 1 — PO decision #5.6 (2026-09-27): unit tests for
// attachUnrecoverableHistoryDisclosure(), the pure post-processing step
// that adds a plain-language disclosure to any scheme (and its currency's
// portfolio block) whose real, already-computed performance figures rest
// partly on NAV history confirmed unrecoverable from every approved
// source. These tests fail on the pre-existing analyticsOrchestrator.ts
// output alone (which has no such flag or mechanism) -- they exercise the
// new function directly, proving it does what PO decision #5.6 asks
// without touching the certified engine's own computation.

import { describe, it, expect } from 'vitest';
import { attachUnrecoverableHistoryDisclosure, UNRECOVERABLE_HISTORY_FLAG } from '@/lib/engines/investment-intelligence/navCoverageDisclosure';
import type { AnalyticsResultSet, SchemeAnalytics, PortfolioCurrencyAnalytics } from '@/lib/engines/investment-intelligence/analyticsOrchestrator';

function calculated<T>(value: T) {
  return { status: 'CALCULATED' as const, value };
}

function scheme(overrides: Partial<SchemeAnalytics> = {}): SchemeAnalytics {
  return {
    instrumentId: 'instrument-1',
    instrumentName: 'Test Scheme',
    currencyCode: 'INR',
    currentValueDate: '2026-09-18',
    investorXirr: calculated({ rate: 0.12 }),
    navReturns: {},
    activeReturn: calculated({ activeReturn: 0.02, family: 'debt', benchmarkKey: 'x' }),
    annotations: [],
    inputFingerprint: 'fp-1',
    ...overrides,
  };
}

function portfolio(overrides: Partial<PortfolioCurrencyAnalytics> = {}): PortfolioCurrencyAnalytics {
  return {
    currencyCode: 'INR',
    schemeCount: 1,
    totalValue: 100000,
    portfolioXirr: calculated({ rate: 0.1 }),
    blendedBenchmarkReturn: calculated({ blendedReturn: 0.08, coveragePct: 100 }),
    risk: {} as PortfolioCurrencyAnalytics['risk'],
    rolling: {} as PortfolioCurrencyAnalytics['rolling'],
    drawdownSeries: [],
    performanceVsBenchmarkSeries: [],
    contributingBenchmarks: [],
    annotations: [],
    inputFingerprint: 'fp-p1',
    ...overrides,
  };
}

function resultSet(schemes: SchemeAnalytics[], portfolios: PortfolioCurrencyAnalytics[]): AnalyticsResultSet {
  return {
    asOfDate: '2026-09-18',
    periodStart: '2025-09-18',
    engineVersion: 'test',
    subVersions: {} as AnalyticsResultSet['subVersions'],
    portfolios,
    schemes,
    crossCurrency: { status: 'NOT_APPLICABLE' },
    annotations: [],
  };
}

describe('attachUnrecoverableHistoryDisclosure', () => {
  it('NEGATIVE CONTROL: with no gaps at all, the result is returned UNCHANGED (same object reference)', () => {
    const results = resultSet([scheme()], [portfolio()]);
    const out = attachUnrecoverableHistoryDisclosure(results, {});
    expect(out).toBe(results);
  });

  it('a scheme with an open gap gets a new UNRECOVERABLE_HISTORY_PERIOD annotation, without altering its computed figures', () => {
    const results = resultSet([scheme()], [portfolio()]);
    const out = attachUnrecoverableHistoryDisclosure(results, {
      'instrument-1': [{ gapFrom: '2013-01-28', gapTo: '2022-09-19', reasonCode: 'fund_house_transition' }],
    });
    expect(out.schemes[0].annotations).toHaveLength(1);
    expect(out.schemes[0].annotations[0].flag).toBe(UNRECOVERABLE_HISTORY_FLAG);
    expect(out.schemes[0].annotations[0].detail).toContain('2013-01-28');
    expect(out.schemes[0].annotations[0].detail).toContain('2022-09-19');
    expect(out.schemes[0].annotations[0].detail).toContain('fund house');
    // The figures themselves must be untouched.
    expect(out.schemes[0].investorXirr).toEqual(results.schemes[0].investorXirr);
  });

  it('a scheme with NO gap in a mixed portfolio is left untouched (same object reference) while the affected one is not', () => {
    const healthy = scheme({ instrumentId: 'instrument-healthy' });
    const affected = scheme({ instrumentId: 'instrument-1' });
    const results = resultSet([healthy, affected], [portfolio()]);
    const out = attachUnrecoverableHistoryDisclosure(results, {
      'instrument-1': [{ gapFrom: '2013-01-28', gapTo: '2022-09-19', reasonCode: 'fund_house_transition' }],
    });
    expect(out.schemes.find((s) => s.instrumentId === 'instrument-healthy')).toBe(healthy);
    expect(out.schemes.find((s) => s.instrumentId === 'instrument-1')).not.toBe(affected);
  });

  it('multiple gap ranges on the same instrument produce multiple annotations, one per range', () => {
    const results = resultSet([scheme()], [portfolio()]);
    const out = attachUnrecoverableHistoryDisclosure(results, {
      'instrument-1': [
        { gapFrom: '2013-01-28', gapTo: '2015-01-01', reasonCode: 'fund_house_transition' },
        { gapFrom: '2016-01-01', gapTo: '2017-01-01', reasonCode: 'other' },
      ],
    });
    expect(out.schemes[0].annotations).toHaveLength(2);
  });

  it('the portfolio block for the AFFECTED currency also gets a summary annotation', () => {
    const results = resultSet([scheme({ currencyCode: 'INR' })], [portfolio({ currencyCode: 'INR' }), portfolio({ currencyCode: 'AUD' })]);
    const out = attachUnrecoverableHistoryDisclosure(results, {
      'instrument-1': [{ gapFrom: '2013-01-28', gapTo: '2022-09-19', reasonCode: 'fund_house_transition' }],
    });
    const inr = out.portfolios.find((p) => p.currencyCode === 'INR')!;
    const aud = out.portfolios.find((p) => p.currencyCode === 'AUD')!;
    expect(inr.annotations).toHaveLength(1);
    expect(inr.annotations[0].flag).toBe(UNRECOVERABLE_HISTORY_FLAG);
    expect(aud.annotations).toHaveLength(0); // a different currency's portfolio must not be touched
  });

  it('a gapsByInstrumentId entry with an empty array is treated as "no gap" (defensive against a caller passing an empty list instead of omitting the key)', () => {
    const results = resultSet([scheme()], [portfolio()]);
    const out = attachUnrecoverableHistoryDisclosure(results, { 'instrument-1': [] });
    expect(out).toBe(results);
  });
});
