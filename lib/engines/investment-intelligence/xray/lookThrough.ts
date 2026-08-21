// Investment Intelligence R5 — weighted portfolio look-through.
//
// THE CORE FORMULA (spec section 63):
//
//     Effective_Exposure_ij = Portfolio_Weight_i × Fund_Holding_Weight_ij
//     Effective_Exposure_j  = Σ_i Effective_Exposure_ij
//
// Worked example, asserted verbatim in certification case XRAY-EXACT-001:
//   Fund A is 40% of the portfolio and holds 8% Reliance -> 0.40 × 0.08 = 3.2%
//   Fund B contributes a further 2.0% Reliance
//   Total effective Reliance exposure = 5.2%
//
// NO-DOUBLE-COUNT (spec section 62, critical-FAIL item 7):
// Look-through is ATTRIBUTION, NOT ADDITIONAL WEALTH. A Rs 1,000,000 fund
// investment looked through into its underlying securities is still
// Rs 1,000,000 of economic value — it is never Rs 1,000,000 of fund PLUS
// Rs 1,000,000 of securities. This module therefore returns WEIGHTS and
// derived values that always sum back to the original portfolio value, and
// writes nothing to any register table. R5 is strictly read-only with
// respect to net worth.
//
// NO BLIND RESCALING (spec section 59, critical-FAIL item 12):
// Real disclosure files do not sum to exactly 100%: cash, derivatives,
// unlisted holdings, receivables and rounding all intervene. R5 computes a
// genuine `reportedHoldingsCoverage` per fund and retains the shortfall as an
// EXPLICIT REMAINDER. It never rescales 87% of disclosed holdings up to 100%.

import {
  HOLDINGS_FRESHNESS_DAYS,
  type HoldingsFreshness,
  COVERAGE_THRESHOLDS,
  MIXED_DATE_SPREAD_DAYS,
  WEIGHT_SUM_ROUNDING_TOLERANCE_PCT,
  XRAY_THRESHOLD_CONFIG_VERSION,
} from '@/lib/config/investment-intelligence/xrayThresholds';

export const LOOKTHROUGH_METHOD_VERSION = 'lookthrough-weighted-r5-v1';

function toUtc(iso: string): number {
  return Date.parse(`${iso}T00:00:00.000Z`);
}
function daysBetween(a: string, b: string): number {
  return Math.round((toUtc(b) - toUtc(a)) / 86_400_000);
}

/** One resolved (or deliberately unresolved) line inside a fund's snapshot. */
export interface SnapshotHolding {
  /** Canonical security id, or null when the line is genuinely unresolved. */
  canonicalId: string | null;
  displayName: string;
  /** Disclosed portfolio weight WITHIN the fund, as a percentage 0..100. */
  weightPct: number;
  /** Non-equity buckets are preserved, never redistributed. */
  assetKind?: 'security' | 'cash' | 'derivative' | 'other';
  sectorCode?: string | null;
  industryCode?: string | null;
  marketCapClass?: string | null;
  creditRatingBand?: string | null;
  maturityDate?: string | null;
  modifiedDuration?: number | null;
  issuerId?: string | null;
}

/** A versioned holdings snapshot for one fund. */
export interface FundHoldingsSnapshot {
  snapshotId: string;
  fundInstrumentId: string;
  /** The date the holdings describe — NOT the ingestion date. */
  holdingsAsOfDate: string;
  sourceKey: string;
  sourceDataVersion: string | null;
  classificationVersion: string | null;
  holdings: SnapshotHolding[];
}

/** A fund position in the user's portfolio. */
export interface PortfolioFundPosition {
  fundInstrumentId: string;
  fundName: string;
  /** Current value in the investment's own local currency. Never FX-converted here. */
  value: number;
  currencyCode: string;
  amcId?: string | null;
  amcName?: string | null;
}

// ---------------------------------------------------------------------------
// Snapshot selection and freshness
// ---------------------------------------------------------------------------

/**
 * Choose the latest eligible snapshot AT OR BEFORE the analytics as-of date.
 *
 * A FUTURE snapshot is NEVER used to describe an earlier portfolio date
 * (spec section 62, critical-FAIL item 14) — doing so would let hindsight
 * leak into a historical view. Older snapshots are preserved, never
 * destroyed by a newer arrival.
 */
export function selectSnapshotAsOf(snapshots: FundHoldingsSnapshot[], asOfDate: string): FundHoldingsSnapshot | null {
  const eligible = snapshots
    .filter((s) => toUtc(s.holdingsAsOfDate) <= toUtc(asOfDate))
    .sort((a, b) => {
      const d = toUtc(b.holdingsAsOfDate) - toUtc(a.holdingsAsOfDate);
      return d !== 0 ? d : b.snapshotId.localeCompare(a.snapshotId);
    });
  return eligible[0] ?? null;
}

export function classifyFreshness(holdingsAsOfDate: string | null, asOfDate: string): HoldingsFreshness {
  if (!holdingsAsOfDate) return 'MISSING';
  const age = daysBetween(holdingsAsOfDate, asOfDate);
  if (age < 0) return 'MISSING'; // a future snapshot is not usable for this date
  if (age <= HOLDINGS_FRESHNESS_DAYS.CURRENT_MAX) return 'CURRENT';
  if (age <= HOLDINGS_FRESHNESS_DAYS.ACCEPTABLE_MAX) return 'ACCEPTABLE';
  if (age <= HOLDINGS_FRESHNESS_DAYS.STALE_MAX) return 'STALE';
  return 'VERY_STALE';
}

// ---------------------------------------------------------------------------
// Per-fund disclosed coverage
// ---------------------------------------------------------------------------

export interface FundCoverage {
  fundInstrumentId: string;
  /** Sum of ALL disclosed weights (securities + cash + derivatives + other), as a fraction 0..1. */
  disclosedWeightTotal: number;
  /** Fraction of the fund whose lines resolved to a canonical security. */
  resolvedWeight: number;
  /** Disclosed but unresolved. Retained, never dropped, never matched by name. */
  unresolvedWeight: number;
  cashWeight: number;
  derivativeWeight: number;
  otherWeight: number;
  /** Not disclosed at all — the honest remainder. Never rescaled away. */
  undisclosedRemainder: number;
  /** disclosedWeightTotal, clamped to 1. The fund's "reported holdings coverage". */
  reportedHoldingsCoverage: number;
  weightSumWithinRoundingTolerance: boolean;
}

export function calculateFundCoverage(snapshot: FundHoldingsSnapshot): FundCoverage {
  let resolved = 0;
  let unresolved = 0;
  let cash = 0;
  let derivative = 0;
  let other = 0;

  for (const h of snapshot.holdings) {
    const w = h.weightPct / 100;
    const kind = h.assetKind ?? 'security';
    if (kind === 'cash') cash += w;
    else if (kind === 'derivative') derivative += w;
    else if (kind === 'other') other += w;
    else if (h.canonicalId) resolved += w;
    else unresolved += w;
  }

  const disclosedWeightTotal = resolved + unresolved + cash + derivative + other;
  const deviationPct = Math.abs(disclosedWeightTotal * 100 - 100);
  return {
    fundInstrumentId: snapshot.fundInstrumentId,
    disclosedWeightTotal,
    resolvedWeight: resolved,
    unresolvedWeight: unresolved,
    cashWeight: cash,
    derivativeWeight: derivative,
    otherWeight: other,
    // Only a genuine shortfall counts as undisclosed; a file summing to
    // 100.02% has no negative remainder.
    undisclosedRemainder: Math.max(0, 1 - disclosedWeightTotal),
    reportedHoldingsCoverage: Math.min(1, disclosedWeightTotal),
    weightSumWithinRoundingTolerance: deviationPct <= WEIGHT_SUM_ROUNDING_TOLERANCE_PCT,
  };
}

// ---------------------------------------------------------------------------
// Portfolio look-through
// ---------------------------------------------------------------------------

export type XrayQualityStatus =
  | 'COMPLETE'
  | 'PARTIAL_COVERAGE'
  | 'STALE_HOLDINGS'
  | 'MISSING_HOLDINGS'
  | 'UNDERLYING_UNRESOLVED'
  | 'CLASSIFICATION_INCOMPLETE'
  | 'MIXED_AS_OF_DATES'
  | 'DEBT_METADATA_INCOMPLETE'
  | 'INSUFFICIENT_COVERAGE';

export interface EffectiveExposure {
  canonicalId: string;
  displayName: string;
  /** Effective portfolio weight, fraction 0..1. */
  effectiveWeight: number;
  /** Value equivalent in portfolio currency terms. */
  effectiveValue: number;
  contributingFunds: Array<{ fundInstrumentId: string; fundName: string; portfolioWeight: number; holdingWeightInFund: number; contribution: number }>;
  schemeCount: number;
  sectorCode?: string | null;
  industryCode?: string | null;
  marketCapClass?: string | null;
}

export interface LookThroughResult {
  status: 'ok' | 'unavailable';
  asOfDate: string;
  /** Portfolio positions as-of date — may legitimately DIFFER from holdings dates. */
  portfolioAsOfDate: string;
  exposures: EffectiveExposure[];
  /** Weight of the portfolio in schemes that had a usable snapshot at all. */
  schemeCoverage: number;
  /** Within those schemes, weighted average disclosed coverage. */
  holdingsCoverageWithinSchemes: number;
  /** schemeCoverage × holdingsCoverageWithinSchemes — the headline figure the UI MUST display. */
  effectiveCoverage: number;
  /** Preserved buckets. Never redistributed across disclosed equities. */
  cashWeight: number;
  derivativeWeight: number;
  otherWeight: number;
  unresolvedWeight: number;
  /** Portfolio in funds with NO usable snapshot. */
  noSnapshotWeight: number;
  undisclosedRemainderWeight: number;
  freshness: HoldingsFreshness;
  newestHoldingsDate: string | null;
  oldestHoldingsDate: string | null;
  mixedDateSpreadDays: number | null;
  mixedDateWarning: boolean;
  portfolioConclusionSuppressed: boolean;
  qualityStatuses: XrayQualityStatus[];
  totalPortfolioValue: number;
  currencyCode: string | null;
  perFundCoverage: FundCoverage[];
  snapshotIdsUsed: string[];
  method: typeof LOOKTHROUGH_METHOD_VERSION;
  thresholdConfigVersion: typeof XRAY_THRESHOLD_CONFIG_VERSION;
  detail?: string;
}

/**
 * Compute weighted look-through exposure for a portfolio.
 *
 * Every weight in the result is a fraction of the WHOLE portfolio value, so
 * exposures + cash + derivatives + other + unresolved + undisclosed remainder
 * + no-snapshot weight sums to 1 (within floating tolerance). That identity is
 * asserted directly in the certification pack, and is what makes
 * double-counting structurally impossible.
 */
export function calculatePortfolioLookThrough(
  positions: PortfolioFundPosition[],
  snapshotsByFund: Map<string, FundHoldingsSnapshot[]>,
  asOfDate: string,
  portfolioAsOfDate: string
): LookThroughResult {
  const base = {
    method: LOOKTHROUGH_METHOD_VERSION,
    thresholdConfigVersion: XRAY_THRESHOLD_CONFIG_VERSION,
    asOfDate,
    portfolioAsOfDate,
  } as const;

  const totalValue = positions.reduce((s, p) => s + p.value, 0);
  const currencyCode = positions[0]?.currencyCode ?? null;

  const empty: LookThroughResult = {
    status: 'unavailable',
    exposures: [],
    schemeCoverage: 0,
    holdingsCoverageWithinSchemes: 0,
    effectiveCoverage: 0,
    cashWeight: 0,
    derivativeWeight: 0,
    otherWeight: 0,
    unresolvedWeight: 0,
    noSnapshotWeight: positions.length > 0 ? 1 : 0,
    undisclosedRemainderWeight: 0,
    freshness: 'MISSING',
    newestHoldingsDate: null,
    oldestHoldingsDate: null,
    mixedDateSpreadDays: null,
    mixedDateWarning: false,
    portfolioConclusionSuppressed: true,
    qualityStatuses: ['MISSING_HOLDINGS'],
    totalPortfolioValue: totalValue,
    currencyCode,
    perFundCoverage: [],
    snapshotIdsUsed: [],
    ...base,
  };

  if (positions.length === 0 || totalValue <= 0) {
    return { ...empty, noSnapshotWeight: 0, detail: 'No mutual-fund positions are available to analyse.' };
  }

  const exposureMap = new Map<string, EffectiveExposure>();
  const perFundCoverage: FundCoverage[] = [];
  const snapshotIdsUsed: string[] = [];
  const holdingsDates: string[] = [];

  let cashWeight = 0;
  let derivativeWeight = 0;
  let otherWeight = 0;
  let unresolvedWeight = 0;
  let noSnapshotWeight = 0;
  let undisclosedRemainderWeight = 0;
  let schemeCoverage = 0;
  let coverageWeightedSum = 0;
  let classificationIncomplete = false;

  for (const pos of positions) {
    const portfolioWeight = pos.value / totalValue;
    const snapshot = selectSnapshotAsOf(snapshotsByFund.get(pos.fundInstrumentId) ?? [], asOfDate);
    if (!snapshot) {
      noSnapshotWeight += portfolioWeight;
      continue;
    }
    schemeCoverage += portfolioWeight;
    snapshotIdsUsed.push(snapshot.snapshotId);
    holdingsDates.push(snapshot.holdingsAsOfDate);

    const cov = calculateFundCoverage(snapshot);
    perFundCoverage.push(cov);
    coverageWeightedSum += portfolioWeight * cov.reportedHoldingsCoverage;
    undisclosedRemainderWeight += portfolioWeight * cov.undisclosedRemainder;
    cashWeight += portfolioWeight * cov.cashWeight;
    derivativeWeight += portfolioWeight * cov.derivativeWeight;
    otherWeight += portfolioWeight * cov.otherWeight;
    unresolvedWeight += portfolioWeight * cov.unresolvedWeight;

    for (const h of snapshot.holdings) {
      const kind = h.assetKind ?? 'security';
      if (kind !== 'security' || !h.canonicalId) continue; // already bucketed above
      const holdingWeightInFund = h.weightPct / 100;
      // ---- THE CORE FORMULA ----
      const contribution = portfolioWeight * holdingWeightInFund;
      if (!h.sectorCode || !h.marketCapClass) classificationIncomplete = true;

      const existing = exposureMap.get(h.canonicalId);
      if (existing) {
        existing.effectiveWeight += contribution;
        existing.effectiveValue += contribution * totalValue;
        existing.contributingFunds.push({
          fundInstrumentId: pos.fundInstrumentId,
          fundName: pos.fundName,
          portfolioWeight,
          holdingWeightInFund,
          contribution,
        });
        existing.schemeCount = existing.contributingFunds.length;
        existing.sectorCode = existing.sectorCode ?? h.sectorCode ?? null;
        existing.industryCode = existing.industryCode ?? h.industryCode ?? null;
        existing.marketCapClass = existing.marketCapClass ?? h.marketCapClass ?? null;
      } else {
        exposureMap.set(h.canonicalId, {
          canonicalId: h.canonicalId,
          displayName: h.displayName,
          effectiveWeight: contribution,
          effectiveValue: contribution * totalValue,
          contributingFunds: [
            { fundInstrumentId: pos.fundInstrumentId, fundName: pos.fundName, portfolioWeight, holdingWeightInFund, contribution },
          ],
          schemeCount: 1,
          sectorCode: h.sectorCode ?? null,
          industryCode: h.industryCode ?? null,
          marketCapClass: h.marketCapClass ?? null,
        });
      }
    }
  }

  if (snapshotIdsUsed.length === 0) {
    return {
      ...empty,
      detail:
        'No fund holdings disclosure is available for any scheme in this portfolio at the selected date. Look-through exposure cannot be calculated, so no exposure breakdown is shown.',
    };
  }

  const holdingsCoverageWithinSchemes = schemeCoverage > 0 ? coverageWeightedSum / schemeCoverage : 0;
  const effectiveCoverage = schemeCoverage * holdingsCoverageWithinSchemes;

  const sortedDates = [...holdingsDates].sort((a, b) => toUtc(a) - toUtc(b));
  const oldestHoldingsDate = sortedDates[0];
  const newestHoldingsDate = sortedDates[sortedDates.length - 1];
  const mixedDateSpreadDays = daysBetween(oldestHoldingsDate, newestHoldingsDate);
  const mixedDateWarning = mixedDateSpreadDays > MIXED_DATE_SPREAD_DAYS.WARN;

  // Freshness of the portfolio-level view is governed by its OLDEST
  // contributing snapshot — the weakest link, never the most flattering one.
  const freshness = classifyFreshness(oldestHoldingsDate, asOfDate);

  const qualityStatuses: XrayQualityStatus[] = [];
  if (effectiveCoverage >= COVERAGE_THRESHOLDS.EFFECTIVELY_COMPLETE) qualityStatuses.push('COMPLETE');
  else qualityStatuses.push('PARTIAL_COVERAGE');
  if (noSnapshotWeight > 0) qualityStatuses.push('MISSING_HOLDINGS');
  if (unresolvedWeight > 0) qualityStatuses.push('UNDERLYING_UNRESOLVED');
  if (freshness === 'STALE' || freshness === 'VERY_STALE') qualityStatuses.push('STALE_HOLDINGS');
  if (mixedDateWarning) qualityStatuses.push('MIXED_AS_OF_DATES');
  if (classificationIncomplete) qualityStatuses.push('CLASSIFICATION_INCOMPLETE');
  if (effectiveCoverage < COVERAGE_THRESHOLDS.MIN_FOR_PORTFOLIO_CONCLUSION) qualityStatuses.push('INSUFFICIENT_COVERAGE');

  const portfolioConclusionSuppressed =
    effectiveCoverage < COVERAGE_THRESHOLDS.MIN_FOR_PORTFOLIO_CONCLUSION ||
    mixedDateSpreadDays > MIXED_DATE_SPREAD_DAYS.SUPPRESS_PORTFOLIO_CONCLUSION;

  const exposures = [...exposureMap.values()].sort((a, b) => {
    const d = b.effectiveWeight - a.effectiveWeight;
    return d !== 0 ? d : a.canonicalId.localeCompare(b.canonicalId);
  });

  return {
    status: 'ok',
    exposures,
    schemeCoverage,
    holdingsCoverageWithinSchemes,
    effectiveCoverage,
    cashWeight,
    derivativeWeight,
    otherWeight,
    unresolvedWeight,
    noSnapshotWeight,
    undisclosedRemainderWeight,
    freshness,
    newestHoldingsDate,
    oldestHoldingsDate,
    mixedDateSpreadDays,
    mixedDateWarning,
    portfolioConclusionSuppressed,
    qualityStatuses,
    totalPortfolioValue: totalValue,
    currencyCode,
    perFundCoverage,
    snapshotIdsUsed,
    ...base,
  };
}

/** Top N effective underlying holdings. */
export function topEffectiveHoldings(result: LookThroughResult, n: number): EffectiveExposure[] {
  return result.exposures.slice(0, n);
}

export const __lookThroughInternals = { daysBetween, toUtc };
