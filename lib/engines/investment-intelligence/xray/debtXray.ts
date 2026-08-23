// Investment Intelligence R5 — debt-fund look-through.
//
// R5 calculates ONLY the debt measures the source data genuinely supports
// (spec sections 71-73). Equity-style sector analysis is NOT forced onto debt
// instruments, and every metric below independently reports itself
// unavailable rather than returning a misleading zero.
//
// THREE HARD RULES, each a critical-FAIL condition if broken:
//
//  1. A MISSING RATING IS NOT A RATING. Unrated exposure is reported in an
//     UNRATED bucket, which is a statement about DATA AVAILABILITY, not about
//     creditworthiness. R5 never converts "we don't know" into "AAA", and
//     never into "below A" either.
//
//  2. MULTI-AGENCY RATINGS ARE NOT ARBITRARILY COLLAPSED. When a security
//     carries ratings from several agencies and no approved consolidation
//     methodology is configured, R5 RETAINS the agency-specific values and
//     SUPPRESSES the consolidated credit-quality assessment. It never quietly
//     takes the most favourable rating (nor the least favourable — either
//     choice would be an unapproved methodology).
//
//  3. DURATION IS NEVER ESTIMATED FROM MATURITY. Modified duration is shown
//     only when the source provides it. A bond's duration depends on its
//     coupon and yield, not only its maturity, so inferring one from the
//     other would fabricate precision. Absent source duration, the metric is
//     marked unavailable.

import { CREDIT_RATING_BANDS, type CreditRatingBand, MATURITY_BUCKETS, type MaturityBucketKey, XRAY_THRESHOLD_CONFIG_VERSION } from '@/lib/config/investment-intelligence/xrayThresholds';

export const DEBT_XRAY_METHOD_VERSION = 'debt-xray-r5-v1';

function toUtc(iso: string): number {
  return Date.parse(`${iso}T00:00:00.000Z`);
}

/** A debt holding line contributing effective portfolio weight. */
export interface DebtExposureLine {
  canonicalId: string | null;
  displayName: string;
  effectiveWeight: number;
  issuerId?: string | null;
  issuerName?: string | null;
  /** Single approved band, when the source gives one unambiguous rating. */
  creditRatingBand?: CreditRatingBand | null;
  /** Present when several agencies rated this security differently. */
  agencyRatings?: Array<{ agency: string; rating: string }> | null;
  maturityDate?: string | null;
  modifiedDuration?: number | null;
}

export interface DebtBucketResult<K extends string> {
  status: 'ok' | 'unavailable';
  buckets: Array<{ key: K; label: string; effectiveWeight: number; securityCount: number }>;
  coveredWeight: number;
  uncoveredWeight: number;
  detail?: string;
  method: typeof DEBT_XRAY_METHOD_VERSION;
}

export interface CreditQualityResult extends DebtBucketResult<CreditRatingBand> {
  /** True when consolidation was suppressed due to unreconciled multi-agency ratings. */
  consolidationSuppressed: boolean;
  /** Retained agency-specific data for the securities that caused suppression. */
  multiAgencySecurities?: Array<{ canonicalId: string | null; displayName: string; effectiveWeight: number; agencyRatings: Array<{ agency: string; rating: string }> }>;
}

/**
 * Credit-quality distribution by approved rating band.
 *
 * @param consolidationMethodology  the approved multi-agency consolidation
 *        methodology key, or null when none is configured. When null AND any
 *        security carries conflicting agency ratings, the consolidated
 *        assessment is suppressed rather than guessed.
 */
export function calculateCreditQuality(lines: DebtExposureLine[], consolidationMethodology: string | null = null): CreditQualityResult {
  const multiAgency = lines.filter((l) => {
    const rs = l.agencyRatings ?? [];
    if (rs.length < 2) return false;
    return new Set(rs.map((r) => r.rating.trim().toUpperCase())).size > 1;
  });

  if (multiAgency.length > 0 && !consolidationMethodology) {
    return {
      status: 'unavailable',
      buckets: [],
      coveredWeight: 0,
      uncoveredWeight: lines.reduce((s, l) => s + l.effectiveWeight, 0),
      consolidationSuppressed: true,
      multiAgencySecurities: multiAgency.map((l) => ({
        canonicalId: l.canonicalId,
        displayName: l.displayName,
        effectiveWeight: l.effectiveWeight,
        agencyRatings: l.agencyRatings ?? [],
      })),
      detail: `${multiAgency.length} holding(s) carry different ratings from different agencies and no approved method for combining them is configured. The agency-specific ratings are retained, but a single consolidated credit-quality breakdown is not shown.`,
      method: DEBT_XRAY_METHOD_VERSION,
    };
  }

  const map = new Map<CreditRatingBand, { key: CreditRatingBand; label: string; effectiveWeight: number; securityCount: number }>();
  let covered = 0;
  for (const l of lines) {
    // Rule 1: a missing rating becomes UNRATED — a data-availability
    // statement — and never any credit-quality band.
    const band: CreditRatingBand = l.creditRatingBand && CREDIT_RATING_BANDS.includes(l.creditRatingBand) ? l.creditRatingBand : 'UNRATED';
    covered += l.effectiveWeight;
    const b = map.get(band);
    if (b) {
      b.effectiveWeight += l.effectiveWeight;
      b.securityCount += 1;
    } else {
      map.set(band, { key: band, label: band === 'UNRATED' ? 'Unrated (no rating available in source data)' : band.replace(/_/g, ' '), effectiveWeight: l.effectiveWeight, securityCount: 1 });
    }
  }

  if (map.size === 0) {
    return { status: 'unavailable', buckets: [], coveredWeight: 0, uncoveredWeight: 0, consolidationSuppressed: false, detail: 'No debt holdings available.', method: DEBT_XRAY_METHOD_VERSION };
  }

  const order = CREDIT_RATING_BANDS as readonly string[];
  const buckets = [...map.values()].sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
  return { status: 'ok', buckets, coveredWeight: covered, uncoveredWeight: 0, consolidationSuppressed: false, method: DEBT_XRAY_METHOD_VERSION };
}

/** Deterministic, versioned maturity buckets. */
export function calculateMaturityBuckets(lines: DebtExposureLine[], asOfDate: string): DebtBucketResult<MaturityBucketKey> {
  const map = new Map<MaturityBucketKey, { key: MaturityBucketKey; label: string; effectiveWeight: number; securityCount: number }>();
  let covered = 0;
  let uncovered = 0;

  for (const l of lines) {
    let key: MaturityBucketKey = 'PERPETUAL_UNKNOWN';
    if (l.maturityDate) {
      const years = (toUtc(l.maturityDate) - toUtc(asOfDate)) / (365.25 * 86_400_000);
      const bucket = MATURITY_BUCKETS.find((b) => b.minYears !== null && b.maxYears !== null && years >= b.minYears && years < b.maxYears);
      if (bucket) {
        key = bucket.key;
        covered += l.effectiveWeight;
      } else {
        // Negative (already matured) or unmatched — do not force into a band.
        uncovered += l.effectiveWeight;
      }
    } else {
      uncovered += l.effectiveWeight;
    }
    const label = MATURITY_BUCKETS.find((b) => b.key === key)?.label ?? key;
    const b = map.get(key);
    if (b) {
      b.effectiveWeight += l.effectiveWeight;
      b.securityCount += 1;
    } else {
      map.set(key, { key, label, effectiveWeight: l.effectiveWeight, securityCount: 1 });
    }
  }

  if (map.size === 0) {
    return { status: 'unavailable', buckets: [], coveredWeight: 0, uncoveredWeight: 0, detail: 'No debt holdings available.', method: DEBT_XRAY_METHOD_VERSION };
  }
  const order = MATURITY_BUCKETS.map((b) => b.key) as readonly string[];
  const buckets = [...map.values()].sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
  return { status: 'ok', buckets, coveredWeight: covered, uncoveredWeight: uncovered, method: DEBT_XRAY_METHOD_VERSION };
}

export interface DurationResult {
  status: 'ok' | 'unavailable';
  /** Weight-weighted average modified duration, in years. */
  weightedModifiedDuration?: number;
  /** Weight the duration figure is actually based on. */
  coveredWeight?: number;
  detail?: string;
  method: typeof DEBT_XRAY_METHOD_VERSION;
}

/**
 * Weighted modified duration — SOURCE-PROVIDED ONLY.
 *
 * Rule 3: never estimated from maturity. If no line carries a source
 * duration, the metric is unavailable. If only part of the book carries one,
 * the covered weight is reported so the figure is never mistaken for
 * whole-portfolio duration.
 */
export function calculateWeightedDuration(lines: DebtExposureLine[], minCoverage = 0.8): DurationResult {
  let weighted = 0;
  let covered = 0;
  let total = 0;
  for (const l of lines) {
    total += l.effectiveWeight;
    if (l.modifiedDuration !== null && l.modifiedDuration !== undefined && Number.isFinite(l.modifiedDuration)) {
      weighted += l.effectiveWeight * l.modifiedDuration;
      covered += l.effectiveWeight;
    }
  }
  if (covered <= 0) {
    return {
      status: 'unavailable',
      detail: 'Modified duration is not provided in the available holdings data. It is not shown, because duration cannot be reliably derived from maturity dates alone.',
      method: DEBT_XRAY_METHOD_VERSION,
    };
  }
  const coverageFraction = total > 0 ? covered / total : 0;
  if (coverageFraction < minCoverage) {
    return {
      status: 'unavailable',
      coveredWeight: covered,
      detail: `Modified duration is available for only ${(coverageFraction * 100).toFixed(1)}% of the debt holdings, which is not enough to state a portfolio duration. No figure is shown.`,
      method: DEBT_XRAY_METHOD_VERSION,
    };
  }
  return { status: 'ok', weightedModifiedDuration: weighted / covered, coveredWeight: covered, method: DEBT_XRAY_METHOD_VERSION };
}

export interface IssuerConcentrationResult {
  status: 'ok' | 'unavailable';
  buckets: Array<{ issuerId: string; issuerName: string; effectiveWeight: number; securityCount: number }>;
  unattributedWeight: number;
  detail?: string;
  method: typeof DEBT_XRAY_METHOD_VERSION;
  thresholdConfigVersion: typeof XRAY_THRESHOLD_CONFIG_VERSION;
}

/** Issuer-level concentration — the debt analogue of security concentration. */
export function calculateIssuerConcentration(lines: DebtExposureLine[]): IssuerConcentrationResult {
  const base = { method: DEBT_XRAY_METHOD_VERSION, thresholdConfigVersion: XRAY_THRESHOLD_CONFIG_VERSION } as const;
  const map = new Map<string, { issuerId: string; issuerName: string; effectiveWeight: number; securityCount: number }>();
  let unattributed = 0;
  for (const l of lines) {
    if (!l.issuerId) {
      unattributed += l.effectiveWeight;
      continue;
    }
    const b = map.get(l.issuerId);
    if (b) {
      b.effectiveWeight += l.effectiveWeight;
      b.securityCount += 1;
    } else {
      map.set(l.issuerId, { issuerId: l.issuerId, issuerName: l.issuerName ?? l.issuerId, effectiveWeight: l.effectiveWeight, securityCount: 1 });
    }
  }
  if (map.size === 0) {
    return { status: 'unavailable', buckets: [], unattributedWeight: unattributed, detail: 'Issuer information is not available in the holdings data, so issuer concentration is not shown.', ...base };
  }
  const buckets = [...map.values()].sort((a, b) => (b.effectiveWeight - a.effectiveWeight) || a.issuerId.localeCompare(b.issuerId));
  return { status: 'ok', buckets, unattributedWeight: unattributed, ...base };
}
