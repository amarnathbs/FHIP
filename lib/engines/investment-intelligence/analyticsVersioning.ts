// R4 — Calculation versioning and input-fingerprinting (spec sections
// 55-57). Every persisted ii_analytics_results row carries the fields
// this module assembles, so a shown number is always reproducible from
// its versioned inputs, and a later change to any input can be detected
// as staleness.

import { createHash } from 'crypto';
import { XIRR_METHOD_VERSION } from './xirr';
import { TWRR_METHOD_VERSION } from './twrr';
import { NAV_RETURN_METHOD_VERSION } from './navReturn';
import { RISK_METRICS_METHOD_VERSION } from './riskMetrics';
import { BLENDED_BENCHMARK_METHOD_VERSION } from './benchmarkEngine';
import { ROLLING_RETURN_METHOD_VERSION } from './rollingReturns';
import { MINIMUM_HISTORY_CONFIG_VERSION } from '@/lib/config/investment-intelligence/minimumHistory';
import { RISK_FREE_RATE_METHOD_VERSION } from '@/lib/config/investment-intelligence/riskFreeRate';

/** The single overall engine version, bumped whenever ANY of the sub-engine
 *  versions above changes, or the orchestration logic itself changes. */
export const PERFORMANCE_ENGINE_VERSION = 'performance-engine-r4-v1';

export const ENGINE_SUB_VERSIONS = {
  xirr: XIRR_METHOD_VERSION,
  twrr: TWRR_METHOD_VERSION,
  navReturn: NAV_RETURN_METHOD_VERSION,
  riskMetrics: RISK_METRICS_METHOD_VERSION,
  blendedBenchmark: BLENDED_BENCHMARK_METHOD_VERSION,
  rollingReturn: ROLLING_RETURN_METHOD_VERSION,
  minimumHistoryConfig: MINIMUM_HISTORY_CONFIG_VERSION,
  riskFreeRate: RISK_FREE_RATE_METHOD_VERSION,
} as const;

export interface AnalyticsResultMetadata {
  metric: string;
  metricVersion: string;
  engineVersion: string;
  dataAsOfDate: string; // ISO date
  inputSnapshotVersion: string; // fingerprint, see fingerprintInputs()
  benchmarkMappingVersion: string | null;
  navDataVersion: string | null;
  benchmarkDataVersion: string | null;
  riskFreeVersion: string | null;
  createdAt: string; // ISO timestamp
  qualityStatus: 'ok' | 'unavailable' | 'stale';
}

/**
 * Deterministic input fingerprint. Canonicalises the supplied input arrays
 * (transactions, holdings, NAV points, benchmark points, benchmark
 * mapping rows, methodology version) into exact decimal-string /
 * ISO-date-string form (never floats — same discipline as R2's
 * fingerprint.ts) before hashing, so the hash changes deterministically
 * whenever any relevant input changes and is stable across re-runs with
 * unchanged input.
 */
export function fingerprintInputs(canonicalParts: unknown[]): string {
  const canonical = JSON.stringify(canonicalParts, (_key, value) => {
    if (typeof value === 'number') return value.toFixed(10); // exact decimal string, never float repr
    if (value instanceof Date) return value.toISOString();
    return value;
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * True if any of the versions embedded in a previously-persisted result's
 * metadata differ from the CURRENT engine/config versions, OR if the
 * current input fingerprint differs from the persisted one — either
 * condition marks the prior result stale (spec section 57). Never served
 * as current without a warning.
 */
export function isStale(
  persisted: { engineVersion: string; inputSnapshotVersion: string },
  currentEngineVersion: string,
  currentInputFingerprint: string
): boolean {
  return persisted.engineVersion !== currentEngineVersion || persisted.inputSnapshotVersion !== currentInputFingerprint;
}
