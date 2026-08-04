import {
  comparisonStatusFromRelativePosition,
  comparisonStatusFromTargetRange,
  type ComparisonDirection,
  type ComparisonStatus,
  type MaterialityThresholds,
  DEFAULT_MATERIALITY,
} from './taxonomy';

export interface GapResult {
  absoluteGap: number;
  percentageGap: number | null;
  relativePosition: number | null;
  status: ComparisonStatus;
}

// Deterministic gap calculation (spec section 13). relativePosition follows
// the spec's own formula: user/benchmark for higher-is-better metrics,
// benchmark/user for lower-is-better metrics — never the reverse, so a
// materially-ahead result always means "genuinely better", not an artefact
// of which side of the ratio the metric happened to be on.
export function computeGap(
  userValue: number,
  benchmarkValue: number,
  direction: ComparisonDirection,
  targetRange?: { min: number | null; max: number | null },
  thresholds: MaterialityThresholds = DEFAULT_MATERIALITY
): GapResult {
  const absoluteGap = userValue - benchmarkValue;
  const percentageGap = benchmarkValue !== 0 ? absoluteGap / Math.abs(benchmarkValue) : null;

  if (direction === 'target_range') {
    return {
      absoluteGap,
      percentageGap,
      relativePosition: null,
      status: comparisonStatusFromTargetRange(userValue, targetRange?.min ?? null, targetRange?.max ?? null),
    };
  }
  if (direction === 'context_only') {
    return { absoluteGap, percentageGap, relativePosition: null, status: 'context_required' };
  }

  const relativePosition = computeRelativePosition(userValue, benchmarkValue, direction);
  return { absoluteGap, percentageGap, relativePosition, status: comparisonStatusFromRelativePosition(relativePosition, thresholds) };
}

// Avoids Infinity/NaN when either side of the ratio is zero — a genuine
// "user has $0 debt vs a $5,000 benchmark" case is the strongest possible
// lower-is-better position, not an undefined one.
function computeRelativePosition(userValue: number, benchmarkValue: number, direction: 'higher_better' | 'lower_better'): number {
  if (direction === 'higher_better') {
    if (benchmarkValue === 0) return userValue === 0 ? 1 : userValue > 0 ? 1.5 : 0.5;
    return userValue / benchmarkValue;
  }
  if (userValue === 0) return benchmarkValue === 0 ? 1 : 1.5;
  return benchmarkValue / userValue;
}
