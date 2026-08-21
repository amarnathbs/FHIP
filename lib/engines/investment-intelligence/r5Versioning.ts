// Investment Intelligence R5 — calculation versioning and input
// fingerprinting for SIP Intelligence and Portfolio X-Ray.
//
// Mirrors R4's analyticsVersioning.ts contract (and reuses its
// fingerprintInputs) so every persisted R5 result is reproducible from its
// versioned inputs, and any change to an input or a methodology is detectable
// as staleness rather than silently re-labelling a historical result.

import { fingerprintInputs } from './analyticsVersioning';
import { XIRR_METHOD_VERSION } from './xirr';
import { SIP_DETECTION_METHOD_VERSION } from './sip/sipDetection';
import { SIP_ATTRIBUTION_METHOD_VERSION } from './sip/sipAttribution';
import { SIP_XIRR_METHOD_VERSION, BENCHMARK_SIP_METHOD_VERSION } from './sip/sipXirr';
import { SIP_CONSISTENCY_METHOD_VERSION } from './sip/sipConsistency';
import { SIP_SIMULATION_METHOD_VERSION, SIP_TIMING_METHOD_VERSION } from './sip/sipSimulation';
import { SIP_DATE_ALIGNMENT_VERSION } from './sip/dateAlignment';
import { SECURITY_RESOLUTION_METHOD_VERSION } from './xray/securityResolution';
import { LOOKTHROUGH_METHOD_VERSION } from './xray/lookThrough';
import { OVERLAP_METHOD_VERSION } from './xray/overlap';
import { CONCENTRATION_METHOD_VERSION, EXPOSURE_AGGREGATION_METHOD_VERSION } from './xray/concentration';
import { DEBT_XRAY_METHOD_VERSION } from './xray/debtXray';
import { SIP_THRESHOLD_CONFIG_VERSION } from '@/lib/config/investment-intelligence/sipThresholds';
import { XRAY_THRESHOLD_CONFIG_VERSION } from '@/lib/config/investment-intelligence/xrayThresholds';

/** Bumped whenever ANY sub-version below changes, or orchestration changes. */
export const SIP_ENGINE_VERSION = 'sip-engine-r5-v1';
export const XRAY_ENGINE_VERSION = 'xray-engine-r5-v1';

export const R5_SIP_SUB_VERSIONS = {
  detection: SIP_DETECTION_METHOD_VERSION,
  attribution: SIP_ATTRIBUTION_METHOD_VERSION,
  sipXirr: SIP_XIRR_METHOD_VERSION,
  benchmarkSip: BENCHMARK_SIP_METHOD_VERSION,
  consistency: SIP_CONSISTENCY_METHOD_VERSION,
  simulation: SIP_SIMULATION_METHOD_VERSION,
  timing: SIP_TIMING_METHOD_VERSION,
  dateAlignment: SIP_DATE_ALIGNMENT_VERSION,
  xirr: XIRR_METHOD_VERSION, // the certified R4 engine, reused not reimplemented
  thresholds: SIP_THRESHOLD_CONFIG_VERSION,
} as const;

export const R5_XRAY_SUB_VERSIONS = {
  securityResolution: SECURITY_RESOLUTION_METHOD_VERSION,
  lookThrough: LOOKTHROUGH_METHOD_VERSION,
  overlap: OVERLAP_METHOD_VERSION,
  concentration: CONCENTRATION_METHOD_VERSION,
  exposureAggregation: EXPOSURE_AGGREGATION_METHOD_VERSION,
  debt: DEBT_XRAY_METHOD_VERSION,
  thresholds: XRAY_THRESHOLD_CONFIG_VERSION,
} as const;

export type R5MetricKey =
  | 'sip_series'
  | 'sip_actual_xirr'
  | 'sip_benchmark_xirr'
  | 'sip_excess_return'
  | 'sip_wealth_comparison'
  | 'sip_consistency'
  | 'sip_activity_status'
  | 'sip_simulation'
  | 'sip_timing_comparison'
  | 'xray_lookthrough'
  | 'xray_top_holdings'
  | 'xray_security_concentration'
  | 'xray_sector_exposure'
  | 'xray_market_cap_exposure'
  | 'xray_amc_concentration'
  | 'xray_fund_overlap'
  | 'xray_debt_credit_quality'
  | 'xray_debt_maturity'
  | 'xray_debt_duration'
  | 'xray_data_quality';

export interface R5ResultMetadata {
  metricKey: R5MetricKey;
  metricVersion: string;
  engineVersion: string;
  dataAsOfDate: string;
  /** Portfolio positions as-of date. May differ from holdingsAsOfDate — both are displayed. */
  portfolioAsOfDate: string | null;
  /** Newest contributing fund-holdings snapshot date. */
  holdingsAsOfDate: string | null;
  holdingsSnapshotIds: string[];
  holdingsSourceVersions: string[];
  classificationVersion: string | null;
  benchmarkMappingVersion: string | null;
  benchmarkDataVersion: string | null;
  navDataVersion: string | null;
  inputSnapshotVersion: string;
  coverage: number | null;
  qualityStatus: string;
  createdAt: string;
}

/**
 * Deterministic fingerprint for a SIP calculation. Canonicalises exactly the
 * inputs that can change the answer, so a rerun over unchanged data produces
 * a byte-identical hash (the determinism proof), and any change to a
 * contribution, NAV, benchmark point, or methodology version changes it.
 */
export function fingerprintSipInputs(parts: {
  seriesKey: string;
  contributions: Array<{ date: string; amount: number; units: number | null; id: string }>;
  attributableInflows: Array<{ date: string; amount: number }>;
  navAtAsOf: number | null;
  benchmarkPoints: Array<{ date: string; value: number }>;
  asOfDate: string;
  methodVersions: Record<string, string>;
}): string {
  return fingerprintInputs([
    parts.seriesKey,
    parts.contributions.map((c) => [c.id, c.date, c.amount, c.units]),
    parts.attributableInflows.map((i) => [i.date, i.amount]),
    parts.navAtAsOf,
    parts.benchmarkPoints.map((p) => [p.date, p.value]),
    parts.asOfDate,
    parts.methodVersions,
  ]);
}

/** Deterministic fingerprint for an X-Ray calculation. */
export function fingerprintXrayInputs(parts: {
  positions: Array<{ fundInstrumentId: string; value: number }>;
  snapshotIds: string[];
  holdingsSourceVersions: string[];
  classificationVersion: string | null;
  asOfDate: string;
  portfolioAsOfDate: string;
  methodVersions: Record<string, string>;
}): string {
  return fingerprintInputs([
    [...parts.positions].sort((a, b) => a.fundInstrumentId.localeCompare(b.fundInstrumentId)).map((p) => [p.fundInstrumentId, p.value]),
    [...parts.snapshotIds].sort(),
    [...parts.holdingsSourceVersions].sort(),
    parts.classificationVersion,
    parts.asOfDate,
    parts.portfolioAsOfDate,
    parts.methodVersions,
  ]);
}

/**
 * Staleness triggers (spec sections 75, 90). A persisted result is stale when
 * any embedded version differs from current, or the recomputed input
 * fingerprint differs. Historical results remain auditable; only a
 * non-stale result is ever displayed as current.
 */
export function isR5ResultStale(
  persisted: { engineVersion: string; inputSnapshotVersion: string },
  currentEngineVersion: string,
  currentInputFingerprint: string
): boolean {
  return persisted.engineVersion !== currentEngineVersion || persisted.inputSnapshotVersion !== currentInputFingerprint;
}
