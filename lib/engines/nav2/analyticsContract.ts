// NAV2 -- the SERVICE CONTRACT a report section, a screen or a cache layer calls
// (spec 12, 13). Pure: it assembles the typed results of the individual engine
// functions for ONE held scheme from an AnalysisSpec, and keeps the two result
// families apart (spec 2):
//
//   scheme       -> the fund's own NAV series (CAGR, rolling, volatility, ...). Never
//                   reads a cash flow; labelled as the scheme's growth, not the user's return.
//   investor     -> the user's own money (XIRR, current value, invested, gain / loss).
//                   Never reads a scheme CAGR.
//
// `explanation` is the plain-language difference a screen puts between them.
// Calls are deterministic: the same inputs give a byte-identical result (no clock
// is read; the as-of date is part of the input).

import type { Nav2BenchmarkInput } from './benchmarkGate';
import type { AnalysisSpec } from './analysisSpec';
import { computeInvestorExperience, SCHEME_CAGR_LABEL, SCHEME_VS_INVESTOR_EXPLANATION, type InvestorExperience, type InvestorExperienceInput } from './investorExperience';
import type { RiskFreeSupply } from './riskFree';
import { cagr, pointToPointReturn, rollingReturn, type CagrValue, type PointToPointValue, type RollingReturnValue } from './schemeReturns';
import { beta, jensenAlpha, maxDrawdown, sharpeRatio, sortinoRatio, volatility, type BetaValue, type JensenAlphaValue, type MaxDrawdownValue, type SharpeValue, type SortinoValue, type VolatilityValue } from './schemeRisk';
import { ema, navAverage, navExtremes, roc, sma, type NavAverageValue, type NavExtremesValue, type TrendValue } from './schemeTrend';
import type { PreparedSeries } from './series';
import { NAV2_ENGINE_VERSION } from '@/lib/config/nav2/metricPolicy';
import type { Nav2Context, Nav2Result } from './types';

export interface SchemePerformanceFamily {
  family: 'scheme_performance';
  instrumentId: string;
  asOfDate: string;
  label: typeof SCHEME_CAGR_LABEL;
  navSeries: { firstDate: string | null; lastDate: string | null; count: number; checksum: string; materialGapCount: number };
  pointToPoint: Array<{ id: string; result: Nav2Result<PointToPointValue>; cagr: Nav2Result<CagrValue> }>;
  rolling: Array<{ horizonId: string; result: Nav2Result<RollingReturnValue> }>;
  volatility: Nav2Result<VolatilityValue> | null;
  sharpe: Nav2Result<SharpeValue> | null;
  sortino: Nav2Result<SortinoValue> | null;
  maxDrawdown: Nav2Result<MaxDrawdownValue> | null;
  beta: Nav2Result<BetaValue> | null;
  alpha: Nav2Result<JensenAlphaValue> | null;
  movingAverages: Array<{ kind: 'sma' | 'ema'; period: number; result: Nav2Result<TrendValue> }>;
  rateOfChange: Array<{ period: number; result: Nav2Result<TrendValue> }>;
  extremes: Nav2Result<NavExtremesValue>;
  average: Nav2Result<NavAverageValue>;
  policyVersion: string;
  engineVersion: string;
}

export interface SchemePerformanceInputs {
  series: PreparedSeries;
  spec: AnalysisSpec;
  ctx: Nav2Context;
  /** Effective-dated benchmark segments for this scheme, already entitlement-gated and clamped by the loader. */
  benchmarks?: readonly Nav2BenchmarkInput[];
  /** null = the risk-free dataset slot is empty. */
  riskFree: RiskFreeSupply;
}

export function computeSchemePerformance(inputs: SchemePerformanceInputs): SchemePerformanceFamily {
  const { series, spec, ctx } = inputs;
  const window = { start: spec.analysisStart, end: spec.analysisEnd };
  const f = spec.frequency;
  return {
    family: 'scheme_performance',
    instrumentId: series.identity.instrumentId,
    asOfDate: spec.asOfDate,
    label: SCHEME_CAGR_LABEL,
    navSeries: { firstDate: series.firstDate, lastDate: series.lastDate, count: series.count, checksum: series.checksum, materialGapCount: series.gaps.length },
    pointToPoint: spec.pointToPoint.map((p) => ({ id: p.id, result: pointToPointReturn(series, ctx, p.start, p.end), cagr: cagr(series, ctx, p.start, p.end) })),
    rolling: spec.rollingHorizonIds.map((horizonId) => ({ horizonId, result: rollingReturn(series, ctx, horizonId, window) })),
    volatility: spec.risk ? volatility(series, ctx, window, f) : null,
    sharpe: spec.risk ? sharpeRatio(series, ctx, inputs.riskFree, window, f) : null,
    sortino: spec.risk ? sortinoRatio(series, ctx, inputs.riskFree, window, f) : null,
    maxDrawdown: spec.risk ? maxDrawdown(series, ctx, window) : null,
    beta: spec.benchmarkRelative ? beta(series, ctx, inputs.benchmarks, window, f) : null,
    alpha: spec.benchmarkRelative ? jensenAlpha(series, ctx, inputs.benchmarks, inputs.riskFree, window, f) : null,
    movingAverages: spec.movingAverages.map((m) => ({ kind: m.kind, period: m.period, result: m.kind === 'sma' ? sma(series, ctx, m.period, window) : ema(series, ctx, m.period, window) })),
    rateOfChange: spec.rocPeriods.map((period) => ({ period, result: roc(series, ctx, period, window) })),
    extremes: navExtremes(series, ctx, window),
    average: navAverage(series, ctx, window),
    policyVersion: ctx.policy.version,
    engineVersion: NAV2_ENGINE_VERSION,
  };
}

export interface HeldSchemeAnalytics {
  scheme: SchemePerformanceFamily;
  /** null when the caller has no transaction-aware input (e.g. a scheme shown without the user's flows). */
  investor: InvestorExperience | null;
  /** Plain-language difference between the two families; shown wherever both appear. */
  explanation: typeof SCHEME_VS_INVESTOR_EXPLANATION;
}

export function computeHeldSchemeAnalytics(inputs: SchemePerformanceInputs, investor: InvestorExperienceInput | null): HeldSchemeAnalytics {
  return {
    scheme: computeSchemePerformance(inputs),
    investor: investor ? computeInvestorExperience(investor, inputs.ctx) : null,
    explanation: SCHEME_VS_INVESTOR_EXPLANATION,
  };
}
