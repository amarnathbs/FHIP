/**
 * Personal report sections and owner classes (2026-10-01, PO decision): entity-owned data is never
 * silently summed into the personal chapters; every owner class is listed as its own item with an
 * explicit macro line. The certified engines are not touched: the four chapters run on a read-only
 * client narrowed to the non-entity accounts (same loaders, fewer rows).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { entityExclusionNote, hasEntityClasses, ownerBreakupNarrative } from '@/lib/engines/reportOwnerBreakup';
import { buildInvestmentPerformance, buildPortfolioXray, buildSipContribution, buildTaxAndCost } from '@/lib/engines/reportSectionsPremium';
import { buildOwnerBreakup, type OwnerLabels } from '@/lib/services/investment-intelligence/ownerClass';
import { deriveAccountOwnership } from '@/lib/services/investment-intelligence/ownerModel';
import { loadOwnerClassScopeForReport } from '@/lib/services/investment-intelligence/ownerClassReportScope';
import type { PremiumSourceData, ReportSourceData } from '@/lib/services/reportSnapshotResolver';
import { makeFakeSupabase, type Row } from './readModels/helpers/fakeSupabase';
import { USER } from './readModels/helpers/fixtures';

const labels: OwnerLabels = {
  member: (id) => ({ m1: { name: 'Asha Rao', relationship: 'self' }, m2: { name: 'Ravi Rao', relationship: 'spouse' } } as Record<string, { name: string; relationship: string }>)[id],
  entity: (id) => ({ e1: { name: 'Rao Family Trust', entityType: 'family_trust' } } as Record<string, { name: string; entityType: string }>)[id],
};
const own = (rows: { m?: string; e?: string; bp: number }[], ptr: string | null = null) =>
  deriveAccountOwnership(ptr, rows.map((r) => ({ owner_member_id: r.m ?? null, owner_business_entity_id: r.e ?? null, allocation_basis_points: r.bp, ii_instrument_id: null, status: 'active' })));

const breakupWithEntity = buildOwnerBreakup(
  [
    { id: 'a1', ownership: own([], 'm1') },
    { id: 'a2', ownership: own([{ m: 'm1', bp: 6000 }, { m: 'm2', bp: 4000 }]) },
    { id: 'a3', ownership: own([{ e: 'e1', bp: 10000 }]) },
  ],
  [
    { accountId: 'a1', currencyCode: 'INR', value: 100_000 },
    { accountId: 'a2', currencyCode: 'INR', value: 1_000_000 },
    { accountId: 'a3', currencyCode: 'INR', value: 500_000 },
  ],
  labels
);
const breakupPersonalOnly = buildOwnerBreakup([{ id: 'a1', ownership: own([], 'm1') }], [{ accountId: 'a1', currencyCode: 'INR', value: 100_000 }], labels);

describe('ownerBreakupNarrative', () => {
  const text = ownerBreakupNarrative(breakupWithEntity)!;
  it('lists every class as its own item with its own total, joint parts divided by the split, and the trust marked as kept separate', () => {
    expect(text).toContain('each class is complete on its own and is not added to the others');
    expect(text).toMatch(/Asha Rao \(You\): ₹1,00,000/);
    expect(text).toMatch(/Jointly owned \(household members\): ₹10,00,000 \[Asha Rao ₹6,00,000, Ravi Rao ₹4,00,000\]/);
    expect(text).toMatch(/Rao Family Trust \(Family trust\): ₹5,00,000 \(kept separate; not part of your personal figures\)/);
  });
  it('ends with the explicit macro line (each position once, labelled not a personal total) and says the chapters cover personal and joint only', () => {
    expect(text).toContain('Consolidated (macro view only): ₹16,00,000 across 3 positions (each counted once; it is not your personal total)');
    expect(text).toContain('chapters of this report cover your personal and joint holdings only');
  });
  it('NEGATIVE CONTROL [single class]: a household with one owner class gets no breakup text at all (the report is unchanged)', () => {
    expect(ownerBreakupNarrative(breakupPersonalOnly)).toBeNull();
    expect(ownerBreakupNarrative(null)).toBeNull();
  });
  it('without any entity the "personal and joint only" sentence is not added (the chapters cover everything)', () => {
    const joint = buildOwnerBreakup([{ id: 'a1', ownership: own([], 'm1') }, { id: 'a2', ownership: own([{ m: 'm1', bp: 5000 }, { m: 'm2', bp: 5000 }]) }], [{ accountId: 'a1', currencyCode: 'INR', value: 1 }, { accountId: 'a2', currencyCode: 'INR', value: 2 }], labels);
    expect(hasEntityClasses(joint)).toBe(false);
    expect(ownerBreakupNarrative(joint)).not.toContain('personal and joint holdings only');
  });
  it('entityExclusionNote only when an entity class exists', () => {
    expect(entityExclusionNote(breakupWithEntity)).toContain('not included in this chapter');
    expect(entityExclusionNote(breakupPersonalOnly)).toBeNull();
  });
});

describe('premium report sections', () => {
  const source = { premium: null } as unknown as ReportSourceData;
  const results = { portfolios: [], engineVersion: 'v', asOfDate: '2026-09-30' };
  const mk = (ownerBreakup: PremiumSourceData['ownerBreakup']): PremiumSourceData =>
    ({
      ownerBreakup,
      canonicalInvestments: null,
      investmentPerformance: { results, warnings: [], earliestCashFlowDateByInstrument: {} },
      sip: { results: { analytics: [], presentableCount: 0, seriesCount: 0, asOfDate: '2026-09-30', engineVersion: 'v' }, warnings: [], earliestTransactionDateByInstrument: {} },
      xray: { results: { asOfDate: '2026-09-30', sectorExposure: { status: 'unavailable' }, securityConcentration: {}, schemeConcentration: {}, engineVersion: 'v', classificationVersion: 'c' }, warnings: [] },
      taxAndCost: { results: { disposalResults: [], exitLoadResults: [], disclaimer: 'd', taxYearAggregation: [], engineVersion: 'v' }, asOfDate: '2026-09-30', taxProfileSource: 'none' },
    }) as unknown as PremiumSourceData;

  it('performance chapter: carries the breakup in sectionData and lists every class in its limitation text; the other three chapters say entity holdings are excluded', () => {
    const p = mk(breakupWithEntity);
    const perf = buildInvestmentPerformance(source, p);
    expect((perf.sectionData as { ownerBreakup?: unknown }).ownerBreakup).toBe(breakupWithEntity);
    expect(perf.limitationText).toContain('Holdings by owner class');
    expect(perf.limitationText).toContain('Consolidated (macro view only)');
    for (const b of [buildSipContribution, buildPortfolioXray, buildTaxAndCost]) {
      expect(b(source, p).limitationText).toContain('Trust, HUF and company holdings are not included in this chapter');
    }
  });

  it('NEGATIVE CONTROL [no change for a single-class household]: without a breakup the sections are exactly as before', () => {
    const p = mk(null);
    const perf = buildInvestmentPerformance(source, p);
    expect(perf.sectionData).toEqual({ results });
    expect(perf.limitationText).not.toContain('owner class');
    for (const b of [buildSipContribution, buildPortfolioXray, buildTaxAndCost]) {
      expect(b(source, p).limitationText).not.toContain('Trust, HUF');
    }
  });
});

describe('loadOwnerClassScopeForReport', () => {
  const tbl = (withEntity: boolean): Record<string, Row[]> => ({
    ii_accounts: [
      { id: 'a-asha', user_id: USER, owner_member_id: 'm1' },
      { id: 'a-trust', user_id: USER, owner_member_id: null },
    ],
    ii_ownership_allocation: withEntity ? [{ id: 'o1', user_id: USER, ii_account_id: 'a-trust', owner_member_id: null, owner_business_entity_id: 'e1', allocation_basis_points: 10000, ii_instrument_id: null, status: 'active' }] : [],
    household_members: [{ id: 'm1', user_id: USER, full_name: 'Asha Rao', relationship: 'self' }],
    business_entities: [{ id: 'e1', user_id: USER, name: 'Rao Family Trust', entity_type: 'family_trust' }],
    ii_transactions: [
      { id: 't1', user_id: USER, account_id: 'a-asha' },
      { id: 't2', user_id: USER, account_id: 'a-trust' },
    ],
    ii_holding_snapshots: [
      { id: 's1', user_id: USER, account_id: 'a-asha', instrument_id: 'f', as_of_date: '2026-09-30', value: 10, currency_code: 'INR' },
      { id: 's2', user_id: USER, account_id: 'a-trust', instrument_id: 'f', as_of_date: '2026-09-30', value: 90, currency_code: 'INR' },
    ],
  });
  const ids = async (client: unknown) => ((await (client as { from: (t: string) => { select: (c: string) => PromiseLike<{ data: { id: string }[] }> } }).from('ii_transactions').select('id')).data ?? []).map((r) => r.id);

  it('no entity accounts -> the SAME client (zero behaviour change) and no breakup for a single class', async () => {
    const { client } = makeFakeSupabase({ ...tbl(false), ii_accounts: [{ id: 'a-asha', user_id: USER, owner_member_id: 'm1' }] });
    const s = await loadOwnerClassScopeForReport(USER, client as never);
    expect(s.client).toBe(client);
    expect(s.breakup).toBeNull();
  });

  it('with an entity account -> a read-only client narrowed to the non-entity accounts, and the breakup lists both classes', async () => {
    const { client } = makeFakeSupabase(tbl(true));
    const s = await loadOwnerClassScopeForReport(USER, client as never);
    expect(s.client).not.toBe(client);
    expect(await ids(s.client)).toEqual(['t1']); // the trust's transaction never reaches the personal chapters
    expect(await ids(client)).toEqual(['t1', 't2']); // control: unscoped sees both
    expect(s.breakup?.classes.map((c) => c.info.key)).toEqual(['member:m1', 'entity:e1']);
    expect(s.breakup?.consolidated.valueByCurrency[0].totalValue).toBe(100);
  });
});

describe('wiring (structural)', () => {
  const read = (rel: string) => readFileSync(path.join(path.resolve(__dirname, '../..'), rel), 'utf8');
  it('the report resolver runs the four II chapters on the scoped client and stores the breakup', () => {
    const src = read('lib/services/reportSnapshotResolver.ts');
    for (const l of ['loadInvestmentPerformanceForReport', 'loadSipForReport', 'loadXrayForReport', 'loadTaxForReport']) expect(src).toContain(`${l}(userId, iiScope.client)`);
    expect(src).toContain('ownerBreakup: iiScope.breakup');
  });
  it('the certified engines are untouched: no engine file mentions owner classes', () => {
    for (const f of ['lib/engines/investment-intelligence/analyticsOrchestrator.ts', 'lib/engines/investment-intelligence/sip/sipOrchestrator.ts', 'lib/engines/investment-intelligence/xray/xrayOrchestrator.ts', 'lib/engines/investment-intelligence/tax/taxOrchestrator.ts']) {
      expect(read(f)).not.toMatch(/ownerClass|owner_class|OwnerClass/);
    }
  });
});
