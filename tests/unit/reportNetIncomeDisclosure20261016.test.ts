/**
 * PO complaint 16-10-2026: "the report, the net worth and monthly surplus working is not correct".
 * FIRST HYPOTHESIS (blank take-home on the salary) - the PO's real cause turned out to be a period-basis mismatch
 * (see incomePeriodBasis20261016.test.ts); this file keeps the blank-take-home scenario because the PO then DECIDED
 * (16-10-2026) that a blank take-home is calculated at the GROSS and disclosed (reversing GAP-09). Synthetic shape (AUD):
 *
 *   income (monthly): Employment Salary 16,416 (take-home NOT recorded), Rental 2,123, Business 1,208,
 *                     Capital Gains 34 (take-home recorded for the last three, equal to gross)
 *   expenses: discretionary 4,535 (nothing marked essential); debt repayments 8,362
 *
 * Hand-calculated oracle (never produced by running the code):
 *   gross income            = 16,416 + 2,123 + 1,208 + 34                    = 19,781
 *   net income (salary take-home blank -> gross assumed) = 16,416 + 2,123 + 1,208 + 34 = 19,781
 *   monthly surplus         = 19,781 - 4,535 - 8,362                         = +6,884
 *   Net worth               = assets register 1,670,298 + investments 590,000 + retirement 636,000
 *                             - liabilities 1,385,857                        = 1,510,441
 *   wealth chart (bucketed by asset class across registers) sums to total assets 2,896,298
 *
 * The Dashboard already says "Take-home pay is unknown for part of your income" (DashboardDataStatusNotice);
 * the Report built from the same DashboardSummary said nothing, so a gross 19,781 / net 3,365 / deficit
 * -9,532 read as a complete picture.
 */
import { describe, expect, it, vi } from 'vitest';

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

import { resolveReportSourceData, buildEligibilityInput } from '@/lib/services/reportSnapshotResolver';
import { buildReportSections } from '@/lib/engines/reportSections';
import { makeFakeSupabase, type Row } from './readModels/helpers/fakeSupabase';
import { expenseItem, incomeSource, liability, profile, tables, USER } from './readModels/helpers/fixtures';

function asset(id: string, name: string, value: number, key: string, cls: string): Row {
  return { id, user_id: USER, asset_name: name, asset_class: cls, current_value: value, currency_code: 'AUD', owner: 'self', master_item_key: key, source_type: 'manual', linked_liability_id: null, country_code: 'AU', is_active: true };
}
function investment(id: string, name: string, value: number, key: string, type: string): Row {
  return { id, user_id: USER, investment_name: name, investment_type: type, current_value: value, cost_base: value, currency_code: 'AUD', owner: 'self', master_item_key: key, source_type: 'manual', ii_canonical_account_id: null, ii_canonical_instrument_id: null, country_code: 'AU', annual_contribution: 0, institution: 'X', is_active: true };
}

function poShapedHousehold(opts: { salaryNet: number | null }): Record<string, Row[]> {
  return tables(profile('AUD', 'AU', 56), {
    income_sources: [
      incomeSource('i-sal', 'Employment Salary', 16416, 'monthly', { net_amount: opts.salaryNet, master_item_key: 'employment_salary', employer_name: 'Acme' }),
      incomeSource('i-rent', 'Rental Income', 2123, 'monthly', { net_amount: 2123, master_item_key: 'rental_income' }),
      incomeSource('i-biz', 'Business Income', 1208, 'monthly', { net_amount: 1208, master_item_key: 'business_income' }),
      incomeSource('i-cg', 'Capital Gains', 34, 'monthly', { net_amount: 34, master_item_key: 'capital_gains' }),
    ],
    expense_items: [expenseItem('e-disc', 'Discretionary spend', 4535, 'monthly', { is_essential: false, master_item_key: 'entertainment' })],
    liabilities: [liability('l-1', { liability_name: 'Loans', debt_type: 'mortgage', master_item_key: 'home_loan', balance: 1385857, monthly_repayment: 8362, interest_rate: 6, country_code: 'AU' })],
    assets: [
      asset('a-home', 'Home', 1395000, 'principal_residence', 'property'),
      asset('a-cash', 'Savings', 21798, 'savings_account', 'cash'),
      asset('a-other', 'Other assets', 253500, 'collectibles', 'other'),
    ],
    investments: [
      investment('v-shares', 'Shares', 25000, 'shares', 'shares'),
      // Property held in the INVESTMENTS register: grouped as Property in the wealth chart, but counted as Investments in the Net worth breakdown.
      investment('v-prop', 'Investment property', 565000, 'property', 'property'),
    ],
    retirement_accounts: [
      { id: 'ret', user_id: USER, account_name: 'Super', account_type: 'super', current_balance: 636000, currency_code: 'AUD', owner: 'self', employer_contribution: 0, personal_contribution: 0, contribution_frequency: 'monthly', source_type: 'manual', retirement_member_id: null, country_code: 'AU', target_retirement_age: null, is_active: true },
    ],
  });
}

async function build(t: Record<string, Row[]>) {
  const { client } = makeFakeSupabase(tables(t, { user_entitlements: [{ user_id: USER, plan_tier: 'free' }] }));
  const source = await resolveReportSourceData(USER, undefined, client as never);
  const sections = buildReportSections(source, buildEligibilityInput(source), false);
  return { source, sections, get: (code: string) => sections.find((s) => s.sectionCode === code)! };
}

describe('Monthly Report net income and surplus on a PO-shaped household', () => {
  it('a blank take-home is taken at the gross: net = gross = 19,781, surplus +6,884, and the source is named', async () => {
    const { source } = await build(poShapedHousehold({ salaryNet: null }));
    const d = source.dashboard;
    expect(d.grossMonthlyIncome).toBe(19781);
    expect(d.netMonthlyIncome).toBe(19781);
    expect(d.totalMonthlyExpenses).toBe(4535);
    expect(d.debtMonthlyRepayments).toBe(8362);
    expect(d.monthlySurplus).toBe(6884);
    expect(d.dataStatus?.netIncomeAssumed).toEqual({ count: 1, grossMonthly: 16416, sources: [{ name: 'Employment Salary', grossMonthly: 16416 }] });
    expect(d.dataStatus?.netIncomeBasis).toBe('net_partial');
  });

  it('with the salary take-home recorded the surplus is on a complete net basis (control: nothing to disclose)', async () => {
    const { source, get } = await build(poShapedHousehold({ salaryNet: 11000 }));
    expect(source.dashboard.netMonthlyIncome).toBe(14365);
    expect(source.dashboard.monthlySurplus).toBe(14365 - 4535 - 8362);
    expect((get('cash_flow').sectionData.netIncomeAssumed as { count: number }).count).toBe(0);
    expect(get('cash_flow').sectionData.netIncomeNote ?? null).toBeNull();
    expect(JSON.stringify(get('executive_summary').chartData)).not.toMatch(/take-home/i);
  });

  it('[DEFECT] the Cash Flow section says gross is treated as take-home, naming the source and how many', async () => {
    const { get } = await build(poShapedHousehold({ salaryNet: null }));
    const cf = get('cash_flow');
    expect((cf.sectionData.netIncomeAssumed as { count: number }).count).toBe(1);
    expect(cf.sectionData.netIncomeNote).toMatch(/Gross is being treated as take-home: no tax has been deducted for 1 income source/);
    expect(cf.sectionData.netIncomeNote).toMatch(/Employment Salary \(\$16,416 a month\)/);
    expect(cf.sectionData.netIncomeNote).toMatch(/Cash Flow, Savings and Debt scores/);
  });

  it('[DEFECT] the Executive Summary surplus sentence carries the same assumed-gross note', async () => {
    const { get } = await build(poShapedHousehold({ salaryNet: null }));
    const summary = (get('executive_summary').chartData as { cashFlow: { summary: string } }).cashFlow.summary;
    expect(summary).toContain('retained a monthly surplus of $6,884');
    expect(summary).toMatch(/Gross is being treated as take-home/);
  });
});

describe('Monthly Report Net Worth presentation on a PO-shaped household', () => {
  it('Net Worth reconciles; the wealth chart and the register breakdown are two groupings of the SAME assets (explained, not a double count)', async () => {
    const { source, get } = await build(poShapedHousehold({ salaryNet: null }));
    const nw = get('net_worth').sectionData as { totalAssets: number; coreAssets: number; totalInvestments: number; totalRetirement: number; totalLiabilities: number; netWorth: number; netWorthAllocation: { bucket: string; value: number }[] };
    expect(nw.coreAssets).toBe(1670298);
    expect(nw.totalInvestments).toBe(590000);
    expect(nw.totalRetirement).toBe(636000);
    expect(nw.totalAssets).toBe(2896298);
    expect(nw.netWorth).toBe(2896298 - 1385857);
    const byBucket = Object.fromEntries(nw.netWorthAllocation.map((a) => [a.bucket, a.value]));
    expect(byBucket).toEqual({ property: 1960000, cash: 21798, other: 253500, shares: 25000, super: 636000 });
    expect(Object.values(byBucket).reduce((s, v) => s + v, 0)).toBe(nw.totalAssets);
    expect(source.dashboard.netWorth).toBe(nw.netWorth);
  });

  it('[DEFECT] Net Worth explains why "Investments" ($590,000) is larger than the Shares slice ($25,000) of the wealth chart', async () => {
    const { get } = await build(poShapedHousehold({ salaryNet: null }));
    const note = (get('net_worth').sectionData as { groupingNote?: string | null }).groupingNote ?? '';
    expect(note).toMatch(/investments register/i);
    expect(note).toMatch(/property/i);
  });

  it('[DEFECT] the "Imported, not yet in Net Worth" disclosure says what the items are and how to include them', async () => {
    const t = tables(poShapedHousehold({ salaryNet: null }), {
      ii_holding_snapshots: [
        { id: 'hs-1', user_id: USER, account_id: 'ii-acc', instrument_id: 'ii-vas', as_of_date: '2026-09-28', units: 100, value: 14406, currency_code: 'AUD', created_at: '2026-09-28T00:00:00Z' },
      ],
    });
    const { get } = await build(t);
    const nw = get('net_worth');
    expect((nw.sectionData as { notInNetWorth: unknown[] }).notInNetWorth).toEqual([{ label: 'Imported, not yet in Net Worth', count: 1, total: 14406 }]);
    const note = (nw.sectionData as { notInNetWorthNote?: string | null }).notInNetWorthNote ?? '';
    expect(note).toMatch(/Investments tab/);
    expect(note).toMatch(/Add to Net Worth/);
    expect(note).toMatch(/not counted/i);
  });
});
