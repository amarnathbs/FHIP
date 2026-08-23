// R4 — BenchmarkEngine service layer (spec sections 28-36, 67).
//
// benchmarkEngine.ts holds the PURE, independently-certified primitives
// (resolveBenchmarkForDate, blendedBenchmarkReturn, activeReturn). This
// module is the bounded SERVICE that turns real, dated inputs —
// per-instrument valuation series, effective-dated mappings, and benchmark
// index series — into the period structure those primitives consume.
//
// NOTE ON FILE NAMING: this file is deliberately `benchmarkService.ts` and
// not `BenchmarkEngine.ts`. The repo is developed on a case-insensitive
// filesystem (Windows), where `BenchmarkEngine.ts` and `benchmarkEngine.ts`
// resolve to the SAME file and the service would silently overwrite the
// certified primitives. Keep service filenames lexically distinct, not
// merely differently-cased.
//
// No formula is re-implemented here; every arithmetic result still comes
// from the certified primitives. Read-only: consumes already-loaded
// reference data, writes nothing.

import {
  resolveBenchmarkForDate,
  blendedBenchmarkReturn,
  activeReturn,
  BLENDED_BENCHMARK_METHOD_VERSION,
  MIN_COVERAGE_FOR_CONCLUSION,
  type BenchmarkMapping,
  type BenchmarkPeriodReturn,
  type HoldingPeriodWeight,
  type BlendedBenchmarkResult,
  type ActiveReturnResult,
} from './benchmarkEngine';
import type { DataQualityAnnotation } from './dataQuality';

export interface SeriesPoint {
  date: Date;
  value: number;
}

/** Per-instrument portfolio valuation series (already in the instrument's own currency). */
export interface InstrumentValuationSeries {
  instrumentId: string;
  points: SeriesPoint[];
}

export interface BlendedBenchmarkRequest {
  periodStart: Date;
  periodEnd: Date;
  instrumentSeries: InstrumentValuationSeries[];
  mappings: BenchmarkMapping[];
  /** Benchmark index level series keyed by benchmarkId. */
  benchmarkSeriesById: Record<string, SeriesPoint[]>;
  /** When true, a PRI series standing in for a total-return comparison is flagged. */
  requireTotalReturn?: boolean;
}

export interface BlendedBenchmarkServiceResult {
  blended: BlendedBenchmarkResult;
  /** Rebalance boundaries actually used. */
  rebalanceDates: Date[];
  /** Benchmarks that contributed, for the "how this was calculated" view. */
  contributingBenchmarks: Array<{ benchmarkId: string; benchmarkKey: string; returnType: string }>;
  annotations: DataQualityAnnotation[];
  methodVersion: string;
  minCoverageThreshold: number;
}

/** Last series point on or before `date` (never interpolates, never looks forward). */
export function valueOnOrBefore(points: SeriesPoint[], date: Date): SeriesPoint | undefined {
  let best: SeriesPoint | undefined;
  for (const p of points) {
    if (p.date.getTime() <= date.getTime() && (!best || p.date.getTime() > best.date.getTime())) best = p;
  }
  return best;
}

/** Last calendar day of the month containing `d`, in UTC. */
function monthEnd(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
}

/**
 * Monthly rebalance boundaries spanning [start, end], inclusive of both
 * endpoints (spec section 33: monthly rebalancing). Deterministic and
 * timezone-independent (all UTC).
 */
export function monthlyRebalanceDates(start: Date, end: Date): Date[] {
  if (end.getTime() <= start.getTime()) return [new Date(start.getTime())];
  const out: Date[] = [new Date(start.getTime())];
  let cursor = monthEnd(start);
  while (cursor.getTime() < end.getTime()) {
    out.push(new Date(cursor.getTime()));
    // Advance to the first day of the next month, then take that month's end.
    cursor = monthEnd(new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1)));
  }
  out.push(new Date(end.getTime()));
  const seen = new Set<number>();
  return out
    .filter((d) => {
      const t = d.getTime();
      if (seen.has(t)) return false;
      seen.add(t);
      return true;
    })
    .sort((a, b) => a.getTime() - b.getTime());
}

/**
 * Build the monthly-rebalanced, weight-at-period-start period structure and
 * hand it to the certified blendedBenchmarkReturn primitive.
 *
 * Coverage discipline (spec section 34): an instrument with no effective
 * mapping on the period-start date counts toward the denominator as
 * `hasBenchmarkMapping: false`, so coverage genuinely falls and the
 * primitive suppresses the conclusion below MIN_COVERAGE_FOR_CONCLUSION.
 * An instrument whose benchmark exists but whose SERIES lacks a boundary
 * value is likewise treated as uncovered rather than silently assigned a
 * zero return — a missing input never becomes a 0% contribution.
 */
export function computeBlendedBenchmark(req: BlendedBenchmarkRequest): BlendedBenchmarkServiceResult {
  const annotations: DataQualityAnnotation[] = [];
  const rebalanceDates = monthlyRebalanceDates(req.periodStart, req.periodEnd);
  const contributing = new Map<string, { benchmarkId: string; benchmarkKey: string; returnType: string }>();

  if (rebalanceDates.length < 2) {
    return {
      blended: { status: 'unavailable', reason: 'NO_PERIODS' },
      rebalanceDates,
      contributingBenchmarks: [],
      annotations: [
        { flag: 'NAV_HISTORY_INCOMPLETE', detail: 'The selected period is too short to form a single rebalance period.' },
      ],
      methodVersion: BLENDED_BENCHMARK_METHOD_VERSION,
      minCoverageThreshold: MIN_COVERAGE_FOR_CONCLUSION,
    };
  }

  const periods: BenchmarkPeriodReturn[] = [];
  let sawUnmapped = false;
  let sawMissingSeries = false;
  let sawPriForTotalReturn = false;

  for (let i = 0; i < rebalanceDates.length - 1; i++) {
    const pStart = rebalanceDates[i];
    const pEnd = rebalanceDates[i + 1];

    // Weights are taken at the START of the period (spec section 33).
    const valuesAtStart: Array<{ instrumentId: string; value: number }> = [];
    for (const s of req.instrumentSeries) {
      const v = valueOnOrBefore(s.points, pStart);
      if (v && v.value > 0) valuesAtStart.push({ instrumentId: s.instrumentId, value: v.value });
    }
    const total = valuesAtStart.reduce((sum, v) => sum + v.value, 0);
    if (total <= 0) continue;

    const weights: HoldingPeriodWeight[] = [];
    const benchmarkReturnsByInstrument: Record<string, number> = {};

    for (const { instrumentId, value } of valuesAtStart) {
      const weight = value / total;
      const mapping = resolveBenchmarkForDate(req.mappings, instrumentId, pStart);
      if (!mapping) {
        sawUnmapped = true;
        weights.push({ instrumentId, weight, hasBenchmarkMapping: false });
        continue;
      }
      const series = req.benchmarkSeriesById[mapping.benchmarkId] ?? [];
      const bStart = valueOnOrBefore(series, pStart);
      const bEnd = valueOnOrBefore(series, pEnd);
      if (!bStart || !bEnd || bStart.value <= 0) {
        sawMissingSeries = true;
        weights.push({ instrumentId, weight, hasBenchmarkMapping: false });
        continue;
      }
      if (req.requireTotalReturn && mapping.returnType === 'PRI') sawPriForTotalReturn = true;
      contributing.set(mapping.benchmarkId, {
        benchmarkId: mapping.benchmarkId,
        benchmarkKey: mapping.benchmarkKey,
        returnType: mapping.returnType,
      });
      weights.push({ instrumentId, weight, hasBenchmarkMapping: true });
      benchmarkReturnsByInstrument[instrumentId] = bEnd.value / bStart.value - 1;
    }

    periods.push({ periodStart: pStart, periodEnd: pEnd, weights, benchmarkReturnsByInstrument });
  }

  if (sawUnmapped) {
    annotations.push({
      flag: 'BENCHMARK_MAPPING_MISSING',
      detail: 'One or more holdings have no benchmark mapping effective for part of the selected period, reducing benchmark coverage.',
    });
  }
  if (sawMissingSeries) {
    annotations.push({
      flag: 'BENCHMARK_HISTORY_INCOMPLETE',
      detail: 'One or more mapped benchmarks lack index values at the required period boundaries, reducing benchmark coverage.',
    });
  }
  if (sawPriForTotalReturn) {
    annotations.push({
      flag: 'BENCHMARK_HISTORY_INCOMPLETE',
      detail: 'A Price Return Index (PRI) series was used where a Total Return Index (TRI) is required. PRI excludes dividends and understates the benchmark, so this comparison is qualified rather than presented as a like-for-like total return.',
    });
  }

  return {
    blended: blendedBenchmarkReturn(periods),
    rebalanceDates,
    contributingBenchmarks: [...contributing.values()],
    annotations,
    methodVersion: BLENDED_BENCHMARK_METHOD_VERSION,
    minCoverageThreshold: MIN_COVERAGE_FOR_CONCLUSION,
  };
}

/**
 * Portfolio active return. Deliberately accepts ONLY a TWRR-vs-blended-TWRR
 * pair (spec section 36): portfolio XIRR must never be differenced against a
 * benchmark time-weighted return. The `'TWRR'` family argument is fixed
 * here rather than caller-supplied, so the incompatible combination is
 * unrepresentable at this call site.
 */
export function computePortfolioActiveReturn(
  portfolioTwrr: number | undefined,
  blendedBenchmarkTwrr: number | undefined
): ActiveReturnResult {
  return activeReturn(portfolioTwrr, blendedBenchmarkTwrr, 'TWRR');
}

/**
 * Scheme active return against its own primary benchmark, restricted to a
 * compatible measure pair. `family` describes BOTH sides of the subtraction.
 */
export function computeSchemeActiveReturn(
  schemeMetric: number | undefined,
  benchmarkMetric: number | undefined,
  family: 'CAGR' | 'POINT_TO_POINT'
): ActiveReturnResult {
  return activeReturn(schemeMetric, benchmarkMetric, family);
}

/**
 * Benchmark return over an arbitrary window, expressed in BOTH measure
 * families so the caller can pick the one matching its scheme-side figure.
 */
export function benchmarkWindowReturn(
  series: SeriesPoint[],
  start: Date,
  end: Date
): { status: 'ok' | 'unavailable'; pointToPoint?: number; cagr?: number; reason?: string } {
  const s = valueOnOrBefore(series, start);
  const e = valueOnOrBefore(series, end);
  if (!s || !e) return { status: 'unavailable', reason: 'BENCHMARK_HISTORY_INCOMPLETE' };
  if (s.value <= 0) return { status: 'unavailable', reason: 'INVALID_INPUT' };
  const pointToPoint = e.value / s.value - 1;
  const years = (e.date.getTime() - s.date.getTime()) / (365.25 * 86_400_000);
  const cagr = years > 0 ? Math.pow(e.value / s.value, 1 / years) - 1 : undefined;
  return { status: 'ok', pointToPoint, cagr };
}
