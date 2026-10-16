/**
 * Net Worth at two levels (PO decision 16-10-2026): the REAL loaders (Dashboard loader and the Monthly Report
 * source resolver) driven against the in-memory PostgREST fake, on the PO's production household:
 *
 *   assets register 1,670,298 + investments 590,000 + retirement 636,000 = total assets 2,896,298
 *   liabilities 1,385,857            net worth (previously reported) 1,510,441
 *   Retirement = SMSF 503,000 (owner self) + Other Retirement Assets 133,000 (owner smsf) + Spouse Contribution 0 (owner spouse)
 *
 * Property and loan OWNERSHIP is not in the report, so it is a synthetic assignment of the report's totals:
 *   House (null master key, trailing space, owner joint)  1,395,000      Savings (self) 21,798      Other assets (spouse) 253,500
 *   Shares (self) 25,000      Investment property (joint) 565,000
 *   Home loan (joint) 800,000      Investment loan (self) 585,857
 *
 * Hand-calculated oracle, joint items split 50/50 (no split recorded):
 *   Self   assets 21,798 + 25,000 + 503,000 + (1,395,000 + 565,000)/2 = 1,529,798; liabilities 585,857 + 400,000 = 985,857; net 543,941
 *   Spouse assets 253,500 + 0 + 980,000 = 1,233,500; liabilities 400,000; net 833,500
 *   Personal net 1,377,441;  SMSF entity 133,000;  Family net 1,377,441 + 133,000 = 1,510,441 = the previously reported figure.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => {
    throw new Error('createClient() must not be called -- every test passes an explicit client.');
  },
}));
vi.mock('@/lib/services/healthScoreData', () => ({ loadHealthScore: vi.fn().mockRejectedValue(new Error('not under test')) }));
vi.mock('@/lib/services/resilienceData', () => ({ loadResilience: vi.fn().mockRejectedValue(new Error('not under test')) }));
vi.mock('@/lib/services/financialDnaData', () => ({ loadFinancialDna: vi.fn().mockRejectedValue(new Error('not under test')) }));
vi.mock('@/lib/services/goalsData', () => ({
  computeGoalsPagePayload: vi.fn().mockResolvedValue({
    payload: {
      goals: [],
      summary: { activeGoalsCount: 0, totalTargetAmount: 0, totalCurrentAmount: 0, overallProgressPct: 0, totalMonthlyContribution: 0, onTrackCount: 0, atRiskCount: 0, offTrackCount: 0, achievedCount: 0, nextGoalDue: null },
      affordability: { status: 'insufficient_data', monthlySurplus: null, totalPlannedGoalContributions: 0, unallocatedAmount: null, overallocatedAmount: null, usageRatio: null, warning: null },
      modelVersion: 'test',
      goalTypes: [],
    },
  }),
}));
vi.mock('@/lib/services/financialTwinService', () => ({ listTwinRuns: vi.fn().mockResolvedValue([]), getTwinRunDetail: vi.fn() }));
vi.mock('@/lib/services/recommendationsData', () => ({ buildReportActionMatches: vi.fn().mockResolvedValue([]) }));
vi.mock('@/lib/services/forecastReportData', () => ({ buildForecastReportData: vi.fn().mockRejectedValue(new Error('not under test')) }));
vi.mock('@/lib/services/investmentIntelligenceReportData', () => ({
  loadInvestmentPerformanceForReport: vi.fn().mockResolvedValue(null),
  loadSipForReport: vi.fn().mockResolvedValue(null),
  loadXrayForReport: vi.fn().mockResolvedValue(null),
  loadTaxForReport: vi.fn().mockResolvedValue(null),
  loadReviewItemsForReport: vi.fn().mockResolvedValue(null),
}));

import { loadDashboard } from '@/lib/services/dashboardData';
import { resolveReportSourceData, buildEligibilityInput } from '@/lib/services/reportSnapshotResolver';
import { buildReportSections } from '@/lib/engines/reportSections';
import { netWorthHeadline } from '@/components/dashboard/netWorthHeadline';
import type { NetWorthLevels } from '@/lib/engines/netWorthLevels';
import { makeFakeSupabase, type Row } from './readModels/helpers/fakeSupabase';
import { liability, profile, tables, USER } from './readModels/helpers/fixtures';

afterEach(() => vi.restoreAllMocks());

function asset(id: string, name: string, value: number, owner: string, extra: Row = {}): Row {
  return { id, user_id: USER, asset_name: name, asset_class: 'other', current_value: value, currency_code: 'AUD', owner, master_item_key: null, source_type: 'manual', linked_liability_id: null, country_code: 'AU', is_active: true, ...extra };
}
function investment(id: string, name: string, value: number, owner: string, key: string, extra: Row = {}): Row {
  return { id, user_id: USER, investment_name: name, investment_type: key, current_value: value, cost_base: value, currency_code: 'AUD', owner, master_item_key: key, source_type: 'manual', ii_canonical_account_id: null, ii_canonical_instrument_id: null, country_code: 'AU', annual_contribution: 0, institution: 'X', is_active: true, ...extra };
}
function retirement(id: string, name: string, balance: number, owner: string, extra: Row = {}): Row {
  return { id, user_id: USER, account_name: name, account_type: 'super', current_balance: balance, currency_code: 'AUD', owner, employer_contribution: 0, personal_contribution: 0, contribution_frequency: 'monthly', source_type: 'manual', retirement_member_id: null, country_code: 'AU', target_retirement_age: null, is_active: true, ...extra };
}

function poHousehold(extra: Record<string, Row[]> = {}): Record<string, Row[]> {
  return tables(
    profile('AUD', 'AU', 56),
    {
      assets: [
        asset('a-house', 'House ', 1_395_000, 'joint'),
        asset('a-cash', 'Savings', 21_798, 'self', { asset_class: 'cash', master_item_key: 'savings_account' }),
        asset('a-other', 'Other assets', 253_500, 'spouse', { master_item_key: 'collectibles' }),
      ],
      investments: [
        investment('v-shares', 'Shares', 25_000, 'self', 'shares'),
        investment('v-prop', 'Investment property', 565_000, 'joint', 'property'),
      ],
      retirement_accounts: [
        retirement('r-smsf', 'SMSF', 503_000, 'self'),
        retirement('r-other', 'Other Retirement Assets', 133_000, 'smsf'),
        retirement('r-sp', 'Spouse Contribution', 0, 'spouse'),
      ],
      liabilities: [
        liability('l-home', { liability_name: 'Home loan', debt_type: 'mortgage', master_item_key: 'home_loan', balance: 800_000, owner: 'joint', monthly_repayment: 4000, country_code: 'AU' }),
        liability('l-inv', { liability_name: 'Investment loan', debt_type: 'mortgage', master_item_key: 'investment_loan', balance: 585_857, owner: 'self', monthly_repayment: 3000, country_code: 'AU' }),
      ],
    },
    extra,
  );
}

async function dashboard(t: Record<string, Row[]>, options: Parameters<typeof makeFakeSupabase>[1] = {}) {
  const fake = makeFakeSupabase(t, options);
  return loadDashboard(USER, fake.client as never);
}
const party = (l: NetWorthLevels, key: string) => l.personal.parties.find((p) => p.key === key)!;

describe('Dashboard loader: PO household (hand-calculated oracle)', () => {
  it('summary.netWorth is the PERSONAL figure (PO decision 16-10-2026): assets 2,763,298, liabilities 1,385,857, net worth 1,377,441; the previously reported 1,510,441 is the history basis', async () => {
    const d = await dashboard(poHousehold());
    expect(d.totalAssetsCombined).toBe(2_763_298);
    expect(d.totalRetirement).toBe(503_000);
    expect(d.totalLiabilities).toBe(1_385_857);
    expect(d.netWorth).toBe(1_377_441);
    expect(d.netWorthBasis!.history).toMatchObject({ netWorth: 1_510_441, totalAssets: 2_896_298, totalLiabilities: 1_385_857, comparableToPersonal: false });
    expect(d.netWorthBasis!.entityHeld).toMatchObject({ retirement: 133_000, liabilities: 0, net: 133_000 });
  });

  it('builds the two levels: Self 543,941, Spouse 833,500, personal 1,377,441, SMSF 133,000, family 1,510,441', async () => {
    const d = await dashboard(poHousehold());
    const l = d.netWorthLevels!;
    expect(l).toBeTruthy();
    expect(party(l, 'self').total).toMatchObject({ totalAssets: 1_529_798, liabilities: 985_857, net: 543_941 });
    expect(party(l, 'spouse').total).toMatchObject({ totalAssets: 1_233_500, liabilities: 400_000, net: 833_500 });
    expect(l.personal.total.net).toBe(1_377_441);
    expect(l.entities.byKind.smsf).toMatchObject({ retirement: 133_000, liabilities: 0, net: 133_000 });
    expect(l.family.net).toBe(1_510_441);
    expect(l.family.totalAssets).toBe(2_896_298);
    expect(l.family.liabilities).toBe(1_385_857);
  });

  it("the previously reported figure stays reproducible: the family level equals the history-basis net worth with an empty bridge, and the personal summary equals the personal level", async () => {
    const d = await dashboard(poHousehold());
    const l = d.netWorthLevels!;
    expect(l.bridge.previouslyReported).toBe(d.netWorthBasis!.history.netWorth);
    expect(l.bridge.personalSummaryNet).toBe(d.netWorth);
    expect(l.bridge.personalParityOk).toBe(true);
    expect(l.bridge.parityOk).toBe(true);
    expect(l.bridge.lines).toEqual([]);
  });

  it("the joint House (1,395,000) is counted once: the two shares add back to the pool, never 200%", async () => {
    const d = await dashboard(poHousehold());
    const l = d.netWorthLevels!;
    expect(l.personal.jointPool.totalAssets).toBe(1_960_000);
    expect(party(l, 'self').jointShare.totalAssets + party(l, 'spouse').jointShare.totalAssets).toBe(1_960_000);
    expect(l.personal.jointSplitBasis).toBe('default_equal');
  });

  it("'House ' (trailing space, null master key) is grouped as property, not other, in the wealth allocation", async () => {
    const d = await dashboard(poHousehold());
    const byBucket = Object.fromEntries(d.netWorthAllocation.map((a) => [a.bucket, a.value]));
    // House 1,395,000 + Investment property 565,000 (investments register, key 'property')
    expect(byBucket.property).toBe(1_960_000);
    expect(byBucket.other).toBe(253_500);
  });

  it('headline is individual-first with the family figure beside it', async () => {
    const d = await dashboard(poHousehold());
    const h = netWorthHeadline(d);
    expect(h.label).toBe('Net Worth (personal)');
    expect(h.value).toBe(1_377_441);
    expect(h.sub).toContain('1,510,441');
    expect(h.sub).toMatch(/SMSF/);
  });

  it('a household with no entities: family equals personal and the headline says so', async () => {
    const t = tables(profile('AUD', 'AU', 56), { assets: [asset('a', 'Savings', 10_000, 'self', { asset_class: 'cash' })] });
    const d = await dashboard(t);
    expect(d.netWorthLevels!.family.net).toBe(10_000);
    expect(d.netWorthLevels!.personal.total.net).toBe(10_000);
    expect(d.netWorthLevels!.hasEntities).toBe(false);
    expect(netWorthHeadline(d).sub).toContain('no entities recorded');
  });
});

describe('recorded joint split (60/40) from the Investment Intelligence ownership allocation', () => {
  it('divides the joint investment 600,000 / 400,000 by member role and still totals 1,000,000', async () => {
    const t = tables(profile('AUD', 'AU', 56), {
      household_members: [
        { id: 'm-self', user_id: USER, relationship: 'self', is_active: true },
        { id: 'm-sp', user_id: USER, relationship: 'spouse', is_active: true },
      ],
      investments: [investment('v', 'Joint fund', 1_000_000, 'joint', 'managed_funds', { source_type: 'investment_intelligence_published', ii_canonical_account_id: 'acc-1', ii_canonical_instrument_id: 'ins-1' })],
      ii_ownership_allocation: [
        { id: 'al1', user_id: USER, status: 'active', ii_account_id: 'acc-1', ii_instrument_id: null, owner_member_id: 'm-self', owner_business_entity_id: null, allocation_basis_points: 6000 },
        { id: 'al2', user_id: USER, status: 'active', ii_account_id: 'acc-1', ii_instrument_id: null, owner_member_id: 'm-sp', owner_business_entity_id: null, allocation_basis_points: 4000 },
      ],
    });
    const d = await dashboard(t);
    const l = d.netWorthLevels!;
    expect(party(l, 'self').total.net).toBe(600_000);
    expect(party(l, 'spouse').total.net).toBe(400_000);
    expect(l.family.net).toBe(1_000_000);
    expect(d.netWorth).toBe(1_000_000);
    expect(l.personal.jointSplitBasis).toBe('recorded');
  });

  it('when household members cannot be read the split falls back to 50/50, is flagged, and nothing is zeroed', async () => {
    const t = tables(profile('AUD', 'AU', 56), {
      household_members: [{ id: 'm-self', user_id: USER, relationship: 'self', is_active: true }],
      investments: [investment('v', 'Joint fund', 1_000_000, 'joint', 'managed_funds', { source_type: 'investment_intelligence_published', ii_canonical_account_id: 'acc-1', ii_canonical_instrument_id: 'ins-1' })],
      ii_ownership_allocation: [
        { id: 'al1', user_id: USER, status: 'active', ii_account_id: 'acc-1', ii_instrument_id: null, owner_member_id: 'm-self', owner_business_entity_id: null, allocation_basis_points: 6000 },
        { id: 'al2', user_id: USER, status: 'active', ii_account_id: 'acc-1', ii_instrument_id: null, owner_member_id: 'm-sp', owner_business_entity_id: null, allocation_basis_points: 4000 },
      ],
    });
    const d = await dashboard(t, { failOn: new Set(['household_members']) });
    const l = d.netWorthLevels!;
    expect(l.family.net).toBe(1_000_000);
    expect(party(l, 'self').total.net).toBe(500_000);
    expect(l.dataStatus.unavailable).toContainEqual({ section: 'household_members', reason: 'query_failed' });
  });
});

describe('SMSF property loan counted once (loader level)', () => {
  const smsfHousehold = (extra: Record<string, Row[]> = {}) =>
    tables(profile('AUD', 'AU', 56), {
      // Detailed-mode fund: 500,000 property less the linked 365,000 loan = 135,000 carried as the member's retirement balance.
      retirement_accounts: [retirement('r-fund', 'SMSF', 135_000, 'self', { master_item_key: 'smsf' })],
      liabilities: [liability('l-smsf', { liability_name: 'SMSF property loan', debt_type: 'mortgage', master_item_key: 'investment_loan', balance: 365_000, owner: 'self' })],
      property_liability_links: [{ id: 'pl', user_id: USER, liability_id: 'l-smsf', linked_retirement_id: 'r-fund', link_type: 'smsf_property_loan', is_active: true }],
      smsf_funds: [{ id: 'f', user_id: USER, retirement_account_id: 'r-fund', mode: 'detailed' }],
    }, extra);

  it('the SMSF fund row (135,000, net of its loan) is the SMSF block, not personal (PO decision 16-10-2026); the history basis keeps the old -230,000; the family figure counts the loan once (135,000)', async () => {
    const d = await dashboard(smsfHousehold());
    expect(d.netWorth).toBe(0);
    expect(d.totalLiabilities).toBe(0);
    expect(d.netWorthBasis!.history.netWorth).toBe(135_000 - 365_000);
    const l = d.netWorthLevels!;
    expect(l.family.net).toBe(135_000);
    expect(l.family.liabilities).toBe(0);
    expect(l.entities.blocks.find((b) => b.kind === 'smsf')!.nettedLoans).toEqual({ count: 1, amount: 365_000 });
    expect(l.bridge.parityOk).toBe(true);
    expect(l.bridge.lines.map((x) => [x.key, x.amount])).toEqual([['smsf_loan_counted_once', -365_000]]);
  });

  it('Summary-mode funds are net too (migration 0084): the loan is not subtracted again either', async () => {
    const t = smsfHousehold();
    t.smsf_funds = [{ id: 'f', user_id: USER, retirement_account_id: 'r-fund', mode: 'summary' }];
    const d = await dashboard(t);
    expect(d.netWorthLevels!.family.net).toBe(135_000);
    expect(d.netWorthLevels!.bridge.parityOk).toBe(true);
  });

  it('a loan whose fund is not found is NOT treated as netted: it is deducted once, at the SMSF entity', async () => {
    const t = smsfHousehold();
    t.smsf_funds = [];
    const d = await dashboard(t);
    const l = d.netWorthLevels!;
    expect(l.entities.byKind.smsf.liabilities).toBe(365_000);
    expect(l.family.net).toBe(135_000 - 365_000);
    expect(l.bridge.lines).toEqual([]);
  });

  it('when the link tables cannot be read, nothing is netted (previous behaviour) and the gap is reported', async () => {
    const d = await dashboard(smsfHousehold(), { failOn: new Set(['smsf_funds']) });
    const l = d.netWorthLevels!;
    expect(l.family.net).toBe(135_000 - 365_000);
    expect(l.dataStatus.unavailable).toContainEqual({ section: 'smsf_loan_links', reason: 'query_failed' });
  });
});

describe('registered entities at family level (PO decision 16-10-2026)', () => {
  const entity = (id: string, type: string, pct: number, nav: number): Row => ({
    id, user_id: USER, entity_type: type, name: `${type} ${id}`, country_code: 'AU', currency_code: 'AUD', ownership_percentage: pct,
    valuation_mode: 'summary', summary_net_asset_value: nav, is_active: true, created_at: '2026-01-01T00:00:00Z',
  });
  it('company at its 40% share, trust in full, HUF in full; the previous figure (trust at 50%) is bridged', async () => {
    const t = tables(profile('AUD', 'AU', 56), {
      assets: [asset('a', 'Savings', 100_000, 'self', { asset_class: 'cash' })],
      business_entities: [entity('co', 'company', 40, 500_000), entity('tr', 'family_trust', 50, 300_000), entity('hu', 'huf', 100, 200_000)],
    });
    const d = await dashboard(t);
    // PERSONAL: only the savings. The previously reported (history) basis counted every entity at its ownership percentage:
    // 100,000 + 200,000 + 150,000 + 200,000.
    expect(d.netWorth).toBe(100_000);
    expect(d.netWorthBasis!.history.netWorth).toBe(650_000);
    const l = d.netWorthLevels!;
    expect(l.personal.total.net).toBe(100_000);
    expect(l.entities.byKind.company.net).toBe(200_000);
    expect(l.entities.byKind.family_trust.net).toBe(300_000);
    expect(l.entities.byKind.huf.net).toBe(200_000);
    expect(l.family.net).toBe(800_000);
    expect(l.bridge.parityOk).toBe(true);
    expect(l.bridge.lines.map((x) => [x.key, x.amount])).toEqual([['trust_huf_included_in_full', -150_000]]);
  });
  it('a failed entity read is reported, not zeroed silently, and the previous figure still reproduces', async () => {
    const t = tables(profile('AUD', 'AU', 56), { assets: [asset('a', 'Savings', 100_000, 'self', { asset_class: 'cash' })], business_entities: [entity('co', 'company', 40, 500_000)] });
    const d = await dashboard(t, { failOn: new Set(['business_entities']) });
    expect(d.netWorthLevels!.dataStatus.unavailable).toContainEqual({ section: 'business_entities', reason: 'query_failed' });
    expect(d.dataStatus?.unavailable?.some((u) => u.section === 'business_entities')).toBe(true);
  });
});

describe('Monthly Report reads the SAME model as the Dashboard (single source of truth)', () => {
  async function build(t: Record<string, Row[]>, plan: 'free' | 'premium') {
    const { client } = makeFakeSupabase(tables(t, { user_entitlements: [{ user_id: USER, plan_tier: plan }] }));
    const source = await resolveReportSourceData(USER, undefined, client as never);
    const sections = buildReportSections(source, buildEligibilityInput(source), false);
    return { source, nw: sections.find((s) => s.sectionCode === 'net_worth')! };
  }

  it.each(['free', 'premium'] as const)('%s plan: the Net Worth section carries the dashboard model and states both levels', async (plan) => {
    const { source, nw } = await build(poHousehold(), plan);
    expect(nw.sectionStatus).toBe('included');
    const data = nw.sectionData as { levels: NetWorthLevels; netWorth: number; totalAssets: number };
    expect(data.levels).toEqual(source.dashboard.netWorthLevels);
    expect(data.levels.personal.total.net).toBe(1_377_441);
    expect(data.levels.family.net).toBe(1_510_441);
    // The section's own totals are PERSONAL; the family figure is its own labelled value.
    expect(data.netWorth).toBe(1_377_441);
    expect(data.totalAssets).toBe(2_763_298);
    expect((data as unknown as { familyNetWorth: number }).familyNetWorth).toBe(1_510_441);
    const summary = (nw.chartData as { summary: string }).summary;
    expect(summary).toContain('Personal net worth');
    expect(summary).toContain('$1,377,441');
    expect(summary).toContain('Family net worth');
    expect(summary).toContain('$1,510,441');
    expect(summary).toMatch(/SMSF \$133,000/);
  });

  it('an older stored report without levels still reads: the section data simply has no levels', async () => {
    const t = tables(profile('AUD', 'AU', 56), { assets: [asset('a', 'Savings', 10_000, 'self', { asset_class: 'cash' })] });
    const { nw } = await build(t, 'free');
    const levels = (nw.sectionData as { levels: NetWorthLevels | null }).levels;
    expect(levels?.family.net).toBe(10_000); // new reports always carry it
    const stripped = { ...(nw.sectionData as object), levels: undefined } as { levels?: unknown };
    expect(stripped.levels).toBeUndefined();
  });
});
