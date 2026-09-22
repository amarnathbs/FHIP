// PC6/NAV 1 — unit tests for the selective NAV retention policy contract
// (navRetentionPolicy.ts), exercising the workbook's own boundary examples
// directly so a future change to this module has to keep them true.

import { describe, it, expect } from 'vitest';
import {
  evaluateKeep,
  evaluateCandidate,
  withNoReportPinDependency,
  determineHydrationRequirement,
  BENCHMARK_LOOKBACK_DAYS,
  type PolicyContext,
  type NavRow,
} from '@/lib/services/investment-intelligence/pc6/navRetentionPolicy';

const C = '2026-09-21';

function baseCtx(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return withNoReportPinDependency({
    changeoverDate: C,
    acceptedDependencies: new Map(),
    benchmarkDependencies: new Map(),
    retentionHolds: new Map(),
    ...overrides,
  });
}

/** Test-only mirror of the module's own date arithmetic, kept trivial on purpose. */
function subtractDaysForTest(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
function daysBetweenForTest(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00.000Z`) - Date.parse(`${a}T00:00:00.000Z`)) / 86_400_000);
}

describe('navRetentionPolicy — KEEP/CANDIDATE contract', () => {
  it('keeps every row on or after the changeover date, unheld or not', () => {
    const row: NavRow = { instrumentId: 'unheld-scheme', navDate: '2026-09-21' };
    const decision = evaluateKeep(row, baseCtx());
    expect(decision.keep).toBe(true);
    expect(decision.reasons).toContain('post_changeover');
  });

  it('workbook boundary example: earlier row on an unheld live scheme becomes a candidate; the row on C stays protected', () => {
    const ctx = baseCtx();
    const earlier: NavRow = { instrumentId: 'unheld-scheme', navDate: '2026-09-20' };
    const onC: NavRow = { instrumentId: 'unheld-scheme', navDate: '2026-09-21' };
    expect(evaluateCandidate(earlier, ctx)).toBe(true);
    expect(evaluateCandidate(onC, ctx)).toBe(false);
  });

  it('a fully redeemed instrument with complete_from_inception stays protected arbitrarily far back', () => {
    const ctx = baseCtx({
      acceptedDependencies: new Map([
        ['redeemed-scheme', {
          instrumentId: 'redeemed-scheme',
          isAccepted: true,
          historyCompleteness: 'complete_from_inception',
          earliestTransactionDate: null,
          certifiedAsOfDate: null,
        }],
      ]),
    });
    const row: NavRow = { instrumentId: 'redeemed-scheme', navDate: '2006-04-03' };
    const decision = evaluateKeep(row, ctx);
    expect(decision.keep).toBe(true);
    expect(decision.reasons).toContain('accepted_statement_history');
  });

  it('complete_from_known_opening_balance protects only from the earliest non-reversed transaction onward', () => {
    const ctx = baseCtx({
      acceptedDependencies: new Map([
        ['scheme-x', {
          instrumentId: 'scheme-x',
          isAccepted: true,
          historyCompleteness: 'complete_from_known_opening_balance',
          earliestTransactionDate: '2020-01-15',
          certifiedAsOfDate: null,
        }],
      ]),
    });
    expect(evaluateCandidate({ instrumentId: 'scheme-x', navDate: '2019-12-31' }, ctx)).toBe(true);
    expect(evaluateCandidate({ instrumentId: 'scheme-x', navDate: '2020-01-15' }, ctx)).toBe(false);
    expect(evaluateCandidate({ instrumentId: 'scheme-x', navDate: '2020-06-01' }, ctx)).toBe(false);
  });

  it('an instrument with no accepted dependency, no benchmark mapping and no hold is a candidate before C', () => {
    const row: NavRow = { instrumentId: 'never-held-scheme', navDate: '2015-06-01' };
    expect(evaluateCandidate(row, baseCtx())).toBe(true);
  });

  it('benchmark dependency protects a scheme even with no accepted statement', () => {
    const ctx = baseCtx({
      benchmarkDependencies: new Map([['benchmark-only', { instrumentId: 'benchmark-only', everBenchmarked: true }]]),
    });
    const row: NavRow = { instrumentId: 'benchmark-only', navDate: '2018-01-01' };
    expect(evaluateKeep(row, ctx).reasons).toContain('benchmark_dependency');
  });

  it('an active retention hold protects a row that would otherwise be a candidate (race prevention)', () => {
    const ctx = baseCtx({
      retentionHolds: new Map([['scheme-y', { instrumentId: 'scheme-y', isHeld: true }]]),
    });
    const row: NavRow = { instrumentId: 'scheme-y', navDate: '2019-01-01' };
    expect(evaluateKeep(row, ctx).reasons).toContain('active_hold');
  });

  it('report-pin lookup defaults to fail-closed (protect) when the caller has not wired a real answer', () => {
    // Deliberately NOT using withNoReportPinDependency here.
    const ctx: PolicyContext = {
      changeoverDate: C,
      acceptedDependencies: new Map(),
      benchmarkDependencies: new Map(),
      retentionHolds: new Map(),
      // reportPinLookup intentionally omitted
    };
    const row: NavRow = { instrumentId: 'anything', navDate: '2015-01-01' };
    const decision = evaluateKeep(row, ctx);
    expect(decision.keep).toBe(true);
    expect(decision.reasons).toContain('report_pin');
  });

  it('an accepted dependency whose completeness has not yet been evaluated is held conservatively, not deleted', () => {
    const ctx = baseCtx({
      acceptedDependencies: new Map([
        ['scheme-z', { instrumentId: 'scheme-z', isAccepted: true, historyCompleteness: null, earliestTransactionDate: null, certifiedAsOfDate: null }],
      ]),
    });
    expect(evaluateCandidate({ instrumentId: 'scheme-z', navDate: '2010-01-01' }, ctx)).toBe(false);
  });
});

describe('determineHydrationRequirement — NAV 1.26 fetch-window planning', () => {
  it('an instrument with no dependency at all needs no hydration', () => {
    const req = determineHydrationRequirement('none', { acceptedDependencies: new Map(), benchmarkDependencies: new Map() });
    expect(req.required).toBe(false);
    expect(req.fromDate).toBeNull();
  });

  it('complete_from_inception requires fetching from inception (fromDate null)', () => {
    const req = determineHydrationRequirement('a', {
      acceptedDependencies: new Map([['a', { instrumentId: 'a', isAccepted: true, historyCompleteness: 'complete_from_inception', earliestTransactionDate: null, certifiedAsOfDate: null }]]),
      benchmarkDependencies: new Map(),
    });
    expect(req.required).toBe(true);
    expect(req.fromDate).toBeNull();
    expect(req.reasons).toEqual(['accepted_statement_history']);
  });

  it('complete_from_known_opening_balance requires fetching only from the earliest transaction date', () => {
    const req = determineHydrationRequirement('b', {
      acceptedDependencies: new Map([['b', { instrumentId: 'b', isAccepted: true, historyCompleteness: 'complete_from_known_opening_balance', earliestTransactionDate: '2020-03-01', certifiedAsOfDate: null }]]),
      benchmarkDependencies: new Map(),
    });
    expect(req.required).toBe(true);
    expect(req.fromDate).toBe('2020-03-01');
  });

  it('a benchmark-only dependency with NO anchor date supplied fails conservative (from inception)', () => {
    const req = determineHydrationRequirement('c', {
      acceptedDependencies: new Map(),
      benchmarkDependencies: new Map([['c', { instrumentId: 'c', everBenchmarked: true }]]),
    });
    expect(req.required).toBe(true);
    expect(req.fromDate).toBeNull();
    expect(req.reasons).toEqual(['benchmark_dependency']);
  });

  it('a benchmark-only dependency WITH an anchor date uses the grounded rolling-window lookback, not full history', () => {
    // Grounded in rollingReturns.ts/rollingReturnService.ts/minimumHistory.ts
    // (see BENCHMARK_LOOKBACK_DAYS's own header) -- NOT an inference.
    const req = determineHydrationRequirement(
      'c',
      { acceptedDependencies: new Map(), benchmarkDependencies: new Map([['c', { instrumentId: 'c', everBenchmarked: true }]]) },
      '2026-09-21'
    );
    expect(req.required).toBe(true);
    expect(req.fromDate).not.toBeNull();
    expect(req.fromDate).toBe(subtractDaysForTest('2026-09-21', BENCHMARK_LOOKBACK_DAYS));
    // Sanity bound: materially less than "from inception" (this system has
    // real schemes with 20+ years of history), materially more than a
    // single rolling5Y window (must cover rollingMinWindows too).
    const days = daysBetweenForTest(req.fromDate!, '2026-09-21');
    expect(days).toBeGreaterThan(5 * 365); // more than just one 5Y window
    expect(days).toBeLessThan(8 * 365); // nowhere near "from inception" for an old scheme
  });

  it('an accepted complete_from_inception reason is never narrowed by an ALSO-present benchmark dependency', () => {
    const req = determineHydrationRequirement(
      'e',
      {
        acceptedDependencies: new Map([['e', { instrumentId: 'e', isAccepted: true, historyCompleteness: 'complete_from_inception', earliestTransactionDate: null, certifiedAsOfDate: null }]]),
        benchmarkDependencies: new Map([['e', { instrumentId: 'e', everBenchmarked: true }]]),
      },
      '2026-09-21'
    );
    expect(req.fromDate).toBeNull(); // still "from inception", not narrowed to the benchmark's shorter window
    expect(req.reasons).toEqual(['accepted_statement_history', 'benchmark_dependency']);
  });

  it('an unaccepted instrument (isAccepted: false) is not a hydration reason', () => {
    const req = determineHydrationRequirement('d', {
      acceptedDependencies: new Map([['d', { instrumentId: 'd', isAccepted: false, historyCompleteness: null, earliestTransactionDate: null, certifiedAsOfDate: null }]]),
      benchmarkDependencies: new Map(),
    });
    expect(req.required).toBe(false);
  });
});
