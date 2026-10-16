/**
 * Net Worth Statements read the SAME model as the Dashboard and the Monthly Report: the REAL loaders driven against the in-memory
 * PostgREST fake (same harness as netWorthLevelsDashboardReportParity.test.ts), on the PO's household in the three SMSF data shapes.
 *
 * Hand oracle (AUD, joint 50/50). Personal level of the PO household (shape B):
 *   assets 2,260,298, liabilities 1,385,857, net 874,441  (full workings: tests/unit/netWorthStatement.test.ts)
 *   (A) today's rows   : + SMSF 503,000 owner self (retirement) + 133,000 owner smsf -> personal 1,377,441, SMSF 133,000, family 1,510,441
 *   (B) interim        : the 503,000 personal row removed                            -> personal   874,441, SMSF 133,000, family 1,007,441
 *   (C) entity-level   : SMSF asset 503,000 + SMSF liability 370,000 (owner smsf)    -> personal   874,441, SMSF 133,000, family 1,007,441
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
import { loadNetWorthStatementData } from '@/lib/services/netWorthStatementData';
import { resolveReportSourceData, buildEligibilityInput } from '@/lib/services/reportSnapshotResolver';
import { buildReportSections } from '@/lib/engines/reportSections';
import { netWorthHeadline } from '@/components/dashboard/netWorthHeadline';
import type { NetWorthLevels } from '@/lib/engines/netWorthLevels';
import type { NetWorthStatementSet } from '@/lib/engines/netWorthStatement';
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
const loan = (id: string, name: string, balance: number, owner: string, extra: Row = {}) =>
  liability(id, { liability_name: name, debt_type: 'mortgage', master_item_key: 'home_loan', balance, owner, monthly_repayment: 1000, country_code: 'AU', ...extra });

/** The PO household's PERSONAL rows (shape B before any SMSF row). */
function poPersonal(): Record<string, Row[]> {
  return {
    assets: [
      asset('a1', 'Principal Residence', 750_000, 'self', { master_item_key: 'principal_residence' }),
      asset('a2', 'Holiday Home', 300_000, 'self', { master_item_key: 'holiday_home' }),
      asset('a3', 'Vacant Land', 345_000, 'joint', { master_item_key: 'vacant_land' }),
      asset('a4', 'House', 127_500, 'joint'), // no master key, whole-name 'house' -> property (2026-10-16 production report)
      asset('a5', 'Jewellery', 100_000, 'self'),
      asset('a6', 'Motor Vehicle', 26_000, 'spouse', { asset_class: 'vehicle' }),
      asset('a7', 'Offset Account', 20_898, 'self', { master_item_key: 'offset_account' }),
      asset('a8', 'Savings Account', 900, 'self', { master_item_key: 'savings_account' }),
    ],
    investments: [investment('v1', 'Investment Property', 565_000, 'self', 'property'), investment('v2', 'Shares', 25_000, 'self', 'shares')],
    liabilities: [
      loan('l1', 'Home Loan', 520_904, 'self'),
      loan('l2', 'Investment Loan', 451_714, 'joint'),
      loan('l3', 'Construction Loan', 290_100, 'joint'),
      loan('l4', 'Investment loan 1', 63_710, 'joint'),
      loan('l5', 'Construction loan 1', 59_429, 'joint'),
    ],
  };
}
const household = (extra: Record<string, Row[]> = {}) => tables(profile('AUD', 'AU', 56), poPersonal(), extra);

async function statements(t: Record<string, Row[]>, options: Parameters<typeof makeFakeSupabase>[1] = {}): Promise<{ set: NetWorthStatementSet; levels: NetWorthLevels; netWorth: number }> {
  const fake = makeFakeSupabase(t, options);
  const data = await loadNetWorthStatementData(USER, fake.client as never);
  if (data.status !== 'ok') throw new Error(`unavailable: ${data.reason}`);
  const d = await loadDashboard(USER, fake.client as never);
  return { set: data.set, levels: d.netWorthLevels!, netWorth: d.netWorth };
}

describe('personal statement through the real loaders (shape B, no SMSF rows)', () => {
  it('assets 2,260,298, liabilities 1,385,857, net 874,441 -- identical to the Dashboard model', async () => {
    const { set, levels } = await statements(household());
    expect(set.personal.totals).toEqual({ assets: 2_260_298, liabilities: 1_385_857, net: 874_441 });
    expect(set.personal.totals).toEqual({ assets: levels.personal.total.totalAssets, liabilities: levels.personal.total.liabilities, net: levels.personal.total.net });
    expect(set.family.totals.net).toBe(levels.family.net);
    expect(set.parity).toEqual({ ok: true, messages: [] });
  });

  it("groups use the Dashboard's own asset bucketing: 'House ' with no master key is Property; the investments register stays Investments", async () => {
    const { set } = await statements(household());
    const g = Object.fromEntries(set.personal.assetGroups.map((x) => [x.key, x]));
    expect(g.property.subtotal).toBe(1_522_500);
    expect(g.property.lines.map((l) => l.name).sort()).toEqual(['Holiday Home', 'House', 'Principal Residence', 'Vacant Land']);
    expect(g.cash.subtotal).toBe(21_798);
    expect(g.investments.subtotal).toBe(590_000);
    expect(g.other.subtotal).toBe(126_000);
  });

  it('owners are shown as the app labels them, never raw ids', async () => {
    const { set } = await statements(household());
    const owners = new Set([...set.personal.assetGroups.flatMap((g) => g.lines), ...set.personal.liabilities].map((l) => l.ownerLabel));
    expect([...owners].sort()).toEqual(['Joint', 'Self', 'Spouse/Partner']);
    expect(JSON.stringify(set)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/); // no uuid in anything the person reads... except ids
  });

  it('the headline on the Dashboard is the personal figure in the statement', async () => {
    const fake = makeFakeSupabase(household());
    const d = await loadDashboard(USER, fake.client as never);
    const data = await loadNetWorthStatementData(USER, fake.client as never);
    if (data.status !== 'ok') throw new Error('unavailable');
    expect(netWorthHeadline(d).value).toBe(data.set.personal.totals.net);
    expect(data.set.family.dashboard.headline).toEqual({ label: netWorthHeadline(d).label, value: netWorthHeadline(d).value });
    expect(data.set.family.dashboard.headlineMatches).toBe(true);
  });

  it('the Monthly Report carries the same model object: its Net Worth section equals what the statement reads', async () => {
    const { client } = makeFakeSupabase(tables(household(), { user_entitlements: [{ user_id: USER, plan_tier: 'free' }] }));
    const source = await resolveReportSourceData(USER, undefined, client as never);
    const nw = buildReportSections(source, buildEligibilityInput(source), false).find((s) => s.sectionCode === 'net_worth')!;
    const reportLevels = (nw.sectionData as { levels: NetWorthLevels }).levels;
    const { set } = await statements(household());
    expect(reportLevels.personal.total.net).toBe(set.personal.totals.net);
    expect(reportLevels.family.net).toBe(set.family.totals.net);
    expect(reportLevels.family.totalAssets).toBe(set.family.totals.assets);
    expect(reportLevels.family.liabilities).toBe(set.family.totals.liabilities);
  });
});

describe('the three SMSF shapes through the real loaders', () => {
  it('(A) today, on the personal basis: the SMSF fund record (key smsf, owner self) is entity-held and shown but NOT counted beside the fund-level row -> personal 874,441, SMSF 133,000, family 1,007,441', async () => {
    const t = household({
      retirement_accounts: [
        retirement('r1', 'SMSF', 503_000, 'self', { master_item_key: 'smsf' }),
        retirement('r2', 'Other Retirement Assets', 133_000, 'smsf'),
      ],
    });
    const { set, levels, netWorth } = await statements(t);
    expect(set.personal.totals.net).toBe(874_441);
    expect(set.personal.assetGroups.find((g) => g.key === 'retirement')).toBeUndefined(); // the fund record is not a personal asset
    expect(set.entities).toHaveLength(1);
    expect(set.entities[0]).toMatchObject({ entityKind: 'smsf', net: 133_000, contribution: 133_000, netOnlyInModel: true });
    expect(set.entities[0].shownNotCounted.map((l) => [l.name, l.amount])).toEqual([['SMSF', 503_000]]);
    expect(set.entities[0].notes.join(' ')).not.toMatch(/503000/); // no unformatted amount
    expect(set.family.totals.net).toBe(1_007_441);
    expect(set.family.totals.net).toBe(levels.family.net);
    expect(netWorth).toBe(874_441); // the Dashboard's own personal figure
    expect(set.family.dashboard.previouslyReported).toBe(1_510_441); // history basis, unchanged
    expect(set.family.dashboard.bridgeLines.map((l) => l.amount)).toEqual([503_000]);
    expect(levels.dataStatus.smsfPossibleDoubleCount).toMatch(/count it twice/);
    expect(set.personal.notes.join(' ')).toMatch(/count it twice/);
    expect(set.parity.ok).toBe(true);
  });

  it('(A0) a personal retirement row merely named SMSF, without the fund key, stays personal (the old rows-only reading: 1,377,441 / 1,510,441)', async () => {
    const t = household({ retirement_accounts: [retirement('r1', 'SMSF', 503_000, 'self'), retirement('r2', 'Other Retirement Assets', 133_000, 'smsf')] });
    const { set } = await statements(t);
    expect(set.personal.totals.net).toBe(1_377_441);
    expect(set.family.totals.net).toBe(1_510_441);
    expect(set.entities[0].shownNotCounted).toEqual([]);
    expect(set.parity.ok).toBe(true);
  });

  it('(B) interim: personal 874,441, SMSF net 133,000, family 1,007,441', async () => {
    const { set } = await statements(household({ retirement_accounts: [retirement('r2', 'Other Retirement Assets', 133_000, 'smsf')] }));
    expect(set.personal.totals.net).toBe(874_441);
    expect(set.entities[0]).toMatchObject({ net: 133_000, itemisation: 'net_only' });
    expect(set.family.totals.net).toBe(1_007_441);
    expect(set.parity.ok).toBe(true);
  });

  it('(C) entity-level: SMSF asset 503,000 and liability 370,000 itemised on the SMSF page; same personal and family totals as (B)', async () => {
    const t = household({
      assets: [asset('sa', 'SMSF assets', 503_000, 'smsf')],
      liabilities: [loan('sl', 'SMSF loan', 370_000, 'smsf')],
    });
    const { set } = await statements(t);
    expect(set.entities[0]).toMatchObject({ itemisation: 'itemised', assetsTotal: 503_000, liabilitiesTotal: 370_000, net: 133_000 });
    expect(set.personal.totals.net).toBe(874_441);
    expect(set.family.totals.net).toBe(1_007_441);
    expect(set.parity.ok).toBe(true);
  });

  it('negative control at loader level: an SMSF-owned row is in the SMSF page and NOT in the personal totals', async () => {
    const t = household({ assets: [asset('sa', 'SMSF assets', 503_000, 'smsf')] });
    const { set } = await statements(t);
    expect(set.personal.totals.assets).toBe(2_260_298);
    expect(set.personal.assetGroups.flatMap((g) => g.lines).map((l) => l.name)).not.toContain('SMSF assets');
    expect(set.entities[0].assets.map((l) => l.name)).toEqual(['SMSF assets']);
  });
});

describe('registered entities, currencies and loader fallbacks', () => {
  const entity = (id: string, type: string, pct: number, nav: number | null): Row => ({
    id, user_id: USER, entity_type: type, name: `${type} ${id}`, country_code: 'AU', currency_code: 'AUD', ownership_percentage: pct,
    valuation_mode: 'summary', summary_net_asset_value: nav, is_active: true, created_at: '2026-01-01T00:00:00Z',
  });

  it('Company at its 40% share, Trust in full: the statement matches the Dashboard family figure and the bridge explains the previous figure', async () => {
    const t = household({ business_entities: [entity('co', 'company', 40, 500_000), entity('tr', 'family_trust', 50, 300_000)] });
    const { set, levels } = await statements(t);
    const company = set.entities.find((e) => e.entityKind === 'company')!;
    expect(company).toMatchObject({ net: 500_000, includedPercent: 40, contribution: 200_000 });
    expect(set.entities.find((e) => e.entityKind === 'family_trust')).toMatchObject({ net: 300_000, contribution: 300_000 });
    expect(set.family.totals.net).toBe(874_441 + 200_000 + 300_000);
    expect(set.family.totals.net).toBe(levels.family.net);
    expect(set.family.dashboard.bridgeOk).toBe(true);
    expect(set.family.dashboard.bridgeLines.map((l) => l.amount)).toEqual([-150_000]);
    expect(set.parity.ok).toBe(true);
  });

  it('a registered company with no value entered is "Not provided" (null), not zero', async () => {
    const t = household({ business_entities: [entity('co', 'company', 40, null)] });
    const { set } = await statements(t);
    expect(set.entities[0].net).toBeNull();
    expect(set.entities[0].contribution).toBeNull();
  });

  it('an INR flat in an AUD household: AUD amount counted, recorded INR amount shown, one FX note with rate and date', async () => {
    const t = household({ assets: [asset('inr', 'Chennai flat', 5_600_000, 'self', { currency_code: 'INR', master_item_key: 'principal_residence' })] });
    const { set } = await statements(t);
    const line = set.personal.assetGroups.find((g) => g.key === 'property')!.lines.find((l) => l.name === 'Chennai flat')!;
    expect(line.amount).toBe(100_000);
    expect(line.native).toEqual({ amount: 5_600_000, currency: 'INR' });
    expect(set.personal.totals.assets).toBe(2_360_298);
    expect(set.personal.fxNote).toMatch(/1 AUD = 56 INR/);
    expect(set.personal.fxNote).toMatch(/as at \d{2}\/\d{2}\/\d{4}/);
  });

  it('a currency that cannot be converted is listed separately and outside the totals (the model counts it too)', async () => {
    const t = household({ assets: [asset('usd', 'USD account', 5_000, 'self', { currency_code: 'USD', asset_class: 'cash' })] });
    const { set, levels } = await statements(t);
    expect(levels.dataStatus.unconvertedCount).toBe(1);
    expect(set.personal.notIncluded.map((l) => l.name)).toEqual(['USD account']);
    expect(set.personal.totals.assets).toBe(2_260_298);
    expect(set.parity.ok).toBe(true);
  });

  it('SMSF-linked property loan already inside the fund balance: not a personal liability, a note on the SMSF page, family counts it once', async () => {
    const t = tables(profile('AUD', 'AU', 56), {
      retirement_accounts: [retirement('r-fund', 'SMSF', 135_000, 'smsf', { master_item_key: 'smsf' })],
      liabilities: [loan('l-smsf', 'SMSF property loan', 365_000, 'self')],
      property_liability_links: [{ id: 'pl', user_id: USER, liability_id: 'l-smsf', linked_retirement_id: 'r-fund', link_type: 'smsf_property_loan', is_active: true }],
      smsf_funds: [{ id: 'f', user_id: USER, retirement_account_id: 'r-fund', mode: 'detailed' }],
    });
    const { set, levels } = await statements(t);
    expect(set.personal.liabilities).toEqual([]);
    expect(set.entities[0].nettedLoans).toEqual({ count: 1, amount: 365_000 });
    expect(set.family.totals.net).toBe(135_000);
    expect(levels.family.net).toBe(135_000);
    expect(set.parity.ok).toBe(true);
  });

  it('when a register cannot be read the statement is unavailable (nothing shown with a hole in it)', async () => {
    const fake = makeFakeSupabase(household(), { failOn: new Set(['assets']) });
    const data = await loadNetWorthStatementData(USER, fake.client as never);
    expect(data.status).toBe('unavailable');
  });

  it('a household with nothing recorded gives an empty, honest statement (zero items, not an error)', async () => {
    const { set } = await statements(tables(profile('AUD', 'AU', 56), {}));
    expect(set.personal.assetGroups).toEqual([]);
    expect(set.personal.totals).toEqual({ assets: 0, liabilities: 0, net: 0 });
    expect(set.parity.ok).toBe(true);
  });
});

describe('Free vs Premium: the same statements for both plans (it only presents the person\u2019s own entered data)', () => {
  it.each(['free', 'premium'] as const)('%s plan loads the full statement set', async (plan) => {
    const t = household({
      retirement_accounts: [retirement('r2', 'Other Retirement Assets', 133_000, 'smsf')],
      user_entitlements: [{ user_id: USER, plan_tier: plan }],
    });
    const { set } = await statements(t);
    expect(set.personal.totals.net).toBe(874_441);
    expect(set.entities).toHaveLength(1);
    expect(set.family.totals.net).toBe(1_007_441);
  });

  it('the two plans produce byte-identical statements', async () => {
    const mk = (plan: string) => household({ retirement_accounts: [retirement('r2', 'Other Retirement Assets', 133_000, 'smsf')], user_entitlements: [{ user_id: USER, plan_tier: plan }] });
    const free = (await statements(mk('free'))).set;
    const premium = (await statements(mk('premium'))).set;
    expect(JSON.stringify(free)).toBe(JSON.stringify(premium));
  });
});

describe('the PO production household as diagnosed (fund record + fund-level row + Detailed-mode holdings + an inactive personal loan)', () => {
  const production = () => {
    const t = household({
      retirement_accounts: [
        retirement('r-fund', 'SMSF', 503_000, 'self', { master_item_key: 'smsf' }),
        retirement('r-other', 'Other Retirement Assets', 133_000, 'smsf'),
      ],
      smsf_funds: [{ id: 'f1', user_id: USER, retirement_account_id: 'r-fund', fund_name: 'Rao Super Fund', mode: 'detailed', is_active: true }],
      smsf_holdings: [
        { id: 'h1', user_id: USER, smsf_fund_id: 'f1', holding_class: 'property', holding_type: 'residential_property', holding_name: 'Investment property', value: 475_000, currency_code: 'AUD', is_active: true },
        { id: 'h2', user_id: USER, smsf_fund_id: 'f1', holding_class: 'cash', holding_type: 'cash_account', holding_name: 'Cash', value: 3_000, currency_code: 'AUD', is_active: true },
        { id: 'h3', user_id: USER, smsf_fund_id: 'f1', holding_class: 'other', holding_type: 'other_smsf_asset', holding_name: 'Other', value: 25_000, currency_code: 'AUD', is_active: true },
      ],
    });
    t.liabilities.push(loan('l-inactive', 'SMSF property loan', 365_000, 'self', { is_active: false }));
    return t;
  };

  it('personal 874,441 and family 1,007,441, identical to the Dashboard; the inactive personal loan is not a liability anywhere', async () => {
    const { set, levels, netWorth } = await statements(production());
    expect(netWorth).toBe(874_441);
    expect(set.personal.totals).toEqual({ assets: 2_260_298, liabilities: 1_385_857, net: 874_441 });
    expect(set.family.totals.net).toBe(1_007_441);
    expect(set.family.totals.net).toBe(levels.family.net);
    expect(set.personal.liabilities.map((l) => l.name)).not.toContain('SMSF property loan');
    expect(set.parity).toEqual({ ok: true, messages: [] });
  });

  it("the SMSF page itemises the fund's holdings: property 475,000 + cash 3,000 + other 25,000 = 503,000; the loan is 'not recorded at the fund'; net stays the model's 133,000", async () => {
    const { set } = await statements(production());
    const smsf = set.entities[0];
    expect(smsf).toMatchObject({ source: 'smsf_holdings', itemisation: 'itemised', assetsTotal: 503_000, liabilitiesTotal: null, liabilitiesNotRecorded: true, net: 133_000, contribution: 133_000 });
    expect(smsf.assets.map((l) => [l.name, l.amount])).toEqual([['Cash', 3_000], ['Investment property', 475_000], ['Other', 25_000]]);
    expect(smsf.liabilities).toEqual([]); // nothing invented
    expect(smsf.notes.join(' ')).toMatch(/not recorded at the fund/);
    expect(smsf.notes.join(' ')).toMatch(/holdings add to \$503,000, so \$370,000 of the difference is not itemised/);
    expect(smsf.notes.join(' ')).toMatch(/entered as: Other Retirement Assets/);
    expect(smsf.shownNotCounted.map((l) => l.amount)).toEqual([503_000]);
  });

  it('the family page still adds the SMSF at its net 133,000 (not the holdings) and notes the fund record that is not counted', async () => {
    const { set } = await statements(production());
    expect(set.family.levels.find((l) => l.key === 'tag:smsf')).toMatchObject({ net: 133_000, netOnly: true });
    expect(set.family.notes.join(' ')).toMatch(/SMSF fund record "SMSF" \$503,000 is shown but not counted/);
  });

  it('a Summary-mode fund has no holdings to itemise: the SMSF page stays net-only', async () => {
    const t = production();
    t.smsf_funds = [{ id: 'f1', user_id: USER, retirement_account_id: 'r-fund', fund_name: 'Rao Super Fund', mode: 'summary', is_active: true }];
    const { set } = await statements(t);
    expect(set.entities[0]).toMatchObject({ source: 'owner_tagged_rows', itemisation: 'net_only', liabilitiesNotRecorded: false });
    expect(set.entities[0].assets).toEqual([]);
  });

  it('when the fund tables cannot be read the SMSF page says so and does not guess', async () => {
    const { set } = await statements(production(), { failOn: new Set(['smsf_holdings']) });
    expect(set.entities[0].itemisation).toBe('net_only');
    expect(set.entities[0].notes.join(' ')).toMatch(/holdings could not be read/);
  });
});
