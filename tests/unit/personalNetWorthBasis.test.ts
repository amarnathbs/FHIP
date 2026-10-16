/**
 * PERSONAL BASIS (PO decision 16-10-2026): an amount held by an ENTITY (the SMSF fund's own rows, a trust, a company, the
 * fund's own property loan) is not part of any PERSONAL net worth figure and is never a member's balance. It lives only
 * in the entity block and in the consolidated FAMILY figure.
 *
 * The REAL loaders run against the in-memory PostgREST fake, on the PO's production household. Hand calculations:
 *
 *   Other assets (everything except retirement)  1,670,298 + 590,000 = 2,260,298
 *   Liabilities                                  1,385,857
 *   Personal net worth with no retirement         874,441            (2,260,298 - 1,385,857)
 *
 * (A1) data as it is today, the SMSF section's fund row (master_item_key 'smsf', owner self) 503,000 + Other Retirement Assets
 *     133,000 (owner smsf): the fund row is ENTITY-HELD whoever owns it. A fund-level row exists, so the fund is counted ONCE:
 *     the fund-level row (133,000) is counted in the SMSF block, the fund record is listed but not counted.
 *     personal assets 2,260,298; personal net 874,441; SMSF block 133,000; family 1,007,441 (= B and C);
 *     bridge to the previously reported 1,510,441: +503,000 (fund record not counted)
 * (A2) the same two amounts typed by hand with NO fund key (503,000 owner self, named SMSF): the model cannot know it is the
 *     fund, so it is personal: personal assets 2,763,298; personal net 1,377,441; family 1,510,441; a notice says so.
 * (B) interim corrected shape: the 503,000 row removed, 133,000 (owner smsf) kept as the fund's net balance
 *     personal assets 2,260,298; personal net 874,441; retirement personal 0; SMSF block 133,000; family 1,007,441
 * (C) entity-level shape: SMSF asset 503,000 (owner smsf) AND SMSF liability 370,000 (owner smsf), no 133,000 row
 *     personal 874,441; SMSF block assets 503,000 - liabilities 370,000 = 133,000; family 1,007,441 (= B); the loan is
 *     deducted exactly once, at the SMSF.
 *
 * Score arithmetic (state before -> after), personal assets base A = 2,763,298 vs previous 2,896,298:
 *   net worth ratio     1,510,441 / 2,896,298 = 0.52152   ->  1,377,441 / 2,763,298 = 0.49847
 *   property concentr.  1,960,000 / 2,896,298 = 0.67670   ->  1,960,000 / 2,763,298 = 0.70930
 *   liquid asset ratio     21,798 / 2,896,298 = 0.007526  ->     21,798 / 2,763,298 = 0.007888
 *   retirement balance  636,000 -> 503,000 (A); debt ratios (DTI/DSR) are unchanged: SMSF rows were never in them.
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
import { buildReportSections, previousDebtToIncome } from '@/lib/engines/reportSections';
import { buildCanonicalFinancialSnapshot } from '@/lib/read-models/snapshot';
import { buildCanonicalAppendix } from '@/lib/engines/reportCanonicalAppendix';
import { computeDashboard } from '@/lib/engines/dashboard';
import { computeNetWorthLevels, type NetWorthLevels, type NetWorthRowInput } from '@/lib/engines/netWorthLevels';
import { ENTITY_OWNER_TAGS, isEntityOwnerTag, isPersonalBasisRow, netWorthForHistoryComparison } from '@/lib/engines/netWorthBasis';
import { netWorthHeadline } from '@/components/dashboard/netWorthHeadline';
import { loadRetirementForecastPosition, loadForeignPosition, loadDebtForecastLiabilities, loadInvestmentForecastHoldings, forecastFx } from '@/lib/services/forecastCanonicalInputs';
import { forecastRunIsPersonalBasis, resolveVarianceActual } from '@/lib/engines/forecast/varianceBasis';
import { FORECAST_ENGINE_VERSION } from '@/lib/engines/forecast/engine';
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

/** Everything except the retirement register (the PO household's assets, investments and liabilities). */
function baseRegisters(): Record<string, Row[]> {
  return {
    assets: [
      asset('a-house', 'House ', 1_395_000, 'joint'),
      asset('a-cash', 'Savings', 21_798, 'self', { asset_class: 'cash', master_item_key: 'savings_account' }),
      asset('a-other', 'Other assets', 253_500, 'spouse', { master_item_key: 'collectibles' }),
    ],
    investments: [investment('v-shares', 'Shares', 25_000, 'self', 'shares'), investment('v-prop', 'Investment property', 565_000, 'joint', 'property')],
    liabilities: [
      liability('l-home', { liability_name: 'Home loan', debt_type: 'mortgage', master_item_key: 'home_loan', balance: 800_000, owner: 'joint', monthly_repayment: 4000, country_code: 'AU' }),
      liability('l-inv', { liability_name: 'Investment loan', debt_type: 'mortgage', master_item_key: 'investment_loan', balance: 585_857, owner: 'self', monthly_repayment: 3000, country_code: 'AU' }),
    ],
  };
}

/** (A2) manual rows, no fund key: the model cannot tell the 503,000 is the fund. */
const shapeA = () => tables(profile('AUD', 'AU', 56), baseRegisters(), {
  retirement_accounts: [retirement('r-smsf', 'SMSF', 503_000, 'self'), retirement('r-other', 'Other Retirement Assets', 133_000, 'smsf'), retirement('r-sp', 'Spouse Contribution', 0, 'spouse')],
});
/** (A1) the SMSF section fund row (master_item_key 'smsf', owner self by construction) beside the owner-smsf net row. */
const shapeA1 = () => tables(profile('AUD', 'AU', 56), baseRegisters(), {
  retirement_accounts: [retirement('r-smsf', 'SMSF', 503_000, 'self', { master_item_key: 'smsf' }), retirement('r-other', 'Other Retirement Assets', 133_000, 'smsf'), retirement('r-sp', 'Spouse Contribution', 0, 'spouse')],
});
const shapeB = () => tables(profile('AUD', 'AU', 56), baseRegisters(), {
  retirement_accounts: [retirement('r-other', 'Other Retirement Assets', 133_000, 'smsf'), retirement('r-sp', 'Spouse Contribution', 0, 'spouse')],
});
const shapeC = () => tables(profile('AUD', 'AU', 56), baseRegisters(), {
  retirement_accounts: [retirement('r-fund', 'SMSF fund assets', 503_000, 'smsf'), retirement('r-sp', 'Spouse Contribution', 0, 'spouse')],
  liabilities: [liability('l-smsf', { liability_name: 'SMSF fund loan', debt_type: 'mortgage', master_item_key: 'investment_loan', balance: 370_000, owner: 'smsf', country_code: 'AU' })],
});

async function dashboard(t: Record<string, Row[]>) {
  return loadDashboard(USER, makeFakeSupabase(t).client as never);
}

describe('(A2) manual rows with no fund key: 503,000 owner self + 133,000 owner smsf', () => {
  it('personal 1,377,441 (retirement 503,000), SMSF fund-level 133,000 only in the entity block, family 1,510,441', async () => {
    const d = await dashboard(shapeA());
    expect(d.totalAssets + d.totalInvestments).toBe(2_260_298);
    expect(d.totalRetirement).toBe(503_000);
    expect(d.totalAssetsCombined).toBe(2_763_298);
    expect(d.totalLiabilities).toBe(1_385_857);
    expect(d.netWorth).toBe(1_377_441);
    const l = d.netWorthLevels!;
    expect(l.personal.total.net).toBe(1_377_441);
    expect(l.personal.total.retirement).toBe(503_000);
    expect(l.entities.byKind.smsf).toMatchObject({ retirement: 133_000, liabilities: 0, net: 133_000 });
    expect(l.family.net).toBe(1_510_441);
    expect(l.bridge.personalParityOk).toBe(true);
  });

  it('the 133,000 is in NO personal figure: not total assets, not retirement, not the allocation chart, not the headline', async () => {
    const d = await dashboard(shapeA());
    expect(d.totalRetirement).not.toBe(636_000);
    const allocated = d.netWorthAllocation.reduce((s, a) => s + a.value, 0);
    expect(allocated).toBe(2_763_298);
    expect(netWorthHeadline(d).value).toBe(1_377_441);
    expect(netWorthHeadline(d).sub).toContain('1,510,441');
  });

  it('the model cannot know the 503,000 is the fund, so it raises a plain data-quality notice and changes no figure', async () => {
    const d = await dashboard(shapeA());
    const note = d.netWorthLevels!.dataStatus.smsfPossibleDoubleCount!;
    expect(note).toContain('may be counted twice');
    expect(note).toContain('"SMSF"');
    expect(note).toContain('"Other Retirement Assets"');
    expect(note).not.toMatch(/mistake|wrong|error|fault/i);
  });

  it('score arithmetic: ratios use the personal base (hand calculation in the header)', async () => {
    const d = await dashboard(shapeA());
    expect(d.propertyConcentration).toBeCloseTo(1_960_000 / 2_763_298, 10);
    expect(d.liquidAssetRatio).toBeCloseTo(21_798 / 2_763_298, 10);
    expect(d.propertyConcentration! - 1_960_000 / 2_896_298).toBeGreaterThan(0.03);
    // Debt ratios never contained the SMSF row: unchanged by this decision.
    expect(d.totalLiabilities).toBe(1_385_857);
  });
});

describe('(A1) the SMSF fund row (master_item_key smsf) is entity-held, and the fund is counted once', () => {
  it('personal 874,441 with no retirement; SMSF block 133,000 (the fund-level row); the 503,000 fund record is listed, not counted; family 1,007,441', async () => {
    const d = await dashboard(shapeA1());
    expect(d.totalAssetsCombined).toBe(2_260_298);
    expect(d.totalRetirement).toBe(0);
    expect(d.netWorth).toBe(874_441);
    const l = d.netWorthLevels!;
    expect(l.personal.total.net).toBe(874_441);
    expect(l.personal.total.retirement).toBe(0);
    const block = l.entities.blocks.find((b) => b.kind === 'smsf')!;
    expect(block.included.net).toBe(133_000);
    expect(block.suppressedFundRecord).toEqual({ count: 1, amount: 503_000 });
    expect(l.family.net).toBe(1_007_441);
    expect(l.personal.total.net + l.entities.total.net).toBe(l.family.net);
    // the previously reported (history) figure is bridged: both rows were counted before
    expect(d.netWorthBasis!.history.netWorth).toBe(1_510_441);
    expect(l.bridge.parityOk).toBe(true);
    expect(l.bridge.lines.map((x) => [x.key, x.amount])).toEqual([['smsf_fund_record_not_counted', 503_000]]);
    expect(l.bridge.personalParityOk).toBe(true);
  });

  it('the notice names both rows, recommends recording the fund once at its own net, and does not blame', async () => {
    const note = (await dashboard(shapeA1())).netWorthLevels!.dataStatus.smsfPossibleDoubleCount!;
    expect(note).toContain('SMSF fund record');
    expect(note).toContain('"SMSF"');
    expect(note).toContain('"Other Retirement Assets"');
    expect(note).toContain('own net balance');
    expect(note).not.toMatch(/mistake|wrong|error|fault/i);
  });

  it('a genuine personal pension / super account stays personal; the fund row alone (no fund-level row) is counted in the SMSF block once', async () => {
    const t = tables(profile('AUD', 'AU', 56), {
      retirement_accounts: [
        retirement('r-fund', 'SMSF', 135_000, 'self', { master_item_key: 'smsf' }),
        retirement('r-super', 'Industry super', 50_000, 'self'),
        retirement('r-sp', 'Spouse super', 20_000, 'spouse'),
      ],
    });
    const d = await dashboard(t);
    expect(d.totalRetirement).toBe(70_000);
    expect(d.netWorth).toBe(70_000);
    const l = d.netWorthLevels!;
    expect(l.personal.total.net).toBe(70_000);
    expect(l.entities.byKind.smsf.net).toBe(135_000);
    expect(l.family.net).toBe(205_000);
    expect(l.dataStatus.smsfPossibleDoubleCount).toBeNull();
  });
});

describe('(B) interim corrected shape: the 503,000 row removed, 133,000 (owner smsf) kept as the fund net balance', () => {
  it('personal 874,441 with no retirement; SMSF block 133,000; family 1,007,441', async () => {
    const d = await dashboard(shapeB());
    expect(d.totalAssetsCombined).toBe(2_260_298);
    expect(d.totalRetirement).toBe(0);
    expect(d.netWorth).toBe(874_441);
    const l = d.netWorthLevels!;
    expect(l.personal.total.net).toBe(874_441);
    expect(l.entities.byKind.smsf.net).toBe(133_000);
    expect(l.family.net).toBe(1_007_441);
    expect(l.dataStatus.smsfPossibleDoubleCount).toBeNull();
  });
});

describe('(C) entity-level shape: SMSF asset 503,000 and SMSF liability 370,000, no 133,000 row', () => {
  it('personal 874,441; the SMSF block is 503,000 - 370,000 = 133,000 with the loan deducted once; family 1,007,441 = shape B', async () => {
    const d = await dashboard(shapeC());
    expect(d.netWorth).toBe(874_441);
    expect(d.totalLiabilities).toBe(1_385_857); // the fund loan is not a personal liability
    const l = d.netWorthLevels!;
    expect(l.entities.byKind.smsf).toMatchObject({ retirement: 503_000, liabilities: 370_000, net: 133_000 });
    expect(l.family.liabilities).toBe(1_385_857 + 370_000);
    expect(l.family.net).toBe(1_007_441);
    const b = await dashboard(shapeB());
    expect(l.family.net).toBe(b.netWorthLevels!.family.net);
    expect(l.personal.total.net).toBe(b.netWorthLevels!.personal.total.net);
  });

  it('pure engine, same numbers: the member benefit (the fund net balance) is a memo on the SMSF block, never added to the personal level', () => {
    const rows: NetWorthRowInput[] = [
      { id: 'a', register: 'assets', name: 'Savings', owner: 'self', amountReporting: 874_441 + 1_385_857 },
      { id: 'l', register: 'liabilities', name: 'Loans', owner: 'self', amountReporting: 1_385_857 },
      { id: 'f', register: 'retirement', name: 'SMSF fund assets', owner: 'smsf', amountReporting: 503_000 },
      { id: 'fl', register: 'liabilities', name: 'SMSF fund loan', owner: 'smsf', amountReporting: 370_000 },
    ];
    const l = computeNetWorthLevels({ currency: 'AUD', rows });
    expect(l.personal.total.net).toBe(874_441);
    expect(l.entities.byKind.smsf.net).toBe(133_000);
    expect(l.family.net).toBe(874_441 + 133_000);
    expect(l.personal.total.net + l.entities.total.net).toBe(l.family.net);
  });
});

describe('negative controls: these would FAIL if owner=smsf rows leaked into personal figures', () => {
  it('the previous all-rows computation gives 1,510,441 / 636,000 -- exactly the leak the assertions above reject', async () => {
    const t = shapeA();
    const rows = (name: string) => t[name];
    const leaked = computeDashboard(
      {
        income: [], expenses: [], insurance: [], goals: [], snapshots: [],
        assets: rows('assets').map((r) => ({ current_value: r.current_value as number, asset_class: r.asset_class as string, asset_name: r.asset_name as string, master_item_key: r.master_item_key as string | null, currency_code: 'AUD', owner: r.owner as string })),
        investments: rows('investments').map((r) => ({ current_value: r.current_value as number, cost_base: null, investment_type: r.investment_type as string, master_item_key: r.master_item_key as string, country_code: 'AU', annual_contribution: 0, currency_code: 'AUD', owner: r.owner as string })),
        retirement: rows('retirement_accounts').map((r) => ({ current_balance: r.current_balance as number, employer_contribution: 0, personal_contribution: 0, contribution_frequency: 'monthly' as const, currency_code: 'AUD', owner: r.owner as string })),
        liabilities: rows('liabilities').map((r) => ({ balance: r.balance as number, interest_rate: null, monthly_repayment: 0, debt_type: 'mortgage', currency_code: 'AUD', owner: r.owner as string })),
      },
      'AUD',
    );
    expect(leaked.netWorth).toBe(1_510_441);
    expect(leaked.totalRetirement).toBe(636_000);
    const d = await dashboard(t);
    expect(d.netWorth).not.toBe(leaked.netWorth);
    expect(d.totalRetirement).not.toBe(leaked.totalRetirement);
  });

  it('every entity owner tag is excluded from the personal rows, and the personal-basis rule agrees with the levels model for ALL owner tags', () => {
    for (const owner of ['self', 'spouse', 'joint', 'child', 'other', null, 'family_trust', 'company', 'smsf'] as const) {
      const levels = computeNetWorthLevels({ currency: 'AUD', rows: [{ id: 'x', register: 'assets', name: 'Row', owner, amountReporting: 1000 }] });
      const inEntityBlock = levels.entities.total.net === 1000;
      expect(isEntityOwnerTag(owner), `owner ${String(owner)}`).toBe(inEntityBlock);
      expect(isPersonalBasisRow({ owner })).toBe(!inEntityBlock);
      expect(levels.personal.total.net).toBe(inEntityBlock ? 0 : 1000);
    }
    expect([...ENTITY_OWNER_TAGS].sort()).toEqual(['company', 'family_trust', 'smsf']);
  });

  it('an SMSF-linked property loan is never personal, whatever its owner tag says', () => {
    expect(isPersonalBasisRow({ owner: 'self' }, { smsfLinkedLoan: true })).toBe(false);
  });
});

describe('SMSF property loan counted once; the fund row is the SMSF block (loader level)', () => {
  it('Detailed-mode fund row (master_item_key smsf, net of its loan) is the SMSF block 135,000, not personal; the 365,000 loan is not a personal liability and not deducted twice', async () => {
    const t = tables(profile('AUD', 'AU', 56), {
      retirement_accounts: [retirement('r-fund', 'SMSF', 135_000, 'self', { master_item_key: 'smsf' })],
      liabilities: [liability('l-smsf', { liability_name: 'SMSF property loan', debt_type: 'mortgage', master_item_key: 'investment_loan', balance: 365_000, owner: 'self' })],
      property_liability_links: [{ id: 'pl', user_id: USER, liability_id: 'l-smsf', linked_retirement_id: 'r-fund', link_type: 'smsf_property_loan', is_active: true }],
      smsf_funds: [{ id: 'f', user_id: USER, retirement_account_id: 'r-fund', mode: 'detailed' }],
    });
    const d = await dashboard(t);
    expect(d.netWorth).toBe(0);
    expect(d.totalRetirement).toBe(0);
    expect(d.totalLiabilities).toBe(0);
    expect(d.netWorthLevels!.family.net).toBe(135_000);
    expect(d.netWorthLevels!.personal.total.net).toBe(0);
    expect(d.netWorthLevels!.entities.byKind.smsf.net).toBe(135_000);
    expect(d.netWorthLevels!.entities.blocks.find((b) => b.kind === 'smsf')!.nettedLoans).toEqual({ count: 1, amount: 365_000 });
  });
});

describe('entity-free households are unchanged', () => {
  const plain = () =>
    tables(profile('AUD', 'AU', 56), {
      assets: [asset('a', 'Savings', 100_000, 'self', { asset_class: 'cash' })],
      retirement_accounts: [retirement('r', 'Super', 50_000, 'self')],
      liabilities: [liability('l', { liability_name: 'Card', debt_type: 'credit_card', master_item_key: 'credit_card', balance: 10_000, owner: 'self', country_code: 'AU' })],
    });
  it('personal = history basis = family; the stored snapshot carries exactly the same figures as before', async () => {
    const fake = makeFakeSupabase(plain());
    const d = await loadDashboard(USER, fake.client as never);
    expect(d.netWorth).toBe(140_000);
    expect(d.netWorthBasis!.history).toMatchObject({ netWorth: 140_000, comparableToPersonal: true });
    expect(d.netWorthBasis!.entityHeld.net).toBe(0);
    expect(d.netWorthLevels!.family.net).toBe(140_000);
    const snap = fake.upserts.find((u) => u.table === 'financial_snapshots')!.row;
    expect(snap).toMatchObject({ net_worth: 140_000, total_assets: 150_000, total_liabilities: 10_000 });
  });
  it('month-on-month movement is the personal figure and is labelled "Net worth"', async () => {
    const d = await dashboard(plain());
    expect(netWorthForHistoryComparison(d)).toEqual({ value: 140_000, basis: 'personal', note: null });
  });
});

describe('stored history is not rewritten and not mixed (snapshot basis, PO decision)', () => {
  it('PO household: the snapshot is written on the HISTORY basis (1,510,441 / 2,896,298 / 1,385,857), never the personal figure', async () => {
    const fake = makeFakeSupabase(shapeA());
    const d = await loadDashboard(USER, fake.client as never);
    const snap = fake.upserts.find((u) => u.table === 'financial_snapshots')!.row;
    expect(snap).toMatchObject({ net_worth: 1_510_441, total_assets: 2_896_298, total_liabilities: 1_385_857 });
    expect(d.netWorth).toBe(1_377_441);
  });
  it('movement for a household with entity amounts is on the history basis and says so; it is never compared with the personal figure', async () => {
    const t = tables(shapeA(), { financial_snapshots: [{ user_id: USER, snapshot_month: '2026-09-01', net_worth: 1_500_000, total_assets: 2_880_000, total_liabilities: 1_380_000, monthly_income: 1, monthly_expenses: 1, monthly_surplus: 0 }] });
    const d = await dashboard(t);
    const cmp = netWorthForHistoryComparison(d);
    expect(cmp.basis).toBe('family_incl_entities');
    expect(cmp.value).toBe(1_510_441);
    expect(cmp.note).toContain('family basis');
    expect(previousDebtToIncome(d, { ...d.snapshots[0], monthly_income: 10_000 })).toBeNull();
  });
  it('the Monthly Report Net Worth section: personal totals, a labelled family line, "Family net worth" movement, and the basis note', async () => {
    const t = tables(shapeA(), {
      user_entitlements: [{ user_id: USER, plan_tier: 'free' }],
      financial_snapshots: [{ user_id: USER, snapshot_month: '2026-09-01', net_worth: 1_500_000, total_assets: 2_880_000, total_liabilities: 1_380_000, monthly_income: 1, monthly_expenses: 1, monthly_surplus: 0 }],
    });
    const { client } = makeFakeSupabase(t);
    const source = await resolveReportSourceData(USER, undefined, client as never);
    const nw = buildReportSections(source, buildEligibilityInput(source), false).find((s) => s.sectionCode === 'net_worth')!;
    const data = nw.sectionData as { netWorth: number; totalAssets: number; totalRetirement: number; familyNetWorth: number; basis: string; historyBasis: string; historyBasisNote: string; movement: { label: string }; levels: NetWorthLevels };
    expect(data).toMatchObject({ netWorth: 1_377_441, totalAssets: 2_763_298, totalRetirement: 503_000, familyNetWorth: 1_510_441, basis: 'personal', historyBasis: 'family_incl_entities' });
    expect(data.movement.label).toBe('Family net worth');
    expect(data.historyBasisNote).toContain('family basis');
    // dashboard / report parity on the personal figure
    const d = await dashboard(t);
    expect(data.netWorth).toBe(d.netWorth);
    expect(data.levels.personal.total.net).toBe(d.netWorth);
  });
});

describe('report evidence appendix: entity-held rows are listed but not counted', () => {
  it('133,000 owner smsf is shown with a note, excluded from countedTotal and from the net worth reconciliation', async () => {
    const { client } = makeFakeSupabase(shapeA());
    const snapshot = await buildCanonicalFinancialSnapshot(USER, { client: client as never });
    if (snapshot.status !== 'ok') throw new Error('snapshot unavailable');
    const appendix = buildCanonicalAppendix(snapshot);
    const ret = appendix.tables.find((x) => x.key === 'retirement')!;
    const row = ret.rows.find((r) => r.name === 'Other Retirement Assets')!;
    expect(row.counted).toBe(false);
    expect(row.note).toContain('Held by an entity');
    expect(ret.countedTotal).toBe(503_000);
    expect(appendix.reconciliation.netWorth).toEqual({ assets: 1_670_298, investments: 590_000, retirement: 503_000, liabilities: 1_385_857 });
  });
});

describe('forecast opening balances and variance use the same personal rows', () => {
  it('retirement forecast position: balance 503,000, not 636,000; cross-border/debt/investment loaders drop entity-held rows', async () => {
    const t = tables(shapeA(), {
      assets: [asset('a-smsf-prop', 'Fund property', 400_000, 'smsf')],
      investments: [investment('v-fund', 'Fund shares', 90_000, 'smsf', 'shares')],
      liabilities: [liability('l-fund', { liability_name: 'Fund loan', debt_type: 'mortgage', master_item_key: 'investment_loan', balance: 300_000, owner: 'smsf', country_code: 'AU' })],
    });
    const { client } = makeFakeSupabase(t);
    const fx = forecastFx('AUD', 56, 'AU');
    const pos = await loadRetirementForecastPosition(USER, client as never, fx);
    expect(pos.currentBalance).toBe(503_000);
    expect(pos.accounts.every((a) => a.owner !== 'smsf')).toBe(true);
    const debts = await loadDebtForecastLiabilities(USER, client as never);
    expect(debts.map((l) => l.id).sort()).toEqual(['l-home', 'l-inv']);
    const invs = await loadInvestmentForecastHoldings(USER, client as never);
    expect(invs.map((i) => i.id).sort()).toEqual(['v-prop', 'v-shares']);
    const foreign = await loadForeignPosition(USER, client as never, 'INR');
    expect(foreign.assets + foreign.investments + foreign.retirement + foreign.liabilities).toBe(0);
  });

  it('engine version 1.7.0 marks runs built on the personal basis; earlier runs are compared on the earlier basis', () => {
    expect(FORECAST_ENGINE_VERSION).toBe('forecast-1.7.0');
    expect(forecastRunIsPersonalBasis('forecast-1.7.0')).toBe(true);
    expect(forecastRunIsPersonalBasis('forecast-1.10.0')).toBe(true);
    expect(forecastRunIsPersonalBasis('forecast-1.6.0')).toBe(false);
    expect(forecastRunIsPersonalBasis(null)).toBe(false);
  });

  it('variance actual: personal run -> personal 1,377,441 (stored history not usable); earlier run -> stored/history basis 1,510,441; entity-free -> identical', async () => {
    const d = await dashboard(shapeA());
    const snap = { net_worth: 1_510_000 };
    expect(resolveVarianceActual({ category: 'net_worth', runEngineVersion: 'forecast-1.7.0', snapshot: snap, dashboard: d })).toMatchObject({ actual: 1_377_441, usedSnapshot: false });
    expect(resolveVarianceActual({ category: 'net_worth', runEngineVersion: 'forecast-1.6.0', snapshot: snap, dashboard: d })).toMatchObject({ actual: 1_510_000, usedSnapshot: true });
    expect(resolveVarianceActual({ category: 'net_worth', runEngineVersion: 'forecast-1.6.0', snapshot: null, dashboard: d }).actual).toBe(1_510_441);
    expect(resolveVarianceActual({ category: 'retirement', runEngineVersion: 'forecast-1.6.0', snapshot: null, dashboard: d }).actual).toBe(636_000);
    expect(resolveVarianceActual({ category: 'retirement', runEngineVersion: 'forecast-1.7.0', snapshot: null, dashboard: d }).actual).toBe(503_000);
    const plain = await dashboard(tables(profile('AUD', 'AU', 56), { assets: [asset('a', 'Savings', 5_000, 'self', { asset_class: 'cash' })] }));
    expect(resolveVarianceActual({ category: 'net_worth', runEngineVersion: 'forecast-1.6.0', snapshot: { net_worth: 4_900 }, dashboard: plain })).toMatchObject({ actual: 4_900, usedSnapshot: true });
    expect(resolveVarianceActual({ category: 'net_worth', runEngineVersion: 'forecast-1.7.0', snapshot: { net_worth: 4_900 }, dashboard: plain })).toMatchObject({ actual: 4_900, usedSnapshot: true });
  });
});

describe('joint 60/40 still totals 100% on the personal basis', () => {
  it('a joint investment recorded 60/40 keeps its 1,000,000 and the personal summary equals the personal level', async () => {
    const t = tables(profile('AUD', 'AU', 56), {
      investments: [investment('v-j', 'Joint shares', 1_000_000, 'joint', 'shares', { ii_canonical_account_id: 'acc-1' })],
    });
    const d = await dashboard(t);
    expect(d.netWorth).toBe(1_000_000);
    expect(d.netWorthLevels!.personal.total.net).toBe(1_000_000);
    expect(d.netWorthLevels!.personal.jointPool.net).toBe(1_000_000);
    const shares = d.netWorthLevels!.personal.parties.filter((p) => p.key !== 'other_household').map((p) => p.jointShare.net);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(1_000_000);
  });
});

describe('Trust / HUF / Company treatment at the family level is unchanged', () => {
  it('a registered company at 40%, trust and HUF in full are in the family figure only, never in the personal one', async () => {
    const entity = (id: string, type: string, pct: number, nav: number): Row => ({
      id, user_id: USER, entity_type: type, name: `${type} ${id}`, country_code: 'AU', currency_code: 'AUD', ownership_percentage: pct,
      valuation_mode: 'summary', summary_net_asset_value: nav, is_active: true, created_at: '2026-01-01T00:00:00Z',
    });
    const t = tables(profile('AUD', 'AU', 56), {
      assets: [asset('a', 'Savings', 100_000, 'self', { asset_class: 'cash' })],
      business_entities: [entity('co', 'company', 40, 500_000), entity('tr', 'family_trust', 50, 300_000), entity('hu', 'huf', 100, 200_000)],
    });
    const d = await dashboard(t);
    expect(d.netWorth).toBe(100_000);
    expect(d.businessEntityOwnershipValue).toBe(0);
    expect(d.netWorthLevels!.family.net).toBe(100_000 + 200_000 + 300_000 + 200_000);
  });
});

describe('register grid footer', () => {
  it('splits the personal total from entity-held rows on the four balance-sheet registers (asset, investment, liability, retirement) and not on flow registers', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../../components/grid/FinancialDataGrid.tsx', import.meta.url), 'utf8');
    expect(src).toMatch(/PERSONAL_TOTAL_GRID_CATEGORIES[^=]*=\s*new Set\(\['asset', 'investment', 'liability', 'retirement'\]\)/);
    expect(src).toContain('isEntityOwnerTag(r.owner)');
    expect(src).toContain('Held by an entity (SMSF, trust or company), not in your personal net worth');
  });
});
