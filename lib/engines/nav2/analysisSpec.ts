// NAV2 -- the ANALYSIS SPEC: one description of "what analysis is wanted for a
// held scheme", consumed by BOTH sides so they cannot drift apart:
//   * the Phase B window planner turns it into the NAV history that must exist
//     (requiredWindowPlanner.ts), and
//   * the Phase C orchestrator turns it into the metrics that are computed
//     (analyticsContract.ts).
// A metric that is in the spec therefore always has the history it needs
// requested, and a history requirement always corresponds to a metric.

import type { Nav2Policy, ReturnFrequency } from '@/lib/config/nav2/metricPolicy';
import { subtractMonthsIso } from './dates';

export interface PointToPointRequest {
  id: string;
  /** ISO. */
  start: string;
  end: string;
}

export interface MovingAverageRequest {
  kind: 'sma' | 'ema';
  /** Valid OBSERVATIONS, not calendar days. */
  period: number;
}

export interface AnalysisSpec {
  /** The calculation date (ISO). The latest NAV used is the latest valid published NAV on or before it; never a future one. */
  asOfDate: string;
  /**
   * The earliest date at which any analysis END-point is wanted. null = the earliest date the scheme is held
   * (the planner supplies it). This is what keeps hydration bounded: history is requested back from HERE, not
   * back to scheme inception, unless the caller explicitly asks for an earlier date.
   */
  analysisStart: string | null;
  /** null = the as-of date. */
  analysisEnd: string | null;
  pointToPoint: PointToPointRequest[];
  /** Rolling horizon ids from the policy (1M, 3M, 6M, 1Y, 3Y, 5Y). */
  rollingHorizonIds: string[];
  movingAverages: MovingAverageRequest[];
  /** Rate-of-change periods, in observations. */
  rocPeriods: number[];
  /** Volatility, Sharpe, Sortino, maximum drawdown. */
  risk: boolean;
  /** Beta and Jensen alpha (need a gated benchmark). */
  benchmarkRelative: boolean;
  frequency: ReturnFrequency;
}

/** A minimal spec: only what the held scheme's own earliest date and the as-of date need. No horizons, no averages. */
export function minimalAnalysisSpec(asOfDate: string): AnalysisSpec {
  return { asOfDate, analysisStart: null, analysisEnd: null, pointToPoint: [], rollingHorizonIds: [], movingAverages: [], rocPeriods: [], risk: false, benchmarkRelative: false, frequency: 'daily' };
}

/**
 * The standard report spec: every rolling horizon, the four approved SMAs and the 20 / 50 EMAs, risk and
 * benchmark-relative measures. WHICH of these a report actually shows is a Stage 2 product decision; this is
 * the widest set, so the history it implies (about five years before the earliest held date) is the upper
 * bound of what NAV2 would ever request for a scheme without an explicit inception-to-date request.
 */
export function standardAnalysisSpec(asOfDate: string, policy: Nav2Policy): AnalysisSpec {
  return {
    asOfDate,
    analysisStart: null,
    analysisEnd: null,
    pointToPoint: [],
    rollingHorizonIds: policy.rollingHorizons.map((h) => h.id),
    movingAverages: [...policy.movingAveragePeriods.map((period) => ({ kind: 'sma' as const, period })), { kind: 'ema' as const, period: 20 }, { kind: 'ema' as const, period: 50 }],
    rocPeriods: [20],
    risk: true,
    benchmarkRelative: true,
    frequency: 'daily',
  };
}

// ---------------------------------------------------------------------------
// The Fund analytics REPORT's period choice (Stage 2). One choice, applied to every scheme.
// ---------------------------------------------------------------------------

export type ReportPeriodChoice = 'since_first_held' | '1y' | '3y' | '5y' | 'all_history';

export const REPORT_PERIOD_CHOICES: readonly ReportPeriodChoice[] = ['since_first_held', '1y', '3y', '5y', 'all_history'];

export const REPORT_PERIOD_LABELS: Record<ReportPeriodChoice, string> = {
  since_first_held: 'Since you first held each fund',
  '1y': 'Last 1 year',
  '3y': 'Last 3 years',
  '5y': 'Last 5 years',
  all_history: 'All available history',
};

export function isReportPeriodChoice(x: unknown): x is ReportPeriodChoice {
  return typeof x === 'string' && (REPORT_PERIOD_CHOICES as readonly string[]).includes(x);
}

/**
 * The spec for a Fund analytics report. The point-to-point periods are the three trailing ones (1Y, 3Y, 5Y); the analysis
 * window follows the user's choice. `since_first_held` and `all_history` leave analysisStart null here: the planner then
 * starts from each scheme's earliest held date (the "first endpoint"), and the report assembler narrows the metric window
 * per scheme to its own first held date for `since_first_held`.
 */
export function reportAnalysisSpec(asOfDate: string, policy: Nav2Policy, choice: ReportPeriodChoice): AnalysisSpec {
  const base = standardAnalysisSpec(asOfDate, policy);
  const trailing: PointToPointRequest[] = [
    { id: '1Y', start: subtractMonthsIso(asOfDate, 12), end: asOfDate },
    { id: '3Y', start: subtractMonthsIso(asOfDate, 36), end: asOfDate },
    { id: '5Y', start: subtractMonthsIso(asOfDate, 60), end: asOfDate },
  ];
  const fixedStart = choice === '1y' ? subtractMonthsIso(asOfDate, 12) : choice === '3y' ? subtractMonthsIso(asOfDate, 36) : choice === '5y' ? subtractMonthsIso(asOfDate, 60) : null;
  return { ...base, pointToPoint: trailing, analysisStart: fixedStart };
}
