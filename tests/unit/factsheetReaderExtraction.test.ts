// Factsheet benchmark reader: the deterministic text-pattern pass, the benchmark classifier and the offline
// "dry run on a stored sample" tool, against SYNTHETIC fixtures that mimic the benchmark sections of the four research
// funds (tests/fixtures/factsheet-benchmark-reader/*.txt). No network, no database, no real fund-house document.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { extractWithPatterns, findAllDates, findDocumentDate, findFirstDate, plausibleBenchmarkName, schemeNameRegex, splitEffectiveRemark } from '@/lib/services/investment-intelligence/factsheetReader/patternExtractor';
import { classifyBenchmark, decideCatalogueState, parseComposition, sameBenchmark } from '@/lib/services/investment-intelligence/factsheetReader/benchmarkClassifier';
import { SAMPLE_CATALOGUE, dryRunOnSample } from '@/lib/services/investment-intelligence/factsheetReader/sampleDryRun';

const FIX = path.resolve(__dirname, '..', 'fixtures', 'factsheet-benchmark-reader');
const read = (f: string) => fs.readFileSync(path.join(FIX, f), 'utf8');

const HDFC = read('hdfc_balanced_advantage_sid.txt');
const SBI_MA = read('sbi_multi_asset_allocation_factsheet.txt');
const SBI_CONTRA = read('sbi_contra_factsheet.txt');
const NIPPON = read('nippon_power_infra_presentation.txt');

function found(text: string, schemeName: string, scope: 'single_scheme' | 'multi_scheme' = 'single_scheme') {
  const r = extractWithPatterns({ text, schemeName, scope });
  if (r.status !== 'found') throw new Error(`expected found, got ${r.status}: ${'reason' in r ? r.reason : ''}`);
  return r.extraction;
}

describe('the four research-fund fixtures (pattern pass)', () => {
  it('HDFC Balanced Advantage: Tier-1 50:50 TRI with the heading variant hint, additional Nifty 50 TRI, SID date 28-06-2024', () => {
    const e = found(HDFC, 'HDFC Balanced Advantage Fund');
    expect(e.tier1?.raw).toBe('NIFTY 50 Hybrid Composite Debt 50:50 Index (Total Returns Index)');
    expect(e.tier1?.variantHint).toBe('total_return');
    expect(e.additional.map((a) => a.raw)).toEqual(['NIFTY 50 Total Returns Index (TRI)']);
    expect(e.documentDate).toEqual({ iso: '2024-06-28', precision: 'day' });
    expect(e.effectiveFromStated).toBeNull();
  });

  it('the "Benchmark Riskometer" cell is never read as a benchmark', () => {
    const e = found(HDFC, 'HDFC Balanced Advantage Fund');
    expect(e.tier1?.raw).not.toMatch(/riskometer|very high/i);
    expect(plausibleBenchmarkName('Riskometer')).toBe(false);
    expect(plausibleBenchmarkName('Very High')).toBe(false);
  });

  it('SBI Multi Asset: the four-leg composite (read across a wrapped line), its stated effective date 31-10-2023 and the report date 30-04-2026 (day-first)', () => {
    const e = found(SBI_MA, 'SBI Multi Asset Allocation Fund');
    expect(e.tier1?.raw).toBe('45% BSE 500 TRI + 40% Crisil Composite Bond Fund Index + 10% Domestic prices of Gold + 5% Domestic prices of silver');
    expect(e.effectiveFromStated).toEqual({ iso: '2023-10-31', precision: 'day' });
    expect(e.documentDate).toEqual({ iso: '2026-04-30', precision: 'day' });
    expect(e.additional).toEqual([]);
  });

  it('SBI Contra: First Tier and "As per AMFI Tier I benchmark" both read as the SAME benchmark (BSE 500 TRI vs BSE 500 TRI Index); report date 31-08-2025', () => {
    const e = found(SBI_CONTRA, 'SBI Contra Fund');
    expect(classifyBenchmark(e.tier1?.raw ?? '').kind).toBe('single_index');
    expect(e.tier1?.raw).toMatch(/BSE 500 TRI/);
    expect(e.documentDate).toEqual({ iso: '2025-08-31', precision: 'day' });
  });

  it('Nippon Power & Infra: "B:" and "AB:" lines; "Data as on 30 July 2021"; the "&" in the name matches "and"', () => {
    const e = found(NIPPON, 'Nippon India Power & Infra Fund');
    expect(e.tier1?.raw).toBe('Nifty Infrastructure TRI');
    expect(e.additional.map((a) => a.raw)).toEqual(['S&P BSE Sensex TRI']);
    expect(e.documentDate).toEqual({ iso: '2021-07-30', precision: 'day' });
    expect(schemeNameRegex('Nippon India Power & Infra Fund').test('Nippon India Power and Infra Fund')).toBe(true);
  });
});

describe('what the pass refuses to guess', () => {
  it('a document that does not name the scheme records nothing (scheme absent), even when it states a benchmark', () => {
    const r = extractWithPatterns({ text: HDFC, schemeName: 'Some Other Fund', scope: 'single_scheme' });
    expect(r).toMatchObject({ status: 'not_found', schemeNamePresent: false });
  });
  it('no explicit label = not found (a prose mention of the word "benchmark" is not a declaration)', () => {
    const text = 'HDFC Balanced Advantage Fund\nThe scheme aims to beat its benchmark over the long run. Benchmarks matter.\nReport As On: 30/04/2026\n';
    expect(extractWithPatterns({ text, schemeName: 'HDFC Balanced Advantage Fund', scope: 'single_scheme' }).status).toBe('not_found');
  });
  it('two DIFFERENT Tier-1 answers in one document = ambiguous, never "pick one"', () => {
    const text = 'SBI Contra Fund\nFirst Tier Benchmark: BSE 500 TRI\nTier I Benchmark: Nifty 100 TRI\nReport As On: 31/08/2025\n';
    const r = extractWithPatterns({ text, schemeName: 'SBI Contra Fund', scope: 'single_scheme' });
    expect(r.status).toBe('ambiguous');
  });
  it('a multi-scheme document reads only the text around the named scheme', () => {
    const text = ['Other Fund A', 'First Tier Benchmark: Nifty 100 TRI', '', ...Array(200).fill('filler line'), 'ICICI Prudential Dividend Yield Equity Fund', 'Benchmark: Nifty 500 TRI', 'Report As On: 30/09/2026'].join('\n');
    const e = found(text, 'ICICI Prudential Dividend Yield Equity Fund', 'multi_scheme');
    expect(e.tier1?.raw).toBe('Nifty 500 TRI');
  });
  it('performance / return figures are never extracted: the extraction has no numeric return field', () => {
    const e = found(HDFC, 'HDFC Balanced Advantage Fund');
    expect(Object.keys(e).sort()).toEqual(['additional', 'documentDate', 'effectiveFromStated', 'excerpt', 'schemeNamePresent', 'tier1']);
  });
});

describe('dates are day-first and validated', () => {
  it('numeric dates are dd/mm/yyyy: 04/05/2026 is 4 May 2026, never 5 April', () => {
    expect(findFirstDate('as on 04/05/2026')).toEqual({ iso: '2026-05-04', precision: 'day' });
    expect(findFirstDate('as on 04-05-2026')).toEqual({ iso: '2026-05-04', precision: 'day' });
  });
  it('an impossible date is not a date; written forms and month-only forms work', () => {
    expect(findFirstDate('31/02/2026')).toBeNull();
    expect(findFirstDate('30th April, 2026')).toEqual({ iso: '2026-04-30', precision: 'day' });
    expect(findFirstDate('April 30, 2026')).toEqual({ iso: '2026-04-30', precision: 'day' });
    expect(findFirstDate('Fund Facts - March 2026')).toEqual({ iso: '2026-03-01', precision: 'month' });
    expect(findAllDates('12/13/2026')).toEqual([]);
  });
  it('the returns-table "as at" footnote date is the weakest evidence: an explicit "dated" wins', () => {
    expect(findDocumentDate('performance as at 30 September 2025\nThis SID is dated November 21, 2025')).toEqual({ iso: '2025-11-21', precision: 'day' });
  });
  it('a stated effective date is split from the benchmark name', () => {
    expect(splitEffectiveRemark('45% X TRI + 55% Y (W.e.f. 31 October 2023)')).toEqual({ name: '45% X TRI + 55% Y', effective: { iso: '2023-10-31', precision: 'day' } });
    expect(splitEffectiveRemark('Nifty 500 TRI').effective).toBeNull();
  });
});

describe('classification (reuses the repository matcher; a composite or a commodity price is never reduced to a leg)', () => {
  it('composite: legs and weights are stored; identity ignores leg order', () => {
    const c = classifyBenchmark('45% BSE 500 TRI + 40% Crisil Composite Bond Fund Index + 10% Domestic prices of Gold + 5% Domestic prices of silver');
    expect(c.kind).toBe('composite');
    expect(c.composition.map((l) => l.weightPct)).toEqual([45, 40, 10, 5]);
    expect(c.composition[0].name).toBe('BSE 500 TRI');
    const shuffled = classifyBenchmark('5% Domestic prices of silver + 10% Domestic prices of Gold + 40% Crisil Composite Bond Fund Index + 45% BSE 500 TRI');
    expect(sameBenchmark(c, shuffled)).toBe(true);
    expect(sameBenchmark(c, classifyBenchmark('50% BSE 500 TRI + 40% Crisil Composite Bond Fund Index + 10% Domestic prices of Gold'))).toBe(false);
    expect(parseComposition('BSE 500 TRI')).toEqual([{ weightPct: null, name: 'BSE 500 TRI' }]);
  });
  it('commodity price: "domestic price of physical gold" and the plural / reordered wordings', () => {
    for (const n of ['Domestic price of physical gold', 'Domestic prices of Gold', 'Gold price (INR)']) expect(classifyBenchmark(n).kind, n).toBe('commodity_price');
  });
  it('a plain index is a single index; the heading hint and the bare name are the same benchmark', () => {
    expect(classifyBenchmark('Nifty Infrastructure TRI').kind).toBe('single_index');
    expect(sameBenchmark(classifyBenchmark('BSE 500 TRI'), classifyBenchmark('S&P BSE 500 TRI Index'))).toBe(true);
    expect(sameBenchmark(classifyBenchmark('Nifty 500 TRI'), classifyBenchmark('BSE 500 TRI'))).toBe(false); // owner is part of identity
    expect(sameBenchmark(classifyBenchmark('NIFTY 50 Hybrid Composite Debt 65:35 Index (TRI)'), classifyBenchmark('NIFTY 50 Hybrid Composite Debt 50:50 Index (TRI)'))).toBe(false);
  });
  it('catalogue state: HDFC 50:50 and Nippon Infra and SBI Contra match a VERIFIED entry at high confidence; the composite and the gold price never match', () => {
    const state = (raw: string, hint: 'total_return' | null = null) => decideCatalogueState({ raw, variantHint: hint }, classifyBenchmark(raw), SAMPLE_CATALOGUE);
    expect(state('NIFTY 50 Hybrid Composite Debt 50:50 Index (Total Returns Index)', 'total_return')).toMatchObject({ state: 'matched_verified', confidence: 'high' });
    expect(state('Nifty Infrastructure TRI')).toMatchObject({ state: 'matched_verified', confidence: 'high' });
    expect(state('BSE 500 TRI Index')).toMatchObject({ state: 'matched_verified' });
    expect(state('45% BSE 500 TRI + 40% Crisil Composite Bond Fund Index + 10% Domestic prices of Gold')).toMatchObject({ state: 'unsupported_composite', benchmarkId: null });
    expect(state('Domestic price of physical gold')).toMatchObject({ state: 'unsupported_commodity', benchmarkId: null });
    // the older 65:35 index and Nifty 50 TRI are NOT in the catalogue: no safe match, not a near-miss to 50:50
    expect(state('NIFTY 50 Hybrid Composite Debt 65:35 Index (Total Returns Index)').state).toBe('no_catalogue_match');
    expect(state('NIFTY 50 Total Returns Index (TRI)').state).toBe('no_catalogue_match');
  });
  it('NEGATIVE CONTROL: a price index never matches a total-return requirement (the catalogue holds only the PRICE series)', () => {
    const priceOnly = [{ benchmarkId: 'p1', benchmarkKey: 'IN_NIFTY_50_PRI', officialName: 'Nifty 50 (price index close)', returnVariant: 'price' as const, verified: true, active: true }];
    const d = decideCatalogueState({ raw: 'Nifty 50 TRI', variantHint: null }, classifyBenchmark('Nifty 50 TRI'), priceOnly);
    expect(d.state).toBe('no_catalogue_match');
    expect(d.benchmarkId).toBeNull();
    expect(d.match?.rejected.some((r) => r.reason === 'PRICE_INDEX_NOT_TOTAL_RETURN' || r.reason === 'VARIANT_MISMATCH')).toBe(true);
  });
  it('an unverified catalogue entry is "matched_other" (a human decides), never "matched_verified"', () => {
    const unverified = SAMPLE_CATALOGUE.map((e) => ({ ...e, verified: false }));
    expect(decideCatalogueState({ raw: 'Nifty Infrastructure TRI', variantHint: null }, classifyBenchmark('Nifty Infrastructure TRI'), unverified).state).toBe('matched_other');
  });
});

describe('dry run on a stored sample (no network, no database)', () => {
  it('SBI Multi Asset: recorded as an unsupported composite, sent to the review queue, effective 31-10-2023 as the document states; nothing is proposed', () => {
    const r = dryRunOnSample({ text: SBI_MA, sourceKey: 'sbi_multi_asset_factsheet_2026_04' });
    expect(r.decision.action).toBe('new_version');
    if (r.decision.action !== 'new_version') return;
    expect(r.decision.version).toMatchObject({ benchmarkKind: 'composite', catalogueState: 'unsupported_composite', effectiveFrom: '2023-10-31', effectiveFromBasis: 'document_stated', reviewState: 'pending_review', matchedBenchmarkId: null });
    expect(r.decision.version.composition).toHaveLength(4);
    expect(r.decision.reviewRequired).toBe(true);
    expect(r.decision.proposal).toBeNull();
    expect(r.summary.join('\n')).toMatch(/Decision: new_version/);
  });
  it('HDFC Balanced Advantage: a clean first reading waits one month ("awaiting confirmation"); effective date is the document month start, flagged estimated', () => {
    const r = dryRunOnSample({ text: HDFC, sourceKey: 'hdfc_baf_sid_2024_06' });
    if (r.decision.action !== 'new_version') throw new Error('expected a new version');
    expect(r.decision.version).toMatchObject({ catalogueState: 'matched_verified', reviewState: 'awaiting_confirmation', effectiveFrom: '2024-06-01', effectiveFromBasis: 'estimated_document_month', extractionMethod: 'text_pattern' });
    expect(r.decision.reviewRequired).toBe(false);
    expect(r.decision.proposal).toBeNull();
  });
  it('Nippon: the document type is "other", so even a perfect match can never auto-publish (checked in the runner tests too)', () => {
    const r = dryRunOnSample({ text: NIPPON, sourceKey: 'nippon_power_infra_presentation' });
    if (r.decision.action !== 'new_version') throw new Error('expected a new version');
    expect(r.decision.version.sourceDocumentType).toBe('other');
    expect(r.decision.version.catalogueState).toBe('matched_verified');
  });
});
