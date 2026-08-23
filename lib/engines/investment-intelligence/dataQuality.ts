// R4 — Deterministic data-quality flag vocabulary (spec section 66).
// Every engine result that is 'unavailable' carries one of these flags
// (or a metric-specific reason already using this vocabulary in spirit —
// see xirr.ts/twrr.ts/riskMetrics.ts's own `reason` unions, which are the
// metric-specific detail; DataQualityFlag below is the coarser, UI-facing
// classification each of those maps onto). A missing input NEVER produces
// a silent 0 — it produces one of these flags plus a human-readable
// explanation.

export type DataQualityFlag =
  | 'COMPLETE'
  | 'PARTIAL_TRANSACTION_HISTORY'
  | 'NAV_HISTORY_INCOMPLETE'
  | 'BENCHMARK_MAPPING_MISSING'
  | 'BENCHMARK_HISTORY_INCOMPLETE'
  | 'RISK_FREE_DATA_MISSING'
  | 'INSUFFICIENT_HISTORY'
  | 'OPTION_TOTAL_RETURN_UNAVAILABLE'
  | 'STALE_MARKET_DATA'
  | 'PLAN_OPTION_MISMATCH';

export interface DataQualityAnnotation {
  flag: DataQualityFlag;
  detail: string;
}

/**
 * Since-inception investor XIRR may ONLY be shown as authoritative when
 * the certified R2 history_completeness for the position is
 * 'complete_from_inception' (spec section 11). Every other value blocks
 * a since-inception XIRR claim, though a PERIOD-SPECIFIC return may still
 * be possible if a certified start valuation exists for that period.
 */
export function sinceInceptionXirrEligible(historyCompleteness: string | null): { eligible: boolean; annotation?: DataQualityAnnotation } {
  if (historyCompleteness === 'complete_from_inception') {
    return { eligible: true };
  }
  const detailByStatus: Record<string, string> = {
    complete_from_known_opening_balance: 'Since-inception XIRR unavailable: history begins from a known opening balance, not the true acquisition date — cash-flow history is not fully complete from inception.',
    partial_history: 'Since-inception XIRR unavailable: complete acquisition/cash-flow history is not available.',
    holdings_only: 'Since-inception XIRR unavailable: only a point-in-time holding snapshot is available, with no transaction history.',
  };
  return {
    eligible: false,
    annotation: {
      flag: 'PARTIAL_TRANSACTION_HISTORY',
      detail: historyCompleteness && detailByStatus[historyCompleteness]
        ? detailByStatus[historyCompleteness]
        : 'Since-inception XIRR unavailable: cash-flow history completeness could not be certified.',
    },
  };
}

/**
 * A payout/IDCW-option scheme's raw NAV decline after a distribution must
 * never be presented as economic underperformance unless the distribution
 * has been properly added back (total-return treatment). If that
 * adjustment is not available, the scheme-level total return is qualified
 * rather than shown as raw NAV CAGR (spec section 22).
 */
export function optionTotalReturnEligible(optionType: string | null, hasDistributionAdjustment: boolean): { eligible: boolean; annotation?: DataQualityAnnotation } {
  const isPayout = optionType === 'dividend_payout' || optionType === 'idcw';
  if (!isPayout) return { eligible: true };
  if (hasDistributionAdjustment) return { eligible: true };
  return {
    eligible: false,
    annotation: {
      flag: 'OPTION_TOTAL_RETURN_UNAVAILABLE',
      detail: 'This scheme is a payout/IDCW option. Raw NAV return would understate performance because it does not add back distributions already paid out. Total-return-adjusted figures are not available for this option; only investor XIRR (which includes actual distributions received as cash flows) is shown.',
    },
  };
}
