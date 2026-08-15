import { describe, it, expect } from 'vitest';
import { computeDashboard, type DashboardInput, type DashboardSummary } from '@/lib/engines/dashboard';
import { computeHealthScore, type HealthScoreConfig, type HealthScoreInput } from '@/lib/engines/healthScore';
import { computeHealthScoreEligibility } from '@/lib/engines/healthScoreEligibility';
import {
  ALL_SECTIONS,
  effectiveSectionStatus,
  type FinancialSection,
  type FinancialSectionStatus,
} from '@/lib/engines/financialSectionStatus';

// Matches the seed config in supabase/migrations/0006_module4_health_score.sql
// exactly, so these tests exercise the same weighting/banding real accounts do.
const HEALTH_SCORE_CONFIG: HealthScoreConfig = {
  componentWeights: {
    cash_flow: 0.15,
    savings: 0.12,
    emergency_fund: 0.12,
    debt: 0.15,
    net_worth: 0.1,
    investment: 0.08,
    retirement: 0.1,
    insurance: 0.08,
    resilience: 0.05,
    behaviour: 0.05,
  },
  scoreBands: [
    { min: 85, band: 'excellent', label: 'Excellent' },
    { min: 70, band: 'good', label: 'Good' },
    { min: 55, band: 'fair', label: 'Fair' },
    { min: 40, band: 'needs_attention', label: 'Needs Attention' },
    { min: 0, band: 'critical', label: 'Critical' },
  ],
  riskOverride: { deficitMonthsThreshold: 2, emergencyMonthsThreshold: 1, scoreCap: 49 },
};

const EMPTY: DashboardInput = {
  income: [],
  expenses: [],
  assets: [],
  liabilities: [],
  investments: [],
  retirement: [],
  insurance: [],
  goals: [],
  snapshots: [],
};

// Same derivation loadSectionStatus uses for a household with no explicit
// confirmations on file — pure row presence, nothing inferred.
function defaultSectionStatus(dashboard: DashboardSummary): Record<FinancialSection, FinancialSectionStatus> {
  const hasRows: Record<FinancialSection, boolean> = {
    household: true,
    income: dashboard.hasIncome,
    expenses: dashboard.hasExpenses,
    assets: dashboard.hasAssets,
    liabilities: dashboard.hasLiabilities,
    investments: dashboard.hasInvestments,
    retirement: dashboard.hasRetirement,
    insurance: dashboard.hasInsurance,
  };
  const result = {} as Record<FinancialSection, FinancialSectionStatus>;
  for (const section of ALL_SECTIONS) {
    result[section] = effectiveSectionStatus({ hasRows: hasRows[section], explicitConfirmation: null });
  }
  return result;
}

function scoreFor(
  rows: Partial<DashboardInput>,
  extra: Partial<Omit<HealthScoreInput, 'dashboard' | 'config' | 'sectionStatus'>> & {
    sectionStatus?: Partial<Record<FinancialSection, FinancialSectionStatus>>;
  } = {}
) {
  const dashboard = computeDashboard({ ...EMPTY, ...rows }, 'AUD');
  const sectionStatus = { ...defaultSectionStatus(dashboard), ...extra.sectionStatus };
  const input: HealthScoreInput = {
    dashboard,
    age: extra.age ?? 35,
    dependantsCount: extra.dependantsCount ?? 0,
    isSelfEmployed: extra.isSelfEmployed ?? false,
    checkIns: extra.checkIns ?? null,
    resilienceResult: extra.resilienceResult ?? null,
    config: HEALTH_SCORE_CONFIG,
    sectionStatus,
  };
  const result = computeHealthScore(input);
  const eligibility = computeHealthScoreEligibility(sectionStatus, result.components);
  return { result, eligibility, sectionStatus };
}

function componentByCode(result: ReturnType<typeof scoreFor>['result'], code: string) {
  return result.components.find((c) => c.code === code)!;
}

describe('Phase 0C — Financial Health Score eligibility and missing-data integrity', () => {
  // --- Test Group A: zero data ----------------------------------------------
  it('Group A: profile-only account has no scored components and is not_yet_scored', () => {
    const { result, eligibility } = scoreFor({});
    expect(result.components.every((c) => c.treatment === 'missing_data')).toBe(true);
    expect(result.overallScore).toBe(0);
    expect(eligibility.state).toBe('not_yet_scored');
    expect(eligibility.canDisplayNumericScore).toBe(false);
    expect(eligibility.confidencePercent).toBe(0);
    expect(eligibility.confidenceTier).toBe('low');
  });

  // --- Test Group B: income only ---------------------------------------------
  it('Group B: income only does not let Savings Behaviour assume zero expenses', () => {
    const { result, eligibility } = scoreFor({
      income: [{ amount: 95000, net_amount: 72000, frequency: 'annually', master_item_key: 'employment_salary' }],
    });
    expect(componentByCode(result, 'savings').treatment).toBe('missing_data');
    expect(componentByCode(result, 'cash_flow').treatment).toBe('missing_data');
    // Income alone (no assets/liabilities reviewed either) must not meet the
    // conservative minimum for a Preliminary score.
    expect(eligibility.state).toBe('not_yet_scored');
  });

  // --- Test Group C: income + expenses ---------------------------------------
  it('Group C: income + expenses lets Savings Behaviour and Cash Flow calculate correctly, without assuming liabilities/investments/insurance', () => {
    const { result } = scoreFor({
      income: [{ amount: 95000, net_amount: 72000, frequency: 'annually', master_item_key: 'employment_salary' }],
      expenses: [{ expense_name: 'Rent', amount: 2200, frequency: 'monthly', is_essential: false }],
    });
    expect(componentByCode(result, 'cash_flow').treatment).toBe('scored');
    expect(componentByCode(result, 'savings').treatment).toBe('scored');
    // No silent assumption about liabilities, investments, retirement, or insurance.
    expect(componentByCode(result, 'debt').treatment).toBe('missing_data');
    expect(componentByCode(result, 'investment').treatment).toBe('missing_data');
    expect(componentByCode(result, 'retirement').treatment).toBe('missing_data');
    expect(componentByCode(result, 'insurance').treatment).toBe('missing_data');
  });

  // --- Test Group D: no liabilities, not reviewed ----------------------------
  it('Group D: unreviewed absence of liabilities is missing data, not 100', () => {
    const { result } = scoreFor({
      income: [{ amount: 95000, net_amount: 72000, frequency: 'annually', master_item_key: 'employment_salary' }],
      expenses: [{ expense_name: 'Rent', amount: 2200, frequency: 'monthly', is_essential: false }],
      assets: [{ current_value: 25000, asset_class: 'cash' }],
    });
    const debt = componentByCode(result, 'debt');
    expect(debt.treatment).toBe('missing_data');
    expect(debt.rawScore).toBeNull();
  });

  // --- Test Group E: no liabilities, explicitly confirmed --------------------
  it('Group E: explicit zero-liabilities confirmation scores Debt Health as a confirmed 100', () => {
    const { result } = scoreFor(
      {
        income: [{ amount: 95000, net_amount: 72000, frequency: 'annually', master_item_key: 'employment_salary' }],
        expenses: [{ expense_name: 'Rent', amount: 2200, frequency: 'monthly', is_essential: false }],
        assets: [{ current_value: 25000, asset_class: 'cash' }],
      },
      { sectionStatus: { liabilities: 'reviewed_zero' } }
    );
    const debt = componentByCode(result, 'debt');
    expect(debt.treatment).toBe('scored');
    expect(debt.rawScore).toBe(100);
    expect(debt.explanation).toContain('confirmed by you');
  });

  // --- Test Group F: liabilities exist ---------------------------------------
  it('Group F: real liability rows are scored from actual debt-service ratio, unaffected by Phase 0C', () => {
    const { result } = scoreFor({
      income: [{ amount: 95000, net_amount: 72000, frequency: 'annually', master_item_key: 'employment_salary' }],
      expenses: [{ expense_name: 'Rent', amount: 2200, frequency: 'monthly', is_essential: false }],
      liabilities: [{ balance: 20000, interest_rate: 15, monthly_repayment: 600, debt_type: 'personal_loan', interest_rate_type: 'variable' }],
    });
    const debt = componentByCode(result, 'debt');
    expect(debt.treatment).toBe('scored');
    expect(debt.rawScore).not.toBeNull();
    expect(debt.currentValue.totalDebt).toBe(20000);
  });

  // --- Test Group G: insurance unknown ---------------------------------------
  it('Group G: unreviewed insurance is missing data, no arbitrary default score', () => {
    const { result } = scoreFor({
      income: [{ amount: 95000, net_amount: 72000, frequency: 'annually', master_item_key: 'employment_salary' }],
      expenses: [{ expense_name: 'Rent', amount: 2200, frequency: 'monthly', is_essential: false }],
    });
    expect(componentByCode(result, 'insurance').treatment).toBe('missing_data');
  });

  // --- Test Group H: explicitly no insurance ----------------------------------
  it('Group H: explicit no-insurance confirmation is evaluated by the existing approved logic', () => {
    const { result } = scoreFor(
      {
        income: [{ amount: 95000, net_amount: 72000, frequency: 'annually', master_item_key: 'employment_salary' }],
        expenses: [{ expense_name: 'Rent', amount: 2200, frequency: 'monthly', is_essential: false }],
      },
      { sectionStatus: { insurance: 'reviewed_zero' }, dependantsCount: 0 }
    );
    const insurance = componentByCode(result, 'insurance');
    expect(insurance.treatment).toBe('scored');
    expect(insurance.rawScore).toBe(60);
    expect(insurance.explanation).toContain('confirmed by you');
  });

  // --- Test Group I: investments not applicable -------------------------------
  it('Group I: not-applicable investments are excluded from both the score and the confidence denominator', () => {
    const { result, eligibility } = scoreFor(
      {
        income: [{ amount: 95000, net_amount: 72000, frequency: 'annually', master_item_key: 'employment_salary' }],
        expenses: [{ expense_name: 'Rent', amount: 2200, frequency: 'monthly', is_essential: false }],
        assets: [{ current_value: 25000, asset_class: 'cash' }],
      },
      {
        sectionStatus: { liabilities: 'reviewed_zero', investments: 'not_applicable', retirement: 'not_applicable', insurance: 'reviewed_zero' },
      }
    );
    const investment = componentByCode(result, 'investment');
    expect(investment.treatment).toBe('not_applicable');
    expect(investment.weightedContribution).toBe(0);
    // not_applicable sections still count as "reviewed" for eligibility —
    // the household has told us it doesn't apply, which is a real answer.
    expect(eligibility.missingSections).not.toContain('investments');
  });

  // --- Test Group J: preliminary score ----------------------------------------
  it('Group J: minimum core sections reviewed (income, expenses, assets, liabilities) yields a Preliminary state', () => {
    const { eligibility } = scoreFor(
      {
        income: [{ amount: 95000, net_amount: 72000, frequency: 'annually', master_item_key: 'employment_salary' }],
        expenses: [{ expense_name: 'Rent', amount: 2200, frequency: 'monthly', is_essential: false }],
        assets: [{ current_value: 25000, asset_class: 'cash' }],
      },
      { sectionStatus: { liabilities: 'reviewed_zero' } }
    );
    expect(eligibility.state).toBe('preliminary');
    expect(eligibility.canDisplayNumericScore).toBe(true);
    expect(eligibility.missingSections).toEqual(expect.arrayContaining(['investments', 'retirement', 'insurance']));
    expect(eligibility.preliminaryReasons.length).toBeGreaterThan(0);
  });

  it('Group J: assets reviewed but liabilities NOT reviewed stays Not Yet Scored (conservative minimum requires both)', () => {
    const { eligibility } = scoreFor({
      income: [{ amount: 95000, net_amount: 72000, frequency: 'annually', master_item_key: 'employment_salary' }],
      expenses: [{ expense_name: 'Rent', amount: 2200, frequency: 'monthly', is_essential: false }],
      assets: [{ current_value: 25000, asset_class: 'cash' }],
      // liabilities left unreviewed — no rows, no explicit confirmation
    });
    expect(eligibility.state).toBe('not_yet_scored');
  });

  // --- Test Group K: full score -------------------------------------------------
  it('Group K: all 7 sections reviewed (data or explicit confirmation) yields a Full state with high confidence', () => {
    const { eligibility } = scoreFor(
      {
        income: [{ amount: 95000, net_amount: 72000, frequency: 'annually', master_item_key: 'employment_salary' }],
        expenses: [{ expense_name: 'Rent', amount: 2200, frequency: 'monthly', is_essential: false }],
        assets: [{ current_value: 25000, asset_class: 'cash' }],
        investments: [{ current_value: 10000, cost_base: 8000, investment_type: 'etfs', country_code: 'AU', annual_contribution: 0, institution: 'Vanguard' }],
        retirement: [{ current_balance: 50000, employer_contribution: 500, personal_contribution: 0, contribution_frequency: 'monthly', country_code: 'AU' }],
      },
      { sectionStatus: { liabilities: 'reviewed_zero', insurance: 'reviewed_zero' } }
    );
    expect(eligibility.state).toBe('full');
    expect(eligibility.missingSections).toHaveLength(0);
    expect(eligibility.confidencePercent).toBe(100);
    expect(eligibility.confidenceTier).toBe('high');
    expect(eligibility.canDisplayNumericScore).toBe(true);
  });

  // --- Confidence tier boundaries ------------------------------------------------
  it('confidenceTierFor bands match the canonical High >=80 / Medium >=50 / Low <50 thresholds', () => {
    // 4 of 7 sections reviewed = 57% -> medium
    const { eligibility: medium } = scoreFor(
      {
        income: [{ amount: 95000, net_amount: 72000, frequency: 'annually', master_item_key: 'employment_salary' }],
        expenses: [{ expense_name: 'Rent', amount: 2200, frequency: 'monthly', is_essential: false }],
        assets: [{ current_value: 25000, asset_class: 'cash' }],
      },
      { sectionStatus: { liabilities: 'reviewed_zero' } }
    );
    expect(medium.confidencePercent).toBe(57);
    expect(medium.confidenceTier).toBe('medium');

    // 6 of 7 = 86% -> high
    const { eligibility: high } = scoreFor(
      {
        income: [{ amount: 95000, net_amount: 72000, frequency: 'annually', master_item_key: 'employment_salary' }],
        expenses: [{ expense_name: 'Rent', amount: 2200, frequency: 'monthly', is_essential: false }],
        assets: [{ current_value: 25000, asset_class: 'cash' }],
        investments: [{ current_value: 10000, cost_base: 8000, investment_type: 'etfs', country_code: 'AU', annual_contribution: 0, institution: 'Vanguard' }],
        retirement: [{ current_balance: 50000, employer_contribution: 500, personal_contribution: 0, contribution_frequency: 'monthly', country_code: 'AU' }],
      },
      { sectionStatus: { liabilities: 'reviewed_zero' } }
    );
    expect(high.confidencePercent).toBe(86);
    expect(high.confidenceTier).toBe('high');
  });
});
