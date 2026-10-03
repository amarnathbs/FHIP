// CATEGORY REFERENCE benchmark: the table, the resolver, the read-time loader, and every surface it reaches.
// EVIDENCE LABEL: code-level unit tests with the in-memory Supabase fake. The category table is UNVERIFIED
// (AMFI's own list could not be read); these tests pin what the table SAYS and that nothing it produces can
// be stored, proposed or auto-published or shown without the existing gates. Nothing here was seen in a
// browser and nothing ran against DEV or PROD.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  CATEGORY_REFERENCE_KIND,
  CATEGORY_REFERENCE_TABLE,
  DECLARED_BENCHMARK_LABEL,
  NO_CATEGORY_BENCHMARK_MESSAGE,
  categoryReferenceBasisLabel,
  categoryReferenceFor,
  resolveFundCategory,
} from '@/lib/services/investment-intelligence/benchmarkData/categoryReference';
import { loadCategoryReferenceMappings } from '@/lib/services/investment-intelligence/benchmarkData/categoryReferenceLoader';
import { compareHoldingToBenchmark, declaredWins, type BenchmarkSegmentInput } from '@/lib/engines/investment-intelligence/holdingBenchmarkComparison';
import { loadHoldingsTable } from '@/lib/services/investment-intelligence/holdingsRepository';
import { loadAnalyticsDataset } from '@/lib/services/investment-intelligence/analyticsRepository';
import { runAnalytics } from '@/lib/engines/investment-intelligence/analyticsOrchestrator';
import { detectBenchmarkUnderperformance } from '@/lib/engines/investment-intelligence/reviewCentre';
import { makeFakeSupabase } from './support/fakeSupabaseClient';

const ROOT = path.resolve(__dirname, '..', '..');
const LABEL = (c: string) => `Compared with the usual benchmark for ${c} funds (not this fund's own declared benchmark)`;

describe('the table (UNVERIFIED; pinned so a silent edit is caught)', () => {
  const pinned: Array<[string, string]> = [
    ['large_cap', 'IN_NIFTY_100_TRI'],
    ['mid_cap', 'IN_NIFTY_MIDCAP_150_TRI'],
    ['small_cap', 'IN_BSE_250_SMALLCAP_TRI'],
    ['large_mid_cap', 'IN_NIFTY_LARGEMIDCAP_250_TRI'],
    ['flexi_cap', 'IN_NIFTY_500_TRI'],
    ['multi_cap', 'IN_NIFTY_500_TRI'],
    ['elss', 'IN_NIFTY_500_TRI'],
    ['focused', 'IN_NIFTY_500_TRI'],
    ['value', 'IN_NIFTY_500_TRI'],
    ['contra', 'IN_NIFTY_500_TRI'],
    ['balanced_advantage', 'IN_NIFTY50_HYBRID_COMP_DEBT_5050_TRI'],
    ['aggressive_hybrid', 'IN_NIFTY50_HYBRID_COMP_DEBT_5050_TRI'],
    ['corporate_bond', 'IN_NIFTY_CORPORATE_BOND_A2_TRI'],
    ['infrastructure', 'IN_NIFTY_INFRASTRUCTURE_TRI'],
    ['mnc', 'IN_NIFTY_MNC_TRI'],
  ];
  it('maps exactly the agreed categories to the agreed catalogue series', () => {
    expect(CATEGORY_REFERENCE_TABLE.map((r) => [r.key, r.benchmarkKey])).toEqual(pinned);
  });
  it('every series named exists in the seeded catalogue manifest, every row is marked UNVERIFIED and carries a rationale', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/investment-intelligence/bench1_phase2/catalogue_manifest.json'), 'utf8')) as { entries: Array<{ benchmark_key: string }> };
    const keys = new Set(manifest.entries.map((e) => e.benchmark_key));
    for (const r of CATEGORY_REFERENCE_TABLE) {
      expect(keys.has(r.benchmarkKey), r.key).toBe(true);
      expect(r.status).toBe('UNVERIFIED');
      expect(r.rationale.length).toBeGreaterThan(20);
    }
  });
});

describe('resolving a fund\'s category', () => {
  it.each([
    ['Large Cap Fund', 'large_cap'], ['Mid Cap Fund', 'mid_cap'], ['Small Cap Fund', 'small_cap'], ['Large & Mid Cap Fund', 'large_mid_cap'],
    ['Flexi Cap Fund', 'flexi_cap'], ['Multi Cap Fund', 'multi_cap'], ['ELSS', 'elss'], ['Focused Fund', 'focused'], ['Value Fund', 'value'], ['Contra Fund', 'contra'],
    ['Dynamic Asset Allocation or Balanced Advantage', 'balanced_advantage'], ['Aggressive Hybrid Fund', 'aggressive_hybrid'], ['Corporate Bond Fund', 'corporate_bond'],
  ])('%s -> %s', (sub, key) => {
    expect(resolveFundCategory({ subCategory: sub })).toMatchObject({ key, source: 'scheme_master' });
  });

  it('a sectoral fund is placed by its NAME (infrastructure / power / MNC); another sectoral fund gets none', () => {
    expect(resolveFundCategory({ subCategory: 'Sectoral Fund', instrumentName: 'RMFPSGPG-NIPPON INDIA POWER & INFRA FUND - GROWTH PLAN (Non Demat)' }).key).toBe('infrastructure');
    expect(resolveFundCategory({ subCategory: 'Sectoral/ Thematic', instrumentName: '108MFGPG-UTI MNC Fund - Regular Plan (Non Demat)' }).key).toBe('mnc');
    expect(resolveFundCategory({ subCategory: 'Sectoral Fund', instrumentName: 'Some Pharma Opportunities Fund' }).key).toBeNull();
  });

  it('the section header is used when the sub-category is empty; the name only when both are', () => {
    expect(resolveFundCategory({ subCategory: null, categoryHeaderRaw: 'Open Ended Schemes(Equity Scheme - Mid Cap Fund)' })).toMatchObject({ key: 'mid_cap', source: 'category_header' });
    expect(resolveFundCategory({ subCategory: null, categoryHeaderRaw: null, instrumentName: 'K123-Kotak Mid Cap Fund Regular Growth (Non-Demat)' })).toMatchObject({ key: 'mid_cap', source: 'name_inference' });
  });

  it('the scheme-master category is authoritative: a "Large Cap" NAME with a Contra master category is Contra, not Large Cap', () => {
    expect(resolveFundCategory({ subCategory: 'Contra Fund', instrumentName: 'Some Large Cap Opportunities Fund' }).key).toBe('contra');
  });
});

describe('RULE: a category with no honest equivalent gets NO benchmark and says so (named negative controls)', () => {
  it.each([
    ['FoF Domestic', 'HDFC Gold ETF Fund of Fund - Regular Plan - Growth'],
    ['Multi Asset Allocation', 'SBI Multi Asset Allocation Fund'],
    ['FoF Overseas', 'Some Overseas FoF'],
    ['Index Funds', 'Some Nifty Index Fund'],
    ['Other ETFs', 'Some ETF'],
    ['Liquid Fund', 'Some Liquid Fund'],
    ['Money Market Fund', 'Some Money Market Fund'],
    ['Gilt Fund', 'Some Gilt Fund'],
    ['Ultra Short Duration Fund', 'Some Duration Fund'],
    ['Dividend Yield Fund', 'ICICI Prudential Dividend Yield Fund'],
    ['Conservative Hybrid Fund', 'Some Conservative Hybrid Fund'],
    ['Retirement Fund', 'Some Retirement Fund'],
    ['Arbitrage Fund', 'Some Arbitrage Fund'],
    ['Sectoral Fund', 'Some Pharma Fund'],
  ])('%s -> none', (sub, name) => {
    const r = categoryReferenceFor({ subCategory: sub, instrumentName: name });
    expect(r.state).toBe('none');
    if (r.state === 'none') expect(r.message).toContain(NO_CATEGORY_BENCHMARK_MESSAGE);
  });
  it('a name that merely CONTAINS a supported word is not enough when the master category says otherwise (an infrastructure index fund is an index fund)', () => {
    expect(categoryReferenceFor({ subCategory: 'Index Funds', instrumentName: 'Nifty Infrastructure Index Fund' }).state).toBe('none');
    expect(categoryReferenceFor({ subCategory: null, categoryHeaderRaw: null, instrumentName: 'Nifty Infrastructure Index Fund' }).state).toBe('none');
  });
  it('CONTROL: a doctored table that adds a gold row WOULD give one, so the shipped table is what withholds it', () => {
    const doctored = [...CATEGORY_REFERENCE_TABLE];
    expect(categoryReferenceFor({ subCategory: 'Large Cap Fund' }, doctored).state).toBe('available');
    expect(categoryReferenceFor({ subCategory: 'FoF Domestic', instrumentName: 'Gold FoF' }, doctored).state).toBe('none');
  });
});

describe('labels', () => {
  it('the wording is exact', () => {
    expect(categoryReferenceBasisLabel('Large Cap')).toBe(LABEL('Large Cap'));
    expect(DECLARED_BENCHMARK_LABEL).toBe("Fund's declared benchmark");
    const r = categoryReferenceFor({ subCategory: 'Large Cap Fund' });
    expect(r).toMatchObject({ state: 'available', kind: 'category_reference', basisLabel: LABEL('Large Cap'), benchmarkKey: 'IN_NIFTY_100_TRI' });
  });
});

// ---- the loader (read time; writes nothing) --------------------------------------------------------
const USER = 'user-1';
const BM = { large: 'bm-nifty100', midcap: 'bm-midcap150' };
const bmRow = (id: string, key: string, label: string, over: Record<string, unknown> = {}) => ({ id, benchmark_key: key, benchmark_label: label, return_type: 'TRI', lifecycle_status: 'active', catalogue_status: 'verified', ...over });
function world(over: Record<string, unknown[]> = {}) {
  return {
    ii_scheme_master: [{ instrument_id: 'i1', sub_category: 'Large Cap Fund', category_header_raw: 'Open Ended Schemes(Equity Scheme - Large Cap Fund)', effective_to: null }],
    ii_instruments: [{ id: 'i1', instrument_name: 'Test Large Cap Fund', base_currency: 'INR', country_of_domicile: 'IN', isin: 'INF000000001' }],
    ii_benchmarks: [bmRow(BM.large, 'IN_NIFTY_100_TRI', 'NIFTY 100 TRI'), bmRow(BM.midcap, 'IN_NIFTY_MIDCAP_150_TRI', 'Nifty Midcap 150 TRI')],
    ...over,
  };
}

describe('the loader', () => {
  const load = async (t: Record<string, unknown[]>, ids = ['i1'], declared: string[] = []) => {
    const h = makeFakeSupabase(t as never);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await loadCategoryReferenceMappings(h.client as any, ids, new Set(declared));
    return { out, writes: h.writes };
  };

  it('resolves the series by catalogue key and returns an IN-MEMORY mapping of kind category_reference; it WRITES NOTHING', async () => {
    const { out, writes } = await load(world());
    expect(out.mappings).toHaveLength(1);
    expect(out.mappings[0]).toMatchObject({ instrumentId: 'i1', benchmarkId: BM.large, benchmarkKey: 'IN_NIFTY_100_TRI', basis: CATEGORY_REFERENCE_KIND, categoryLabel: 'Large Cap', basisLabel: LABEL('Large Cap'), effectiveTo: null });
    expect(out.facts.get(BM.large)).toMatchObject({ label: 'NIFTY 100 TRI', catalogueVerified: true });
    expect(writes).toEqual([]);
  });

  it('NEGATIVE CONTROL: a declared mapping ALWAYS wins - an instrument that has one is not given a category reference at all', async () => {
    const withDeclared = await load(world(), ['i1'], ['i1']);
    expect(withDeclared.out.mappings).toEqual([]);
    expect(withDeclared.out.noBenchmark.size).toBe(0);
    const without = await load(world(), ['i1'], []);
    expect(without.out.mappings).toHaveLength(1); // the only difference is the declared mapping
  });

  it('an unsupported category produces no mapping and the explicit message', async () => {
    const { out } = await load(world({ ii_scheme_master: [{ instrument_id: 'i1', sub_category: 'FoF Domestic', category_header_raw: null, effective_to: null }] }));
    expect(out.mappings).toEqual([]);
    expect(out.noBenchmark.get('i1')).toContain('Benchmark not available for this fund category');
  });

  it('a series missing from the catalogue (or inactive) leaves the fund with a named "not in the catalogue" message, never a guess', async () => {
    expect((await load(world({ ii_benchmarks: [] }))).out.noBenchmark.get('i1')).toMatch(/NIFTY 100 TRI: this benchmark is not in the catalogue yet/);
    expect((await load(world({ ii_benchmarks: [bmRow(BM.large, 'IN_NIFTY_100_TRI', 'NIFTY 100 TRI', { lifecycle_status: 'deprecated' })] }))).out.mappings).toEqual([]);
  });

  it('an UNVERIFIED catalogue entry is carried as unverified (the consumers then refuse a figure)', async () => {
    const { out } = await load(world({ ii_benchmarks: [bmRow(BM.large, 'IN_NIFTY_100_TRI', 'NIFTY 100 TRI', { catalogue_status: 'draft' })] }));
    expect(out.facts.get(BM.large)?.catalogueVerified).toBe(false);
  });

  it('a failed read fails closed for every fund (no mapping, explicit message)', async () => {
    const h = makeFakeSupabase(world() as never, 'fail_all');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await loadCategoryReferenceMappings(h.client as any, ['i1'], new Set());
    expect(out.mappings).toEqual([]);
    expect(out.noBenchmark.get('i1')).toContain('Benchmark not available');
  });
});

// ---- engine: declared wins -------------------------------------------------------------------------
const daily = (from: string, to: string, level: (d: number) => number) => {
  const out: Array<{ date: Date; value: number }> = [];
  const t0 = Date.parse(`${from}T00:00:00Z`);
  for (let t = t0, i = 0; t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000, i++) out.push({ date: new Date(t), value: level(i) });
  return out;
};
const SERIES = daily('2023-01-01', '2026-01-10', (i) => 100 + i * 0.05);
const seg = (o: Partial<BenchmarkSegmentInput> = {}): BenchmarkSegmentInput => ({ benchmarkId: 'b', benchmarkKey: 'K', label: 'NIFTY 100 TRI', returnType: 'TRI', effectiveFrom: new Date('1900-01-01'), effectiveTo: null, catalogueVerified: true, entitled: true, series: SERIES, ...o });

describe('engine: declared wins, the label travels, every gate still applies', () => {
  const flows = [{ date: new Date('2024-01-02T00:00:00Z'), amount: -10000 }];
  const base = { flows, terminalValue: 12000, asOfDate: new Date('2026-01-01T00:00:00Z'), currencyCode: 'INR' };

  it('declaredWins drops category segments whenever a declared one exists (NEGATIVE CONTROL: with no declared segment the category segment is used)', () => {
    const cat = seg({ basis: 'category_reference', categoryLabel: 'Large Cap', benchmarkKey: 'CAT' });
    const dec = seg({ basis: 'declared', benchmarkKey: 'DEC' });
    expect(declaredWins([cat, dec]).map((s) => s.benchmarkKey)).toEqual(['DEC']);
    expect(declaredWins([cat]).map((s) => s.benchmarkKey)).toEqual(['CAT']);
    const r = compareHoldingToBenchmark({ ...base, segments: [cat, dec] });
    expect(r.status === 'ok' && r.benchmarkBasis).toBe('declared');
    const r2 = compareHoldingToBenchmark({ ...base, segments: [cat] });
    expect(r2.status === 'ok' && r2.benchmarkBasis).toBe('category_reference');
  });

  it('a figure carries the honest label (category) or "Fund\'s declared benchmark" (declared)', () => {
    const c = compareHoldingToBenchmark({ ...base, segments: [seg({ basis: 'category_reference', categoryLabel: 'Large Cap' })] });
    const d = compareHoldingToBenchmark({ ...base, segments: [seg({ basis: 'declared' })] });
    expect(c.status === 'ok' && c.benchmarkBasisLabel).toBe(LABEL('Large Cap'));
    expect(d.status === 'ok' && d.benchmarkBasisLabel).toBe("Fund's declared benchmark");
  });

  it.each([
    ['no entitlement', { entitled: false, entitlementDetail: 'NIFTY 100 TRI: no approved entitlement covers this benchmark, so no comparison is shown.' }, 'NOT_ENTITLED'],
    ['unverified catalogue entry', { catalogueVerified: false }, 'CATALOGUE_NOT_VERIFIED'],
    ['price index', { returnType: 'PRI' as const }, 'PRICE_INDEX_NOT_TOTAL_RETURN'],
    ['no series', { series: [] }, 'NO_SERIES'],
  ])('NEGATIVE CONTROL (%s): no figure, but the benchmark NAME and the category label are still shown', (_n, over, reason) => {
    const r = compareHoldingToBenchmark({ ...base, segments: [seg({ basis: 'category_reference', categoryLabel: 'Large Cap', ...over })] });
    expect(r).toMatchObject({ status: 'unavailable', reason, benchmarkLabel: 'NIFTY 100 TRI', benchmarkBasis: 'category_reference', benchmarkBasisLabel: LABEL('Large Cap') });
    expect(JSON.stringify(r)).not.toMatch(/holdingReturn|benchmarkReturn|difference|benchmarkEndingValue/);
  });
});

// ---- end to end through the real loaders -----------------------------------------------------------
const BMV = 'bm-nifty100';
const access = (o: Record<string, unknown> = {}) => ({ benchmark_id: BMV, can_calculate: true, can_display: true, can_export: false, data_from: null, data_to: null, ...o });
function e2e(opts: { declared?: boolean; sub?: string; catalogue?: Record<string, unknown>; access?: unknown[]; name?: string } = {}) {
  return {
    ii_portfolio_truth_status: [{ user_id: USER, account_id: 'a1', instrument_id: 'i1', status: 'certified', unit_variance_within_tolerance: true, latest_source_document_id: 'd1', history_completeness: 'complete_from_inception' }],
    ii_transactions: [{ user_id: USER, account_id: 'a1', instrument_id: 'i1', transaction_type: 'purchase', transaction_date: '2020-01-01', gross_amount: 10000, units: 500, currency_code: 'INR', status: 'parsed' }],
    ii_holding_snapshots: [{ user_id: USER, account_id: 'a1', instrument_id: 'i1', as_of_date: '2021-01-01', units: 500, value: 15000, currency_code: 'INR', quality_status: 'certified', source_document_id: 'd1' }],
    ii_instruments: [{ id: 'i1', instrument_name: opts.name ?? 'L036G-Test Large Cap Fund (Non-Demat)', base_currency: 'INR', country_of_domicile: 'IN', isin: 'INF000000001' }],
    ii_accounts: [{ id: 'a1', user_id: USER, folio_number: 'F1', institution_name: 'AMC', currency_code: 'INR' }],
    ii_source_documents: [{ id: 'd1', source_detected: 'cams' }],
    ii_scheme_master: [{ instrument_id: 'i1', scheme_name: 'Test Large Cap Fund', sub_category: opts.sub ?? 'Large Cap Fund', category_header_raw: null, effective_to: null }],
    ii_instrument_benchmarks: opts.declared
      ? [{ instrument_id: 'i1', benchmark_id: 'bm-declared', relationship_type: 'primary', effective_from: '2019-01-01', effective_to: null, quality_status: 'ok', ii_benchmarks: { benchmark_key: 'IN_BSE_100_TRI', benchmark_label: 'BSE 100 TRI', return_type: 'TRI', licence_status: 'unknown', lifecycle_status: 'active', catalogue_status: 'verified' } }]
      : [],
    ii_benchmarks: [bmRow(BMV, 'IN_NIFTY_100_TRI', 'NIFTY 100 TRI', opts.catalogue ?? {})],
    ii_benchmark_series: [
      { benchmark_id: BMV, series_date: '2020-01-01', value: 100, quality_status: 'ok' },
      { benchmark_id: BMV, series_date: '2021-01-01', value: 110, quality_status: 'ok' },
      { benchmark_id: 'bm-declared', series_date: '2020-01-01', value: 100, quality_status: 'ok' },
      { benchmark_id: 'bm-declared', series_date: '2021-01-01', value: 120, quality_status: 'ok' },
    ],
    ii_risk_free_rates: [],
    ii_prices_nav: [],
    __benchmark_access: opts.access ?? [access(), access({ benchmark_id: 'bm-declared' })],
  };
}
const holding = async (t: Record<string, unknown[]>) => {
  const { client } = makeFakeSupabase(t as never);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (await loadHoldingsTable(client as any, USER)).holdings[0];
};

describe('Holdings table (real loaders): category reference only when nothing is declared, and only through every gate', () => {
  it('no declared mapping, supported category, verified + entitled + covered: a figure labelled as the category benchmark', async () => {
    const c = (await holding(e2e())).benchmarkComparison;
    expect(c.status).toBe('ok');
    if (c.status !== 'ok') return;
    expect(c).toMatchObject({ benchmarkBasis: 'category_reference', benchmarkLabel: 'NIFTY 100 TRI', benchmarkBasisLabel: LABEL('Large Cap') });
    expect(c.benchmarkEndingValue).toBeCloseTo(11000, 6);
  });

  it('NEGATIVE CONTROL: a DECLARED mapping wins even though the category benchmark has data (BSE 100 TRI 20%, not NIFTY 100 TRI 10%)', async () => {
    const c = (await holding(e2e({ declared: true }))).benchmarkComparison;
    expect(c.status).toBe('ok');
    if (c.status !== 'ok') return;
    expect(c).toMatchObject({ benchmarkBasis: 'declared', benchmarkLabel: 'BSE 100 TRI', benchmarkBasisLabel: "Fund's declared benchmark" });
    expect(c.benchmarkEndingValue).toBeCloseTo(12000, 6);
  });

  it('NEGATIVE CONTROL: the entitlement missing => no figure, but the name and category label are shown', async () => {
    const c = (await holding(e2e({ access: [] }))).benchmarkComparison;
    expect(c).toMatchObject({ status: 'unavailable', reason: 'NOT_ENTITLED', benchmarkLabel: 'NIFTY 100 TRI', benchmarkBasisLabel: LABEL('Large Cap') });
  });

  it('NEGATIVE CONTROL: an unverified catalogue entry => no figure', async () => {
    expect((await holding(e2e({ catalogue: { catalogue_status: 'draft' } }))).benchmarkComparison).toMatchObject({ status: 'unavailable', reason: 'CATALOGUE_NOT_VERIFIED', benchmarkLabel: 'NIFTY 100 TRI' });
  });

  it('NEGATIVE CONTROL: a price-return catalogue entry is never used for a total-return comparison', async () => {
    expect((await holding(e2e({ catalogue: { return_type: 'PRI' } }))).benchmarkComparison).toMatchObject({ status: 'unavailable', reason: 'PRICE_INDEX_NOT_TOTAL_RETURN' });
  });

  it('NEGATIVE CONTROL: an unsupported category => no benchmark and the explicit message, no name, no figure', async () => {
    const c = (await holding(e2e({ sub: 'FoF Domestic', name: 'HGFOF-HDFC Gold ETF Fund of Fund - Regular Plan - Growth (Non-Demat)' }))).benchmarkComparison;
    expect(c).toMatchObject({ status: 'unavailable', reason: 'NO_MAPPING' });
    expect((c as { detail: string }).detail).toMatch(/Benchmark not available for this fund category/);
  });

  it('the category reference is never counted as "mapped" by the coverage summary and is never stored (no write is issued)', async () => {
    const h = makeFakeSupabase(e2e() as never);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await loadHoldingsTable(h.client as any, USER);
    expect(h.writes).toEqual([]);
  });
});

describe('Performance (orchestrator) and Review Centre: same rules, same labels', () => {
  const run = async (t: Record<string, unknown[]>) => {
    const { client } = makeFakeSupabase(t as never);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { dataset } = await loadAnalyticsDataset(client as any, USER, {});
    if (!dataset) throw new Error('no dataset');
    return { rs: runAnalytics(dataset), dataset };
  };

  it('a category-referenced scheme comparison is labelled, and the blended PORTFOLIO benchmark never uses the category reference', async () => {
    const { rs, dataset } = await run(e2e());
    const s = rs.schemes[0];
    expect(s.benchmarkComparison).toMatchObject({ status: 'ok', benchmarkBasis: 'category_reference', benchmarkBasisLabel: LABEL('Large Cap') });
    expect(s.activeReturn.value).toMatchObject({ family: 'XIRR', benchmarkBasis: 'category_reference', benchmarkBasisLabel: LABEL('Large Cap') });
    expect(dataset.mappings).toEqual([]); // declared only: the portfolio blend is untouched
    expect(rs.portfolios[0].contributingBenchmarks).toEqual([]);
  });

  it('NEGATIVE CONTROL: with a declared mapping the scheme uses it and says "Fund\'s declared benchmark"', async () => {
    const { rs } = await run(e2e({ declared: true }));
    expect(rs.schemes[0].activeReturn.value).toMatchObject({ benchmarkBasis: 'declared', benchmarkKey: 'IN_BSE_100_TRI', benchmarkBasisLabel: "Fund's declared benchmark" });
  });

  it('NEGATIVE CONTROL: un-entitled => no number on the scheme, the name and label still present', async () => {
    const { rs } = await run(e2e({ access: [] }));
    expect(rs.schemes[0].activeReturn.value).toBeUndefined();
    expect(rs.schemes[0].benchmarkComparison).toMatchObject({ status: 'unavailable', benchmarkLabel: 'NIFTY 100 TRI', benchmarkBasisLabel: LABEL('Large Cap') });
  });

  it('Review Centre wording says it is the category benchmark when it is, and the declared wording otherwise', () => {
    const rule = { reviewType: 'benchmark_underperformance', category: 'performance', defaultSeverity: 'low', complianceClassification: 'informational', ruleKey: 'benchmark_underperformance', ruleVersion: 'v1', thresholdConfig: { underperformanceFraction: 0.02 } } as never;
    const cat = detectBenchmarkUnderperformance('u', [{ scopeId: 's1', metricKey: 'scheme_active_return', activeReturn: -0.05, qualityStatus: 'ok', engineVersion: 'e', benchmarkBasis: 'category_reference', benchmarkBasisLabel: LABEL('Large Cap') }], '2026-10-03', rule);
    expect(cat[0].title).toBe('Position trailing its category benchmark');
    expect(cat[0].description).toContain(LABEL('Large Cap'));
    const dec = detectBenchmarkUnderperformance('u', [{ scopeId: 's1', metricKey: 'scheme_active_return', activeReturn: -0.05, qualityStatus: 'ok', engineVersion: 'e', benchmarkBasis: 'declared' }], '2026-10-03', rule);
    expect(dec[0].title).toBe('Position trailing its benchmark');
    expect(dec[0].description).toContain("the fund's declared benchmark");
    expect(dec[0].description).not.toContain('usual benchmark');
  });
});

describe('static guarantees (source)', () => {
  const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
  it('nothing in production code stores a category reference: the loader has no write, and "category_reference" is never a relationship_type value', () => {
    const loader = read('lib/services/investment-intelligence/benchmarkData/categoryReferenceLoader.ts');
    expect(loader).not.toMatch(/\.(insert|update|upsert|delete)\(|\.rpc\(/);
    for (const f of ['lib/services/investment-intelligence/benchmarkData/categoryReference.ts', 'lib/services/investment-intelligence/benchmarkData/categoryReferenceLoader.ts', 'lib/services/investment-intelligence/benchmarkData/schemeMappingProposals.ts', 'app/api/admin/investment-intelligence/benchmark-data/mappings/route.ts']) {
      expect(read(f), f).not.toMatch(/relationship_type['"]?\s*[:=]\s*['"]category_reference/);
    }
    expect(read('supabase/migrations/0241_bench1_phase2_benchmark_data_governance.sql')).not.toMatch(/category_reference/);
  });
  it('no migration is needed: the new migration (0251) does not touch mappings, proposals or auto-publish', () => {
    expect(read('supabase/migrations/0251_bench1_held_schemes_for_benchmark_mapping.sql')).not.toMatch(/auto_publish|ii_instrument_benchmarks\s*\(|insert\s+into/i);
  });
  it('the label wording is on every surface that shows a comparison', () => {
    expect(read('components/investment-intelligence/BenchmarkComparisonView.tsx')).toMatch(/benchmarkBasisLabel/);
    expect(read('components/admin/benchmarkData/HeldSchemesTable.tsx')).toMatch(/basisLabel/);
    expect(read('lib/engines/investment-intelligence/reviewCentre.ts')).toMatch(/not this fund's own declared benchmark/);
    expect(read('lib/services/investment-intelligence/benchmarkData/categoryReference.ts')).toMatch(/Compared with the usual benchmark for \$\{categoryLabel\} funds \(not this fund's own declared benchmark\)/);
    // The Holdings table and the Performance scheme row both render the shared view.
    expect(read('components/investment-intelligence/HoldingsTable.tsx')).toMatch(/BenchmarkComparisonView/);
    expect(read('components/investment-intelligence/PerformanceClient.tsx')).toMatch(/BenchmarkComparisonView/);
  });
});
