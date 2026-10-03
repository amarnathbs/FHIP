// Scheme -> benchmark proposal pipeline (pure). EVIDENCE LABEL: code-level unit tests with
// evidence strings modelled on the held-scheme matrix; they prove ranking, gating and
// effective-dating logic, and that every payload fits the EXISTING propose route's schema.
// They prove nothing about live data, AMFI's lists (unreadable on 2026-10-03) or any licence.
import { describe, it, expect } from 'vitest';
import {
  buildMappingProposals,
  isAutoPublishEligible,
  summariseUnmappedSchemes,
  type DeclaredBenchmarkEvidence,
  type SchemeForMapping,
} from '@/lib/services/investment-intelligence/benchmarkData/schemeMappingProposals';
import type { CatalogueEntryLite } from '@/lib/services/investment-intelligence/benchmarkData/benchmarkNameMatcher';
import { MappingBody } from '@/lib/services/investment-intelligence/benchmarkData/routeSupport';

const SCHEME: SchemeForMapping = { instrumentId: '11111111-1111-4111-8111-111111111111', schemeName: 'Test Large Cap Fund', amcName: 'Test Mutual Fund', amfiCode: '100001', subCategory: 'Large Cap Fund' };
const E = (key: string, name: string, over: Partial<CatalogueEntryLite> = {}): CatalogueEntryLite => ({ benchmarkId: `22222222-2222-4222-8222-${key.length.toString().padStart(12, '0')}`, benchmarkKey: key, officialName: name, returnVariant: 'total_return', verified: true, active: true, ...over });
const CAT = [E('IN_NIFTY_100_TRI', 'NIFTY 100 TRI'), E('IN_BSE_100_TRI', 'BSE 100 TRI'), E('IN_NIFTY_100_PRI', 'NIFTY 100', { returnVariant: 'price' })];

const DOC = (over: Partial<DeclaredBenchmarkEvidence> = {}): DeclaredBenchmarkEvidence => ({
  benchmarkName: 'NIFTY 100 TRI',
  effectiveFrom: '2018-02-01',
  evidenceSource: 'amc_sid',
  evidenceUrl: 'https://example.test/sid.pdf',
  evidenceTitle: 'Test Large Cap Fund SID',
  evidenceDocumentDate: '2025-05-30',
  evidenceRetrievedAt: '2026-10-01',
  evidenceExcerpt: 'Benchmark: NIFTY 100 TRI',
  ...over,
});

describe('authority 1: the scheme\'s own document', () => {
  it('an exact, evidenced match to a VERIFIED entry is high-confidence, deterministic and auto-publish ELIGIBLE (the database still decides)', () => {
    const set = buildMappingProposals({ scheme: SCHEME, catalogue: CAT, declared: [DOC()] });
    const d = set.drafts[0];
    expect(d.authority).toBe('scheme_document');
    expect(d.rank).toBe(1);
    expect(d.payload).toMatchObject({ benchmark_id: CAT[0].benchmarkId, resolution_method: 'deterministic_exact', confidence: 'high', ambiguity_reason: null, evidence_source: 'amc_sid' });
    expect(d.autoPublishEligible).toBe(true);
  });

  it('every payload fits the existing propose route\'s own zod schema (no new table, RPC or migration)', () => {
    const set = buildMappingProposals({ scheme: SCHEME, catalogue: CAT, declared: [DOC()] });
    expect(MappingBody.safeParse(set.drafts[0].payload).success).toBe(true);
  });

  it('a medium/low name match goes to a reviewer as admin_judgement and is NOT auto-publish eligible', () => {
    const set = buildMappingProposals({ scheme: SCHEME, catalogue: CAT, declared: [DOC({ benchmarkName: 'Nifty 100' })] }); // variant unstated
    const d = set.drafts[0];
    // 'Nifty 100' also names the PRICE entry, which is rejected; the TRI entry matches at medium.
    expect(d.payload?.confidence).toBe('medium');
    expect(d.payload?.resolution_method).toBe('admin_judgement');
    expect(d.autoPublishEligible).toBe(false);
    expect(d.requiresAdminReview).toBe(true);
  });

  it('an UNVERIFIED catalogue entry is never auto-publish eligible (NEGATIVE CONTROL: verified is the only difference)', () => {
    const verified = buildMappingProposals({ scheme: SCHEME, catalogue: [E('IN_NIFTY_100_TRI', 'NIFTY 100 TRI')], declared: [DOC()] });
    const unverified = buildMappingProposals({ scheme: SCHEME, catalogue: [E('IN_NIFTY_100_TRI', 'NIFTY 100 TRI', { verified: false })], declared: [DOC()] });
    expect(verified.drafts[0].autoPublishEligible).toBe(true);
    expect(unverified.drafts[0].autoPublishEligible).toBe(false);
  });

  it('a name with no catalogue entry still yields a reviewable proposal that says the entry must be created first', () => {
    const set = buildMappingProposals({ scheme: SCHEME, catalogue: [], declared: [DOC({ benchmarkName: 'Nifty 500 TRI' })] });
    expect(set.drafts[0].needsCatalogueEntry).toBe(true);
    expect(set.drafts[0].payload?.benchmark_id).toBeNull();
    expect(set.drafts[0].payload?.ambiguity_reason).toMatch(/entry has to be created and verified first/);
    expect(set.drafts[0].autoPublishEligible).toBe(false);
  });

  it('a PRICE-only catalogue entry never produces a mapping to it (NEGATIVE CONTROL: a TRI entry would)', () => {
    const priceOnly = buildMappingProposals({ scheme: SCHEME, catalogue: [E('IN_NIFTY_100_PRI', 'NIFTY 100', { returnVariant: 'price' })], declared: [DOC({ benchmarkName: 'NIFTY 100 TRI' })] });
    expect(priceOnly.drafts[0].payload?.benchmark_id).toBeNull();
    expect(priceOnly.drafts[0].warnings.join(' ')).toMatch(/PRICE index/);
    const withTri = buildMappingProposals({ scheme: SCHEME, catalogue: [E('IN_NIFTY_100_TRI', 'NIFTY 100 TRI')], declared: [DOC()] });
    expect(withTri.drafts[0].payload?.benchmark_id).not.toBeNull();
  });

  it('a composite or commodity-price declaration makes no proposal at all (never approximated by one leg)', () => {
    const set = buildMappingProposals({ scheme: SCHEME, catalogue: CAT, declared: [DOC({ benchmarkName: '45% BSE 500 TRI + 40% CRISIL Composite Bond Fund Index + 10% domestic gold + 5% domestic silver' })] });
    expect(set.drafts[0].payload).toBeNull();
    expect(set.drafts[0].warnings[0]).toMatch(/composite/);
  });
});

describe('RULE: a fund\'s CATEGORY benchmark is never a proposal, so it can never auto-publish (named negative controls)', () => {
  it('a Large Cap fund with no document gets NO proposal of any kind from the builder (the category benchmark is a read-time reference, see categoryReference.test.ts)', () => {
    const set = buildMappingProposals({ scheme: SCHEME, catalogue: CAT });
    expect(set.drafts).toEqual([]);
    expect('categoryOptions' in set).toBe(false);
    expect(set.skipped.every((s) => s.source !== ('category_default' as never))).toBe(true);
  });

  it('NEGATIVE CONTROL: a payload shaped like the OLD category default (low, admin_judgement, evidence "other") fails the database auto-publish test on each of its three grounds, and one fixed up on all three would pass, so the test bites', () => {
    const verified = { benchmarkId: 'x', benchmarkKey: 'K', officialName: 'NIFTY 100 TRI', returnVariant: 'total_return' as const, verified: true, active: true };
    const oldShape = { instrument_id: SCHEME.instrumentId, benchmark_id: 'x', proposed_benchmark_name: 'NIFTY 100 TRI', relationship_type: 'primary' as const, effective_from: '2021-12-01', effective_to: null, evidence_source: 'other' as const, evidence_url: 'https://example.test/c', evidence_title: null, evidence_document_date: '2021-10-27', evidence_retrieved_at: '2026-10-01', evidence_excerpt: null, resolution_method: 'admin_judgement' as const, confidence: 'low' as const, ambiguity_reason: 'category' };
    expect(isAutoPublishEligible(oldShape, verified)).toBe(false);
    expect(isAutoPublishEligible({ ...oldShape, confidence: 'high', ambiguity_reason: null, evidence_source: 'amc_sid' }, verified)).toBe(false); // still admin_judgement
    expect(isAutoPublishEligible({ ...oldShape, resolution_method: 'deterministic_exact', ambiguity_reason: null, evidence_source: 'amc_sid' }, verified)).toBe(false); // still low
    expect(isAutoPublishEligible({ ...oldShape, resolution_method: 'deterministic_exact', confidence: 'high', ambiguity_reason: null }, verified)).toBe(false); // still 'other'
    expect(isAutoPublishEligible({ ...oldShape, resolution_method: 'deterministic_exact', confidence: 'high', ambiguity_reason: null, evidence_source: 'amc_sid' }, verified)).toBe(true);
  });
});

describe('authority 2: AMFI per-scheme name is skipped unless verified usable', () => {
  const amfi = { benchmarkName: 'NIFTY 100 TRI', url: 'https://www.amfiindia.com/example', documentDate: '2026-09-30', retrievedAt: '2026-10-03', effectiveFrom: '2022-01-01' };
  it('UNVERIFIED (the default state today) => not used, and says so', () => {
    const set = buildMappingProposals({ scheme: SCHEME, catalogue: CAT, amfi: { ...amfi, verifiedUsable: false } });
    expect(set.drafts).toEqual([]);
    expect(set.skipped.find((s) => s.source === 'amfi_per_scheme')?.reason).toMatch(/not been verified/);
  });
  it('NEGATIVE CONTROL: the same data marked verified IS used, ranks below the scheme document and is amfi_disclosure evidence', () => {
    const set = buildMappingProposals({ scheme: SCHEME, catalogue: CAT, amfi: { ...amfi, verifiedUsable: true }, declared: [DOC({ effectiveFrom: '2018-02-01', effectiveTo: '2021-12-31' })] });
    expect(set.drafts.map((d) => d.authority)).toEqual(['scheme_document', 'amfi_per_scheme']);
    expect(set.drafts[1].payload?.evidence_source).toBe('amfi_disclosure');
  });
});

describe('RULE: effective dating - a changed benchmark is a later effective-dated proposal, never an overwrite', () => {
  const changed = buildMappingProposals({
    scheme: SCHEME,
    catalogue: CAT,
    declared: [
      DOC({ benchmarkName: 'BSE 100 TRI', effectiveFrom: '2018-02-01', evidenceUrl: 'https://example.test/old.pdf' }),
      DOC({ benchmarkName: 'NIFTY 100 TRI', effectiveFrom: '2026-05-16', evidenceSource: 'amc_addendum', evidenceUrl: 'https://example.test/addendum.pdf' }),
    ],
  });
  it('the earlier declaration is closed the day before the next one starts, so the two never overlap', () => {
    expect(changed.drafts.map((d) => [d.payload?.proposed_benchmark_name, d.payload?.effective_from, d.payload?.effective_to])).toEqual([
      ['BSE 100 TRI', '2018-02-01', '2026-05-15'],
      ['NIFTY 100 TRI', '2026-05-16', null],
    ]);
    expect(changed.warnings).toEqual([]);
  });
  it('NEGATIVE CONTROL: the same two declarations given overlapping end dates are reported, not silently accepted', () => {
    const bad = buildMappingProposals({
      scheme: SCHEME,
      catalogue: CAT,
      declared: [DOC({ benchmarkName: 'BSE 100 TRI', effectiveFrom: '2018-02-01', effectiveTo: '2026-08-01' }), DOC({ benchmarkName: 'NIFTY 100 TRI', effectiveFrom: '2026-05-16' })],
    });
    expect(bad.warnings.join(' ')).toMatch(/overlap/);
  });
  it('a gap between two declarations is reported', () => {
    const gap = buildMappingProposals({
      scheme: SCHEME,
      catalogue: CAT,
      declared: [DOC({ benchmarkName: 'BSE 100 TRI', effectiveFrom: '2018-02-01', effectiveTo: '2020-12-31' }), DOC({ benchmarkName: 'NIFTY 100 TRI', effectiveFrom: '2021-06-01' })],
    });
    expect(gap.warnings.join(' ')).toMatch(/gap/);
  });
});

describe('admin list: schemes with no mapping yet, counts by category', () => {
  const rows = [
    { instrumentId: 'a', subCategory: 'Large Cap Fund', schemeName: 'A', amcName: 'X' },
    { instrumentId: 'b', subCategory: 'Large Cap Fund', schemeName: 'B', amcName: 'X' },
    { instrumentId: 'c', subCategory: 'Large Cap Fund', schemeName: 'C', amcName: 'X' },
    { instrumentId: 'd', subCategory: 'Liquid Fund', schemeName: 'D', amcName: 'Y' },
    { instrumentId: 'e', subCategory: null, schemeName: 'E', amcName: null },
  ];
  const s = summariseUnmappedSchemes(rows, new Set(['a']), new Set(['b', 'd']));

  it('counts mapped, unmapped and already-waiting-for-review per category', () => {
    const large = s.byCategory.find((c) => c.category === 'Large Cap Fund')!;
    expect(large).toMatchObject({ schemeRows: 3, mappedRows: 1, unmappedRows: 2, openProposalRows: 1, categoryReferenceBenchmark: 'NIFTY 100 TRI' });
    expect(large.categoryReferenceLabel).toBe("Compared with the usual benchmark for Large Cap funds (not this fund's own declared benchmark)");
    expect(s.byCategory.find((c) => c.category === 'Liquid Fund')).toMatchObject({ unmappedRows: 1, openProposalRows: 1, categoryReferenceBenchmark: null, categoryReferenceLabel: null });
    expect(s.byCategory.find((c) => c.category === 'Category not recorded')).toMatchObject({ unmappedRows: 1 });
    expect(s).toMatchObject({ totalSchemeRows: 5, mappedRows: 1, unmappedRows: 4 });
  });
  it('NEGATIVE CONTROL: a scheme whose only mapping is a PROPOSAL (not approved) still counts as unmapped', () => {
    expect(s.byCategory.find((c) => c.category === 'Large Cap Fund')!.unmappedRows).toBe(2); // 'b' has a proposal but no mapping
  });
});
