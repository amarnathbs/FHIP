/**
 * PO production data, 16-10-2026 (confirmed by the PO): the "Employment Salary" income record is an ANNUAL gross
 * (196,994.48, frequency 'annually') whose net_amount is 3,975.43 - the net of ONE FORTNIGHTLY payslip. The record
 * therefore mixes two period bases: net monthly became 331.29 instead of 8,613.43, so the report showed net income
 * 3,574 and a deficit of 9,324 instead of about 11,856 and about 1,041.
 *
 * Hand-calculated oracle (never produced by running the code under test):
 *   payslip: fortnightly gross 7,576.71 (196,994.48 / 26), net 3,975.43
 *   net per year   = 3,975.43 x 26                 = 103,361.18      net per month = 103,361.18 / 12 = 8,613.43
 *   fortnightly -> monthly factor 26 / 12          ; fortnightly -> annually factor 26
 *   other sources (as recorded): rental weekly 490 / 465 -> 2,123.33 / 2,015.00; business annual 14,500.01 -> 1,208.33;
 *   capital gains annual 407.60 / 229.21 -> 33.97 / 19.10
 *   net income (broken)    = 331.29 + 2,015.00 + 1,208.33 + 19.10 = 3,573.72
 *   net income (corrected) = 8,613.43 + 2,015.00 + 1,208.33 + 19.10 = 11,855.86
 *   outflow = discretionary 4,535 + debt 8,362.06 = 12,897.06  ->  deficit -9,323.34 (broken) / -1,041.20 (corrected)
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

import { incomeAdapter, type ExistingIncomeRow, type IncomeEvidence } from '@/lib/import-bridge/adapters/incomeAdapter';
import { assessNetToGross, MIN_PLAUSIBLE_NET_TO_GROSS } from '@/lib/engines/incomePlausibility';
import { resolveReportSourceData, buildEligibilityInput } from '@/lib/services/reportSnapshotResolver';
import { buildReportSections } from '@/lib/engines/reportSections';
import { makeFakeSupabase, type Row } from './readModels/helpers/fakeSupabase';
import { expenseItem, incomeSource, liability, profile, tables, USER } from './readModels/helpers/fixtures';

// ---------------------------------------------------------------------------
// 1. The import proposal can never put a per-pay net on an annual gross
// ---------------------------------------------------------------------------

const annualSalaryRow: ExistingIncomeRow = {
  id: '63d26f07-a799-4286-bdb6-38f324c87428', source_name: 'Employment Salary', income_type: 'other', amount: 196994.48, net_amount: null,
  frequency: 'annually', currency_code: 'AUD', owner: 'self', is_taxable: true, employer_name: null, notes: null, master_item_key: 'employment_salary',
};
function evidence(over: Partial<IncomeEvidence> = {}): IncomeEvidence {
  return {
    payrollEventId: 'pe-1', employerName: 'Acme Pty Ltd', currencyCode: 'AUD', canonicalFrequency: 'fortnightly', frequencyStated: true,
    grossPay: 7576.71, netPay: 3975.43, reimbursementsIncludedInGross: false, reviewReasons: [], bankMatchStatus: 'not_attempted', ...over,
  };
}
const byName = (draft: ReturnType<typeof incomeAdapter.buildProposal>, name: string) => draft.fields.find((f) => f.fieldName === name);

describe('Income import proposal keeps one period basis per row', () => {
  it('[DEFECT] a fortnightly payslip proposed onto an ANNUAL row is converted to the row frequency (net 3,975.43 x 26 = 103,361.18)', () => {
    const draft = incomeAdapter.buildProposal(evidence(), [annualSalaryRow]);
    expect(draft.targetEntityId).toBe(annualSalaryRow.id);
    expect(byName(draft, 'net_amount')?.proposedValue).toBe('103361.18');
    expect(byName(draft, 'amount')?.proposedValue).toBe('196994.46');
    // The row keeps its own frequency: no frequency change is proposed, so no tick combination can mix bases.
    expect(byName(draft, 'frequency')).toBeUndefined();
    expect(draft.summary.reviewReasons).toContain('amounts_converted_to_existing_frequency');
  });

  it('[DEFECT] fortnightly onto a MONTHLY row: x 26 / 12 (3,975.43 -> 8,613.43)', () => {
    const draft = incomeAdapter.buildProposal(evidence(), [{ ...annualSalaryRow, frequency: 'monthly', amount: 16416.21 }]);
    expect(byName(draft, 'net_amount')?.proposedValue).toBe('8613.43');
    expect(byName(draft, 'frequency')).toBeUndefined();
  });

  it('[DEFECT] when the payslip frequency was only inferred, the converted amounts must be explicitly confirmed', () => {
    const draft = incomeAdapter.buildProposal(evidence({ frequencyStated: false }), [annualSalaryRow]);
    expect(byName(draft, 'net_amount')?.requiresConfirmation).toBe(true);
    expect(byName(draft, 'amount')?.requiresConfirmation).toBe(true);
    expect(draft.summary.reviewReasons).toContain('frequency_uncertain');
  });

  it('control: same frequency on both sides is untouched (no conversion, no reason)', () => {
    const draft = incomeAdapter.buildProposal(evidence(), [{ ...annualSalaryRow, frequency: 'fortnightly', amount: 7576.71 }]);
    expect(byName(draft, 'net_amount')?.proposedValue).toBe('3975.43');
    expect(draft.summary.reviewReasons).not.toContain('amounts_converted_to_existing_frequency');
  });

  it('control: a brand-new row keeps the payslip frequency and per-pay amounts', () => {
    const draft = incomeAdapter.buildProposal(evidence(), []);
    expect(byName(draft, 'frequency')?.proposedValue).toBe('fortnightly');
    expect(byName(draft, 'net_amount')?.proposedValue).toBe('3975.43');
  });
});

describe('validateApply refuses a selection that would mix period bases (proposals generated before this fix)', () => {
  // A legacy stored proposal: per-pay amounts, frequency change proposed but not ticked by default.
  const legacy = [
    { fieldName: 'amount', valueKind: 'money', proposedValue: '7576.71', existingValue: '196994.48', isRecommended: true, requiresConfirmation: false, reasonCode: 'gross_from_payslip' },
    { fieldName: 'net_amount', valueKind: 'money', proposedValue: '3975.43', existingValue: null, isRecommended: true, requiresConfirmation: false, reasonCode: 'net_from_payslip' },
    { fieldName: 'frequency', valueKind: 'enum', proposedValue: 'fortnightly', existingValue: 'annually', isRecommended: true, requiresConfirmation: true, reasonCode: 'frequency_inferred_single_payslip' },
  ] as never;
  it('[DEFECT] net alone onto an annual row is refused', () => {
    expect(incomeAdapter.validateApply('apply_selected_fields', legacy, ['net_amount']).ok).toBe(false);
  });
  it('[DEFECT] amount + net without the frequency is refused', () => {
    expect(incomeAdapter.validateApply('apply_selected_fields', legacy, ['amount', 'net_amount']).ok).toBe(false);
  });
  it('[DEFECT] frequency without the amounts is refused (the old annual gross would be read as per-fortnight)', () => {
    expect(incomeAdapter.validateApply('apply_selected_fields', legacy, ['frequency']).ok).toBe(false);
  });
  it('amount + net + frequency together are accepted (one consistent basis)', () => {
    expect(incomeAdapter.validateApply('apply_selected_fields', legacy, ['amount', 'net_amount', 'frequency']).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Plausibility: a wage whose take-home is a tiny share of its gross is disclosed
// ---------------------------------------------------------------------------

describe('assessNetToGross', () => {
  it('documents its threshold: net below 30% of gross, or above gross, is implausible for wages', () => {
    expect(MIN_PLAUSIBLE_NET_TO_GROSS).toBe(0.3);
    expect(assessNetToGross(16416.21, 331.29)).toBe('net_far_below_gross');
    expect(assessNetToGross(16416.21, 8613.43)).toBe('ok');
    expect(assessNetToGross(1000, 1200)).toBe('net_above_gross');
    expect(assessNetToGross(1000, 300)).toBe('ok'); // exactly the threshold is allowed
    expect(assessNetToGross(0, 0)).toBe('ok');
  });
});

function poIncomeRows(salaryNet: number): Row[] {
  return [
    incomeSource('63d26f07', 'Employment Salary', 196994.48, 'annually', { net_amount: salaryNet, source_type: 'payslip_import', master_item_key: 'employment_salary' }),
    incomeSource('37232316', 'Rental Income', 490, 'weekly', { net_amount: 465, master_item_key: 'rental_income', owner: 'joint' }),
    incomeSource('78d7a1ba', 'Business Income', 14500.01, 'annually', { net_amount: 14500.01, master_item_key: 'business_income' }),
    incomeSource('c5c4f379', 'Capital Gains', 407.6, 'annually', { net_amount: 229.21, master_item_key: 'capital_gains' }),
  ];
}
async function build(salaryNet: number) {
  const t = tables(profile('AUD', 'AU', 56), {
    income_sources: poIncomeRows(salaryNet),
    expense_items: [expenseItem('e-1', 'Spend', 4535, 'monthly', { is_essential: false, master_item_key: 'entertainment' })],
    liabilities: [liability('l-1', { liability_name: 'Loans', debt_type: 'mortgage', master_item_key: 'home_loan', balance: 1385857, monthly_repayment: 8362.06, interest_rate: 6, country_code: 'AU' })],
  });
  const { client } = makeFakeSupabase(tables(t, { user_entitlements: [{ user_id: USER, plan_tier: 'free' }] }));
  const source = await resolveReportSourceData(USER, undefined, client as never);
  const sections = buildReportSections(source, buildEligibilityInput(source), false);
  return { source, get: (code: string) => sections.find((s) => s.sectionCode === code)! };
}

describe('Monthly Report on the PO income records', () => {
  it('reproduces the PDF with the mixed-basis record: net 3,573.72 and deficit 9,323.34', async () => {
    const { source } = await build(3975.43);
    expect(source.dashboard.grossMonthlyIncome).toBeCloseTo(19781.84, 2);
    expect(source.dashboard.netMonthlyIncome).toBeCloseTo(3573.72, 2);
    expect(source.dashboard.monthlySurplus).toBeCloseTo(-9323.34, 2);
  });

  it('with the net on the annual basis (103,361.18) the deficit is about 1,041 and nothing is flagged', async () => {
    const { source, get } = await build(103361.18);
    expect(source.dashboard.netMonthlyIncome).toBeCloseTo(11855.86, 1);
    expect(source.dashboard.monthlySurplus).toBeCloseTo(-1041.2, 1);
    expect(source.dashboard.dataStatus?.netIncomeImplausible ?? []).toEqual([]);
    expect(get('cash_flow').sectionData.netIncomeNote ?? null).toBeNull();
  });

  it('[DEFECT] the mixed-basis record is disclosed on the Dashboard data status and in the report', async () => {
    const { source, get } = await build(3975.43);
    const flags = source.dashboard.dataStatus?.netIncomeImplausible ?? [];
    expect(flags).toHaveLength(1);
    expect(flags[0].name).toBe('Employment Salary');
    expect(flags[0].kind).toBe('net_far_below_gross');
    expect(flags[0].netToGross).toBeCloseTo(331.29 / 16416.21, 3);
    const note = get('cash_flow').sectionData.netIncomeNote as string;
    expect(note).toMatch(/Employment Salary/);
    expect(note).toMatch(/take-home pay of 2% of gross/i);
    expect(note).toMatch(/same pay period/i);
    const exec = (get('executive_summary').chartData as { cashFlow: { summary: string } }).cashFlow.summary;
    expect(exec).toMatch(/Employment Salary/);
  });

  it('a rental or capital-gains line with a low net is NOT flagged (only wages are tested)', async () => {
    const t = tables(profile('AUD', 'AU', 56), { income_sources: [incomeSource('r1', 'Rental Income', 1000, 'monthly', { net_amount: 100, master_item_key: 'rental_income' })] });
    const { client } = makeFakeSupabase(tables(t, { user_entitlements: [{ user_id: USER, plan_tier: 'free' }] }));
    const source = await resolveReportSourceData(USER, undefined, client as never);
    expect(source.dashboard.dataStatus?.netIncomeImplausible ?? []).toEqual([]);
  });
});
