// Pure chart-data shaping for the AMC / fund-house concentration pie chart
// rendered by PortfolioXrayClient. Kept as a plain module (no 'use client'),
// mirroring dateDisplay.ts, so the grouping logic is directly unit-testable
// without pulling in the client component tree.
//
// `calculateAmcConcentration()` (lib/engines/investment-intelligence/xray/concentration.ts)
// returns one bucket per AMC with no upper bound on count -- a portfolio
// spread across many fund houses can return far more buckets than a pie
// chart can render legibly (recharts renders every wedge regardless of how
// thin it gets). This groups the smallest tail buckets into a single
// "Other" slice so the chart stays readable. It changes nothing about the
// underlying data: the existing fund-house list elsewhere in the UI still
// shows every AMC individually, at full precision, unmodified.
//
// This performs NO new computation on portfolio data -- `weight` and
// `schemeCount` are taken as-is from the already-computed buckets. It only
// decides how many distinct slices to draw.

export interface AmcBucket {
  amcId: string;
  amcName: string;
  weight: number;
  schemeCount: number;
}

export interface AmcPieSlice {
  key: string;
  name: string;
  weight: number;
  schemeCount: number;
  isOther: boolean;
}

/** Above this many AMCs, the tail is collapsed into a single "Other" slice. */
export const AMC_PIE_MAX_SLICES = 7;

export function buildAmcPieSlices(buckets: AmcBucket[], maxSlices: number = AMC_PIE_MAX_SLICES): AmcPieSlice[] {
  if (buckets.length === 0) return [];

  // Defensive sort -- calculateAmcConcentration() already returns buckets
  // sorted by descending weight, but this never assumes that invariant
  // holds upstream.
  const sorted = [...buckets].sort((a, b) => b.weight - a.weight || a.amcId.localeCompare(b.amcId));

  if (sorted.length <= maxSlices) {
    return sorted.map((b) => ({ key: b.amcId, name: b.amcName, weight: b.weight, schemeCount: b.schemeCount, isOther: false }));
  }

  const head = sorted.slice(0, maxSlices - 1);
  const tail = sorted.slice(maxSlices - 1);
  const otherWeight = tail.reduce((s, b) => s + b.weight, 0);
  const otherSchemeCount = tail.reduce((s, b) => s + b.schemeCount, 0);

  return [
    ...head.map((b) => ({ key: b.amcId, name: b.amcName, weight: b.weight, schemeCount: b.schemeCount, isOther: false })),
    { key: '__other__', name: `Other (${tail.length} fund houses)`, weight: otherWeight, schemeCount: otherSchemeCount, isOther: true },
  ];
}
