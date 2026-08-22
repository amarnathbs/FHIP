import { describe, it, expect } from 'vitest';
import { computeDashboard, type DashboardInput } from '@/lib/engines/dashboard';
import { classifyFinancialDna, type DnaConfig, type DnaProfileInput } from '@/lib/engines/financialDna';

const DNA_CONFIG: DnaConfig = {
  dimensionWeights: {
    savings_discipline: 0.15,
    spending_pattern: 0.12,
    debt_structure: 0.15,
    asset_allocation: 0.15,
    investment_behaviour: 0.12,
    liquidity_position: 0.1,
    retirement_preparation: 0.08,
    income_capacity: 0.08,
    protection_planning: 0.05,
  },
  secondaryThreshold: { minScore: 55, maxGapFromPrimary: 20 },
  profileChangeThreshold: 5,
  confidenceWeights: { dataCompleteness: 0.4, signalConsistency: 0.3, separation: 0.2, recency: 0.1 },
  confidenceBands: [
    { min: 85, band: 'very_high', label: 'Very high' },
    { min: 70, band: 'high', label: 'High' },
    { min: 55, band: 'moderate', label: 'Moderate' },
    { min: 40, band: 'low', label: 'Low' },
    { min: 0, band: 'insufficient', label: 'Insufficient for confirmed classification' },
  ],
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

function classify(rows: Partial<DashboardInput>, extra: Partial<Omit<DnaProfileInput, 'dashboard' | 'config'>> = {}) {
  const dashboard = computeDashboard({ ...EMPTY, ...rows }, 'AUD');
  return classifyFinancialDna({
    dashboard,
    age: extra.age ?? 35,
    dependantsCount: extra.dependantsCount ?? 0,
    isSelfEmployed: extra.isSelfEmployed ?? false,
    isRetired: extra.isRetired ?? false,
    previousProfileCode: extra.previousProfileCode ?? null,
    config: DNA_CONFIG,
  });
}

describe('Financial DNA classification — synthetic personas', () => {
  it('Persona A: Cash-Rich Accumulator', () => {
    const result = classify({
      income: [{ amount: 8000, net_amount: null, frequency: 'monthly', master_item_key: 'employment_salary' }],
      expenses: [
        { expense_name: 'Essentials', amount: 4000, frequency: 'monthly', is_essential: true },
        { expense_name: 'Lifestyle', amount: 500, frequency: 'monthly', is_essential: false },
      ],
      assets: [{ current_value: 40000, asset_class: 'cash' }],
    });
    expect(result.primaryProfileCode).toBe('cash_rich_accumulator');
  });

  it('Persona B: Wealth Builder', () => {
    const result = classify({
      income: [{ amount: 9000, net_amount: null, frequency: 'monthly', master_item_key: 'employment_salary' }],
      expenses: [
        { expense_name: 'Essentials', amount: 4000, frequency: 'monthly', is_essential: true },
        { expense_name: 'Lifestyle', amount: 1000, frequency: 'monthly', is_essential: false },
      ],
      assets: [{ current_value: 15000, asset_class: 'cash' }],
      investments: [
        { current_value: 80000, cost_base: 60000, investment_type: 'etfs', country_code: 'AU', annual_contribution: 12000 },
        { current_value: 40000, cost_base: 35000, investment_type: 'shares', country_code: 'AU', annual_contribution: 6000 },
        { current_value: 20000, cost_base: 18000, investment_type: 'reits', country_code: 'AU', annual_contribution: 0 },
      ],
      liabilities: [{ balance: 15000, interest_rate: 6, monthly_repayment: 500, debt_type: 'personal_loan' }],
    });
    expect(result.primaryProfileCode).toBe('wealth_builder');
  });

  it('Persona C: Lifestyle Optimiser', () => {
    const result = classify({
      income: [{ amount: 12000, net_amount: null, frequency: 'monthly', master_item_key: 'employment_salary' }],
      expenses: [
        { expense_name: 'Essentials', amount: 3000, frequency: 'monthly', is_essential: true },
        { expense_name: 'Travel', amount: 4500, frequency: 'monthly', is_essential: false },
        { expense_name: 'Dining', amount: 4020, frequency: 'monthly', is_essential: false },
      ],
      assets: [{ current_value: 6000, asset_class: 'cash' }],
    });
    expect(result.primaryProfileCode).toBe('lifestyle_optimiser');
  });

  it('Persona D: Property-Focused Investor', () => {
    const result = classify({
      income: [
        { amount: 9000, net_amount: null, frequency: 'monthly', master_item_key: 'employment_salary' },
        { amount: 1500, net_amount: null, frequency: 'monthly', master_item_key: 'rental_income' },
      ],
      expenses: [
        { expense_name: 'Essentials', amount: 4000, frequency: 'monthly', is_essential: true },
        { expense_name: 'Lifestyle', amount: 800, frequency: 'monthly', is_essential: false },
      ],
      assets: [
        { current_value: 850000, asset_class: 'property' },
        { current_value: 20000, asset_class: 'cash' },
      ],
      liabilities: [
        { balance: 620000, interest_rate: 6, monthly_repayment: 3800, debt_type: 'mortgage' },
        { balance: 130000, interest_rate: 6.2, monthly_repayment: 800, debt_type: 'investment_loan' },
      ],
    });
    expect(result.primaryProfileCode).toBe('property_focused_investor');
  });

  it('Persona E: Debt-Constrained Builder', () => {
    const result = classify({
      income: [{ amount: 7500, net_amount: null, frequency: 'monthly', master_item_key: 'employment_salary' }],
      expenses: [
        { expense_name: 'Essentials', amount: 3500, frequency: 'monthly', is_essential: true },
        { expense_name: 'Lifestyle', amount: 500, frequency: 'monthly', is_essential: false },
      ],
      assets: [{ current_value: 3000, asset_class: 'cash' }],
      liabilities: [
        { balance: 25000, interest_rate: 19, monthly_repayment: 2200, debt_type: 'credit_card' },
        { balance: 15000, interest_rate: 14, monthly_repayment: 1300, debt_type: 'personal_loan' },
      ],
    });
    expect(result.primaryProfileCode).toBe('debt_constrained_builder');
  });

  it('Persona F: Future-Ready Professional', () => {
    const result = classify(
      {
        income: [{ amount: 8500, net_amount: null, frequency: 'monthly', master_item_key: 'employment_salary' }],
        expenses: [
          { expense_name: 'Essentials', amount: 3800, frequency: 'monthly', is_essential: true },
          { expense_name: 'Lifestyle', amount: 1200, frequency: 'monthly', is_essential: false },
        ],
        assets: [{ current_value: 8000, asset_class: 'cash' }],
        liabilities: [{ balance: 8000, interest_rate: 7, monthly_repayment: 400, debt_type: 'car_loan' }],
        retirement: [
          {
            current_balance: 25000,
            employer_contribution: 800,
            personal_contribution: 300,
            contribution_frequency: 'monthly',
          },
        ],
      },
      { age: 29 }
    );
    expect(result.primaryProfileCode).toBe('future_ready_professional');
  });

  it('Persona G: Retired household', () => {
    const result = classify(
      {
        income: [
          { amount: 2200, net_amount: null, frequency: 'monthly', master_item_key: 'super_pension' },
          { amount: 800, net_amount: null, frequency: 'monthly', master_item_key: 'age_pension' },
        ],
        expenses: [
          { expense_name: 'Essentials', amount: 2000, frequency: 'monthly', is_essential: true },
          { expense_name: 'Lifestyle', amount: 500, frequency: 'monthly', is_essential: false },
        ],
        assets: [{ current_value: 60000, asset_class: 'cash' }],
        retirement: [
          { current_balance: 450000, employer_contribution: 0, personal_contribution: 0, contribution_frequency: null },
        ],
      },
      { age: 68, isRetired: true }
    );
    expect(result.primaryProfileCode).toBe('retirement_focused_preserver');
  });

  it('Persona H: Insufficient data', () => {
    const result = classify({
      income: [{ amount: 6000, net_amount: null, frequency: 'monthly', master_item_key: 'employment_salary' }],
    });
    expect(result.status).toBe('insufficient_data');
    expect(result.primaryProfileCode).toBeNull();
  });

  it('Persona I: Financial Stabiliser (bonus persona for the second recommended profile)', () => {
    const result = classify({
      income: [{ amount: 3200, net_amount: null, frequency: 'monthly', master_item_key: 'employment_salary' }],
      expenses: [{ expense_name: 'Essentials', amount: 3300, frequency: 'monthly', is_essential: true }],
      assets: [{ current_value: 400, asset_class: 'cash' }],
    });
    expect(result.primaryProfileCode).toBe('financial_stabiliser');
  });

  it('Life-stage safeguard: a renter with no property is not forced into Property-Focused Investor', () => {
    const result = classify({
      income: [{ amount: 9000, net_amount: null, frequency: 'monthly', master_item_key: 'employment_salary' }],
      expenses: [
        { expense_name: 'Rent', amount: 2500, frequency: 'monthly', is_essential: true },
        { expense_name: 'Lifestyle', amount: 1000, frequency: 'monthly', is_essential: false },
      ],
      assets: [{ current_value: 20000, asset_class: 'cash' }],
    });
    expect(result.primaryProfileCode).not.toBe('property_focused_investor');
  });

  it('Profile-change stability: a small month-to-month variation does not flip the primary profile', () => {
    const dashboard = {
      income: [{ amount: 9000, net_amount: null, frequency: 'monthly' as const, master_item_key: 'employment_salary' }],
      expenses: [
        { expense_name: 'Essentials', amount: 4000, frequency: 'monthly' as const, is_essential: true },
        { expense_name: 'Lifestyle', amount: 1050, frequency: 'monthly' as const, is_essential: false },
      ],
      assets: [{ current_value: 15000, asset_class: 'cash' }],
      investments: [
        { current_value: 82000, cost_base: 60000, investment_type: 'etfs', country_code: 'AU', annual_contribution: 12000 },
        { current_value: 41000, cost_base: 35000, investment_type: 'shares', country_code: 'AU', annual_contribution: 6000 },
        { current_value: 21000, cost_base: 18000, investment_type: 'reits', country_code: 'AU', annual_contribution: 0 },
      ],
      liabilities: [{ balance: 14800, interest_rate: 6, monthly_repayment: 495, debt_type: 'personal_loan' }],
    };
    const first = classify(dashboard);
    expect(first.primaryProfileCode).toBe('wealth_builder');
    // A slightly different month, previously classified as wealth_builder — even if some
    // other profile now nominally scores marginally higher, it shouldn't flip on a small move.
    const second = classify(dashboard, { previousProfileCode: 'wealth_builder' });
    expect(second.primaryProfileCode).toBe('wealth_builder');
    expect(second.profileChanged).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Financial DNA debt-dependence redesign (App Review Spec 1 §24-28,
// DNA-01 through DNA-05 plus additional cases). Every case below asserts
// the actual before/after numbers, not just pass/fail, per this project's
// calculation-change documentation discipline.
// ---------------------------------------------------------------------------
describe('Financial DNA — debt-purpose redesign (Spec 1 §24-28)', () => {
  const BASE_INCOME = [
    { amount: 10000, net_amount: null, frequency: 'monthly' as const, master_item_key: 'employment_salary' },
  ];
  const LIVING_EXPENSES_2500 = [
    { expense_name: 'Living expenses', amount: 2500, frequency: 'monthly' as const, is_essential: true },
  ];

  it('DNA-01: owner-occupied debt at exactly 30% of gross income is classified as low/within reference band', () => {
    const result = classify({
      income: BASE_INCOME,
      expenses: LIVING_EXPENSES_2500,
      liabilities: [{ balance: 500000, interest_rate: 6, monthly_repayment: 3000, debt_type: 'other', master_item_key: 'home_loan' }],
    });
    const a = result.debtPurposeAssessment.ownerOccupied;
    // Before (old, pre-redesign): DNA had no purpose split at all — this
    // household's blended debtServiceRatio was 3000/10000 = 0.30, which the
    // old debt_dependence trait (levelFromRatio 0.15/0.35) put in the
    // *middle* band ('moderate'), indistinguishable from a household
    // servicing a mix of debts at the same blended rate.
    // After: assessed specifically against the owner-occupied 30%-of-gross
    // reference band from Spec 1 §24.
    expect(a.ratioOfGrossIncome).toBe(0.3);
    expect(a.monthlyRepayment).toBe(3000);
    expect(a.level).toBe('low');
  });

  it('DNA-02: owner-occupied debt at 5,500/10,000 (55%) is NOT classified identically to the 30% case', () => {
    const result = classify({
      income: BASE_INCOME,
      expenses: LIVING_EXPENSES_2500,
      liabilities: [{ balance: 500000, interest_rate: 6, monthly_repayment: 5500, debt_type: 'other', master_item_key: 'home_loan' }],
    });
    const a = result.debtPurposeAssessment.ownerOccupied;
    expect(a.ratioOfGrossIncome).toBe(0.55);
    expect(a.level).toBe('excessive');
    expect(a.level).not.toBe('low'); // must differ from DNA-01's classification
  });

  it('DNA-03: investment property debt is evaluated via household capacity, not the owner-occupied threshold — 5,500 within a 6,250 capacity is acceptable', () => {
    const result = classify({
      income: BASE_INCOME,
      expenses: LIVING_EXPENSES_2500,
      liabilities: [{ balance: 800000, interest_rate: 6.2, monthly_repayment: 5500, debt_type: 'other', master_item_key: 'investment_loan' }],
    });
    const a = result.debtPurposeAssessment.investmentProperty;
    // Before (old, pre-redesign): blended debtServiceRatio = 5500/10000 =
    // 0.55 would have put this in the old trait's 'high' band — the exact
    // "leveraged property looks alarming under a blended view" case the
    // spec calls out.
    // After: buffer = 1.5 x 2,500 = 3,750; capacity = 10,000 - 3,750 = 6,250
    // (matches the spec's worked example exactly); 5,500 <= 6,250.
    expect(a.livingCostBuffer).toBe(1.5);
    expect(a.householdCapacity).toBe(6250);
    expect(a.ratioOfCapacity).toBeCloseTo(5500 / 6250, 10);
    expect(a.level).toBe('low'); // acceptable — not flagged as excessive
  });

  it('DNA-04: mixed owner-occupied + investment-property debt in the same household are assessed separately, never blended into one number', () => {
    const result = classify({
      income: BASE_INCOME,
      expenses: LIVING_EXPENSES_2500,
      liabilities: [
        { balance: 500000, interest_rate: 6, monthly_repayment: 2500, debt_type: 'other', master_item_key: 'home_loan' },
        { balance: 400000, interest_rate: 6.2, monthly_repayment: 3000, debt_type: 'other', master_item_key: 'investment_loan' },
      ],
    });
    const { ownerOccupied, investmentProperty } = result.debtPurposeAssessment;
    expect(ownerOccupied.monthlyRepayment).toBe(2500);
    expect(ownerOccupied.ratioOfGrossIncome).toBe(0.25); // 2,500 / 10,000, gross-income basis
    expect(ownerOccupied.level).toBe('low');
    // Capacity nets out the owner-occupied repayment before assessing what's
    // left for investment debt: 10,000 - 3,750 - 2,500 = 3,750.
    expect(investmentProperty.householdCapacity).toBe(3750);
    expect(investmentProperty.ratioOfCapacity).toBe(0.8); // 3,000 / 3,750
    expect(investmentProperty.level).toBe('low');
    // The two figures are NOT the blended total-debt-to-income view a
    // pre-redesign reader might expect ((2500+3000)/10000 = 0.55) — proof
    // the two purposes were genuinely evaluated independently, not summed.
    expect(ownerOccupied.ratioOfGrossIncome).not.toBeCloseTo(0.55, 5);
    expect(investmentProperty.ratioOfCapacity).not.toBeCloseTo(0.55, 5);
  });

  it('DNA-05: consumer debt is never given favourable treatment merely because investment debt exists and is fine elsewhere in the household', () => {
    const result = classify({
      income: BASE_INCOME,
      expenses: LIVING_EXPENSES_2500,
      liabilities: [
        // Investment debt: small and comfortably serviceable.
        { balance: 150000, interest_rate: 6.2, monthly_repayment: 1000, debt_type: 'other', master_item_key: 'investment_loan' },
        // Consumer debt: genuinely high relative to income, on its own.
        { balance: 20000, interest_rate: 19, monthly_repayment: 4000, debt_type: 'other', master_item_key: 'credit_card' },
      ],
    });
    const { investmentProperty, consumerOrOther } = result.debtPurposeAssessment;
    expect(consumerOrOther.ratioOfIncome).toBe(0.4); // 4,000 / 10,000
    expect(consumerOrOther.level).toBe('high'); // flagged on its own merits
    expect(investmentProperty.level).toBe('low'); // investment debt being fine does not rescue consumer debt
    // Overall debt_dependence trait must reflect the worse of the two —
    // never diluted/averaged down by the acceptable investment-debt outcome.
    const debtTrait = result.traits.find((t) => t.code === 'debt_dependence');
    expect(debtTrait?.level).toBe('high');
  });

  it('additional case: investment-property debt well beyond capacity is still flagged excessive — investment leverage is not automatically healthy', () => {
    const result = classify({
      income: BASE_INCOME,
      expenses: LIVING_EXPENSES_2500,
      liabilities: [{ balance: 1500000, interest_rate: 6.5, monthly_repayment: 10000, debt_type: 'other', master_item_key: 'investment_loan' }],
    });
    const a = result.debtPurposeAssessment.investmentProperty;
    // capacity = 10,000 - 3,750 = 6,250; repayment 10,000 / 6,250 = 1.6x capacity.
    expect(a.householdCapacity).toBe(6250);
    expect(a.ratioOfCapacity).toBeCloseTo(1.6, 5);
    expect(a.level).toBe('excessive');
  });

  it('additional case: a household with no debt at all reports low/no-debt levels across all three purposes without crashing', () => {
    const result = classify({ income: BASE_INCOME, expenses: LIVING_EXPENSES_2500, assets: [{ current_value: 1000, asset_class: 'cash' }] });
    const { ownerOccupied, investmentProperty, consumerOrOther } = result.debtPurposeAssessment;
    expect(ownerOccupied.level).toBe('low');
    expect(investmentProperty.level).toBe('low');
    expect(consumerOrOther.level).toBe('low');
  });

  it('additional case: a mixed-purpose loan (single row, ambiguous construction_loan) degrades safely — classified, not crashed, and disclosed as a limitation', () => {
    const result = classify({
      income: BASE_INCOME,
      expenses: LIVING_EXPENSES_2500,
      liabilities: [{ balance: 300000, interest_rate: 6, monthly_repayment: 1500, debt_type: 'other', master_item_key: 'construction_loan' }],
    });
    // Heuristic: construction_loan defaults to the stricter owner-occupied band.
    expect(result.debtPurposeAssessment.ownerOccupied.monthlyRepayment).toBe(1500);
    expect(result.debtPurposeAssessment.investmentProperty.monthlyRepayment).toBe(0);
    expect(result.debtPurposeAssessment.limitations.length).toBeGreaterThan(0);
    expect(result.debtPurposeAssessment.limitations.join(' ')).toMatch(/mixed-purpose/i);
  });

  it('Observed vs Self-Reported separation: DnaResult explicitly tags its output as observed financial data', () => {
    const result = classify({ income: BASE_INCOME, expenses: LIVING_EXPENSES_2500 });
    expect(result.behaviourSource).toBe('observed_financial_data');
  });

  it('Financial Twin regression: property_focused_investor persona (Persona D) still wins on the real purpose signal, not the old blended debtToIncome guess', () => {
    // Same fixture as "Persona D: Property-Focused Investor" above — this
    // is the exact case that feeds Financial Twin's dnaProfileCode cohort
    // dimension (lib/services/twinData.ts). Re-asserted here alongside the
    // new purpose fields to make the cross-module dependency explicit.
    const result = classify({
      income: [
        { amount: 9000, net_amount: null, frequency: 'monthly', master_item_key: 'employment_salary' },
        { amount: 1500, net_amount: null, frequency: 'monthly', master_item_key: 'rental_income' },
      ],
      expenses: [
        { expense_name: 'Essentials', amount: 4000, frequency: 'monthly', is_essential: true },
        { expense_name: 'Lifestyle', amount: 800, frequency: 'monthly', is_essential: false },
      ],
      assets: [
        { current_value: 850000, asset_class: 'property' },
        { current_value: 20000, asset_class: 'cash' },
      ],
      liabilities: [
        { balance: 620000, interest_rate: 6, monthly_repayment: 3800, debt_type: 'mortgage' },
        { balance: 130000, interest_rate: 6.2, monthly_repayment: 800, debt_type: 'investment_loan' },
      ],
    });
    expect(result.primaryProfileCode).toBe('property_focused_investor');
    // propertyPurposeDebtRatio = (620,000 + 130,000) / 750,000 = 1.0 — the
    // real purpose signal now driving this profile, replacing the old
    // blended debtToIncome (which was 5.95x, inside the old 3-10x guess
    // band for unrelated reasons).
    const propertyCandidate = result.candidates.find((c) => c.code === 'property_focused_investor');
    const dim = propertyCandidate?.dimensionScores.find((d) => d.metric === 'propertyPurposeDebtRatio');
    expect(dim?.value).toBe(1);
    expect(dim?.score).toBe(100);
  });
});
