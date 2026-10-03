// NAV2 -- the ANALYSIS SPEC: one description of "what analysis is wanted for a
// held scheme", consumed by BOTH sides so they cannot drift apart:
//   * the Phase B window planner turns it into the NAV history that must exist
//     (requiredWindowPlanner.ts), and
//   * the Phase C orchestrator turns it into the metrics that are computed
//     (analyticsContract.ts).
// A metric that is in the spec therefore always has the history it needs
// requested, and a history requirement always corresponds to a metric.

import type { Nav2Policy, ReturnFrequency } from '@/lib/config/nav2/metricPolicy';

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
