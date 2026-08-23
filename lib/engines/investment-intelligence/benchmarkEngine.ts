// R4 — BenchmarkEngine: blended-portfolio-benchmark construction and
// active-return calculation (spec sections 28-36).
//
// Blended benchmark methodology (versioned — BLENDED_BENCHMARK_METHOD_VERSION
// must be bumped, never silently changed, if any step below changes):
//   1. Resolve each holding's applicable PRIMARY benchmark via the
//      effective-dated ii_instrument_benchmarks mapping (resolveBenchmarkForDate).
//   2. Compute portfolio weights at the START of each rebalance period
//      (default: monthly — REBALANCE_FREQUENCY, itself versioned/configurable).
//   3. Aggregate holdings that share the same benchmark.
//   4. Weighted benchmark-period return: R_blend,t = Σ w_i,t-1 * R_benchmark_i,t
//   5. Rebalance at the configured frequency (monthly by default).
//   6. Chain-link: Blended Benchmark Return = Π(1 + R_blend,t) - 1
//
// Benchmark coverage = % of portfolio value (at each rebalance point) that
// has a valid benchmark mapping. If coverage falls below
// MIN_COVERAGE_FOR_CONCLUSION, the active-return conclusion is suppressed
// (status 'unavailable', reason INSUFFICIENT_BENCHMARK_COVERAGE) rather
// than silently presented as if coverage were 100%.
//
// Active return = Portfolio TWRR - Blended Benchmark TWRR for the SAME
// period. Scheme active return = scheme CAGR/point-to-point return minus
// the SAME metric type for the benchmark (never annualised-vs-non-annualised
// mixing). Portfolio active return NEVER mixes Portfolio XIRR with
// Benchmark TWRR — both sides of the subtraction must be the same
// metric family.

export const BLENDED_BENCHMARK_METHOD_VERSION = 'blended-benchmark-monthly-rebalance-v1';
export const REBALANCE_FREQUENCY = 'monthly' as const;
export const MIN_COVERAGE_FOR_CONCLUSION = 0.8; // 80% — below this, active return is suppressed, not just footnoted

export interface BenchmarkMapping {
  instrumentId: string;
  benchmarkId: string;
  benchmarkKey: string;
  returnType: 'TRI' | 'PRI' | 'DEBT_INDEX' | 'COMMODITY_GOLD' | 'OTHER';
  effectiveFrom: Date;
  effectiveTo: Date | null;
}

/** Resolve the effective primary benchmark mapping for an instrument on a given date. Never hard-coded. */
export function resolveBenchmarkForDate(mappings: BenchmarkMapping[], instrumentId: string, date: Date): BenchmarkMapping | undefined {
  return mappings.find(
    (m) =>
      m.instrumentId === instrumentId &&
      m.effectiveFrom.getTime() <= date.getTime() &&
      (m.effectiveTo === null || m.effectiveTo.getTime() >= date.getTime())
  );
}

export interface HoldingPeriodWeight {
  instrumentId: string;
  weight: number; // fraction of portfolio value at rebalance-period start, 0..1
  hasBenchmarkMapping: boolean;
}

export interface BenchmarkPeriodReturn {
  periodStart: Date;
  periodEnd: Date;
  weights: HoldingPeriodWeight[];
  /** Per-instrument benchmark return for this period (already resolved by caller from the benchmark's own series). */
  benchmarkReturnsByInstrument: Record<string, number>;
}

export interface BlendedBenchmarkResult {
  status: 'ok' | 'unavailable';
  blendedReturn?: number;
  coveragePct?: number; // value-weighted average coverage across all periods
  periodReturns?: number[];
  reason?: 'INSUFFICIENT_BENCHMARK_COVERAGE' | 'NO_PERIODS' | 'INVALID_INPUT';
  method?: typeof BLENDED_BENCHMARK_METHOD_VERSION;
}

export function blendedBenchmarkReturn(periods: BenchmarkPeriodReturn[]): BlendedBenchmarkResult {
  if (!periods || periods.length === 0) {
    return { status: 'unavailable', reason: 'NO_PERIODS' };
  }
  const periodReturns: number[] = [];
  let coverageWeightedSum = 0;
  for (const period of periods) {
    const coveredWeight = period.weights.filter((w) => w.hasBenchmarkMapping).reduce((s, w) => s + w.weight, 0);
    coverageWeightedSum += coveredWeight;
    let periodReturn = 0;
    for (const w of period.weights) {
      if (!w.hasBenchmarkMapping) continue; // uncovered holdings contribute 0 weight to the blend, tracked separately via coverage
      const r = period.benchmarkReturnsByInstrument[w.instrumentId];
      if (r === undefined) continue;
      periodReturn += w.weight * r;
    }
    // Renormalise by covered weight so uncovered holdings don't silently
    // drag the blended return toward zero — the coverage % is reported
    // separately so the caller can suppress/qualify appropriately.
    periodReturns.push(coveredWeight > 0 ? periodReturn / coveredWeight : 0);
  }
  const coveragePct = coverageWeightedSum / periods.length;
  const blendedReturn = periodReturns.reduce((acc, r) => acc * (1 + r), 1) - 1;

  if (coveragePct < MIN_COVERAGE_FOR_CONCLUSION) {
    return { status: 'unavailable', reason: 'INSUFFICIENT_BENCHMARK_COVERAGE', coveragePct, blendedReturn, periodReturns, method: BLENDED_BENCHMARK_METHOD_VERSION };
  }
  return { status: 'ok', blendedReturn, coveragePct, periodReturns, method: BLENDED_BENCHMARK_METHOD_VERSION };
}

export interface ActiveReturnResult {
  status: 'ok' | 'unavailable';
  activeReturn?: number;
  reason?: 'INCOMPATIBLE_METRICS' | 'BENCHMARK_UNAVAILABLE' | 'PORTFOLIO_METRIC_UNAVAILABLE';
  detail?: string;
}

/**
 * Active return = Portfolio metric - Benchmark metric for the SAME metric
 * family and SAME period. `metricFamily` is required and self-documenting
 * so callers cannot silently mix e.g. XIRR (portfolio) with TWRR
 * (benchmark) — both `portfolioMetric` and `benchmarkMetric` MUST be
 * pre-verified by the caller to be the same family before calling this.
 */
export function activeReturn(
  portfolioMetric: number | undefined,
  benchmarkMetric: number | undefined,
  metricFamily: 'TWRR' | 'CAGR' | 'POINT_TO_POINT'
): ActiveReturnResult {
  if (portfolioMetric === undefined) return { status: 'unavailable', reason: 'PORTFOLIO_METRIC_UNAVAILABLE' };
  if (benchmarkMetric === undefined) return { status: 'unavailable', reason: 'BENCHMARK_UNAVAILABLE' };
  if (!metricFamily) return { status: 'unavailable', reason: 'INCOMPATIBLE_METRICS', detail: 'metricFamily is required to guarantee compatible comparison.' };
  return { status: 'ok', activeReturn: portfolioMetric - benchmarkMetric };
}
