// R4 — Time-weighted rate of return (TWRR), the portfolio-manager-outcome
// metric (spec section 6, 25-27): standard chain-linked sub-period
// methodology. NEVER approximated as ending_value / total_contributions.
//
// Method: given a chronological valuation series and a chronological list
// of external cash flows (contributions positive, withdrawals negative,
// FROM THE PORTFOLIO'S perspective — i.e. money moving IN to the portfolio
// is a positive external flow), the engine:
//   1. Splits the timeline into sub-periods at each external-flow date
//      (a flow closes the prior sub-period and opens the next).
//   2. Requires a valuation immediately before and after each cash flow
//      (end-of-day cash-flow treatment: a flow on date D is treated as
//      occurring at the end of D — the sub-period ending on D excludes it,
//      the sub-period starting on D includes it in the opening value).
//   3. Sub-period return r_k = (V_end,k - CF_k) / V_start,k - 1, where
//      V_end,k is the valuation immediately before the next cash flow (or
//      the final valuation), CF_k is the external flow occurring at the
//      end of sub-period k, and V_start,k is the valuation right after the
//      previous flow (or the initial valuation).
//   4. Chain-link: TWRR = Π(1 + r_k) - 1 over all sub-periods.
//
// If a required valuation cannot be certified at a sub-period boundary,
// the engine returns 'unavailable' rather than inventing a result — it
// does NOT interpolate across the gap (spec section 27).

export const TWRR_METHOD_VERSION = 'twrr-chain-linked-eod-v1';

export interface ValuationPoint {
  date: Date;
  value: number;
}

export interface ExternalFlow {
  date: Date;
  /** Money moving INTO the portfolio (contribution/purchase) = positive; OUT (withdrawal/redemption) = negative. */
  amount: number;
}

export type TwrrUnavailableReason =
  | 'INSUFFICIENT_VALUATION_HISTORY'
  | 'MISSING_BOUNDARY_VALUATION'
  | 'INVALID_INPUT'
  | 'NEGATIVE_OR_ZERO_SUBPERIOD_START';

export interface TwrrSubPeriod {
  start: Date;
  end: Date;
  startValue: number;
  endValue: number;
  externalFlowAtEnd: number;
  subPeriodReturn: number;
}

export interface TwrrResult {
  status: 'ok' | 'unavailable';
  twrr?: number;
  subPeriods?: TwrrSubPeriod[];
  reason?: TwrrUnavailableReason;
  detail?: string;
  method?: typeof TWRR_METHOD_VERSION;
}

function findValuationOn(series: ValuationPoint[], date: Date): ValuationPoint | undefined {
  return series.find((v) => v.date.getTime() === date.getTime());
}

/**
 * Compute chain-linked TWRR. `valuations` must include, at minimum, a
 * certified valuation on the period start date, the period end date, and
 * on every date an external flow occurs (or the caller must supply one —
 * this function does not interpolate). Valuations may be reconstructed
 * from certified NAV histories upstream; that reconstruction is a
 * separate, documented concern (see R4_TWRR_CERTIFICATION.md) and must
 * never overwrite the certified statement holding value it was derived
 * from.
 */
export function twrr(valuations: ValuationPoint[], externalFlows: ExternalFlow[]): TwrrResult {
  if (!valuations || valuations.length < 2) {
    return { status: 'unavailable', reason: 'INSUFFICIENT_VALUATION_HISTORY', detail: 'At least a start and end valuation are required.' };
  }
  const sortedValuations = [...valuations].sort((a, b) => a.date.getTime() - b.date.getTime());
  const sortedFlows = [...externalFlows].sort((a, b) => a.date.getTime() - b.date.getTime());

  for (const v of sortedValuations) {
    if (!Number.isFinite(v.value) || Number.isNaN(v.date.getTime())) {
      return { status: 'unavailable', reason: 'INVALID_INPUT' };
    }
  }

  const periodStart = sortedValuations[0].date;
  const periodEnd = sortedValuations[sortedValuations.length - 1].date;

  // Boundary dates: period start, each flow date, period end (deduplicated, ordered).
  const boundaryDates = Array.from(
    new Set([periodStart.getTime(), ...sortedFlows.map((f) => f.date.getTime()), periodEnd.getTime()])
  )
    .sort((a, b) => a - b)
    .map((t) => new Date(t));

  const subPeriods: TwrrSubPeriod[] = [];
  let compounded = 1;

  for (let i = 0; i < boundaryDates.length - 1; i++) {
    const start = boundaryDates[i];
    const end = boundaryDates[i + 1];
    const startValuation = findValuationOn(sortedValuations, start);
    const endValuation = findValuationOn(sortedValuations, end);
    if (!startValuation || !endValuation) {
      return {
        status: 'unavailable',
        reason: 'MISSING_BOUNDARY_VALUATION',
        detail: `No certified valuation at sub-period boundary ${(!startValuation ? start : end).toISOString().slice(0, 10)}.`,
      };
    }
    if (startValuation.value <= 0) {
      return { status: 'unavailable', reason: 'NEGATIVE_OR_ZERO_SUBPERIOD_START' };
    }
    // External flow(s) occurring exactly at `end` are treated as end-of-day:
    // they belong to the sub-period that is CLOSING (removed from endValue
    // before computing return), and open the NEXT sub-period's start value.
    const flowsAtEnd = sortedFlows.filter((f) => f.date.getTime() === end.getTime());
    const flowTotalAtEnd = flowsAtEnd.reduce((s, f) => s + f.amount, 0);
    const adjustedEndValue = endValuation.value - flowTotalAtEnd;
    const subPeriodReturn = adjustedEndValue / startValuation.value - 1;
    subPeriods.push({
      start,
      end,
      startValue: startValuation.value,
      endValue: endValuation.value,
      externalFlowAtEnd: flowTotalAtEnd,
      subPeriodReturn,
    });
    compounded *= 1 + subPeriodReturn;
  }

  if (subPeriods.length === 0) {
    return { status: 'unavailable', reason: 'INSUFFICIENT_VALUATION_HISTORY' };
  }

  return {
    status: 'ok',
    twrr: compounded - 1,
    subPeriods,
    method: TWRR_METHOD_VERSION,
  };
}
