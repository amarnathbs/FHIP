// Stage 3 (live DEV, Version 6): the one-year CAGR fix did not take effect because the shared per-scheme bundle cache served the old
// computation. The bundle key's definition component was <engine>:<report>:<spec digest> and did NOT include the metric definition
// versions, so bumping cagr / point_to_point left every stored bundle valid. Spec 12.2: a definition or policy change must invalidate.
//
// NAMED NEGATIVE CONTROLS
//   NC-K1  bumping ANY single metric definition version changes the bundle key (each metric in the register is tried); the OLD composition
//          (engine:report:spec) does not change, which is exactly the defect;
//   NC-K2  a bundle stored under definition v1 is NOT returned after a bump even when the NAV checksum is identical (read through the real
//          store against an in-memory table);
//   NC-K3  changing a policy value or the report spec changes the key; an unchanged registry keeps the key (no needless invalidation);
//   NC-K4  the correction worker's sweep invalidates bundles of another registry and of the old key format, and leaves current ones alone;
//   NC-K5  the report manifest carries the ordered metric-definition list and its digest.
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { NAV2_METRICS, NAV2_POLICY } from '@/lib/config/nav2/metricPolicy';
import { bundleDefinitionVersion, metricRegistryDigest, registryDigestOf, selectInvalidated, type CachedResultMeta } from '@/lib/engines/nav2/cacheKeys';
import { reportAnalysisSpec } from '@/lib/engines/nav2/analysisSpec';
import { schemeBundleCacheKey, schemeBundleCacheParts, type HeldSchemeInput } from '@/lib/engines/nav2/fundAnalyticsReport';
import { invalidateStaleDefinitionEntries, readCachedBundles, writeCachedBundles } from '@/lib/services/investment-intelligence/nav2/nav2ResultCacheStore';
import { createInMemoryDb } from '../support/inMemorySupabase';
import { buildSeries, IDENTITY } from './support/fixtures';

const INSTRUMENT = '11111111-1111-4111-8111-111111111111';
const series = buildSeries(['2025-01-01', '2025-06-01', '2026-01-01'], [100, 110, 125], { identity: { instrumentId: INSTRUMENT } });
const held = { instrumentId: INSTRUMENT, firstHeldDate: '2025-01-01', benchmarks: [], series } as unknown as HeldSchemeInput;
const input = { spec: reportAnalysisSpec('2026-10-03', NAV2_POLICY, 'all_history'), periodChoice: 'all_history' as const, policy: NAV2_POLICY, riskFree: null, displayCurrency: 'INR' as const };
void IDENTITY;

/** The registry is a const object: bump one entry for the duration of `fn`, always restore it. */
function withBump<T>(id: string, fn: () => T): T {
  const entry = (NAV2_METRICS as unknown as Record<string, { version: string }>)[id];
  const before = entry.version;
  entry.version = `${before}-bumped`;
  try {
    return fn();
  } finally {
    entry.version = before;
  }
}

/** The key as it was BEFORE the fix: engine, report and spec only. */
function legacyKey(): string {
  const parts = schemeBundleCacheParts(input, held);
  const [engine, report, spec] = parts.definitionVersion.split(':');
  return createHash('sha256').update(`${engine}:${report}:${spec}:${parts.navSeriesChecksum}`).digest('hex');
}

describe('the bundle key changes when ANY metric definition changes (spec 12.2)', () => {
  const base = schemeBundleCacheKey(input, held);
  const ids = Object.keys(NAV2_METRICS);

  it('NC-K1: every metric in the register, bumped on its own, changes the key; the old composition would not have', () => {
    expect(ids.length).toBeGreaterThanOrEqual(15);
    const legacyBase = legacyKey();
    for (const id of ids) {
      const bumped = withBump(id, () => schemeBundleCacheKey(input, held));
      expect(bumped, `${id}: key unchanged after a definition bump`).not.toBe(base);
      // the defect: the old key (engine:report:spec + NAV checksum) is identical before and after the bump
      expect(withBump(id, legacyKey), `${id}: legacy key`).toBe(legacyBase);
    }
  });

  it('the two metrics fixed on 05-10-2026 (cagr, point_to_point) are in the key: the v2 bundle is not the v1 bundle', () => {
    expect(NAV2_METRICS.cagr.version).toBe('nav2-cagr-actual-days-v2');
    const v1 = withBump('cagr', () => schemeBundleCacheKey(input, held));
    expect(v1).not.toBe(base);
  });

  it('NC-K3: an unchanged registry keeps the key (no needless invalidation); a policy value or the spec changes it', () => {
    expect(schemeBundleCacheKey(input, held)).toBe(base);
    const policy = { ...NAV2_POLICY, cagrMinDays: NAV2_POLICY.cagrMinDays + 1 };
    expect(schemeBundleCacheKey({ ...input, policy }, held)).not.toBe(base);
    expect(schemeBundleCacheKey({ ...input, spec: { ...input.spec, asOfDate: '2026-10-04' } }, held)).not.toBe(base);
  });

  it('the definition version has five parts, the fourth being the registry digest', () => {
    const dv = schemeBundleCacheParts(input, held).definitionVersion;
    expect(dv.split(':')).toHaveLength(5);
    expect(registryDigestOf(dv)).toBe(metricRegistryDigest(NAV2_METRICS));
  });
});

describe('a bundle computed under definition v1 is not returned after a bump, even with an identical NAV checksum (NC-K2)', () => {
  it('stores under v1, bumps, reads with the new key: nothing comes back; the old key still reads (the entry is intact, just unreachable)', async () => {
    const db = createInMemoryDb({ strictSchema: true });
    db.reset({ nav2_result_cache: [] });
    const admin = db.client as unknown as SupabaseClient;
    const payload = { sentinel: 'computed under v1' } as never;
    const oldParts = schemeBundleCacheParts(input, held);
    const oldKey = schemeBundleCacheKey(input, held);
    expect(await writeCachedBundles(admin, [{ key: oldKey, parts: oldParts, payload }])).toBe(1);
    expect((await readCachedBundles(admin, [oldKey])).size).toBe(1);

    const newKey = withBump('cagr', () => schemeBundleCacheKey(input, held));
    expect(newKey).not.toBe(oldKey);
    expect(series.checksum).toBe(oldParts.navSeriesChecksum); // the NAV checksum is identical
    expect((await readCachedBundles(admin, [newKey])).size).toBe(0);
  });
});

describe('an invalidated key can be cached again once its inputs are current (NC-K6, Stage 3 finding)', () => {
  it('correction then revert: the entry the worker invalidated is refreshed and valid again, never blocked by its own stale row', async () => {
    const db = createInMemoryDb({ strictSchema: true });
    db.reset({ nav2_result_cache: [] });
    const admin = db.client as unknown as SupabaseClient;
    const parts = schemeBundleCacheParts(input, held);
    const key = schemeBundleCacheKey(input, held);
    expect(await writeCachedBundles(admin, [{ key, parts, payload: { sentinel: 'first computation' } as never }])).toBe(1);
    // the correction worker invalidates it (a NAV correction touched its inputs after it was computed)
    for (const r of db.tables.nav2_result_cache) r.invalidated_at = '2026-10-05T12:00:00.000Z';
    expect((await readCachedBundles(admin, [key])).size).toBe(0);
    // the same key is computed again (same inputs, e.g. after the correction was reverted) and stored
    await writeCachedBundles(admin, [{ key, parts, payload: { sentinel: 'recomputed' } as never }]);
    const back = await readCachedBundles(admin, [key]);
    expect(back.size).toBe(1);
    expect((back.get(key) as unknown as { sentinel: string }).sentinel).toBe('recomputed');
    expect(db.tables.nav2_result_cache).toHaveLength(1); // still ONE row per key
  });

  it('a VALID entry is left exactly as it is (same key = same inputs = same payload; nothing is rewritten)', async () => {
    const db = createInMemoryDb({ strictSchema: true });
    db.reset({ nav2_result_cache: [] });
    const admin = db.client as unknown as SupabaseClient;
    const parts = schemeBundleCacheParts(input, held);
    const key = schemeBundleCacheKey(input, held);
    await writeCachedBundles(admin, [{ key, parts, payload: { sentinel: 'original' } as never }]);
    await writeCachedBundles(admin, [{ key, parts, payload: { sentinel: 'must not replace a valid entry' } as never }]);
    expect(((await readCachedBundles(admin, [key])).get(key) as unknown as { sentinel: string }).sentinel).toBe('original');
  });
});

describe('the correction worker invalidates by definition version too (NC-K4)', () => {
  const entry = (key: string, definitionVersion: string): Record<string, unknown> => ({ cache_key: key, instrument_id: INSTRUMENT, metric_id: 'scheme_performance_bundle', policy_version: NAV2_POLICY.version, definition_version: definitionVersion, actual_end: '2026-10-02', benchmark_id: null, risk_free_dataset_id: null, invalidated_at: null });
  const current = schemeBundleCacheParts(input, held).definitionVersion;
  const stale = withBump('cagr', () => schemeBundleCacheParts(input, held).definitionVersion);

  it('another registry and the OLD key format are invalidated; the current entry is not', async () => {
    const db = createInMemoryDb({ strictSchema: true });
    db.reset({ nav2_result_cache: [entry('cur', current), entry('v1', stale), entry('old-format', 'nav2-engine-v1:nav2-fund-analytics-report-v1:abcdef012345')] });
    const n = await invalidateStaleDefinitionEntries(db.client as unknown as SupabaseClient, metricRegistryDigest(NAV2_METRICS), '2026-10-06T00:00:00.000Z');
    expect(n).toBe(2);
    const rows = db.tables.nav2_result_cache;
    expect(rows.find((r) => r.cache_key === 'cur')?.invalidated_at).toBeNull();
    expect(rows.find((r) => r.cache_key === 'v1')?.invalidated_at).toBe('2026-10-06T00:00:00.000Z');
    expect(rows.find((r) => r.cache_key === 'old-format')?.invalidated_at).toBe('2026-10-06T00:00:00.000Z');
    // idempotent
    expect(await invalidateStaleDefinitionEntries(db.client as unknown as SupabaseClient, metricRegistryDigest(NAV2_METRICS))).toBe(0);
  });

  it('the pure selector treats the composite the same way (definition_change event)', () => {
    const meta = (key: string, dv: string): CachedResultMeta => ({ key, family: 'scheme_performance', scopeHash: null, instrumentId: INSTRUMENT, metricId: 'scheme_performance_bundle', policyVersion: NAV2_POLICY.version, definitionVersion: dv, actualEnd: null, benchmarkId: null, riskFreeDatasetId: null });
    expect(selectInvalidated([meta('cur', current), meta('v1', stale), meta('old', 'a:b:c')], { kind: 'definition_change', currentRegistryDigest: metricRegistryDigest(NAV2_METRICS) })).toEqual(['old', 'v1']);
  });

  it('NC-K4: bundleDefinitionVersion with only engine, report and spec (the old shape) has no registry part, so it is stale by definition', () => {
    expect(registryDigestOf('nav2-engine-v1:nav2-fund-analytics-report-v1:abcdef012345')).toBeNull();
    expect(registryDigestOf(bundleDefinitionVersion({ engineVersion: 'e', reportVersion: 'r', specDigest: 's', registryDigest: 'reg', policyDigest: 'p' }))).toBe('reg');
  });
});

describe('the report manifest carries the ordered metric-definition list (NC-K5)', () => {
  it('lists every metric definition sorted by id, with the digest that is part of every bundle key', async () => {
    const src = (await import('node:fs')).readFileSync(new URL('../../../lib/engines/nav2/fundAnalyticsReport.ts', import.meta.url), 'utf8');
    expect(src).toContain('metricDefinitions: Object.values(NAV2_METRICS)');
    expect(src).toContain('metricRegistryDigest: metricRegistryDigest(NAV2_METRICS)');
    expect(src).toContain('.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))');
  });
});
