// R4 — RollingReturnEngine (spec sections 51-53). Rolling N-year returns
// with consistent periodic (monthly) endpoints: monthly rolling 3Y = each
// month-end's trailing 3-year annualised return, computed at exact
// fund/benchmark-aligned dates. Never fabricates a beat-% from a
// near-empty sample — ROLLING_MIN_WINDOWS is enforced.

import { MINIMUM_OBSERVATIONS } from '@/lib/config/investment-intelligence/minimumHistory';

export const ROLLING_RETURN_METHOD_VERSION = 'rolling-return-monthly-endpoints-v1';

export interface MonthEndValuation {
  date: Date; // must be a month-end observation date
  value: number;
}

export interface RollingWindowResult {
  windowEndDate: Date;
  windowStartDate: Date;
  annualisedReturn: number;
}

export interface RollingReturnSeriesResult {
  status: 'ok' | 'unavailable';
  windows?: RollingWindowResult[];
  reason?: 'INSUFFICIENT_HISTORY';
  stats?: {
    min: number;
    max: number;
    median: number;
    average: number;
    current: number;
    observationCount: number;
  };
}

function median(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Compute a rolling-N-year series from a monthly month-end valuation
 * series. Each window's annualised return uses the actual/365 convention
 * from navReturn.ts, applied to exact calendar-day distance between the
 * two month-end dates.
 */
export function rollingReturnSeries(monthlySeries: MonthEndValuation[], windowYears: number): RollingReturnSeriesResult {
  const sorted = [...monthlySeries].sort((a, b) => a.date.getTime() - b.date.getTime());
  const windows: RollingWindowResult[] = [];
  const windowDays = windowYears * 365;

  for (let i = 0; i < sorted.length; i++) {
    const end = sorted[i];
    // Find the observation closest to (but not after) end.date - windowDays,
    // requiring it be within 20 days of the exact target (month-end grid tolerance).
    const targetTime = end.date.getTime() - windowDays * 86_400_000;
    let best: MonthEndValuation | undefined;
    let bestDiff = Infinity;
    for (const candidate of sorted) {
      if (candidate.date.getTime() > end.date.getTime()) break;
      const diff = Math.abs(candidate.date.getTime() - targetTime);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = candidate;
      }
    }
    if (!best || bestDiff > 20 * 86_400_000 || best.date.getTime() === end.date.getTime()) continue;
    const actualDays = (end.date.getTime() - best.date.getTime()) / 86_400_000;
    const years = actualDays / 365;
    if (years < windowYears - 0.1) continue; // window not actually long enough
    const annualisedReturn = Math.pow(end.value / best.value, 1 / years) - 1;
    windows.push({ windowEndDate: end.date, windowStartDate: best.date, annualisedReturn });
  }

  if (windows.length < MINIMUM_OBSERVATIONS.rollingMinWindows) {
    return { status: 'unavailable', reason: 'INSUFFICIENT_HISTORY' };
  }
  const returns = windows.map((w) => w.annualisedReturn);
  return {
    status: 'ok',
    windows,
    stats: {
      min: Math.min(...returns),
      max: Math.max(...returns),
      median: median(returns),
      average: returns.reduce((s, r) => s + r, 0) / returns.length,
      current: returns[returns.length - 1],
      observationCount: returns.length,
    },
  };
}

export interface RollingBeatResult {
  status: 'ok' | 'unavailable';
  beatPct?: number;
  comparableWindows?: number;
  benchmarkMedian?: number;
  reason?: 'INSUFFICIENT_COMPARABLE_WINDOWS';
}

/**
 * Rolling benchmark-beat % = (windows where fund > benchmark) /
 * (valid comparable windows), only when the comparable-window count meets
 * MINIMUM_OBSERVATIONS.rollingMinWindows — never a meaningful-looking
 * percentage from 1-2 windows.
 */
export function rollingBeatPercentage(fundWindows: RollingWindowResult[], benchmarkWindows: RollingWindowResult[]): RollingBeatResult {
  const benchByEnd = new Map(benchmarkWindows.map((w) => [w.windowEndDate.getTime(), w.annualisedReturn]));
  const comparable = fundWindows.filter((w) => benchByEnd.has(w.windowEndDate.getTime()));
  if (comparable.length < MINIMUM_OBSERVATIONS.rollingMinWindows) {
    return { status: 'unavailable', reason: 'INSUFFICIENT_COMPARABLE_WINDOWS' };
  }
  const beats = comparable.filter((w) => w.annualisedReturn > benchByEnd.get(w.windowEndDate.getTime())!).length;
  const benchReturns = comparable.map((w) => benchByEnd.get(w.windowEndDate.getTime())!);
  return {
    status: 'ok',
    beatPct: beats / comparable.length,
    comparableWindows: comparable.length,
    benchmarkMedian: median(benchReturns),
  };
}
