// R4 — RiskMetricsEngine service layer (spec sections 38-50, 67).
//
// riskMetrics.ts holds the pure, independently-certified formulas. This
// module is the bounded SERVICE that (a) fixes the periodic-return
// frequency and its annualisation factor for both fund and benchmark,
// (b) resolves the risk-free rate from versioned reference data — never a
// hard-coded constant, and (c) runs the full suite, mapping every result
// onto the shared CalculationStatus vocabulary.
//
// Filename is deliberately lexically distinct from `riskMetrics.ts`: the
// repo is developed on a case-insensitive filesystem, where a
// `RiskMetrics.ts` service would silently overwrite the primitives.
//
// Suppression discipline (spec sections 37, 66): if the risk-free
// reference data a metric requires is absent, that metric is returned
// MISSING_REFERENCE_DATA. It is never defaulted to a plausible-looking
// rate, and never returned as 0.

import {
  volatility,
  downsideDeviation,
  maxDrawdown,
  sharpeRatio,
  sortinoRatio,
  beta,
  regressionAlpha,
  trackingError,
  informationRatio,
  captureRatios,
  calmarRatio,
  RISK_METRICS_METHOD_VERSION,
  type DrawdownResult,
} from './riskMetrics';
import { lookupRiskFreeRate, type RiskFreeRatePoint } from '@/lib/config/investment-intelligence/riskFreeRate';
import { fromRiskMetric, missingReferenceData, type CalculationOutcome } from './calculationStatus';

/** Observation frequency of the periodic-return series being analysed. */
export type ReturnFrequency = 'monthly' | 'daily';

/** Annualisation factors. Documented convention: daily = 252 trading days. */
export const PERIODS_PER_YEAR: Record<ReturnFrequency, number> = {
  monthly: 12,
  daily: 252,
};

export interface RiskMetricsRequest {
  /** Periodic returns of the fund/portfolio, e.g. 0.012 = +1.2% for the period. */
  fundReturns: number[];
  /** Benchmark periodic returns, aligned 1:1 by period with fundReturns. */
  benchmarkReturns?: number[];
  /** Valuation series used for drawdown and Calmar (ascending dates). */
  valuationSeries: Array<{ date: Date; value: number }>;
  frequency: ReturnFrequency;
  /** Country whose risk-free curve applies (spec section 37). */
  countryCode: string;
  /** Reference date used for the risk-free lookup (period end, by convention). */
  asOfDate: Date;
  /** Versioned risk-free reference data, loaded by the caller. Empty => suppression. */
  riskFreeSeries: RiskFreeRatePoint[];
}

export interface RiskMetricsResult {
  volatility: CalculationOutcome<{ annualisedVolatility: number; observationCount: number }>;
  downsideDeviation: CalculationOutcome<{ annualisedDownsideDeviation: number; observationCount: number; marPerPeriod: number }>;
  maxDrawdown: CalculationOutcome<DrawdownResult & Record<string, unknown>>;
  sharpeRatio: CalculationOutcome<{ sharpe: number }>;
  sortinoRatio: CalculationOutcome<{ sortino: number }>;
  beta: CalculationOutcome<{ beta: number }>;
  alpha: CalculationOutcome<{ alphaAnnualised: number; betaUsed: number }>;
  trackingError: CalculationOutcome<{ trackingError: number }>;
  informationRatio: CalculationOutcome<{ informationRatio: number }>;
  captureRatios: CalculationOutcome<{ upsideCapture: number | null; downsideCapture: number | null; upsidePeriods: number; downsidePeriods: number }>;
  calmarRatio: CalculationOutcome<{ calmar: number }>;
  /** Resolved risk-free rate actually used, for the calculation-details view. */
  riskFree: { status: 'ok' | 'unavailable'; rate?: number; source?: string; version?: string };
  frequency: ReturnFrequency;
  periodsPerYear: number;
  methodVersion: string;
}

const NO_BENCHMARK =
  'No benchmark series is mapped and available for this period, so benchmark-relative risk metrics cannot be calculated.';
const NO_RISK_FREE =
  'The risk-free rate for this country and period is not present in reference data. Risk-adjusted figures that require it are withheld rather than calculated against an assumed rate.';

export function computeRiskMetrics(req: RiskMetricsRequest): RiskMetricsResult {
  const periodsPerYear = PERIODS_PER_YEAR[req.frequency];
  const rf = lookupRiskFreeRate(req.riskFreeSeries, req.countryCode, req.asOfDate);
  const rfRate = rf.status === 'ok' ? rf.rate : undefined;
  const bench = req.benchmarkReturns ?? [];
  const hasBenchmark = bench.length > 0;

  const vol = fromRiskMetric(volatility(req.fundReturns, periodsPerYear));

  // Downside deviation uses the certified default MAR of 0 per period
  // ("any negative period is downside"). It does NOT require risk-free
  // data, so it is not suppressed when the risk-free curve is absent.
  const downside = fromRiskMetric(downsideDeviation(req.fundReturns, periodsPerYear));

  const dd = fromRiskMetric(maxDrawdown(req.valuationSeries));

  const sharpe =
    rfRate === undefined
      ? missingReferenceData<{ sharpe: number }>('RISK_FREE_DATA_MISSING', NO_RISK_FREE)
      : fromRiskMetric(sharpeRatio(req.fundReturns, periodsPerYear, rfRate));

  // Sortino's target rate is the risk-free rate; its MAR stays at the
  // certified default of 0 so it is consistent with downsideDeviation above.
  const sortino =
    rfRate === undefined
      ? missingReferenceData<{ sortino: number }>('RISK_FREE_DATA_MISSING', NO_RISK_FREE)
      : fromRiskMetric(sortinoRatio(req.fundReturns, periodsPerYear, rfRate));

  const betaOut = hasBenchmark
    ? fromRiskMetric(beta(req.fundReturns, bench))
    : missingReferenceData<{ beta: number }>('BENCHMARK_MAPPING_MISSING', NO_BENCHMARK);

  const alphaOut = !hasBenchmark
    ? missingReferenceData<{ alphaAnnualised: number; betaUsed: number }>('BENCHMARK_MAPPING_MISSING', NO_BENCHMARK)
    : rfRate === undefined
      ? missingReferenceData<{ alphaAnnualised: number; betaUsed: number }>('RISK_FREE_DATA_MISSING', NO_RISK_FREE)
      : fromRiskMetric(regressionAlpha(req.fundReturns, bench, periodsPerYear, rfRate));

  const te = hasBenchmark
    ? fromRiskMetric(trackingError(req.fundReturns, bench, periodsPerYear))
    : missingReferenceData<{ trackingError: number }>('BENCHMARK_MAPPING_MISSING', NO_BENCHMARK);

  const ir = hasBenchmark
    ? fromRiskMetric(informationRatio(req.fundReturns, bench, periodsPerYear))
    : missingReferenceData<{ informationRatio: number }>('BENCHMARK_MAPPING_MISSING', NO_BENCHMARK);

  const capture = hasBenchmark
    ? fromRiskMetric(captureRatios(req.fundReturns, bench))
    : missingReferenceData<{
        upsideCapture: number | null;
        downsideCapture: number | null;
        upsidePeriods: number;
        downsidePeriods: number;
      }>('BENCHMARK_MAPPING_MISSING', NO_BENCHMARK);

  return {
    volatility: vol,
    downsideDeviation: downside,
    maxDrawdown: dd,
    sharpeRatio: sharpe,
    sortinoRatio: sortino,
    beta: betaOut,
    alpha: alphaOut,
    trackingError: te,
    informationRatio: ir,
    captureRatios: capture,
    calmarRatio: computeCalmar(req, dd),
    riskFree:
      rf.status === 'ok'
        ? { status: 'ok', rate: rf.rate, source: rf.point?.source, version: rf.point?.version }
        : { status: 'unavailable' },
    frequency: req.frequency,
    periodsPerYear,
    methodVersion: RISK_METRICS_METHOD_VERSION,
  };
}

/**
 * Calmar needs an annualised return, the full DrawdownResult, and the
 * history length in days (the primitive enforces its own >= 1Y minimum).
 * The annualised return is derived from the valuation-series endpoints.
 */
function computeCalmar(
  req: RiskMetricsRequest,
  dd: CalculationOutcome<DrawdownResult & Record<string, unknown>>
): CalculationOutcome<{ calmar: number }> {
  const series = [...req.valuationSeries].sort((a, b) => a.date.getTime() - b.date.getTime());
  if (series.length < 2) {
    return missingReferenceData(
      'NAV_HISTORY_INCOMPLETE',
      'A valuation series with at least two points is required to annualise return for the Calmar ratio.'
    );
  }
  if (dd.status !== 'CALCULATED' || !dd.value) {
    // Propagate the drawdown's own unavailability rather than inventing one.
    return { status: dd.status, qualityFlag: dd.qualityFlag, engineReason: dd.engineReason, detail: dd.detail };
  }
  const first = series[0];
  const last = series[series.length - 1];
  const historyDays = (last.date.getTime() - first.date.getTime()) / 86_400_000;
  const years = historyDays / 365.25;
  if (years <= 0 || first.value <= 0) {
    return missingReferenceData(
      'NAV_HISTORY_INCOMPLETE',
      'The valuation series does not span a positive period with a positive opening value.'
    );
  }
  const annualisedReturn = Math.pow(last.value / first.value, 1 / years) - 1;
  return fromRiskMetric(calmarRatio(annualisedReturn, dd.value as DrawdownResult, historyDays));
}

/**
 * Derive periodic returns from a valuation series where the series
 * represents a NAV/index level (no external flows). Used for benchmark
 * series and for scheme-level NAV returns; NEVER used for a portfolio
 * with contributions/withdrawals — that path must go through TWRR.
 */
export function periodicReturnsFromLevels(levels: Array<{ date: Date; value: number }>): number[] {
  const sorted = [...levels].sort((a, b) => a.date.getTime() - b.date.getTime());
  const out: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1].value;
    if (prev > 0) out.push(sorted[i].value / prev - 1);
  }
  return out;
}
