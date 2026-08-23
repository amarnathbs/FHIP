// R4 — RollingReturnEngine service layer (spec sections 51-53, 67).
//
// rollingReturns.ts holds the pure primitives. This module is the bounded
// SERVICE that runs the standard 1Y/3Y/5Y horizon set over a month-end
// valuation series, pairs each horizon with its benchmark equivalent, and
// maps every outcome onto the shared CalculationStatus vocabulary.
//
// Filename is deliberately lexically distinct from `rollingReturns.ts`
// (case-insensitive filesystem — see benchmarkService.ts header).
//
// A horizon with too few windows is reported INSUFFICIENT_HISTORY, never
// as a beat-% computed from one or two windows.

import {
  rollingReturnSeries,
  rollingBeatPercentage,
  ROLLING_RETURN_METHOD_VERSION,
  type MonthEndValuation,
  type RollingWindowResult,
  type RollingReturnSeriesResult,
} from './rollingReturns';
import { insufficientHistory, type CalculationOutcome } from './calculationStatus';

/** The standard consistency horizons (spec section 51). */
export const ROLLING_HORIZON_YEARS = [1, 3, 5] as const;
export type RollingHorizon = (typeof ROLLING_HORIZON_YEARS)[number];

export interface RollingHorizonResult {
  windowYears: RollingHorizon;
  series: CalculationOutcome<NonNullable<RollingReturnSeriesResult['stats']>>;
  /** Raw windows retained for charting; empty when the horizon is unavailable. */
  windows: RollingWindowResult[];
  beat: CalculationOutcome<{ beatPct: number; comparableWindows: number; benchmarkMedian: number }>;
}

export interface RollingReturnServiceResult {
  horizons: RollingHorizonResult[];
  methodVersion: string;
}

const INSUFFICIENT_WINDOWS =
  'Not enough complete rolling windows exist in the available history to report this horizon. A percentage derived from one or two windows would not be meaningful, so it is withheld.';
const NO_BENCHMARK_WINDOWS =
  'Not enough benchmark windows align with the fund windows to report a benchmark-beat percentage for this horizon.';

/**
 * Run every standard horizon over the supplied month-end series. The
 * benchmark series is optional: without it, per-horizon return statistics
 * are still produced, and only the beat-% is suppressed.
 */
export function computeRollingReturns(
  fundMonthly: MonthEndValuation[],
  benchmarkMonthly?: MonthEndValuation[]
): RollingReturnServiceResult {
  const horizons: RollingHorizonResult[] = ROLLING_HORIZON_YEARS.map((windowYears) => {
    const fundSeries = rollingReturnSeries(fundMonthly, windowYears);
    const fundWindows = fundSeries.status === 'ok' ? (fundSeries.windows ?? []) : [];

    const series: RollingHorizonResult['series'] =
      fundSeries.status === 'ok' && fundSeries.stats
        ? { status: 'CALCULATED', value: fundSeries.stats }
        : insufficientHistory('INSUFFICIENT_HISTORY', INSUFFICIENT_WINDOWS);

    let beat: RollingHorizonResult['beat'];
    if (!benchmarkMonthly || benchmarkMonthly.length === 0) {
      beat = {
        status: 'MISSING_REFERENCE_DATA',
        qualityFlag: 'BENCHMARK_MAPPING_MISSING',
        detail: 'No benchmark series is available for this scope, so a rolling benchmark-beat percentage cannot be calculated.',
      };
    } else if (fundWindows.length === 0) {
      beat = insufficientHistory('INSUFFICIENT_HISTORY', INSUFFICIENT_WINDOWS);
    } else {
      const benchSeries = rollingReturnSeries(benchmarkMonthly, windowYears);
      const benchWindows = benchSeries.status === 'ok' ? (benchSeries.windows ?? []) : [];
      const r = rollingBeatPercentage(fundWindows, benchWindows);
      beat =
        r.status === 'ok'
          ? {
              status: 'CALCULATED',
              value: {
                beatPct: r.beatPct!,
                comparableWindows: r.comparableWindows!,
                benchmarkMedian: r.benchmarkMedian!,
              },
            }
          : insufficientHistory('BENCHMARK_HISTORY_INCOMPLETE', NO_BENCHMARK_WINDOWS);
    }

    return { windowYears, series, windows: fundWindows, beat };
  });

  return { horizons, methodVersion: ROLLING_RETURN_METHOD_VERSION };
}

/**
 * Collapse an arbitrary dated valuation series onto a month-end grid by
 * taking the LAST observation within each calendar month. Never
 * interpolates or carries a value forward into a month that has no
 * observation at all.
 */
export function toMonthEndSeries(points: Array<{ date: Date; value: number }>): MonthEndValuation[] {
  const byMonth = new Map<string, { date: Date; value: number }>();
  for (const p of points) {
    const key = `${p.date.getUTCFullYear()}-${String(p.date.getUTCMonth() + 1).padStart(2, '0')}`;
    const existing = byMonth.get(key);
    if (!existing || p.date.getTime() > existing.date.getTime()) byMonth.set(key, p);
  }
  return [...byMonth.values()].sort((a, b) => a.date.getTime() - b.date.getTime());
}
