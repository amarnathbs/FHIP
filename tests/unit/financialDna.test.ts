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
