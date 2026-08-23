// Investment Intelligence R5 — concentration and classification exposure.
//
// Everything here is DESCRIPTIVE MEASUREMENT (spec sections 65-66, 69-70).
// R5 reports where exposure is concentrated. It never labels concentration
// itself as good or bad, never recommends diversifying, and never infers
// "diversified" from a scheme count.
//
// HHI CONVENTION (versioned in xrayThresholds.HHI_CONVENTION):
//   HHI = Σ w_i²  over DECIMAL weights (0..1).
//   One security at 100%      -> 1.0
//   Ten equal securities      -> 10 × 0.1² = 0.1
// Documented and asserted in certification case CONC-004 so it can never
// silently drift to the 0..10000 percentage convention.
//
// CLASSIFICATION DISCIPLINE (spec section 70, critical-FAIL adjacent):
// A market-cap class is used ONLY when it is present on the underlying
// security's own versioned classification. R5 never infers a security's
// market-cap class from the FUND'S category label — "Large & Mid Cap Fund"
// is a fund name, not proof about any individual holding. Unclassified
// weight is retained and reported as UNCLASSIFIED, never spread across the
// classified buckets.

import { HHI_CONVENTION, TOP_HOLDINGS_DEFAULT_N, XRAY_THRESHOLD_CONFIG_VERSION } from '@/lib/config/investment-intelligence/xrayThresholds';
import type { EffectiveExposure, LookThroughResult, PortfolioFundPosition } from './lookThrough';

export const CONCENTRATION_METHOD_VERSION = 'concentration-r5-v1';
export const EXPOSURE_AGGREGATION_METHOD_VERSION = 'exposure-aggregation-r5-v1';

export interface SecurityConcentrationResult {
  status: 'ok' | 'unavailable';
  top1?: number;
  top5?: number;
  top10?: number;
  /** Σ w², decimal-weight convention. */
  hhi?: number;
  hhiConvention: typeof HHI_CONVENTION;
  securityCount?: number;
  /** Coverage this measurement is based on — always displayed alongside. */
  basedOnEffectiveCoverage?: number;
  detail?: string;
  method: typeof CONCENTRATION_METHOD_VERSION;
  thresholdConfigVersion: typeof XRAY_THRESHOLD_CONFIG_VERSION;
}

export function calculateSecurityConcentration(lookThrough: LookThroughResult): SecurityConcentrationResult {
  const base = {
    hhiConvention: HHI_CONVENTION,
    method: CONCENTRATION_METHOD_VERSION,
    thresholdConfigVersion: XRAY_THRESHOLD_CONFIG_VERSION,
  } as const;

  if (lookThrough.status !== 'ok' || lookThrough.exposures.length === 0) {
    return {
      status: 'unavailable',
      detail: 'No resolved underlying holdings are available, so concentration cannot be measured. No figures are shown.',
      ...base,
    };
  }
  const weights = lookThrough.exposures.map((e) => e.effectiveWeight);
  const sum = (arr: number[]) => arr.reduce((s, x) => s + x, 0);
  return {
    status: 'ok',
    top1: weights[0] ?? 0,
    top5: sum(weights.slice(0, 5)),
    top10: sum(weights.slice(0, 10)),
    hhi: sum(weights.map((w) => w * w)),
    securityCount: weights.length,
    basedOnEffectiveCoverage: lookThrough.effectiveCoverage,
    ...base,
  };
}

// ---------------------------------------------------------------------------
// Classification exposure (sector / industry / market cap)
// ---------------------------------------------------------------------------

export interface ClassificationBucket {
  key: string;
  label: string;
  effectiveWeight: number;
  securityCount: number;
}

export interface ClassificationExposureResult {
  status: 'ok' | 'unavailable';
  buckets: ClassificationBucket[];
  /** Weight of the look-through that carried a classification at all. */
  classifiedWeight: number;
  /** Retained explicitly. Never redistributed across classified buckets. */
  unclassifiedWeight: number;
  /** The versioned taxonomy these buckets belong to. Two taxonomies are never mixed. */
  classificationVersion: string | null;
  basedOnEffectiveCoverage: number;
  detail?: string;
  method: typeof EXPOSURE_AGGREGATION_METHOD_VERSION;
}

type ClassificationField = 'sectorCode' | 'industryCode' | 'marketCapClass';

function aggregateBy(
  exposures: EffectiveExposure[],
  field: ClassificationField,
  classificationVersion: string | null,
  effectiveCoverage: number,
  labelFor: (key: string) => string
): ClassificationExposureResult {
  const buckets = new Map<string, ClassificationBucket>();
  let classifiedWeight = 0;
  let unclassifiedWeight = 0;

  for (const e of exposures) {
    const key = e[field];
    if (!key) {
      unclassifiedWeight += e.effectiveWeight;
      continue;
    }
    classifiedWeight += e.effectiveWeight;
    const b = buckets.get(key);
    if (b) {
      b.effectiveWeight += e.effectiveWeight;
      b.securityCount += 1;
    } else {
      buckets.set(key, { key, label: labelFor(key), effectiveWeight: e.effectiveWeight, securityCount: 1 });
    }
  }

  const list = [...buckets.values()].sort((a, b) => (b.effectiveWeight - a.effectiveWeight) || a.key.localeCompare(b.key));

  if (list.length === 0) {
    return {
      status: 'unavailable',
      buckets: [],
      classifiedWeight: 0,
      unclassifiedWeight,
      classificationVersion,
      basedOnEffectiveCoverage: effectiveCoverage,
      detail: 'No classification data is available for the underlying holdings, so this breakdown is not shown.',
      method: EXPOSURE_AGGREGATION_METHOD_VERSION,
    };
  }

  return {
    status: 'ok',
    buckets: list,
    classifiedWeight,
    unclassifiedWeight,
    classificationVersion,
    basedOnEffectiveCoverage: effectiveCoverage,
    method: EXPOSURE_AGGREGATION_METHOD_VERSION,
  };
}

export function calculateSectorExposure(lookThrough: LookThroughResult, classificationVersion: string | null, labelFor: (k: string) => string = (k) => k): ClassificationExposureResult {
  return aggregateBy(lookThrough.exposures, 'sectorCode', classificationVersion, lookThrough.effectiveCoverage, labelFor);
}

/** Industry exposure is produced ONLY where a genuine industry classification
 *  exists. It is never derived from sector data (spec section 69). */
export function calculateIndustryExposure(lookThrough: LookThroughResult, classificationVersion: string | null, labelFor: (k: string) => string = (k) => k): ClassificationExposureResult {
  return aggregateBy(lookThrough.exposures, 'industryCode', classificationVersion, lookThrough.effectiveCoverage, labelFor);
}

/** Market-cap exposure from the SECURITY's own versioned classification only. */
export function calculateMarketCapExposure(lookThrough: LookThroughResult, classificationVersion: string | null): ClassificationExposureResult {
  const labels: Record<string, string> = { LARGE: 'Large cap', MID: 'Mid cap', SMALL: 'Small cap', OTHER: 'Other' };
  return aggregateBy(lookThrough.exposures, 'marketCapClass', classificationVersion, lookThrough.effectiveCoverage, (k) => labels[k] ?? k);
}

// ---------------------------------------------------------------------------
// AMC concentration
// ---------------------------------------------------------------------------

export interface AmcConcentrationResult {
  status: 'ok' | 'unavailable';
  buckets: Array<{ amcId: string; amcName: string; value: number; weight: number; schemeCount: number }>;
  /** Portfolio value whose scheme metadata did not identify an AMC. */
  unattributedWeight: number;
  detail?: string;
  method: typeof CONCENTRATION_METHOD_VERSION;
}

/**
 * AMC concentration by portfolio VALUE (not by scheme count — a scheme count
 * says nothing about how much money is exposed, and R5 never infers
 * diversification from it).
 *
 * Requires no look-through data: it is a scheme-metadata measure and remains
 * available even when holdings disclosure is missing.
 */
export function calculateAmcConcentration(positions: PortfolioFundPosition[]): AmcConcentrationResult {
  const total = positions.reduce((s, p) => s + p.value, 0);
  if (total <= 0) {
    return { status: 'unavailable', buckets: [], unattributedWeight: 0, detail: 'No fund positions available.', method: CONCENTRATION_METHOD_VERSION };
  }
  const map = new Map<string, { amcId: string; amcName: string; value: number; schemeCount: number }>();
  let unattributedValue = 0;
  for (const p of positions) {
    if (!p.amcId) {
      unattributedValue += p.value;
      continue;
    }
    const b = map.get(p.amcId);
    if (b) {
      b.value += p.value;
      b.schemeCount += 1;
    } else {
      map.set(p.amcId, { amcId: p.amcId, amcName: p.amcName ?? p.amcId, value: p.value, schemeCount: 1 });
    }
  }
  const buckets = [...map.values()]
    .map((b) => ({ ...b, weight: b.value / total }))
    .sort((a, b) => (b.weight - a.weight) || a.amcId.localeCompare(b.amcId));

  if (buckets.length === 0) {
    return {
      status: 'unavailable',
      buckets: [],
      unattributedWeight: 1,
      detail: 'Scheme metadata does not identify the fund house for any position, so AMC concentration is not shown.',
      method: CONCENTRATION_METHOD_VERSION,
    };
  }
  return { status: 'ok', buckets, unattributedWeight: unattributedValue / total, method: CONCENTRATION_METHOD_VERSION };
}

/** Scheme-level concentration by portfolio value. */
export function calculateSchemeConcentration(positions: PortfolioFundPosition[]): SecurityConcentrationResult {
  const base = {
    hhiConvention: HHI_CONVENTION,
    method: CONCENTRATION_METHOD_VERSION,
    thresholdConfigVersion: XRAY_THRESHOLD_CONFIG_VERSION,
  } as const;
  const total = positions.reduce((s, p) => s + p.value, 0);
  if (total <= 0) return { status: 'unavailable', detail: 'No fund positions available.', ...base };
  const weights = positions.map((p) => p.value / total).sort((a, b) => b - a);
  const sum = (arr: number[]) => arr.reduce((s, x) => s + x, 0);
  return {
    status: 'ok',
    top1: weights[0],
    top5: sum(weights.slice(0, 5)),
    top10: sum(weights.slice(0, TOP_HOLDINGS_DEFAULT_N)),
    hhi: sum(weights.map((w) => w * w)),
    securityCount: weights.length,
    basedOnEffectiveCoverage: 1, // scheme-level needs no look-through
    ...base,
  };
}
