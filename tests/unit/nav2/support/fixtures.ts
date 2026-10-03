// Shared test helpers for the NAV2 suites. NOT part of the code under test: these
// build inputs (dates, series) and compare numbers. Every EXPECTED value in the
// suites is a literal produced by scripts/nav2_independent_oracle.py (50-digit
// Decimal arithmetic, no FHIP code) or derived by hand in a comment next to it.
import { expect } from 'vitest';
import { NAV2_POLICY, type Nav2Policy } from '@/lib/config/nav2/metricPolicy';
import { prepareSeries, type PreparedSeries, type RawNavRow, type SeriesIdentity, type CoverageGapInput } from '@/lib/engines/nav2/series';
import type { Nav2Context } from '@/lib/engines/nav2/types';

export const ctxInr = (policy: Nav2Policy = NAV2_POLICY): Nav2Context => ({ policy, currency: 'INR' });
export const ctxAud = (policy: Nav2Policy = NAV2_POLICY): Nav2Context => ({ policy, currency: 'AUD' });

/** n consecutive Monday-to-Friday dates starting on `start` (which should itself be a weekday). */
export function weekdays(start: string, n: number): string[] {
  const out: string[] = [];
  const cur = new Date(`${start}T00:00:00.000Z`);
  while (out.length < n) {
    const dow = cur.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

export function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export const IDENTITY: SeriesIdentity = { instrumentId: 'inst-a', currency: 'INR', planType: 'direct', optionType: 'growth', resolved: true, schemeName: 'Alpha Flexi Cap Fund - Direct - Growth' };

export function rowsFor(instrumentId: string, dates: readonly string[], navs: readonly number[], currency = 'INR'): RawNavRow[] {
  return dates.map((priceDate, i) => ({ id: `${instrumentId}-${priceDate}`, instrumentId, priceDate, price: navs[i], currencyCode: currency }));
}

export function buildSeries(
  dates: readonly string[],
  navs: readonly number[],
  opts: { identity?: Partial<SeriesIdentity>; asOf?: string; policy?: Nav2Policy; hydrating?: boolean; gaps?: CoverageGapInput[]; extraRows?: RawNavRow[] } = {}
): PreparedSeries {
  const identity = { ...IDENTITY, ...opts.identity };
  return prepareSeries(
    {
      identity,
      asOfDate: opts.asOf ?? '2026-10-03',
      rows: [...rowsFor(identity.instrumentId, dates, navs), ...(opts.extraRows ?? [])],
      hydrating: opts.hydrating,
      knownCoverageGaps: opts.gaps,
    },
    opts.policy ?? NAV2_POLICY
  );
}

/** NAV path from a start level and a list of simple returns: NAV_t = NAV_(t-1) x (1 + r_t). */
export function pathFromReturns(start: number, returns: readonly number[]): number[] {
  const out = [start];
  for (const r of returns) out.push(out[out.length - 1] * (1 + r));
  return out;
}

/** Relative-or-absolute closeness: |a - e| <= tol x max(1, |e|). The engine is IEEE double; the oracle is 50-digit. */
export function expectClose(actual: number, expected: number, tol = 1e-11): void {
  const bound = tol * Math.max(1, Math.abs(expected));
  expect(Math.abs(actual - expected), `expected ${expected}, got ${actual}`).toBeLessThanOrEqual(bound);
}

/** Any ISO yyyy-mm-dd inside user-visible text is a defect (PO date rule: dd-mm-yyyy INR, dd/mm/yyyy otherwise). */
export const ISO_DATE_IN_TEXT = /\b\d{4}-\d{2}-\d{2}\b/;

export function allStrings(value: unknown, acc: string[] = []): string[] {
  if (typeof value === 'string') acc.push(value);
  else if (Array.isArray(value)) value.forEach((v) => allStrings(v, acc));
  else if (value && typeof value === 'object') Object.values(value as Record<string, unknown>).forEach((v) => allStrings(v, acc));
  return acc;
}

/** The B fixture (see the oracle): 60 returns in a 4-cycle, scheme = 1.5 x benchmark + 0.0005 + e. */
export const B_BENCH_CYCLE = [0.01, -0.01, 0.02, -0.02];
export const B_E_CYCLE = [0.002, 0.002, -0.002, -0.002];
export function bReturns(): { bench: number[]; scheme: number[] } {
  const bench = Array.from({ length: 60 }, (_, i) => B_BENCH_CYCLE[i % 4]);
  const scheme = bench.map((b, i) => 1.5 * b + 0.0005 + B_E_CYCLE[i % 4]);
  return { bench, scheme };
}
