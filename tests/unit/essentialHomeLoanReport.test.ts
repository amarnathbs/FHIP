/**
 * PO rule 17-10-2026 in the Monthly Report: the cash-flow section and the Emergency-fund chart carry the provenance note
 * and the same months as the Dashboard (same PO household as essentialHomeLoanRule.test.ts: essential 2,804.67 ->
 * 6,202.14, Emergency Fund 21,798 / 6,202.14 = 3.51 months, total expenses 4,535.30 unchanged).
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

const ESSENTIAL: [string, number, string][] = [
  ['Electricity', 215.4, 'electricity'], ['Groceries', 1100, 'groceries'], ['Health insurance', 310, 'health_insurance'],
  ['Home insurance', 118.27, 'home_insurance'], ['Council rates', 240, 'council_rates'], ['Fuel', 260, 'fuel'],
  ['Public transport', 95, 'public_transport'], ['Body corporate', 150, 'body_corporate'], ['Internet', 89, 'internet'], ['Medical', 227, 'medical'],
];
const DISCRETIONARY: [string, number, string][] = [
  ['Restaurants', 600, 'restaurants'], ['Streaming', 55.63, 'streaming_services'], ['Entertainment', 400, 'entertainment'], ['Holidays', 675, 'holidays'],
];

function poTables(extra: { expenses?: Row[]; liabilities?: Row[]; links?: Row[] } = {}): Record<string, Row[]> {
  return tables(profile('AUD', 'AU', 56), {
    income_sources: [incomeSource('i-1', 'Salary', 10000, 'monthly', { net_amount: 10000, master_item_key: 'salary_wages' })],
    expense_items: [
      ...ESSENTIAL.map(([n, a, k], i) => expenseItem(`e-${i}`, n, a, 'monthly', { master_item_key: k, is_essential: true })),
      ...DISCRETIONARY.map(([n, a, k], i) => expenseItem(`d-${i}`, n, a, 'monthly', { master_item_key: k, is_essential: false })),
      ...(extra.expenses ?? []),
    ],
    assets: [{ id: 'as-cash', user_id: USER, asset_name: 'Savings', asset_class: 'cash', current_value: 21798, currency_code: 'AUD', owner: 'self', master_item_key: 'savings_account', source_type: 'manual', linked_liability_id: null, country_code: 'AU', is_active: true }],
    liabilities: extra.liabilities ?? [
      liability('l-home', { liability_name: 'Home Loan', debt_type: 'mortgage', master_item_key: 'home_loan', balance: 520904, monthly_repayment: 3397.47, owner: 'self', country_code: 'AU' }),
      liability('l-inv', { liability_name: 'Investment Loan', debt_type: 'mortgage', master_item_key: 'investment_loan', balance: 400000, monthly_repayment: 2924.59, owner: 'joint', country_code: 'AU' }),
      liability('l-con', { liability_name: 'Construction Loan', debt_type: 'mortgage', master_item_key: 'construction_loan', balance: 300000, monthly_repayment: 1924, owner: 'joint', country_code: 'AU' }),
      liability('l-con1', { liability_name: 'Construction loan 1', debt_type: 'mortgage', master_item_key: null, balance: 20000, monthly_repayment: 116, owner: 'joint', country_code: 'AU' }),
      liability('l-inv1', { liability_name: 'Investment loan 1', debt_type: 'mortgage', master_item_key: null, balance: 0, monthly_repayment: 0, owner: 'joint', country_code: 'AU' }),
    ],
    property_liability_links: extra.links ?? [],
  });
}

const r2 = (n: number) => Math.round(n * 100) / 100;

async function sectionsFor(t: Record<string, Row[]>) {
  const { client } = makeFakeSupabase(tables(t, { user_entitlements: [{ user_id: USER, plan_tier: 'free' }] }));
  const source = await resolveReportSourceData(USER, undefined, client as never);
  const sections = buildReportSections(source, buildEligibilityInput(source), false);
  return { source, get: (code: string) => sections.find((s) => s.sectionCode === code)! };
}

describe('Monthly Report: owner-occupied home loan inside essentials', () => {
  it('the cash-flow section and the emergency-fund chart carry the provenance note and the same months', async () => {
    const { source, get } = await sectionsFor(poTables());
    const cash = get('cash_flow');
    expect(r2(cash.sectionData.essentialMonthlyExpenses as number)).toBe(6202.14);
    expect(cash.sectionData.essentialHomeLoanMonthly).toBe(3397.47);
    expect(cash.sectionData.essentialHomeLoanNote).toBe('Essential expenses include your home loan repayment of $3,397 a month (no rent recorded).');
    expect(r2(cash.sectionData.totalMonthlyExpenses as number)).toBe(4535.3);
    expect(r2(cash.sectionData.debtMonthlyRepayments as number)).toBe(8362.06);
    expect(r2(cash.sectionData.monthlySurplus as number)).toBe(-2897.36);
    const ef = (get('executive_summary').chartData as { emergencyFund: { months: number; summary: string } }).emergencyFund;
    expect(ef.months).toBeCloseTo(21798 / 6202.14, 9);
    expect(ef.summary).toContain('Essential expenses include your home loan repayment of $3,397 a month (no rent recorded).');
    expect(source.dashboard.emergencyFundMonths).toBe(ef.months);
  });

  it('a rent-paying household has no home-loan amount in the report and the loan is not added', async () => {
    const t = poTables({ expenses: [expenseItem('e-rent', 'Rent', 1800, 'monthly', { master_item_key: 'rent', is_essential: true })] });
    const { get } = await sectionsFor(t);
    const cash = get('cash_flow');
    expect(cash.sectionData.essentialHomeLoanMonthly).toBe(0);
    expect(r2(cash.sectionData.essentialMonthlyExpenses as number)).toBe(r2(2804.67 + 1800));
    const ef = (get('executive_summary').chartData as { emergencyFund: { summary: string } }).emergencyFund;
    expect(ef.summary).not.toContain('home loan repayment of');
  });

  it('a household with no home loan has no note at all', async () => {
    const t = poTables({ liabilities: [liability('l-x', { debt_type: 'personal_loan', master_item_key: 'personal_loan', monthly_repayment: 300 })] });
    const { get } = await sectionsFor(t);
    expect(get('cash_flow').sectionData.essentialHomeLoanNote).toBeNull();
    expect(r2(get('cash_flow').sectionData.essentialMonthlyExpenses as number)).toBe(2804.67);
  });
});
