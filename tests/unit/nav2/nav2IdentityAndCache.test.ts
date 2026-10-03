// NAV2 Stage 1 -- Fixture E (identity safety against the EXISTING resolver) and
// Fixture D (correction -> cache keys and invalidation), plus the privacy rules
// for cache keys (spec 12.2, 14).
//
// Matrix rows: 5 (unresolved scheme -> reconciliation, not a guessed mapping),
// 6 (direct / regular and growth / IDCW never cross), 9, 40 (key level: a corrected
// NAV can never be served from a stale key), 44 (key / plan privacy, pure part).
//
// NAMED NEGATIVE CONTROLS
//   NC-E1  four deceptively similar plan / option variants of one fund name resolve to exactly the
//          requested variant, and a statement that does not say which variant it is stays unresolved
//          (never "the first of four");
//   NC-E2  a renamed fund is matched by its identifier, never by a similar name, and a new name with no
//          identifier is NOT fuzzily joined to the old one;
//   NC-E3  an ISIN that matches nothing is unresolved; an ISIN held by two instruments is ambiguous;
//   NC-E4  a typo / respacing of the name does not match (no fuzzy matching);
//   NC-C1  a corrected NAV changes the series checksum, hence the cache key: the old entry cannot be served;
//   NC-C2  invalidation touches only the corrected scheme (and only results that could have used that date);
//   NC-C3  a user's id never appears in a key; scheme-performance keys carry no scope at all.
import { describe, expect, it } from 'vitest';
import { NAV2_METRICS, NAV2_POLICY } from '@/lib/config/nav2/metricPolicy';
import { buildResultCacheKey, scopeHash, selectInvalidated, type CachedResultMeta, type ResultCacheKeyParts } from '@/lib/engines/nav2/cacheKeys';
import { resolveScheme, type ExistingInstrumentForResolution, type SchemeResolutionQuery } from '@/lib/services/investment-intelligence/schemeResolution';
import { prepareSeries, type RawNavRow } from '@/lib/engines/nav2/series';
import { absoluteReturn } from '@/lib/engines/nav2/schemeReturns';
import { buildSeries, ctxInr, IDENTITY, rowsFor, weekdays } from './support/fixtures';

// ---------------------------------------------------------------------------
// Fixture E
// ---------------------------------------------------------------------------
const AMC = 'ABC AMC';
const variant = (id: string, plan: 'direct' | 'regular', option: 'growth' | 'idcw', isin: string, amfi: string): ExistingInstrumentForResolution => ({
  instrumentId: id,
  isin,
  amfiSchemeCode: amfi,
  internalProvisionalCode: null,
  normalisedSchemeName: 'abc flexi cap fund',
  amcName: AMC,
  planType: plan,
  optionType: option,
  countryCode: 'IN',
});
const EXISTING: ExistingInstrumentForResolution[] = [
  variant('abc-direct-growth', 'direct', 'growth', 'INF000A01001', '100001'),
  variant('abc-regular-growth', 'regular', 'growth', 'INF000A01002', '100002'),
  variant('abc-direct-idcw', 'direct', 'idcw', 'INF000A01003', '100003'),
  variant('abc-regular-idcw', 'regular', 'idcw', 'INF000A01004', '100004'),
  { instrumentId: 'xyz-renamed', isin: 'INF000X01001', amfiSchemeCode: '200001', internalProvisionalCode: null, normalisedSchemeName: 'xyz opportunities fund', amcName: 'XYZ AMC', planType: 'direct', optionType: 'growth', countryCode: 'IN' },
  { instrumentId: 'xyz-merged-predecessor', isin: 'INF000X01099', amfiSchemeCode: '200099', internalProvisionalCode: null, normalisedSchemeName: 'xyz legacy fund', amcName: 'XYZ AMC', planType: 'direct', optionType: 'growth', countryCode: 'IN' },
];
const query = (over: Partial<SchemeResolutionQuery>): SchemeResolutionQuery => ({
  isin: null,
  amfiSchemeCode: null,
  internalProvisionalCode: null,
  normalisedSchemeName: 'abc flexi cap fund',
  amcName: AMC,
  planType: 'direct',
  optionType: 'growth',
  countryCode: 'IN',
  ...over,
});

describe('Fixture E -- scheme identity fails closed (matrix 5, 6)', () => {
  it('NC-E1: by name + plan + option, each of the four variants resolves to exactly itself', () => {
    const expected: Array<['direct' | 'regular', 'growth' | 'idcw', string]> = [
      ['direct', 'growth', 'abc-direct-growth'],
      ['regular', 'growth', 'abc-regular-growth'],
      ['direct', 'idcw', 'abc-direct-idcw'],
      ['regular', 'idcw', 'abc-regular-idcw'],
    ];
    for (const [plan, option, id] of expected) {
      const r = resolveScheme(query({ planType: plan, optionType: option }), EXISTING, []);
      expect(r, `${plan}/${option}`).toMatchObject({ kind: 'resolved', instrumentId: id, matchedVia: 'normalised_name' });
    }
  });

  it('NC-E1: a statement that does not say the plan or option stays UNRESOLVED (reconciliation), never the first of four', () => {
    const r = resolveScheme(query({ planType: 'not_applicable', optionType: 'not_applicable' }), EXISTING, []);
    expect(r.kind).toBe('unresolved');
    const partial = resolveScheme(query({ planType: 'direct', optionType: 'not_applicable' }), EXISTING, []);
    expect(partial.kind).toBe('unresolved');
  });

  it('an exact AMFI scheme code resolves to that instrument only; an exact ISIN to that instrument only (no cross-series)', () => {
    expect(resolveScheme(query({ amfiSchemeCode: '100003', planType: 'not_applicable', optionType: 'not_applicable' }), EXISTING, [])).toMatchObject({ kind: 'resolved', instrumentId: 'abc-direct-idcw', matchedVia: 'amfi_scheme_code' });
    expect(resolveScheme(query({ isin: 'INF000A01002', planType: 'not_applicable', optionType: 'not_applicable' }), EXISTING, [])).toMatchObject({ kind: 'resolved', instrumentId: 'abc-regular-growth', matchedVia: 'isin' });
  });

  it('NC-E2: a renamed fund resolves by its identifier; the new name with NO identifier is not fuzzily joined to the old one', () => {
    const byIsin = resolveScheme(query({ isin: 'INF000X01001', normalisedSchemeName: 'xyz growth opportunities fund', amcName: 'XYZ AMC' }), EXISTING, []);
    expect(byIsin).toMatchObject({ kind: 'resolved', instrumentId: 'xyz-renamed', matchedVia: 'isin' });
    const byNameOnly = resolveScheme(query({ normalisedSchemeName: 'xyz growth opportunities fund', amcName: 'XYZ AMC' }), EXISTING, []);
    expect(byNameOnly.kind).toBe('unresolved');
  });

  it('a merged-away predecessor is a different instrument: its identifiers never resolve to the surviving scheme', () => {
    const r = resolveScheme(query({ isin: 'INF000X01099', normalisedSchemeName: 'xyz opportunities fund', amcName: 'XYZ AMC' }), EXISTING, []);
    expect(r).toMatchObject({ kind: 'resolved', instrumentId: 'xyz-merged-predecessor' });
    expect(r.kind === 'resolved' && r.instrumentId).not.toBe('xyz-renamed');
  });

  it('NC-E3: an unresolved ISIN with no other match is unresolved, and an ISIN held by two instruments is ambiguous', () => {
    expect(resolveScheme(query({ isin: 'INF999Z99999', normalisedSchemeName: 'some other fund', amcName: 'Other AMC' }), EXISTING, []).kind).toBe('unresolved');
    const dup = [...EXISTING, { ...variant('abc-dup', 'direct', 'growth', 'INF000A01001', '777777') }];
    const r = resolveScheme(query({ isin: 'INF000A01001' }), dup, []);
    expect(r.kind).toBe('ambiguous');
    expect(r.kind === 'ambiguous' && [...r.candidateInstrumentIds].sort()).toEqual(['abc-dup', 'abc-direct-growth'].sort());
  });

  it('NC-E4: a typo or re-spacing of the name does not match (deterministic exact normalised-name match only, no fuzzy matching)', () => {
    expect(resolveScheme(query({ normalisedSchemeName: 'abc flexicap fund' }), EXISTING, []).kind).toBe('unresolved');
    expect(resolveScheme(query({ normalisedSchemeName: 'abc flexi cap' }), EXISTING, []).kind).toBe('unresolved');
  });

  it('FINDING NAV2-F1 (characterisation, decision for the PO): when the ISIN and the AMFI code point at DIFFERENT instruments the resolver silently takes the ISIN match', () => {
    // Spec 4.3 orders AMFI code first and demands fail-closed behaviour on ambiguity. The existing resolver (R2) tries the ISIN first
    // and never checks that the AMFI code agrees. Here a statement line carrying the direct-growth ISIN and the REGULAR-growth AMFI
    // code resolves to the direct-growth fund with full confidence. If this changes (a cross-check that returns `ambiguous`), update
    // this test deliberately: it exists so the behaviour is not forgotten.
    const r = resolveScheme(query({ isin: 'INF000A01001', amfiSchemeCode: '100002', planType: 'not_applicable', optionType: 'not_applicable' }), EXISTING, []);
    expect(r).toMatchObject({ kind: 'resolved', instrumentId: 'abc-direct-growth', matchedVia: 'isin', confidence: 1 });
  });
});

describe('Fixture E -- no cross-series contamination at series level (matrix 6)', () => {
  it('the direct-growth series is built only from direct-growth rows: the regular, IDCW and predecessor rows are rejected and counted', () => {
    const dates = weekdays('2025-01-06', 5);
    const rows: RawNavRow[] = [
      ...rowsFor('abc-direct-growth', dates, [100, 101, 102, 103, 104]),
      ...rowsFor('abc-regular-growth', dates, [90, 91, 92, 93, 94]),
      ...rowsFor('abc-direct-idcw', dates, [40, 41, 42, 43, 44]),
      ...rowsFor('abc-regular-idcw', dates, [30, 31, 32, 33, 34]),
    ];
    const s = prepareSeries({ identity: { ...IDENTITY, instrumentId: 'abc-direct-growth' }, asOfDate: '2026-10-03', rows }, NAV2_POLICY);
    expect(s.observations.map((o) => o.value)).toEqual([100, 101, 102, 103, 104]);
    expect(s.rejected.foreign_instrument).toBe(15);
    const r = absoluteReturn(s, ctxInr(), dates[0], dates[4]);
    expect(r.state === 'available' && r.value.absoluteReturn).toBeCloseTo(0.04, 14); // 104 / 100 - 1, none of the other variants' levels leaked in
  });
});

// ---------------------------------------------------------------------------
// Fixture D -- keys and invalidation
// ---------------------------------------------------------------------------
const PARTS: ResultCacheKeyParts = {
  scopeId: 'household-1',
  instrumentId: 'inst-a',
  metricId: 'cagr',
  definitionVersion: NAV2_METRICS.cagr.version,
  policyVersion: NAV2_POLICY.version,
  requested: { start: '2024-01-05', end: '2025-01-05' },
  actual: { start: '2024-01-05', end: '2025-01-05' },
  navSeriesChecksum: 'sum-1',
  benchmarkId: null,
  benchmarkDatasetVersion: null,
  riskFreeDatasetId: null,
  riskFreeDatasetVersion: null,
  transactionVersion: 'txn-1',
  currency: 'INR',
};

describe('result cache keys (spec 12.2, 14)', () => {
  it('stable for equal inputs and different when ANY input changes (every provenance field is part of the key)', () => {
    const k = buildResultCacheKey(PARTS);
    expect(buildResultCacheKey({ ...PARTS })).toBe(k);
    const variants: Array<Partial<ResultCacheKeyParts>> = [
      { scopeId: 'household-2' },
      { instrumentId: 'inst-b' },
      { metricId: 'absolute_return' },
      { definitionVersion: 'cagr-other' },
      { policyVersion: 'nav2-policy-v2' },
      { requested: { start: '2024-01-06', end: '2025-01-05' } },
      { actual: { start: '2024-01-05', end: '2025-01-04' } },
      { navSeriesChecksum: 'sum-2' },
      { benchmarkId: 'bm-1' },
      { benchmarkDatasetVersion: 'v2' },
      { riskFreeDatasetId: 'RBI_91D_TBILL_CUTOFF_YIELD' },
      { riskFreeDatasetVersion: 'v9' },
      { transactionVersion: 'txn-2' },
      { currency: 'AUD' },
    ];
    for (const v of variants) expect(buildResultCacheKey({ ...PARTS, ...v }), JSON.stringify(v)).not.toBe(k);
  });

  it('NC-C3: the user / household id never appears in a key; a scheme-performance key (no scope) is identical for every user', () => {
    expect(buildResultCacheKey(PARTS)).not.toContain('household-1');
    expect(scopeHash('household-1')).toMatch(/^[0-9a-f]{32}$/);
    expect(scopeHash('household-1')).not.toContain('household');
    const shared = { ...PARTS, scopeId: null, transactionVersion: null };
    expect(buildResultCacheKey(shared)).toBe(buildResultCacheKey({ ...shared }));
    expect(scopeHash(null)).toBeNull();
    // an investor-experience key differs per household
    expect(buildResultCacheKey({ ...PARTS, scopeId: 'household-1' })).not.toBe(buildResultCacheKey({ ...PARTS, scopeId: 'household-2' }));
  });

  it('NC-C1 / matrix 9, 40: a corrected NAV changes the series checksum, so the key changes and the pre-correction entry cannot be served', () => {
    const id = IDENTITY.instrumentId;
    const dates = weekdays('2025-01-06', 5);
    const original: RawNavRow = { id: 'r1', instrumentId: id, priceDate: dates[4], price: 105, currencyCode: 'INR' };
    const corrected: RawNavRow = { id: 'r1c', instrumentId: id, priceDate: dates[4], price: 104, currencyCode: 'INR', correctionOfId: 'r1' };
    const base = rowsFor(id, dates.slice(0, 4), [100, 102, 101, 103]);
    const before = prepareSeries({ identity: IDENTITY, asOfDate: '2026-10-03', rows: [...base, original] }, NAV2_POLICY);
    const after = prepareSeries({ identity: IDENTITY, asOfDate: '2026-10-03', rows: [...base, original, corrected] }, NAV2_POLICY);
    const cache = new Map<string, string>();
    const keyFor = (checksum: string) => buildResultCacheKey({ ...PARTS, scopeId: null, transactionVersion: null, navSeriesChecksum: checksum });
    cache.set(keyFor(before.checksum), 'result computed from NAV 105');
    // the dependent figure is requested again after the correction: a MISS (no stale value is served), without any explicit invalidation having run
    expect(cache.has(keyFor(after.checksum))).toBe(false);
    expect(cache.get(keyFor(before.checksum))).toBe('result computed from NAV 105'); // the old entry is only reachable by the OLD checksum
  });
});

describe('invalidation selects only what a change can affect (matrix 9, 40)', () => {
  const meta = (key: string, over: Partial<CachedResultMeta> = {}): CachedResultMeta => ({
    key,
    family: 'scheme_performance',
    scopeHash: null,
    instrumentId: 'inst-a',
    metricId: 'cagr',
    policyVersion: NAV2_POLICY.version,
    definitionVersion: NAV2_METRICS.cagr.version,
    actualEnd: '2025-03-31',
    benchmarkId: null,
    riskFreeDatasetId: null,
    ...over,
  });
  const H1 = scopeHash('household-1');
  const H2 = scopeHash('household-2');
  const entries: CachedResultMeta[] = [
    meta('A-recent'),
    meta('A-old-window', { actualEnd: '2025-01-05' }),
    meta('A-open-end', { actualEnd: null }),
    meta('B', { instrumentId: 'inst-b' }),
    meta('A-investor-h1', { family: 'investor_experience', scopeHash: H1, metricId: 'xirr' }),
    meta('A-investor-h2', { family: 'investor_experience', scopeHash: H2, metricId: 'xirr' }),
    meta('B-investor-h1', { family: 'investor_experience', scopeHash: H1, instrumentId: 'inst-b', metricId: 'xirr' }),
    meta('A-beta', { metricId: 'beta', benchmarkId: 'bm-1', riskFreeDatasetId: null }),
    meta('A-sharpe', { metricId: 'sharpe_ratio', riskFreeDatasetId: 'RBI_91D_TBILL_CUTOFF_YIELD' }),
    meta('A-stale-policy', { policyVersion: 'nav2-policy-v0' }),
  ];

  it('NC-C2: a NAV correction on scheme A for 10-01-2025 hits only A\'s results that could have used that date (recent, open-ended, investor, beta, Sharpe) -- not B, not a window that ended before it', () => {
    const hit = selectInvalidated(entries, { kind: 'nav_correction', instrumentId: 'inst-a', date: '2025-01-10' });
    expect(hit).toEqual(['A-beta', 'A-investor-h1', 'A-investor-h2', 'A-open-end', 'A-recent', 'A-sharpe', 'A-stale-policy']);
    expect(hit).not.toContain('B');
    expect(hit).not.toContain('B-investor-h1');
    expect(hit).not.toContain('A-old-window');
  });

  it('a benchmark correction hits only results built on that benchmark; a risk-free correction only those on that dataset', () => {
    expect(selectInvalidated(entries, { kind: 'benchmark_correction', benchmarkId: 'bm-1', date: '2025-02-01' })).toEqual(['A-beta']);
    expect(selectInvalidated(entries, { kind: 'benchmark_correction', benchmarkId: 'bm-other', date: '2025-02-01' })).toEqual([]);
    expect(selectInvalidated(entries, { kind: 'risk_free_correction', datasetId: 'RBI_91D_TBILL_CUTOFF_YIELD', date: '2025-02-01' })).toEqual(['A-sharpe']);
  });

  it('a transaction change touches only that household\'s investor-experience results for that scheme: never scheme performance, never another household or scheme', () => {
    expect(selectInvalidated(entries, { kind: 'transaction_change', scopeHash: H1!, instrumentId: 'inst-a' })).toEqual(['A-investor-h1']);
    expect(selectInvalidated(entries, { kind: 'transaction_change', scopeHash: H2!, instrumentId: 'inst-b' })).toEqual([]);
  });

  it('a policy-version change invalidates exactly the results computed under another version', () => {
    expect(selectInvalidated(entries, { kind: 'policy_change', currentPolicyVersion: NAV2_POLICY.version })).toEqual(['A-stale-policy']);
    expect(selectInvalidated(entries, { kind: 'policy_change', currentPolicyVersion: 'nav2-policy-v2' })).toHaveLength(entries.length);
  });

  it('the series fixture builder agrees: a series built on an unrelated scheme is unchanged by the correction (unrelated schemes do not recalculate)', () => {
    const a1 = buildSeries(weekdays('2025-01-06', 5), [100, 102, 101, 103, 105]);
    const a2 = buildSeries(weekdays('2025-01-06', 5), [100, 102, 101, 103, 104]);
    const other1 = buildSeries(weekdays('2025-01-06', 5), [50, 51, 52, 53, 54], { identity: { instrumentId: 'inst-b' } });
    const other2 = buildSeries(weekdays('2025-01-06', 5), [50, 51, 52, 53, 54], { identity: { instrumentId: 'inst-b' } });
    expect(a1.checksum).not.toBe(a2.checksum);
    expect(other1.checksum).toBe(other2.checksum);
  });
});
