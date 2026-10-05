// NAV2 Stage 2 -- the shared result cache store (nav2_result_cache, migration 0261; service role only) and the
// correction worker that invalidates it.
//
// The cached unit is one scheme's performance BUNDLE (scheme-performance family: public-data derived, no user
// scope). Cached analytics are never independent truth: the key carries every input that can change a number
// (see cacheKeys.ts), so a changed input is simply a different key; the worker below handles the other direction,
// a CORRECTION to a published input, by marking exactly the affected entries invalidated (selectInvalidated).
// An invalidated entry is never read again; it is not deleted (the row stays as evidence until retention).
//
// A bundle that depends on more than one benchmark segment is not cached (its invalidation key would be
// ambiguous); it is simply recomputed. Reads and writes fail soft: a cache problem can only cost time, never
// change a number or fail a report.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { SchemePerformanceFamily } from '@/lib/engines/nav2/analyticsContract';
import { metricRegistryDigest, selectInvalidated, type CachedResultMeta, type InvalidationEvent, type ResultCacheKeyParts } from '@/lib/engines/nav2/cacheKeys';
import { NAV2_METRICS } from '@/lib/config/nav2/metricPolicy';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CacheWrite {
  key: string;
  parts: ResultCacheKeyParts;
  payload: SchemePerformanceFamily;
}

/** Valid, non-invalidated entries for the keys, as key -> payload. Never throws. */
export async function readCachedBundles(admin: SupabaseClient, keys: readonly string[]): Promise<Map<string, SchemePerformanceFamily>> {
  const out = new Map<string, SchemePerformanceFamily>();
  if (keys.length === 0) return out;
  try {
    const { data, error } = await admin.from('nav2_result_cache').select('cache_key, payload').in('cache_key', [...keys]).is('invalidated_at', null);
    if (error) return out;
    for (const r of (data ?? []) as Array<{ cache_key: string; payload: SchemePerformanceFamily }>) out.set(r.cache_key, r.payload);
  } catch {
    // fail soft
  }
  return out;
}

/** Whether a bundle with these key parts may be stored (one benchmark at most; ids that the table's types accept). */
export function isCacheable(parts: ResultCacheKeyParts): boolean {
  if (!UUID.test(parts.instrumentId)) return false;
  if (parts.benchmarkId !== null && !UUID.test(parts.benchmarkId)) return false;
  return true;
}

/**
 * Stores new entries (an existing VALID key is left as it is: same key = same inputs = same payload). Never throws.
 *
 * An INVALIDATED row with the same key is refreshed and made valid again. The key is content-addressed (it carries the NAV series checksum,
 * the policy and the definition digests), so a payload computed now for that key is correct for exactly those inputs. Without this, a
 * correction followed by its revert (or the worker invalidating an entry that was computed after the correction) left the row invalidated
 * and the unique key blocked the new entry, so that scheme was recomputed on every report until its inputs changed (Stage 3 finding).
 */
export async function writeCachedBundles(admin: SupabaseClient, writes: readonly CacheWrite[]): Promise<number> {
  const rows = writes.filter((w) => isCacheable(w.parts)).map((w) => ({
    cache_key: w.key,
    bundle_kind: 'scheme_performance',
    scope_hash: null,
    instrument_id: w.parts.instrumentId,
    metric_id: w.parts.metricId,
    policy_version: w.parts.policyVersion,
    definition_version: w.parts.definitionVersion,
    actual_end: w.parts.actual.end,
    benchmark_id: w.parts.benchmarkId,
    risk_free_dataset_id: w.parts.riskFreeDatasetId,
    payload: w.payload,
  }));
  if (rows.length === 0) return 0;
  try {
    const { error } = await admin.from('nav2_result_cache').upsert(rows, { onConflict: 'cache_key', ignoreDuplicates: true });
    if (error) return 0;
    // refresh the rows a worker had invalidated (a valid row is not touched: the filter matches invalidated rows only)
    const { data: stale } = await admin.from('nav2_result_cache').select('cache_key').in('cache_key', rows.map((r) => r.cache_key)).not('invalidated_at', 'is', null);
    const staleKeys = new Set(((stale ?? []) as Array<{ cache_key: string }>).map((r) => r.cache_key));
    for (const r of rows) {
      if (!staleKeys.has(r.cache_key)) continue;
      await admin.from('nav2_result_cache').update({ payload: r.payload, invalidated_at: null }).eq('cache_key', r.cache_key).not('invalidated_at', 'is', null);
    }
    return rows.length;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// The correction worker
// ---------------------------------------------------------------------------

interface EventRow {
  id: number;
  kind: 'nav_correction' | 'benchmark_correction' | 'risk_free_correction';
  instrument_id: string | null;
  benchmark_id: string | null;
  series_id: string | null;
  event_date: string;
}

interface CacheRow {
  cache_key: string;
  instrument_id: string | null;
  metric_id: string;
  policy_version: string;
  definition_version: string;
  actual_end: string | null;
  benchmark_id: string | null;
  risk_free_dataset_id: string | null;
}

export function eventToInvalidation(e: EventRow): InvalidationEvent | null {
  const date = String(e.event_date).slice(0, 10);
  if (e.kind === 'nav_correction' && e.instrument_id) return { kind: 'nav_correction', instrumentId: e.instrument_id, date };
  if (e.kind === 'benchmark_correction' && e.benchmark_id) return { kind: 'benchmark_correction', benchmarkId: e.benchmark_id, date };
  if (e.kind === 'risk_free_correction' && e.series_id) return { kind: 'risk_free_correction', datasetId: e.series_id, date };
  return null;
}

/**
 * Marks every still-valid bundle computed under another metric-definition registry (or an older key format) as invalidated. A correct
 * key already means such an entry is never READ (a changed definition is a different key); this is hygiene so the table does not carry
 * entries nothing can reach, and so the monitoring figure for invalidated entries says so. Idempotent. Never throws.
 */
export async function invalidateStaleDefinitionEntries(admin: SupabaseClient, currentRegistryDigest: string, nowIso = new Date().toISOString()): Promise<number> {
  try {
    const { data, error } = await admin.from('nav2_result_cache').select('cache_key, instrument_id, metric_id, policy_version, definition_version, actual_end, benchmark_id, risk_free_dataset_id').is('invalidated_at', null).limit(5000);
    if (error) return 0;
    const metas: CachedResultMeta[] = ((data ?? []) as CacheRow[]).map((r) => ({
      key: r.cache_key,
      family: 'scheme_performance',
      scopeHash: null,
      instrumentId: r.instrument_id ?? '',
      metricId: r.metric_id as CachedResultMeta['metricId'],
      policyVersion: r.policy_version,
      definitionVersion: r.definition_version,
      actualEnd: r.actual_end ? String(r.actual_end).slice(0, 10) : null,
      benchmarkId: r.benchmark_id,
      riskFreeDatasetId: r.risk_free_dataset_id,
    }));
    const keys = selectInvalidated(metas, { kind: 'definition_change', currentRegistryDigest });
    if (keys.length === 0) return 0;
    const { error: uerr } = await admin.from('nav2_result_cache').update({ invalidated_at: nowIso }).in('cache_key', keys).is('invalidated_at', null);
    return uerr ? 0 : keys.length;
  } catch {
    return 0;
  }
}

export interface CorrectionWorkerResult {
  eventsProcessed: number;
  entriesInvalidated: number;
  /** Pinned reports whose NAV range reaches the corrected date: never edited; counted so an operator can decide on a new version. */
  pinnedReportsAffected: number;
  /** Bundles invalidated because a metric definition changed since they were computed (spec 12.2). */
  staleDefinitionInvalidated: number;
  failed: number;
}

/** Processes up to `limit` unprocessed correction events, oldest first. Idempotent: a processed event is never reprocessed. */
export async function processNav2CorrectionEvents(admin: SupabaseClient, limit = 200, nowIso = new Date().toISOString()): Promise<CorrectionWorkerResult> {
  const result: CorrectionWorkerResult = { eventsProcessed: 0, entriesInvalidated: 0, pinnedReportsAffected: 0, staleDefinitionInvalidated: 0, failed: 0 };
  const { data, error } = await admin
    .from('nav2_correction_events')
    .select('id, kind, instrument_id, benchmark_id, series_id, event_date')
    .is('processed_at', null)
    .order('id', { ascending: true })
    .limit(limit);
  if (error) throw new Error(`Could not read correction events: ${error.message}`);
  for (const ev of (data ?? []) as EventRow[]) {
    try {
      const inv = eventToInvalidation(ev);
      let invalidated = 0;
      if (inv) {
        let q = admin.from('nav2_result_cache').select('cache_key, instrument_id, metric_id, policy_version, definition_version, actual_end, benchmark_id, risk_free_dataset_id').is('invalidated_at', null);
        if (inv.kind === 'nav_correction') q = q.eq('instrument_id', inv.instrumentId);
        else if (inv.kind === 'benchmark_correction') q = q.eq('benchmark_id', inv.benchmarkId);
        else if (inv.kind === 'risk_free_correction') q = q.eq('risk_free_dataset_id', inv.datasetId);
        const { data: rows, error: cerr } = await q;
        if (cerr) throw new Error(cerr.message);
        const metas: CachedResultMeta[] = ((rows ?? []) as CacheRow[]).map((r) => ({
          key: r.cache_key,
          family: 'scheme_performance',
          scopeHash: null,
          instrumentId: r.instrument_id ?? '',
          metricId: r.metric_id as CachedResultMeta['metricId'],
          policyVersion: r.policy_version,
          definitionVersion: r.definition_version,
          actualEnd: r.actual_end ? String(r.actual_end).slice(0, 10) : null,
          benchmarkId: r.benchmark_id,
          riskFreeDatasetId: r.risk_free_dataset_id,
        }));
        const keys = selectInvalidated(metas, inv);
        if (keys.length) {
          const { error: uerr } = await admin.from('nav2_result_cache').update({ invalidated_at: nowIso }).in('cache_key', keys).is('invalidated_at', null);
          if (uerr) throw new Error(uerr.message);
        }
        invalidated = keys.length;
        if (inv.kind === 'nav_correction') {
          const { data: pinned } = await admin.from('nav2_report_nav_dependencies').select('id').eq('instrument_id', inv.instrumentId).gte('nav_date_to', inv.date);
          result.pinnedReportsAffected += (pinned ?? []).length;
        }
      }
      const { error: perr } = await admin.from('nav2_correction_events').update({ processed_at: nowIso, entries_invalidated: invalidated }).eq('id', ev.id).is('processed_at', null);
      if (perr) throw new Error(perr.message);
      result.eventsProcessed += 1;
      result.entriesInvalidated += invalidated;
    } catch {
      result.failed += 1;
    }
  }
  // A changed metric definition invalidates every bundle computed under the old registry, not only corrected dates.
  result.staleDefinitionInvalidated = await invalidateStaleDefinitionEntries(admin, metricRegistryDigest(NAV2_METRICS), nowIso);
  return result;
}
