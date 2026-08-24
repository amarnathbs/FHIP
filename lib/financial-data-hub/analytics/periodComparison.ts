/**
 * Financial Data Hub — FDH-8: period-over-period comparison.
 *
 * PURE FUNCTION. Spec section 56: "Handle zero denominator safely — no
 * ∞%/NaN%; e.g. previous=0, current=500 → 'New spending this period' not a
 * meaningless percentage." This is the ONE place that decision is made, so
 * every page (Overview/Spending/Income/Trend) renders the same label for the
 * same shape of comparison rather than each page inventing its own text.
 */

export type ComparisonDirection = 'increase' | 'decrease' | 'no_change' | 'new_activity' | 'no_activity';

export interface PeriodComparisonResult {
  current: number;
  previous: number;
  /** current - previous, exact for the caller's currency (caller must pass
   * already-exact-money values, e.g. from `sumMoney`/`computeApprovedFinancialSummary`). */
  delta: number;
  /** Null whenever a percentage would be undefined or misleading (previous
   * = 0). Never `Infinity`/`NaN` — callers must render `label` in that case. */
  percentChange: number | null;
  direction: ComparisonDirection;
  /** Human-readable, safe to render directly — e.g. "New spending this
   * period", "12.4% higher than last month", "No change from last month". */
  label: string;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/**
 * @param current   this period's total (magnitude, e.g. expense_total)
 * @param previous  the equal-length prior period's total, same currency/metric
 * @param metricLabel  e.g. "spending", "income" — used only in the generated label
 * @param previousPeriodLabel  e.g. "last month", "the previous period"
 */
export function comparePeriods(
  current: number,
  previous: number,
  metricLabel: string,
  previousPeriodLabel = 'the previous period',
): PeriodComparisonResult {
  const delta = current - previous;

  if (previous === 0 && current === 0) {
    return {
      current, previous, delta: 0, percentChange: null,
      direction: 'no_activity',
      label: `No ${metricLabel} recorded this period or ${previousPeriodLabel}`,
    };
  }
  if (previous === 0) {
    // current > 0 (current < 0 cannot occur for a magnitude total, but is
    // still handled safely rather than dividing by zero).
    return {
      current, previous, delta, percentChange: null,
      direction: 'new_activity',
      label: `New ${metricLabel} this period — none recorded ${previousPeriodLabel}`,
    };
  }
  if (current === previous) {
    return {
      current, previous, delta: 0, percentChange: 0,
      direction: 'no_change',
      label: `No change in ${metricLabel} from ${previousPeriodLabel}`,
    };
  }

  const percentChange = round1((delta / Math.abs(previous)) * 100);
  const direction: ComparisonDirection = delta > 0 ? 'increase' : 'decrease';
  const absPercent = Math.abs(percentChange);
  const label = direction === 'increase'
    ? `${absPercent}% higher than ${previousPeriodLabel}`
    : `${absPercent}% lower than ${previousPeriodLabel}`;

  return { current, previous, delta, percentChange, direction, label };
}
