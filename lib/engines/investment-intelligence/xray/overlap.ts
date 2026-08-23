// Investment Intelligence R5 — fund-to-fund portfolio overlap.
//
// THE PRIMARY R5 OVERLAP FORMULA (spec section 67):
//
//     Weighted_Overlap(A, B) = Σ_j min( weight_A,j , weight_B,j )
//
// summed over securities j held by BOTH funds.
//
// Worked example, asserted in certification case OVERLAP-003:
//   Fund A holds Security X at 5%, Fund B holds Security X at 8%.
//   X's contribution to the overlap = min(5%, 8%) = 5%.
//
// MATCHING IS BY CANONICAL IDENTITY ONLY (spec section 68, critical-FAIL
// items 10-11). Two holdings match iff they resolved to the same canonical
// security id. Name-only matching is never performed anywhere in this file,
// and an UNRESOLVED holding is NEVER treated as matched — not even against
// another unresolved holding with an identical printed name, because
// identical names are not evidence of identical securities.
//
// MATHEMATICAL IDENTITIES enforced and certified:
//   * Symmetry: Overlap(A, B) === Overlap(B, A) exactly (min is commutative)
//   * Bounds:   0 <= Overlap <= 1  (each side's weights sum to <= 1)
// Both are asserted directly in the R5 certification pack.
//
// INTERPRETATION DISCIPLINE: R5 reports the overlap percentage and the common
// holdings that drive it. It never classifies an overlap level as good or bad
// and never suggests selling a fund.

import type { FundHoldingsSnapshot, SnapshotHolding } from './lookThrough';
import { classifyFreshness, calculateFundCoverage } from './lookThrough';
import type { HoldingsFreshness } from '@/lib/config/investment-intelligence/xrayThresholds';
import { XRAY_THRESHOLD_CONFIG_VERSION } from '@/lib/config/investment-intelligence/xrayThresholds';

export const OVERLAP_METHOD_VERSION = 'overlap-min-weight-r5-v1';

export interface CommonHolding {
  canonicalId: string;
  displayName: string;
  weightInA: number;
  weightInB: number;
  /** min(weightInA, weightInB) — this security's contribution to the overlap. */
  overlapContribution: number;
}

export interface FundOverlapResult {
  status: 'ok' | 'unavailable';
  fundAId: string;
  fundBId: string;
  /** Weighted overlap as a fraction 0..1. */
  weightedOverlap?: number;
  commonSecurityCount?: number;
  commonHoldings?: CommonHolding[];
  /** Top contributors to the overlap, descending. */
  topCommonHoldings?: CommonHolding[];
  holdingsDateA?: string;
  holdingsDateB?: string;
  /** Weight in each fund that could not be resolved, so could not participate in matching. */
  unresolvedWeightA?: number;
  unresolvedWeightB?: number;
  /** min(coverageA, coverageB) — the honest ceiling on how much of this pair was actually comparable. */
  comparableCoverage?: number;
  freshnessA?: HoldingsFreshness;
  freshnessB?: HoldingsFreshness;
  qualityWarning?: string | null;
  reason?: 'MISSING_SNAPSHOT_A' | 'MISSING_SNAPSHOT_B' | 'SAME_FUND';
  detail?: string;
  method: typeof OVERLAP_METHOD_VERSION;
  thresholdConfigVersion: typeof XRAY_THRESHOLD_CONFIG_VERSION;
}

/** Sum resolved-security weights by canonical id. Unresolved lines are
 *  deliberately excluded from the matchable map and tracked separately. */
function resolvedWeightMap(holdings: SnapshotHolding[]): { map: Map<string, { weight: number; name: string }>; unresolvedWeight: number } {
  const map = new Map<string, { weight: number; name: string }>();
  let unresolvedWeight = 0;
  for (const h of holdings) {
    const kind = h.assetKind ?? 'security';
    if (kind !== 'security') continue; // cash/derivatives never participate in security overlap
    const w = h.weightPct / 100;
    if (!h.canonicalId) {
      unresolvedWeight += w;
      continue;
    }
    const prev = map.get(h.canonicalId);
    if (prev) prev.weight += w;
    else map.set(h.canonicalId, { weight: w, name: h.displayName });
  }
  return { map, unresolvedWeight };
}

/**
 * Weighted overlap between two fund snapshots.
 *
 * Symmetric by construction: the result depends only on the multiset of
 * per-security min() values, and min is commutative. The certification pack
 * additionally asserts overlap(A,B) === overlap(B,A) numerically.
 */
export function calculateFundOverlap(a: FundHoldingsSnapshot | null, b: FundHoldingsSnapshot | null, asOfDate: string, fundAId?: string, fundBId?: string): FundOverlapResult {
  const base = { method: OVERLAP_METHOD_VERSION, thresholdConfigVersion: XRAY_THRESHOLD_CONFIG_VERSION } as const;
  const idA = a?.fundInstrumentId ?? fundAId ?? '';
  const idB = b?.fundInstrumentId ?? fundBId ?? '';

  if (!a) {
    return { status: 'unavailable', fundAId: idA, fundBId: idB, reason: 'MISSING_SNAPSHOT_A', detail: 'No holdings disclosure is available for the first fund, so overlap cannot be calculated.', ...base };
  }
  if (!b) {
    return { status: 'unavailable', fundAId: idA, fundBId: idB, reason: 'MISSING_SNAPSHOT_B', detail: 'No holdings disclosure is available for the second fund, so overlap cannot be calculated.', ...base };
  }

  const A = resolvedWeightMap(a.holdings);
  const B = resolvedWeightMap(b.holdings);

  const common: CommonHolding[] = [];
  let weightedOverlap = 0;
  for (const [canonicalId, entryA] of A.map) {
    const entryB = B.map.get(canonicalId);
    if (!entryB) continue;
    const contribution = Math.min(entryA.weight, entryB.weight);
    weightedOverlap += contribution;
    common.push({ canonicalId, displayName: entryA.name, weightInA: entryA.weight, weightInB: entryB.weight, overlapContribution: contribution });
  }
  // Deterministic ordering: by contribution desc, then canonical id.
  common.sort((x, y) => (y.overlapContribution - x.overlapContribution) || x.canonicalId.localeCompare(y.canonicalId));

  const covA = calculateFundCoverage(a);
  const covB = calculateFundCoverage(b);
  const freshnessA = classifyFreshness(a.holdingsAsOfDate, asOfDate);
  const freshnessB = classifyFreshness(b.holdingsAsOfDate, asOfDate);

  const warnings: string[] = [];
  if (freshnessA === 'STALE' || freshnessA === 'VERY_STALE' || freshnessB === 'STALE' || freshnessB === 'VERY_STALE') {
    warnings.push('At least one of these funds has holdings data older than the freshness threshold, so the overlap describes an older portfolio composition.');
  }
  if (a.holdingsAsOfDate !== b.holdingsAsOfDate) {
    warnings.push(`These funds disclosed on different dates (${a.holdingsAsOfDate} and ${b.holdingsAsOfDate}), so the comparison mixes two portfolio dates.`);
  }
  if (A.unresolvedWeight > 0 || B.unresolvedWeight > 0) {
    warnings.push(`${(A.unresolvedWeight * 100).toFixed(1)}% and ${(B.unresolvedWeight * 100).toFixed(1)}% of these funds could not be matched to identified securities and are excluded from the overlap figure.`);
  }

  return {
    status: 'ok',
    fundAId: idA,
    fundBId: idB,
    weightedOverlap,
    commonSecurityCount: common.length,
    commonHoldings: common,
    topCommonHoldings: common.slice(0, 10),
    holdingsDateA: a.holdingsAsOfDate,
    holdingsDateB: b.holdingsAsOfDate,
    unresolvedWeightA: A.unresolvedWeight,
    unresolvedWeightB: B.unresolvedWeight,
    comparableCoverage: Math.min(covA.reportedHoldingsCoverage, covB.reportedHoldingsCoverage),
    freshnessA,
    freshnessB,
    qualityWarning: warnings.length > 0 ? warnings.join(' ') : null,
    ...base,
  };
}

export interface OverlapMatrix {
  fundIds: string[];
  fundNames: string[];
  /** matrix[i][j] = weighted overlap fraction, or null when unavailable. Diagonal is 1 by definition (a fund fully overlaps itself). */
  matrix: Array<Array<number | null>>;
  pairs: FundOverlapResult[];
  method: typeof OVERLAP_METHOD_VERSION;
}

/**
 * Full pairwise overlap matrix. Naturally O(n²) in fund count, which is
 * acknowledged and acceptable: only the upper triangle is computed and the
 * lower triangle mirrored, so the cost is n(n-1)/2 pair computations, not n².
 */
export function calculateOverlapMatrix(
  funds: Array<{ fundInstrumentId: string; fundName: string; snapshot: FundHoldingsSnapshot | null }>,
  asOfDate: string
): OverlapMatrix {
  const n = funds.length;
  const matrix: Array<Array<number | null>> = Array.from({ length: n }, () => Array<number | null>(n).fill(null));
  const pairs: FundOverlapResult[] = [];

  for (let i = 0; i < n; i++) {
    // A fund's overlap with itself is 1 by definition when it has a snapshot.
    matrix[i][i] = funds[i].snapshot ? 1 : null;
    for (let j = i + 1; j < n; j++) {
      const res = calculateFundOverlap(funds[i].snapshot, funds[j].snapshot, asOfDate, funds[i].fundInstrumentId, funds[j].fundInstrumentId);
      pairs.push(res);
      const v = res.status === 'ok' && res.weightedOverlap !== undefined ? res.weightedOverlap : null;
      matrix[i][j] = v;
      matrix[j][i] = v; // symmetry, mirrored rather than recomputed
    }
  }

  return { fundIds: funds.map((f) => f.fundInstrumentId), fundNames: funds.map((f) => f.fundName), matrix, pairs, method: OVERLAP_METHOD_VERSION };
}
