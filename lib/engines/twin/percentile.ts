// Percentile calculation (spec section 15) — only ever called when a
// benchmark_values row actually stores at least two of {p10,p25,p50,p75,p90}
// for the given cohort/metric. Never invoked from a mean/median-only
// benchmark; the orchestrator checks that before calling this.
export interface DistributionPoints {
  p10?: number | null;
  p20?: number | null;
  p25?: number | null;
  p50?: number | null;
  p75?: number | null;
  p80?: number | null;
  p90?: number | null;
}

export interface PercentileResult {
  percentile: number;
  clamped: 'below_min' | 'above_max' | null;
}

interface Point {
  p: number;
  v: number;
}

function sortedPoints(dist: DistributionPoints): Point[] {
  const raw: { p: number; v: number | null | undefined }[] = ([10, 20, 25, 50, 75, 80, 90] as const).map((p) => ({
    p,
    v: dist[`p${p}` as keyof DistributionPoints],
  }));
  return raw.filter((x): x is Point => typeof x.v === 'number').sort((a, b) => a.v - b.v);
}

export function hasValidDistribution(dist: DistributionPoints): boolean {
  return sortedPoints(dist).length >= 2;
}

/** direction: the metric's peer-comparison direction. Result is a "goodness" percentile — for lower-is-better metrics, a low raw value yields a HIGH percentile (spec 15.3's reverse logic). */
export function computePercentile(userValue: number, dist: DistributionPoints, direction: 'higher_better' | 'lower_better'): PercentileResult | null {
  const points = sortedPoints(dist);
  if (points.length < 2) return null;

  let rawPercentile: number;
  let clamped: 'below_min' | 'above_max' | null = null;
  if (userValue <= points[0].v) {
    rawPercentile = points[0].p;
    if (userValue < points[0].v) clamped = 'below_min';
  } else if (userValue >= points[points.length - 1].v) {
    rawPercentile = points[points.length - 1].p;
    if (userValue > points[points.length - 1].v) clamped = 'above_max';
  } else {
    let lower = points[0];
    let upper = points[points.length - 1];
    for (let i = 0; i < points.length - 1; i++) {
      if (userValue >= points[i].v && userValue <= points[i + 1].v) {
        lower = points[i];
        upper = points[i + 1];
        break;
      }
    }
    rawPercentile = upper.v === lower.v ? lower.p : lower.p + (upper.p - lower.p) * ((userValue - lower.v) / (upper.v - lower.v));
  }

  const goodnessPercentile = direction === 'lower_better' ? 100 - rawPercentile : rawPercentile;
  // Reverse the clamp label too: for a lower-is-better metric, a value below
  // the lowest recorded point is the STRONGEST position (above P90 of
  // goodness), not the weakest.
  const goodnessClamped = direction === 'lower_better' ? (clamped === 'below_min' ? 'above_max' : clamped === 'above_max' ? 'below_min' : null) : clamped;

  return { percentile: Math.round(goodnessPercentile * 10) / 10, clamped: goodnessClamped };
}
