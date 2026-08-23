// R4 — Risk / consistency metrics (spec sections 37-49). Each function
// documents its exact formula, convention, and minimum-history rule in
// this file header and re-states it at the function. All functions
// consume ALREADY frequency-aligned periodic return series (same dates,
// same frequency for fund and benchmark) — callers are responsible for
// alignment (see rollingReturns.ts / PerformanceEngine for how alignment
// is produced); these functions never silently mix daily fund data with
// monthly benchmark data.
//
// Sample vs population standard deviation: SAMPLE (n-1 denominator) is
// used throughout, consistent with standard industry risk-reporting
// practice for a finite historical sample. Documented once here.
//
// Risk-free input: callers must supply an annualised risk-free rate from
// the versioned reference-data source (see riskFreeRate.ts) or the
// affected metric (Sharpe, alpha, information-ratio's use of active
// return is exempt) is suppressed — this module accepts risk-free as a
// plain number/undefined and returns 'unavailable' if required and
// missing; it does not fetch it itself.

import { MINIMUM_OBSERVATIONS } from '@/lib/config/investment-intelligence/minimumHistory';

export const RISK_METRICS_METHOD_VERSION = 'risk-metrics-v1';

export type RiskUnavailableReason =
  | 'INSUFFICIENT_HISTORY'
  | 'ZERO_VOLATILITY'
  | 'ZERO_BENCHMARK_VARIANCE'
  | 'ZERO_TRACKING_ERROR'
  | 'ZERO_DRAWDOWN'
  | 'MISSING_RISK_FREE_DATA'
  | 'INVALID_INPUT'
  | 'INSUFFICIENT_DIRECTIONAL_PERIODS';

export interface MetricResult<T extends Record<string, unknown> = Record<string, unknown>> {
  status: 'ok' | 'unavailable';
  reason?: RiskUnavailableReason;
  detail?: string;
  value?: T;
}

function sampleStdDev(xs: number[]): number {
  const n = xs.length;
  const mean = xs.reduce((s, x) => s + x, 0) / n;
  const variance = xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1);
  return Math.sqrt(variance);
}
function mean(xs: number[]): number {
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

/**
 * Volatility = StdDev(periodic returns) * sqrt(periodsPerYear).
 * `periodsPerYear` documents the observation frequency being annualised
 * (12 for monthly, 252 for daily trading days, 365 for daily calendar).
 */
export function volatility(periodicReturns: number[], periodsPerYear: number): MetricResult<{ annualisedVolatility: number; observationCount: number }> {
  if (periodicReturns.length < MINIMUM_OBSERVATIONS.volatilityMinObservations) {
    return { status: 'unavailable', reason: 'INSUFFICIENT_HISTORY', detail: `Need >= ${MINIMUM_OBSERVATIONS.volatilityMinObservations} observations, got ${periodicReturns.length}.` };
  }
  const sd = sampleStdDev(periodicReturns);
  return { status: 'ok', value: { annualisedVolatility: sd * Math.sqrt(periodsPerYear), observationCount: periodicReturns.length } };
}

/**
 * Downside deviation relative to a minimum acceptable return (MAR),
 * expressed as a PER-PERIOD target. MAR defaults to 0 per period — i.e.
 * "any period with a negative return counts as downside" — and this
 * default is explicit/versioned; a nonzero MAR must be passed explicitly.
 */
export function downsideDeviation(
  periodicReturns: number[],
  periodsPerYear: number,
  marPerPeriod: number = 0
): MetricResult<{ annualisedDownsideDeviation: number; observationCount: number; marPerPeriod: number }> {
  if (periodicReturns.length < MINIMUM_OBSERVATIONS.volatilityMinObservations) {
    return { status: 'unavailable', reason: 'INSUFFICIENT_HISTORY' };
  }
  const downsideSquares = periodicReturns.map((r) => (r < marPerPeriod ? (r - marPerPeriod) ** 2 : 0));
  const variance = downsideSquares.reduce((s, x) => s + x, 0) / (periodicReturns.length - 1);
  return {
    status: 'ok',
    value: { annualisedDownsideDeviation: Math.sqrt(variance) * Math.sqrt(periodsPerYear), observationCount: periodicReturns.length, marPerPeriod },
  };
}

export interface DrawdownResult {
  maxDrawdown: number; // negative fraction, e.g. -0.182 = -18.2%
  peakDate: Date;
  peakValue: number;
  troughDate: Date;
  troughValue: number;
  recoveryDate: Date | null; // null if not yet recovered by the end of the series
  recoveryDurationDays: number | null;
}

/**
 * Max drawdown from a cumulative-wealth / valuation series:
 *   drawdown_t = value_t / running_peak_t - 1
 * Returns the single worst drawdown episode (peak -> trough) and, if the
 * series recovers to a new high after the trough, the recovery date.
 */
export function maxDrawdown(series: Array<{ date: Date; value: number }>): MetricResult<DrawdownResult & Record<string, unknown>> {
  if (!series || series.length < 2) {
    return { status: 'unavailable', reason: 'INSUFFICIENT_HISTORY' };
  }
  const sorted = [...series].sort((a, b) => a.date.getTime() - b.date.getTime());
  let runningPeak = sorted[0].value;
  let runningPeakDate = sorted[0].date;
  let worst = 0;
  let worstPeakDate = sorted[0].date;
  let worstPeakValue = sorted[0].value;
  let worstTroughDate = sorted[0].date;
  let worstTroughValue = sorted[0].value;

  for (const point of sorted) {
    if (point.value > runningPeak) {
      runningPeak = point.value;
      runningPeakDate = point.date;
    }
    const dd = point.value / runningPeak - 1;
    if (dd < worst) {
      worst = dd;
      worstPeakDate = runningPeakDate;
      worstPeakValue = runningPeak;
      worstTroughDate = point.date;
      worstTroughValue = point.value;
    }
  }

  if (worst === 0) {
    return { status: 'ok', value: { maxDrawdown: 0, peakDate: sorted[0].date, peakValue: sorted[0].value, troughDate: sorted[0].date, troughValue: sorted[0].value, recoveryDate: sorted[0].date, recoveryDurationDays: 0 } };
  }

  // Recovery: first date after the trough where value >= worstPeakValue.
  const recovery = sorted.find((p) => p.date.getTime() > worstTroughDate.getTime() && p.value >= worstPeakValue);
  const recoveryDate = recovery ? recovery.date : null;
  const recoveryDurationDays = recoveryDate ? (recoveryDate.getTime() - worstTroughDate.getTime()) / 86_400_000 : null;

  return {
    status: 'ok',
    value: { maxDrawdown: worst, peakDate: worstPeakDate, peakValue: worstPeakValue, troughDate: worstTroughDate, troughValue: worstTroughValue, recoveryDate, recoveryDurationDays },
  };
}

/** Sharpe = annualised excess return / annualised volatility. */
export function sharpeRatio(
  periodicReturns: number[],
  periodsPerYear: number,
  annualisedRiskFreeRate: number | undefined
): MetricResult<{ sharpe: number }> {
  if (annualisedRiskFreeRate === undefined) return { status: 'unavailable', reason: 'MISSING_RISK_FREE_DATA' };
  const vol = volatility(periodicReturns, periodsPerYear);
  if (vol.status !== 'ok') return { status: 'unavailable', reason: vol.reason };
  if (vol.value!.annualisedVolatility === 0) return { status: 'unavailable', reason: 'ZERO_VOLATILITY' };
  const annualisedReturn = Math.pow(1 + mean(periodicReturns), periodsPerYear) - 1;
  const sharpe = (annualisedReturn - annualisedRiskFreeRate) / vol.value!.annualisedVolatility;
  return { status: 'ok', value: { sharpe } };
}

/** Sortino = annualised return above target / annualised downside deviation. Target defaults to the risk-free rate if not separately specified. */
export function sortinoRatio(
  periodicReturns: number[],
  periodsPerYear: number,
  annualisedTargetRate: number | undefined,
  marPerPeriod: number = 0
): MetricResult<{ sortino: number }> {
  if (annualisedTargetRate === undefined) return { status: 'unavailable', reason: 'MISSING_RISK_FREE_DATA' };
  const dd = downsideDeviation(periodicReturns, periodsPerYear, marPerPeriod);
  if (dd.status !== 'ok') return { status: 'unavailable', reason: dd.reason };
  if (dd.value!.annualisedDownsideDeviation === 0) return { status: 'unavailable', reason: 'ZERO_VOLATILITY' };
  const annualisedReturn = Math.pow(1 + mean(periodicReturns), periodsPerYear) - 1;
  const sortino = (annualisedReturn - annualisedTargetRate) / dd.value!.annualisedDownsideDeviation;
  return { status: 'ok', value: { sortino } };
}

/** Beta = Cov(fund, benchmark) / Var(benchmark), on aligned periodic observations. */
export function beta(fundReturns: number[], benchmarkReturns: number[]): MetricResult<{ beta: number }> {
  if (fundReturns.length !== benchmarkReturns.length) return { status: 'unavailable', reason: 'INVALID_INPUT', detail: 'Fund and benchmark series must be aligned to the same dates.' };
  if (fundReturns.length < MINIMUM_OBSERVATIONS.betaMinObservations) return { status: 'unavailable', reason: 'INSUFFICIENT_HISTORY' };
  const fMean = mean(fundReturns);
  const bMean = mean(benchmarkReturns);
  const n = fundReturns.length;
  let cov = 0;
  let varB = 0;
  for (let i = 0; i < n; i++) {
    cov += (fundReturns[i] - fMean) * (benchmarkReturns[i] - bMean);
    varB += (benchmarkReturns[i] - bMean) ** 2;
  }
  cov /= n - 1;
  varB /= n - 1;
  if (varB === 0) return { status: 'unavailable', reason: 'ZERO_BENCHMARK_VARIANCE' };
  return { status: 'ok', value: { beta: cov / varB } };
}

/**
 * Regression (Jensen's) alpha — NEVER `fund_return - benchmark_return`
 * (that is active return, a different concept). Single-factor CAPM
 * regression: fund_excess_t = alpha + beta * benchmark_excess_t + e_t,
 * solved via OLS (beta from the beta() function above, alpha = mean(fund
 * excess) - beta * mean(benchmark excess)). Alpha is then annualised by
 * geometric compounding of the periodic alpha: (1+alpha_period)^ppy - 1 —
 * an explicit, documented convention (distinct from the arithmetic
 * annualisation convention used for the Information Ratio's active
 * return, which is industry-standard for THAT ratio specifically).
 */
export function regressionAlpha(
  fundReturns: number[],
  benchmarkReturns: number[],
  periodsPerYear: number,
  annualisedRiskFreeRate: number | undefined
): MetricResult<{ alphaAnnualised: number; betaUsed: number }> {
  if (annualisedRiskFreeRate === undefined) return { status: 'unavailable', reason: 'MISSING_RISK_FREE_DATA' };
  const b = beta(fundReturns, benchmarkReturns);
  if (b.status !== 'ok') return { status: 'unavailable', reason: b.reason };
  const rfPerPeriod = Math.pow(1 + annualisedRiskFreeRate, 1 / periodsPerYear) - 1;
  const fundExcess = fundReturns.map((r) => r - rfPerPeriod);
  const benchExcess = benchmarkReturns.map((r) => r - rfPerPeriod);
  const alphaPerPeriod = mean(fundExcess) - b.value!.beta * mean(benchExcess);
  const alphaAnnualised = Math.pow(1 + alphaPerPeriod, periodsPerYear) - 1;
  return { status: 'ok', value: { alphaAnnualised, betaUsed: b.value!.beta } };
}

/** Tracking error = annualised StdDev(fund_t - benchmark_t). */
export function trackingError(fundReturns: number[], benchmarkReturns: number[], periodsPerYear: number): MetricResult<{ trackingError: number }> {
  if (fundReturns.length !== benchmarkReturns.length) return { status: 'unavailable', reason: 'INVALID_INPUT' };
  if (fundReturns.length < MINIMUM_OBSERVATIONS.trackingErrorMinObservations) return { status: 'unavailable', reason: 'INSUFFICIENT_HISTORY' };
  const active = fundReturns.map((r, i) => r - benchmarkReturns[i]);
  const sd = sampleStdDev(active);
  return { status: 'ok', value: { trackingError: sd * Math.sqrt(periodsPerYear) } };
}

/**
 * Information Ratio = Annualised Active Return / Annualised Tracking
 * Error. Uses ARITHMETIC annualisation of the mean periodic active return
 * (mean(active) * periodsPerYear) — the industry-standard convention for
 * this specific ratio, distinct from the chain-linked/geometric "Active
 * Return" headline figure computed elsewhere (BenchmarkEngine) from TWRR
 * minus blended-benchmark TWRR. Both conventions are documented; they are
 * not interchangeable and must never be silently swapped.
 */
export function informationRatio(fundReturns: number[], benchmarkReturns: number[], periodsPerYear: number): MetricResult<{ informationRatio: number }> {
  const te = trackingError(fundReturns, benchmarkReturns, periodsPerYear);
  if (te.status !== 'ok') return { status: 'unavailable', reason: te.reason };
  if (te.value!.trackingError === 0) return { status: 'unavailable', reason: 'ZERO_TRACKING_ERROR' };
  const active = fundReturns.map((r, i) => r - benchmarkReturns[i]);
  const annualisedActiveReturn = mean(active) * periodsPerYear;
  return { status: 'ok', value: { informationRatio: annualisedActiveReturn / te.value!.trackingError } };
}

/**
 * Upside/Downside capture, COMPOUNDED-period-return methodology:
 * Upside capture = (chain-linked fund return over benchmark-positive
 * periods) / (chain-linked benchmark return over those same periods).
 * Downside capture = the equivalent over benchmark-negative periods.
 * Requires >= MINIMUM_OBSERVATIONS.captureRatioMinPeriodsPerDirection
 * periods in each direction. The SAME compounded-period method is used by
 * the independent oracle (never a different averaging method between the
 * two, per spec section 46).
 */
export function captureRatios(
  fundReturns: number[],
  benchmarkReturns: number[]
): MetricResult<{ upsideCapture: number | null; downsideCapture: number | null; upsidePeriods: number; downsidePeriods: number }> {
  if (fundReturns.length !== benchmarkReturns.length) return { status: 'unavailable', reason: 'INVALID_INPUT' };
  const upIdx: number[] = [];
  const downIdx: number[] = [];
  benchmarkReturns.forEach((r, i) => {
    if (r > 0) upIdx.push(i);
    else if (r < 0) downIdx.push(i);
  });
  const compound = (idxs: number[], returns: number[]) => idxs.reduce((acc, i) => acc * (1 + returns[i]), 1) - 1;

  const min = MINIMUM_OBSERVATIONS.captureRatioMinPeriodsPerDirection;
  const upsideCapture = upIdx.length >= min ? compound(upIdx, fundReturns) / compound(upIdx, benchmarkReturns) : null;
  const downsideCapture = downIdx.length >= min ? compound(downIdx, fundReturns) / compound(downIdx, benchmarkReturns) : null;

  if (upsideCapture === null && downsideCapture === null) {
    return { status: 'unavailable', reason: 'INSUFFICIENT_DIRECTIONAL_PERIODS' };
  }
  return { status: 'ok', value: { upsideCapture, downsideCapture, upsidePeriods: upIdx.length, downsidePeriods: downIdx.length } };
}

/** Calmar = Annualised Return / |Max Drawdown|. Requires >= 1Y history and a nonzero drawdown. */
export function calmarRatio(
  annualisedReturn: number,
  drawdown: DrawdownResult,
  historyDays: number
): MetricResult<{ calmar: number }> {
  if (historyDays < MINIMUM_OBSERVATIONS.calmarMinDays) return { status: 'unavailable', reason: 'INSUFFICIENT_HISTORY' };
  if (drawdown.maxDrawdown === 0) return { status: 'unavailable', reason: 'ZERO_DRAWDOWN' };
  return { status: 'ok', value: { calmar: annualisedReturn / Math.abs(drawdown.maxDrawdown) } };
}
