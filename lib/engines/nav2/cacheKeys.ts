// NAV2 -- result cache KEY and INVALIDATION contract (spec 12.2, 14). Pure.
//
// Stage 1 defines the contract; the cache store itself (and the writes that use
// it) are Stage 2. Cached analytics are never treated as independent truth: a key
// carries every input that can change the number, so a changed input is a different
// key, and the invalidation rules below name EXACTLY which entries a given change
// can affect (and, just as important, which it cannot).
//
// PRIVACY: the scope (household / user) enters the key only as a one-way hash, and
// scheme-performance results (which depend on public NAV data, not on any user)
// carry no scope at all and are therefore shared. Nothing in a key, a log line built
// from it, or a URL can reveal who holds a scheme (spec 14).

import { createHash } from 'crypto';
import type { Nav2MetricId, ResultFamily } from '@/lib/config/nav2/metricPolicy';

/** The per-scheme performance BUNDLE (every scheme-performance metric of one scheme and window) is cached as one entry. */
export const SCHEME_PERFORMANCE_BUNDLE = 'scheme_performance_bundle' as const;
export type CacheMetricId = Nav2MetricId | typeof SCHEME_PERFORMANCE_BUNDLE;

export interface ResultCacheKeyParts {
  /** Household / user the result belongs to. null for scheme-performance results (public data, shared). */
  scopeId: string | null;
  instrumentId: string;
  metricId: CacheMetricId;
  definitionVersion: string;
  policyVersion: string;
  requested: { start: string | null; end: string | null };
  actual: { start: string | null; end: string | null };
  navSeriesChecksum: string;
  benchmarkId: string | null;
  benchmarkDatasetVersion: string | null;
  riskFreeDatasetId: string | null;
  riskFreeDatasetVersion: string | null;
  /** Fingerprint of the user's transactions / holdings, for investor-experience results only. */
  transactionVersion: string | null;
  currency: string;
}

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

// ---------------------------------------------------------------------------
// The bundle DEFINITION version (spec 12.2: a policy or definition change must invalidate).
//
// A cached bundle holds the results of EVERY scheme-performance metric, so its key must change when ANY metric's definition changes.
// Stage 3 found a bundle key built from the engine version, the report version and the spec only: bumping the CAGR definition left
// the stored bundles valid, and a fresh report served the old computation. The definition component is therefore
//     <engine>:<report>:<spec digest>:<metric registry digest>:<policy digest>
// where the registry digest covers EVERY entry (id, family, version) of the metric register and the policy digest covers every
// policy value. Pure.
// ---------------------------------------------------------------------------
export function metricRegistryDigest(metrics: Readonly<Record<string, { id: string; family: string; version: string }>>): string {
  const ordered = Object.values(metrics)
    .map((m) => [m.id, m.family, m.version])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return sha(JSON.stringify(ordered)).slice(0, 12);
}

export function policyDigest(policy: unknown): string {
  return sha(JSON.stringify(policy)).slice(0, 12);
}

export function bundleDefinitionVersion(p: { engineVersion: string; reportVersion: string; specDigest: string; registryDigest: string; policyDigest: string }): string {
  return `${p.engineVersion}:${p.reportVersion}:${p.specDigest}:${p.registryDigest}:${p.policyDigest}`;
}

/** The metric-registry part of a stored bundle definition version, or null for an older format (which is therefore stale). */
export function registryDigestOf(definitionVersion: string): string | null {
  const parts = definitionVersion.split(':');
  return parts.length === 5 ? parts[3] : null;
}

export function scopeHash(scopeId: string | null): string | null {
  return scopeId === null ? null : sha(`nav2-scope:${scopeId}`).slice(0, 32);
}

export function buildResultCacheKey(p: ResultCacheKeyParts): string {
  const canonical = JSON.stringify([
    scopeHash(p.scopeId),
    p.instrumentId,
    p.metricId,
    p.definitionVersion,
    p.policyVersion,
    p.requested.start,
    p.requested.end,
    p.actual.start,
    p.actual.end,
    p.navSeriesChecksum,
    p.benchmarkId,
    p.benchmarkDatasetVersion,
    p.riskFreeDatasetId,
    p.riskFreeDatasetVersion,
    p.transactionVersion,
    p.currency,
  ]);
  return `nav2:${p.metricId}:${sha(canonical)}`;
}

/** What the cache stores alongside a key so invalidation can be decided without recomputing. */
export interface CachedResultMeta {
  key: string;
  family: ResultFamily;
  scopeHash: string | null;
  instrumentId: string;
  metricId: CacheMetricId;
  policyVersion: string;
  definitionVersion: string;
  /** Last NAV date the result depends on (its actual window end). */
  actualEnd: string | null;
  benchmarkId: string | null;
  riskFreeDatasetId: string | null;
}

export type InvalidationEvent =
  /** A corrected NAV for one scheme on one date. */
  | { kind: 'nav_correction'; instrumentId: string; date: string }
  /** A corrected benchmark level. */
  | { kind: 'benchmark_correction'; benchmarkId: string; date: string }
  /** A corrected risk-free observation. */
  | { kind: 'risk_free_correction'; datasetId: string; date: string }
  /** The user's transactions / ownership for a scheme changed. */
  | { kind: 'transaction_change'; scopeHash: string; instrumentId: string }
  /** The NAV2 policy version changed: everything computed under another version is stale. */
  | { kind: 'policy_change'; currentPolicyVersion: string }
  /** A metric definition (or the engine / report version) changed: every bundle whose registry digest differs, or is in the old format, is stale. */
  | { kind: 'definition_change'; currentRegistryDigest: string };

/**
 * The cache keys an event invalidates. Deliberately narrow: a correction to scheme A never touches scheme B, a
 * transaction change never touches scheme-performance results, and a result is only affected by a NAV date
 * that it could have used (a date on or before the end of its window: warm-up and lookback read older
 * observations, so every older date counts).
 */
export function selectInvalidated(entries: readonly CachedResultMeta[], event: InvalidationEvent): string[] {
  const hit = (e: CachedResultMeta): boolean => {
    switch (event.kind) {
      case 'nav_correction':
        return e.instrumentId === event.instrumentId && (e.actualEnd === null || event.date <= e.actualEnd);
      case 'benchmark_correction':
        return e.benchmarkId === event.benchmarkId && (e.actualEnd === null || event.date <= e.actualEnd);
      case 'risk_free_correction':
        return e.riskFreeDatasetId === event.datasetId && (e.actualEnd === null || event.date <= e.actualEnd);
      case 'transaction_change':
        return e.family === 'investor_experience' && e.scopeHash === event.scopeHash && e.instrumentId === event.instrumentId;
      case 'policy_change':
        return e.policyVersion !== event.currentPolicyVersion;
      case 'definition_change':
        return registryDigestOf(e.definitionVersion) !== event.currentRegistryDigest;
    }
  };
  return entries.filter(hit).map((e) => e.key).sort();
}
