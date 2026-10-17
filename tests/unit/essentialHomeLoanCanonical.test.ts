/**
 * PO rule 17-10-2026 (owner-occupied home-loan repayment is essential when no rent is recorded), driven through the
 * REAL canonical path: the PostgREST-shaped fake -> buildCanonicalFinancialSnapshot -> loadDashboard and the Twin source
 * loader (the Monthly Report is in essentialHomeLoanReport.test.ts). The pure rule and the registers-only engine are in
 * essentialHomeLoanRule.test.ts; this file proves the Dashboard, Twin and Report all read ONE figure and that the
 * property links, imported rent, failed link read and statement-derived loans behave as documented.
 *
 * Hand oracles (the same PO household figures as essentialHomeLoanRule.test.ts):
 *   essential 2,804.67 -> 6,202.14 ; Emergency Fund 21,798 / 2,804.67 = 7.77 -> 21,798 / 6,202.14 = 3.51 months
 *   debt service 8,362.06 and total expenses 4,535.30 unchanged ; fixture net income 10,000 ; surplus -2,897.36 unchanged
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => {
    throw new Error('createClient() must not be called -- every test passes an explicit client.');
  },
}));
vi.mock('@/lib/services/healthScoreData', () => ({
  loadHealthScore: vi.fn().mockResolvedValue({ overallScore: 60, statusLabel: 'Stable', components: [], positiveContributors: [], negativeContributors: [], confidenceLevel: null, recommendations: [], previousScore: null, scoreChange: null, history: [] }),
}));
vi.mock('@/lib/services/resilienceData', () => ({
  loadResilience: vi.fn().mockResolvedValue({ overallScore: 60, statusLabel: 'Resilient', components: [], componentScores: [], risks: [], actions: [], previousScore: null, scoreChange: null, history: [], eligibility: 'full' }),
}));
vi.mock('@/lib/services/financialDnaData', () => ({ loadFinancialDna: vi.fn().mockResolvedValue(null) }));
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
import { loadTwinSourceData } from '@/lib/services/twinData';
import { computeTwinMetricValues } from '@/lib/engines/twin/metricDerivation';
import { makeFakeSupabase, type Row } from './readModels/helpers/fakeSupabase';
import { account, CAT, expenseItem, incomeSource, liability, profile, statement, tables, taxonomy, txn, USER } from './readModels/helpers/fixtures';
import { windowMonths } from './helpers/canonicalGoldenHouseholds';
import { monthEnd, monthStart } from '@/lib/read-models/core/window';

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

const dash = async (t: Record<string, Row[]>, opts?: Parameters<typeof makeFakeSupabase>[1]) => loadDashboard(USER, makeFakeSupabase(t, opts).client as never);
const r2 = (n: number) => Math.round(n * 100) / 100;

describe('Dashboard on the canonical path: PO household', () => {
  it('essential 2,804.67 -> 6,202.14, Emergency Fund 3.51 months; surplus, outflow and DSR unchanged', async () => {
    const d = await dash(poTables());
    expect(d.dataStatus?.basis).toBe('canonical_read_models');
    expect(r2(d.essentialMonthlyExpenses)).toBe(6202.14);
    expect(d.emergencyFundMonths).toBeCloseTo(21798 / 6202.14, 9);
    expect(d.essentialHomeLoan?.status).toBe('counted');
    expect(d.essentialHomeLoan?.lines.map((l) => l.name)).toEqual(['Home Loan']);
    expect(r2(d.debtMonthlyRepayments)).toBe(8362.06);
    expect(r2(d.totalMonthlyExpenses)).toBe(4535.3);
    expect(r2(d.lifestyleMonthlyExpenses)).toBe(1730.63);
    expect(r2(d.monthlySurplus)).toBe(-2897.36);
    expect(d.debtServiceRatio).toBeCloseTo(0.836206, 6);
  });

  it('NEGATIVE CONTROL: the same household with the loan filed as an investment loan stays at 2,804.67 and 7.8 months', async () => {
    const t = poTables();
    t.liabilities = t.liabilities.map((l) => (l.id === 'l-home' ? { ...l, master_item_key: 'investment_loan' } : l));
    const d = await dash(t);
    expect(r2(d.essentialMonthlyExpenses)).toBe(2804.67);
    expect(d.emergencyFundMonths!.toFixed(1)).toBe('7.8');
    expect(r2(d.monthlySurplus)).toBe(-2897.36);
  });

  it('a recorded planned rent row switches the rule off (rent is the housing cost)', async () => {
    const d = await dash(poTables({ expenses: [expenseItem('e-rent', 'Rent', 1800, 'monthly', { master_item_key: 'rent', is_essential: true })] }));
    expect(d.essentialHomeLoan?.status).toBe('rent_recorded');
    expect(r2(d.essentialMonthlyExpenses)).toBe(r2(2804.67 + 1800));
  });

  it('a fortnightly rent row also counts as recorded', async () => {
    const d = await dash(poTables({ expenses: [expenseItem('e-rent', 'Rent', 450, 'fortnightly', { master_item_key: 'rent', is_essential: true })] }));
    expect(d.essentialHomeLoan?.status).toBe('rent_recorded');
  });

  it('an SMSF-owned rent row is the fund\'s, not the household\'s: it does not switch the rule off', async () => {
    const d = await dash(poTables({ expenses: [expenseItem('e-rent', 'Fund rent', 1800, 'monthly', { master_item_key: 'rent', owner: 'smsf' })] }));
    expect(d.essentialHomeLoan?.status).toBe('counted');
  });

  it('imported actual rent (Housing > Rent subcategory) switches it off; imported Housing with NO Rent subcategory cannot be read as rent (documented limitation)', async () => {
    const months = windowMonths();
    const mk = (withRentSub: boolean) => {
      const stmts: Row[] = [];
      const txns: Row[] = [];
      for (const m of months) {
        stmts.push(statement(`st-${m}`, 'bank', monthStart(m), monthEnd(m)));
        txns.push(txn({ id: `t-rent-${m}`, account: 'bank', statement: `st-${m}`, date: `${m}-02`, amount: 2000, type: 'expense', category: CAT.housing, subcategory: withRentSub ? 'sub-rent' : null, description: 'RENT' }));
      }
      const tax = taxonomy();
      tax.fdh_subcategories = [...tax.fdh_subcategories, { id: 'sub-rent', category_id: CAT.housing, display_name: 'Rent', fhip_mapping_key: 'housing.rent', essential_discretionary: 'essential' }];
      return tables(poTables(), tax, { fdh_financial_accounts: [account('bank')], fdh_statement_uploads: stmts, fdh_transactions: txns });
    };
    const withSub = await dash(mk(true));
    expect(withSub.essentialHomeLoan?.status).toBe('rent_recorded');
    expect(withSub.essentialHomeLoan?.rentMonthly).toBeCloseTo(2000, 6);
    const withoutSub = await dash(mk(false));
    expect(withoutSub.essentialHomeLoan?.status).toBe('counted');
  });
});

describe('Property links', () => {
  it('a custom loan linked to the principal residence is counted beside the Home Loan (split loan); investment loans are not', async () => {
    const t = poTables({
      links: [{ id: 'pl-1', user_id: USER, liability_id: 'l-con1', link_type: 'owner_occupied_mortgage', allocation_percent: 100, is_active: true }],
    });
    const d = await dash(t);
    expect(d.essentialHomeLoan?.lines.map((l) => l.name).sort()).toEqual(['Construction loan 1', 'Home Loan']);
    expect(r2(d.essentialMonthlyExpenses)).toBe(r2(2804.67 + 3397.47 + 116));
  });

  it('a Home Loan whose only active link is to an INVESTMENT property is not owner-occupied; an inactive link is ignored', async () => {
    const investment = await dash(poTables({ links: [{ id: 'pl-1', user_id: USER, liability_id: 'l-home', link_type: 'investment_property_loan', allocation_percent: 100, is_active: true }] }));
    expect(r2(investment.essentialMonthlyExpenses)).toBe(2804.67);
    const inactive = await dash(poTables({ links: [{ id: 'pl-1', user_id: USER, liability_id: 'l-home', link_type: 'investment_property_loan', allocation_percent: 100, is_active: false }] }));
    expect(r2(inactive.essentialMonthlyExpenses)).toBe(6202.14);
  });

  it('a failed link read falls back to the Home Loan catalogue item: the Dashboard still loads and the figure is produced', async () => {
    const real = makeFakeSupabase(poTables()).client as unknown as { from: (table: string) => { select: (cols: string) => unknown } };
    // Only THIS rule's link query (it selects link_type) fails; the Liabilities read model's own smsf-link read still works.
    const client = {
      ...real,
      from: (table: string) => {
        const q = real.from(table);
        if (table !== 'property_liability_links') return q;
        const select = q.select.bind(q);
        q.select = (cols: string) => {
          if (!cols.includes('link_type')) return select(cols);
          const failing = { eq: () => failing, range: () => Promise.resolve({ data: null, error: { message: 'injected failure' } }) };
          return failing;
        };
        return q;
      },
    };
    const d = await loadDashboard(USER, client as never);
    expect(d.essentialHomeLoan?.status).toBe('counted');
    expect(r2(d.essentialMonthlyExpenses)).toBe(6202.14);
  });
});

describe('Financial Twin reads the same figure', () => {
  it('Twin: essential ratio 62.0214 %, emergency fund 3.51 months; fixed-commitment ratio unchanged (the repayment is counted once)', async () => {
    const t = poTables();
    const outcome = await loadTwinSourceData(USER, makeFakeSupabase(t).client as never);
    if (outcome.status !== 'ok') throw new Error('country unresolved');
    const m = computeTwinMetricValues(outcome.data);
    expect(outcome.data.dashboard.essentialMonthlyExpenses).toBeCloseTo(6202.14, 6);
    expect(m.essential_expense_ratio.value).toBeCloseTo(62.0214, 4);
    expect(m.emergency_fund_months.value).toBeCloseTo(21798 / 6202.14, 9);
    // (2,804.67 + 8,362.06) / 10,000: the 3,397.47 sits inside both essential and debt, counted once.
    expect(m.fixed_commitment_ratio.value).toBeCloseTo(111.6673, 4);
    expect(m.discretionary_expense_ratio.value).toBeCloseTo(17.3063, 4);
    expect(m.debt_service_ratio.value).toBeCloseTo(83.6206, 4);
  });
});
