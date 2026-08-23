// R4 — PerformanceEngine: the single orchestration point that combines
// xirr.ts / twrr.ts / navReturn.ts / riskMetrics.ts / benchmarkEngine.ts /
// rollingReturns.ts into the investor-facing results described in the R4
// spec (section 67-68: centralise in bounded services, never calculate
// returns inside React components or duplicate a formula per API route).
//
// This module is PURELY DERIVED / READ-ONLY (spec section 58): it never
// writes to investments/assets/retirement_accounts/liabilities/income/
// expenses or any R3 publication row. Its only legitimate write target is
// ii_analytics_results (persisted derived output), which itself never
// feeds back into net worth.

import { xirr, type CashFlow, type XirrResult } from './xirr';
import { pointToPointReturn, cagr, type PointToPointReturnResult } from './navReturn';
import { twrr, type ValuationPoint, type ExternalFlow, type TwrrResult } from './twrr';
import { sinceInceptionXirrEligible, optionTotalReturnEligible, type DataQualityAnnotation } from './dataQuality';
import { fingerprintInputs, PERFORMANCE_ENGINE_VERSION } from './analyticsVersioning';

export interface SchemePerformanceInput {
  instrumentId: string;
  historyCompleteness: string | null;
  optionType: string | null;
  hasDistributionAdjustment: boolean;
  cashFlows: CashFlow[]; // includes the terminal current-value flow if position is open
  currentValue: number;
  currentValueDate: Date;
  navSeries: Array<{ date: Date; value: number }>;
}

export interface SchemePerformanceResult {
  instrumentId: string;
  investorXirr: XirrResult;
  sinceInceptionEligible: boolean;
  dataQualityAnnotations: DataQualityAnnotation[];
  navPointToPoint: Record<string, PointToPointReturnResult>; // keyed by horizon label, e.g. '1Y'
  inputFingerprint: string;
  engineVersion: string;
}

/**
 * Compute scheme-level investor XIRR with the mandatory history-completeness
 * gate (spec section 11): a since-inception XIRR number is only produced
 * when history_completeness === 'complete_from_inception'. Otherwise the
 * engine still computes a period-specific XIRR IF the caller has already
 * restricted cashFlows to a period with a certified starting valuation
 * (that restriction is the caller's responsibility — this function trusts
 * the cash-flow list it is given and only gates the "since inception"
 * LABEL, not the underlying arithmetic).
 */
export function computeSchemePerformance(input: SchemePerformanceInput): SchemePerformanceResult {
  const annotations: DataQualityAnnotation[] = [];
  const inception = sinceInceptionXirrEligible(input.historyCompleteness);
  if (!inception.eligible && inception.annotation) annotations.push(inception.annotation);

  const optionEligibility = optionTotalReturnEligible(input.optionType, input.hasDistributionAdjustment);
  if (!optionEligibility.eligible && optionEligibility.annotation) annotations.push(optionEligibility.annotation);

  const investorXirr = inception.eligible ? xirr(input.cashFlows) : { status: 'unavailable' as const, reason: 'INSUFFICIENT_HISTORY' as const, detail: annotations[0]?.detail };

  const navPointToPoint: Record<string, PointToPointReturnResult> = {};
  if (input.navSeries.length >= 2) {
    const sorted = [...input.navSeries].sort((a, b) => a.date.getTime() - b.date.getTime());
    const last = sorted[sorted.length - 1];
    const horizons: Array<[string, number]> = [
      ['1M', 30], ['3M', 91], ['6M', 182], ['1Y', 365], ['3Y', 365 * 3], ['5Y', 365 * 5], ['7Y', 365 * 7], ['10Y', 365 * 10],
    ];
    for (const [label, days] of horizons) {
      const targetTime = last.date.getTime() - days * 86_400_000;
      const start = [...sorted].reverse().find((p) => p.date.getTime() <= targetTime);
      if (start) {
        navPointToPoint[label] = cagr(start.value, start.date, last.value, last.date);
      }
    }
    navPointToPoint['SINCE_INCEPTION'] = cagr(sorted[0].value, sorted[0].date, last.value, last.date);
  }

  const inputFingerprint = fingerprintInputs([
    input.instrumentId,
    input.historyCompleteness,
    input.cashFlows.map((c) => ({ d: c.date.toISOString(), a: c.amount })),
    input.navSeries.map((n) => ({ d: n.date.toISOString(), v: n.value })),
    PERFORMANCE_ENGINE_VERSION,
  ]);

  return {
    instrumentId: input.instrumentId,
    investorXirr,
    sinceInceptionEligible: inception.eligible,
    dataQualityAnnotations: annotations,
    navPointToPoint,
    inputFingerprint,
    engineVersion: PERFORMANCE_ENGINE_VERSION,
  };
}

export interface PortfolioPerformanceInput {
  valuations: ValuationPoint[];
  externalFlows: ExternalFlow[];
  investorCashFlows: CashFlow[]; // for portfolio-level XIRR
}

export interface PortfolioPerformanceResult {
  portfolioTwrr: TwrrResult;
  portfolioXirr: XirrResult;
  inputFingerprint: string;
  engineVersion: string;
}

export function computePortfolioPerformance(input: PortfolioPerformanceInput): PortfolioPerformanceResult {
  const portfolioTwrr = twrr(input.valuations, input.externalFlows);
  const portfolioXirr = xirr(input.investorCashFlows);
  const inputFingerprint = fingerprintInputs([
    input.valuations.map((v) => ({ d: v.date.toISOString(), v: v.value })),
    input.externalFlows.map((f) => ({ d: f.date.toISOString(), a: f.amount })),
    input.investorCashFlows.map((c) => ({ d: c.date.toISOString(), a: c.amount })),
    PERFORMANCE_ENGINE_VERSION,
  ]);
  return { portfolioTwrr, portfolioXirr, inputFingerprint, engineVersion: PERFORMANCE_ENGINE_VERSION };
}

export { pointToPointReturn };
