import { describe, it, expect } from 'vitest';
import { computeDashboard, type DashboardInput, type DashboardSummary } from '@/lib/engines/dashboard';
import { computeResilience, type ResilienceConfig, type ResilienceInput, type CommitmentRow } from '@/lib/engines/resilience';
import { computeResilienceEligibility } from '@/lib/engines/resilienceEligibility';
import {
  ALL_SECTIONS,
  effectiveSectionStatus,
  type FinancialSection,
  type FinancialSectionStatus,
} from '@/lib/engines/financialSectionStatus';

const RESILIENCE_CONFIG: ResilienceConfig = {
  componentWeights: {
    emergency_fund: 0.25,
    liquidity: 0.15,
    income_resilience: 0.15,
    insurance_protection: 0.2,
    debt_pressure: 0.15,
    concentration_risk: 0.1,
  },
  scoreBands: [
    { min: 85, band: 'highly_resilient', label: 'Highly Resilient' },
    { min: 70, band: 'resilient', label: 'Resilient' },
    { min: 55, band: 'moderately_vulnerable', label: 'Moderately Vulnerable' },
    { min: 40, band: 'vulnerable', label: 'Vulnerable' },
    { min: 0, band: 'fragile', label: 'Fragile' },
  ],
  confidenceWeights: {
    incomeCompleteness: 0.15,
    expenseCompleteness: 0.15,
    liquidAssetCompleteness: 0.2,
    liabilityCompleteness: 0.15,
    insuranceCompleteness: 0.2,
    dataRecency: 0.1,
    verificationHistory: 0.05,
  },
  riskOverride: {
    scoreCapPrimary: 49,
    scoreCapSecondary: 59,
    criticalLiquidityWeeks: 2,
    refinanceExposureMonths: 6,
  },
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

// Phase 0C: derives the same "no explicit confirmation, judge purely by
// row presence" section status every real not-yet-confirmed household
// would have — matches loadSectionStatus's behaviour for a user who has
// never set an explicit reviewed_zero/not_applicable confirmation.
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

function resilienceFor(
  rows: Partial<DashboardInput>,
  extra: Partial<Omit<ResilienceInput, 'dashboard' | 'config' | 'sectionStatus'>> & {
    // Partial overrides merged onto the row-derived default — lets a test
    // simulate an explicit "I have no liabilities/insurance" confirmation
    // without having to spell out the full 8-section map every time.
    sectionStatus?: Partial<Record<FinancialSection, FinancialSectionStatus>>;
  } = {}
) {
  const dashboard = computeDashboard({ ...EMPTY, ...rows }, 'AUD');
  return computeResilience({
    dashboard,
    dependantsCount: extra.dependantsCount ?? 0,
    isSelfEmployed: extra.isSelfEmployed ?? false,
    commitments: (extra.commitments as CommitmentRow[]) ?? [],
    isCurrentSnapshotRecent: extra.isCurrentSnapshotRecent ?? true,
    hasPriorMonthHistory: extra.hasPriorMonthHistory ?? true,
    config: RESILIENCE_CONFIG,
    sectionStatus: { ...defaultSectionStatus(dashboard), ...extra.sectionStatus },
  });
}

function componentByCode(result: ReturnType<typeof resilienceFor>, code: string) {
  return result.components.find((c) => c.code === code)!;
}

function riskCodes(result: ReturnType<typeof resilienceFor>): string[] {
  return result.risks.map((r) => r.code);
}

describe('Financial Resilience scoring — synthetic personas', () => {
  it('Persona A: Highly Resilient Dual-Income', () => {
    const result = resilienceFor(
      {
        income: [
          { amount: 6000, net_amount: null, frequency: 'monthly', master_item_key: 'employment_salary', employer_name: 'Acme Corp' },
          { amount: 3000, net_amount: null, frequency: 'monthly', master_item_key: 'employment_salary', employer_name: 'Beta Pty' },
        ],
        expenses: [
          { expense_name: 'Essentials', amount: 3000, frequency: 'monthly', is_essential: true },
          { expense_name: 'Lifestyle', amount: 1000, frequency: 'monthly', is_essential: false },
        ],
        assets: [{ current_value: 45000, asset_class: 'cash' }],
        investments: [
          { current_value: 25000, cost_base: 20000, investment_type: 'etfs', country_code: 'AU', annual_contribution: 3000, institution: 'Vanguard' },
          { current_value: 25000, cost_base: 20000, investment_type: 'shares', country_code: 'AU', annual_contribution: 3000, institution: 'CommSec' },
        ],
        liabilities: [
          { balance: 300000, interest_rate: 6, monthly_repayment: 1800, debt_type: 'mortgage', interest_rate_type: 'fixed', fixed_rate_expiry: '2030-01-01' },
        ],
        insurance: [
          { policy_name: 'Life', cover_amount: 1200000, premium: 50, premium_frequency: 'monthly', cover_type: 'life', renewal_date: null },
          { policy_name: 'IP', cover_amount: 5000, premium: 40, premium_frequency: 'monthly', cover_type: 'income_protection', renewal_date: null, waiting_period_days: 30 },
        ],
      },
      { dependantsCount: 2 }
    );
    expect(result.risks.filter((r) => r.severity === 'critical')).toHaveLength(0);
    expect(result.overallScore).toBeGreaterThanOrEqual(75);
    expect(['highly_resilient', 'resilient']).toContain(result.statusBand);
  });

  it('Persona B: Single Earner, Limited Cash', () => {
    const result = resilienceFor(
      {
        income: [{ amount: 5000, net_amount: null, frequency: 'monthly', master_item_key: 'employment_salary', employer_name: 'SoloCo' }],
        expenses: [
          { expense_name: 'Rent', amount: 2000, frequency: 'monthly', is_essential: true, master_item_key: 'rent' },
          { expense_name: 'Groceries', amount: 1000, frequency: 'monthly', is_essential: true, master_item_key: 'groceries' },
          { expense_name: 'Lifestyle', amount: 500, frequency: 'monthly', is_essential: false },
        ],
        assets: [{ current_value: 1000, asset_class: 'cash' }],
        liabilities: [{ balance: 20000, interest_rate: 15, monthly_repayment: 600, debt_type: 'personal_loan', interest_rate_type: 'variable' }],
      },
      { dependantsCount: 2 }
    );
    expect(riskCodes(result)).toContain('critical_liquidity');
    expect(riskCodes(result)).toContain('no_life_insurance');
    expect(result.roundedScore).toBeLessThanOrEqual(49);
  });

  it('Persona C: Property-Focused Investor', () => {
    const result = resilienceFor({
      income: [{ amount: 7000, net_amount: null, frequency: 'monthly', master_item_key: 'employment_salary' }],
      expenses: [
        { expense_name: 'Essentials', amount: 2500, frequency: 'monthly', is_essential: true },
        { expense_name: 'Lifestyle', amount: 800, frequency: 'monthly', is_essential: false },
      ],
      assets: [
        { current_value: 5000, asset_class: 'cash' },
        { current_value: 600000, asset_class: 'property' },
      ],
      liabilities: [{ balance: 450000, interest_rate: 5.5, monthly_repayment: 2600, debt_type: 'investment_loan', interest_rate_type: 'variable' }],
    });
    const concentration = componentByCode(result, 'concentration_risk');
    expect(concentration.rawScore).toBeLessThan(60);
    expect(riskCodes(result)).toContain('property_concentration');
  });

  it('Persona D: Cash-Rich Household', () => {
    // Phase 0C: no liability rows alone is no longer enough to score
    // debt_pressure as a confirmed zero — this persona explicitly confirms
    // "I have no liabilities" (sectionStatus.liabilities = 'reviewed_zero')
    // to preserve the original intent of a genuinely debt-free household,
    // rather than relying on the old hasEngaged() inference.
    const result = resilienceFor(
      {
        income: [{ amount: 4000, net_amount: null, frequency: 'monthly', master_item_key: 'employment_salary' }],
        expenses: [{ expense_name: 'Essentials', amount: 2000, frequency: 'monthly', is_essential: true }],
        assets: [{ current_value: 60000, asset_class: 'cash' }],
      },
      { sectionStatus: { liabilities: 'reviewed_zero' } }
    );
    expect(componentByCode(result, 'emergency_fund').rawScore).toBe(100);
    expect(componentByCode(result, 'liquidity').rawScore).toBe(100);
    expect(componentByCode(result, 'debt_pressure').rawScore).toBe(100);
    expect(result.overallScore).toBeGreaterThanOrEqual(80);
  });

  it('Phase 0C: unconfirmed absence of liabilities is missing data, not a confirmed zero', () => {
    const result = resilienceFor({
      income: [{ amount: 4000, net_amount: null, frequency: 'monthly', master_item_key: 'employment_salary' }],
      expenses: [{ expense_name: 'Essentials', amount: 2000, frequency: 'monthly', is_essential: true }],
      assets: [{ current_value: 60000, asset_class: 'cash' }],
    });
    expect(componentByCode(result, 'debt_pressure').treatment).toBe('missing_data');
    expect(componentByCode(result, 'debt_pressure').rawScore).toBeNull();
  });

  it('Phase 0C: unconfirmed absence of insurance is missing data, not an inferred score', () => {
    const result = resilienceFor({
      income: [{ amount: 4000, net_amount: null, frequency: 'monthly', master_item_key: 'employment_salary' }],
      expenses: [{ expense_name: 'Essentials', amount: 2000, frequency: 'monthly', is_essential: true }],
      assets: [{ current_value: 60000, asset_class: 'cash' }],
    });
    expect(componentByCode(result, 'insurance_protection').treatment).toBe('missing_data');
  });

  it('Phase 0C: explicit no-insurance confirmation is scored using the existing approved logic', () => {
    const result = resilienceFor(
      {
        income: [{ amount: 4000, net_amount: null, frequency: 'monthly', master_item_key: 'employment_salary' }],
        expenses: [{ expense_name: 'Essentials', amount: 2000, frequency: 'monthly', is_essential: true }],
        assets: [{ current_value: 60000, asset_class: 'cash' }],
      },
      { sectionStatus: { insurance: 'reviewed_zero' } }
    );
    expect(componentByCode(result, 'insurance_protection').treatment).toBe('scored');
    expect(componentByCode(result, 'insurance_protection').rawScore).toBe(55);
  });

  it('Persona E: Debt-Constrained Household', () => {
    const result = resilienceFor({
      income: [{ amount: 6000, net_amount: null, frequency: 'monthly', master_item_key: 'employment_salary' }],
      expenses: [{ expense_name: 'Essentials', amount: 2500, frequency: 'monthly', is_essential: true }],
      assets: [{ current_value: 4000, asset_class: 'cash' }],
      liabilities: [
        { balance: 25000, interest_rate: 20, monthly_repayment: 2200, debt_type: 'credit_card', interest_rate_type: 'variable', credit_limit: 26000 },
        { balance: 15000, interest_rate: 12, monthly_repayment: 900, debt_type: 'personal_loan', interest_rate_type: 'variable' },
      ],
    });
    expect(componentByCode(result, 'debt_pressure').rawScore).toBeLessThan(50);
    expect(riskCodes(result)).toContain('high_credit_utilization');
    expect(riskCodes(result)).toContain('variable_rate_exposure');
  });

  it('Persona F: Retired Household', () => {
    const result = resilienceFor({
      income: [
        { amount: 2500, net_amount: null, frequency: 'monthly', master_item_key: 'super_pension' },
        { amount: 1200, net_amount: null, frequency: 'monthly', master_item_key: 'age_pension' },
      ],
      expenses: [{ expense_name: 'Essentials', amount: 2000, frequency: 'monthly', is_essential: true }],
      assets: [{ current_value: 40000, asset_class: 'cash' }],
    });
    const income = componentByCode(result, 'income_resilience');
    expect(income.currentValue.passiveIncomeRatio).toBeCloseTo(1, 1);
    expect(income.rawScore).toBeGreaterThan(70);
  });

  it('Persona G: Self-Employed Household', () => {
    const result = resilienceFor(
      {
        income: [{ amount: 5000, net_amount: null, frequency: 'monthly', master_item_key: 'business_income', employer_name: 'Freelance' }],
        expenses: [{ expense_name: 'Essentials', amount: 2500, frequency: 'monthly', is_essential: true }],
        assets: [{ current_value: 10000, asset_class: 'cash' }],
        insurance: [{ policy_name: 'Health', cover_amount: 0, premium: 60, premium_frequency: 'monthly', cover_type: 'health', renewal_date: null }],
      },
      { isSelfEmployed: true }
    );
    expect(riskCodes(result)).toContain('no_income_protection');
    expect(componentByCode(result, 'income_resilience').currentValue.incomeSourceCount).toBe(1);
  });

  it('Persona H: Cross-Border Household', () => {
    const result = resilienceFor({
      income: [{ amount: 8000, net_amount: null, frequency: 'monthly', master_item_key: 'employment_salary' }],
      expenses: [{ expense_name: 'Essentials', amount: 3000, frequency: 'monthly', is_essential: true }],
      assets: [{ current_value: 20000, asset_class: 'cash' }],
      investments: [
        { current_value: 8000, cost_base: 8000, investment_type: 'etfs', country_code: 'AU', annual_contribution: 0, institution: 'Vanguard' },
        { current_value: 40000, cost_base: 35000, investment_type: 'shares', country_code: 'IN', annual_contribution: 0, institution: 'Zerodha' },
      ],
    });
    const concentration = componentByCode(result, 'concentration_risk');
    expect(concentration.currentValue.countryConcentration as number).toBeCloseTo(0.833, 2);
  });

  it('Persona I: Insufficient Data', () => {
    const result = resilienceFor({});
    expect(result.components.every((c) => c.treatment === 'missing_data')).toBe(true);
    expect(result.overallScore).toBe(0);
    expect(result.confidence).toBeLessThan(30);
    expect(result.risks).toHaveLength(0);
  });

  it('Safeguard: essential expenses at zero is missing data, not a confirmed zero', () => {
    const result = resilienceFor({
      income: [{ amount: 3000, net_amount: null, frequency: 'monthly', master_item_key: 'employment_salary' }],
      expenses: [{ expense_name: 'Something', amount: 500, frequency: 'monthly', is_essential: false }],
      assets: [{ current_value: 5000, asset_class: 'cash' }],
    });
    expect(componentByCode(result, 'emergency_fund').treatment).toBe('missing_data');
  });

  it('Safeguard: future commitments reduce accessible emergency resources', () => {
    const rows: Partial<DashboardInput> = {
      income: [{ amount: 4000, net_amount: null, frequency: 'monthly', master_item_key: 'employment_salary' }],
      expenses: [{ expense_name: 'Essentials', amount: 2000, frequency: 'monthly', is_essential: true }],
      assets: [{ current_value: 60000, asset_class: 'cash' }],
    };
    const withoutCommitments = resilienceFor(rows);
    const dueSoon = new Date();
    dueSoon.setDate(dueSoon.getDate() + 10);
    const withCommitments = resilienceFor(rows, {
      commitments: [{ amount: 50000, due_date: dueSoon.toISOString().slice(0, 10), is_mandatory: true }],
    });
    const before = componentByCode(withoutCommitments, 'emergency_fund').currentValue.accessibleResources as number;
    const after = componentByCode(withCommitments, 'emergency_fund').currentValue.accessibleResources as number;
    expect(after).toBeLessThan(before);
    expect(after).toBeCloseTo(10000, 0);
  });
});

// Phase 0C.1 §42 — mandatory RS-01..RS-06 Resilience presentation-state
// tests. No new Resilience methodology is exercised here — only whether
// computeResilienceEligibility() correctly reads the same component
// treatments computeResilience() already produces.
describe('Phase 0C.1 — Resilience presentation states', () => {
  it('RS-01: insufficient data (Persona I) -> Resilience Not Yet Available', () => {
    const result = resilienceFor({});
    const eligibility = computeResilienceEligibility(result.components);
    expect(eligibility.state).toBe('not_yet_available');
    expect(eligibility.canDisplayNumericScore).toBe(false);
    expect(eligibility.scoredComponents).toBe(0);
  });

  it('RS-02: some but not all components available -> Preliminary Resilience', () => {
    // Income + expenses + assets gives emergency_fund, liquidity, and
    // income_resilience real scores; debt/insurance stay missing
    // (unconfirmed), concentration_risk has an asset base to work with too.
    const result = resilienceFor({
      income: [{ amount: 4000, net_amount: null, frequency: 'monthly', master_item_key: 'employment_salary' }],
      expenses: [{ expense_name: 'Essentials', amount: 2000, frequency: 'monthly', is_essential: true }],
      assets: [{ current_value: 20000, asset_class: 'cash' }],
    });
    const eligibility = computeResilienceEligibility(result.components);
    expect(eligibility.state).toBe('preliminary');
    expect(eligibility.canDisplayNumericScore).toBe(true);
    expect(eligibility.missingComponentLabels.length).toBeGreaterThan(0);
  });

  it('RS-03: every component resolved (data or confirmed zero) -> Full Resilience', () => {
    // Persona A already scores every component from real data; Full just
    // needs zero components left as missing_data.
    const result = resilienceFor(
      {
        income: [
          { amount: 6000, net_amount: null, frequency: 'monthly', master_item_key: 'employment_salary', employer_name: 'Acme Corp' },
        ],
        expenses: [{ expense_name: 'Essentials', amount: 3000, frequency: 'monthly', is_essential: true }],
        assets: [{ current_value: 45000, asset_class: 'cash' }],
        investments: [
          { current_value: 25000, cost_base: 20000, investment_type: 'etfs', country_code: 'AU', annual_contribution: 3000, institution: 'Vanguard' },
        ],
      },
      { sectionStatus: { liabilities: 'reviewed_zero', insurance: 'reviewed_zero' } }
    );
    const eligibility = computeResilienceEligibility(result.components);
    expect(eligibility.state).toBe('full');
    expect(eligibility.missingComponentLabels).toHaveLength(0);
    expect(eligibility.canDisplayNumericScore).toBe(true);
  });

  it('RS-04: missing liabilities do not score Debt Pressure (raw methodology unaffected)', () => {
    const result = resilienceFor({
      income: [{ amount: 4000, net_amount: null, frequency: 'monthly', master_item_key: 'employment_salary' }],
      expenses: [{ expense_name: 'Essentials', amount: 2000, frequency: 'monthly', is_essential: true }],
      assets: [{ current_value: 60000, asset_class: 'cash' }],
    });
    expect(componentByCode(result, 'debt_pressure').treatment).toBe('missing_data');
  });

  it('RS-05: confirmed zero liabilities use the existing approved scoring (raw methodology unaffected)', () => {
    const result = resilienceFor(
      {
        income: [{ amount: 4000, net_amount: null, frequency: 'monthly', master_item_key: 'employment_salary' }],
        expenses: [{ expense_name: 'Essentials', amount: 2000, frequency: 'monthly', is_essential: true }],
        assets: [{ current_value: 60000, asset_class: 'cash' }],
      },
      { sectionStatus: { liabilities: 'reviewed_zero' } }
    );
    expect(componentByCode(result, 'debt_pressure').treatment).toBe('scored');
    expect(componentByCode(result, 'debt_pressure').rawScore).toBe(100);
  });

  it('RS-06: missing Insurance does not score Protection (raw methodology unaffected)', () => {
    const result = resilienceFor({
      income: [{ amount: 4000, net_amount: null, frequency: 'monthly', master_item_key: 'employment_salary' }],
      expenses: [{ expense_name: 'Essentials', amount: 2000, frequency: 'monthly', is_essential: true }],
      assets: [{ current_value: 60000, asset_class: 'cash' }],
    });
    expect(componentByCode(result, 'insurance_protection').treatment).toBe('missing_data');
  });
});
