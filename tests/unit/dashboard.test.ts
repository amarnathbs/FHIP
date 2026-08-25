import { describe, it, expect } from 'vitest';
import { computeDashboard, type DashboardInput } from '@/lib/engines/dashboard';
import { expenseGridConfig } from '@/lib/grid/configs';
import { expenseSchema } from '@/lib/validation/expense';

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

// Phase 1 P0 fix (FHIP-FC-FX-001): computeDashboard must convert any row
// tagged with a foreign currency_code into the household's reporting
// currency before summing — previously every total silently added AUD and
// INR raw numbers together for cross-border households.
describe('computeDashboard currency-aware aggregation', () => {
  it('leaves single-currency households byte-for-byte unchanged (no currency_code on rows)', () => {
    const d = computeDashboard(
      {
        ...EMPTY,
        assets: [{ current_value: 100000, asset_class: 'cash' }],
        liabilities: [{ balance: 20000, interest_rate: 5, monthly_repayment: 500, debt_type: 'personal_loan' }],
      },
      'AUD'
    );
    expect(d.totalAssets).toBe(100000);
    expect(d.totalLiabilities).toBe(20000);
    expect(d.netWorth).toBe(80000);
  });

  it('converts a foreign-currency asset into the reporting currency using the supplied FX rate', () => {
    // fx_rate_aud_inr = INR per 1 AUD; an INR asset held by an AUD-reporting
    // household must be divided by the rate, matching
    // lib/engines/fx.ts / crossBorderCalculator.ts's documented convention.
    const fxRateAudInr = 56;
    const d = computeDashboard(
      {
        ...EMPTY,
        assets: [
          { current_value: 100000, asset_class: 'cash', currency_code: 'AUD' },
          { current_value: 560000, asset_class: 'cash', currency_code: 'INR' }, // = 10,000 AUD
        ],
      },
      'AUD',
      fxRateAudInr
    );
    expect(d.totalAssets).toBe(110000);
    expect(d.netWorth).toBe(110000);
  });

  it('converts a foreign-currency liability and its repayment for an INR-reporting household', () => {
    const fxRateAudInr = 56;
    const d = computeDashboard(
      {
        ...EMPTY,
        liabilities: [
          { balance: 100000, interest_rate: 5, monthly_repayment: 2000, debt_type: 'personal_loan', currency_code: 'INR' },
          { balance: 1000, interest_rate: 6, monthly_repayment: 50, debt_type: 'credit_card', currency_code: 'AUD' }, // = 56,000 INR / 2,800 INR
        ],
        income: [{ amount: 100000, net_amount: 100000, frequency: 'monthly', master_item_key: null }],
      },
      'INR',
      fxRateAudInr
    );
    expect(d.totalLiabilities).toBe(100000 + 1000 * fxRateAudInr);
    expect(d.debtMonthlyRepayments).toBe(2000 + 50 * fxRateAudInr);
  });

  it('does not convert an unrecognised or missing currency_code (treated as already in reporting currency)', () => {
    const d = computeDashboard(
      {
        ...EMPTY,
        assets: [{ current_value: 5000, asset_class: 'cash', currency_code: null }],
      },
      'AUD',
      56
    );
    expect(d.totalAssets).toBe(5000);
  });
});

// FHIP 50-User E2E cycle finding: asset_class/investment_type/debt_type
// (lib/validation/asset.ts etc.) are never collected by the real grid UI
// (lib/grid/configs.ts) — every row created through the live app leaves
// them at their Zod default 'other'. Before this fix, liquidAssets (and
// therefore emergencyFundMonths, liquidAssetRatio, propertyConcentration,
// goodDebt/badDebt, creditUtilization) silently read 0 for every real
// user, not just synthetic test data — confirmed by tracing
// bucketAssetClass()/bucketInvestmentType()'s literal-string checks
// against a field the grid never sets, and by the fact GOOD_DEBT_TYPES
// already listed catalog-style keys ('investment_loan', 'hecs_help') that
// don't even exist in debt_type's own 6-value enum. master_item_key is
// the field the grid actually populates.
describe('computeDashboard master_item_key-based classification (grid never sets asset_class/investment_type/debt_type)', () => {
  it('classifies liquidAssets from master_item_key when asset_class is left at its default "other"', () => {
    const d = computeDashboard(
      {
        ...EMPTY,
        assets: [
          { current_value: 7000, asset_class: 'other', master_item_key: 'savings_account' },
          { current_value: 250, asset_class: 'other', master_item_key: 'wallet_cash' },
        ],
        expenses: [{ expense_name: 'Rent', amount: 2000, frequency: 'monthly', is_essential: true }],
      },
      'AUD'
    );
    expect(d.liquidAssets).toBe(7250);
    expect(d.emergencyFundMonths).toBeCloseTo(7250 / 2000, 6);
  });

  it('still classifies via the coarse asset_class value when master_item_key is absent (custom/legacy rows)', () => {
    const d = computeDashboard({ ...EMPTY, assets: [{ current_value: 500, asset_class: 'cash' }] }, 'AUD');
    expect(d.liquidAssets).toBe(500);
  });

  it('classifies investment cash-equivalents (e.g. term deposits) into liquidAssets via master_item_key', () => {
    const d = computeDashboard(
      { ...EMPTY, investments: [{ current_value: 10000, cost_base: 10000, investment_type: 'other', master_item_key: 'term_deposits', country_code: null, annual_contribution: 0 }] },
      'AUD'
    );
    expect(d.liquidAssets).toBe(10000);
  });

  it('classifies good vs bad debt from master_item_key, not the always-"other" debt_type', () => {
    const d = computeDashboard(
      {
        ...EMPTY,
        liabilities: [
          { balance: 400000, interest_rate: 6, monthly_repayment: 2400, debt_type: 'other', master_item_key: 'home_loan' },
          { balance: 5000, interest_rate: 20, monthly_repayment: 200, debt_type: 'other', master_item_key: 'credit_card' },
        ],
      },
      'AUD'
    );
    expect(d.goodDebt).toBe(400000);
    expect(d.badDebt).toBe(5000);
  });

  it('detects a revolving credit-card liability via master_item_key for creditUtilization', () => {
    const d = computeDashboard(
      {
        ...EMPTY,
        liabilities: [{ balance: 2000, interest_rate: 19, monthly_repayment: 100, debt_type: 'other', master_item_key: 'credit_card', credit_limit: 10000 }],
      },
      'AUD'
    );
    expect(d.creditUtilization).toBeCloseTo(0.2, 6);
  });
});

// App Review spec §12-13: Monthly Surplus double-counting audit.
describe('computeDashboard debt-repayment double-counting guard (App Review spec §12-13)', () => {
  // Negative control proving the root cause is real, not assumed: the live
  // grid UI never lets a user set expense_category, so it always saves as
  // the Zod default 'other'. If this ever stops being true (the field gets
  // added to the grid, or the default changes), this test fails loudly and
  // the double-counting fix above needs re-review.
  it('confirms the root cause: expenseGridConfig has no editable expense_category field, and the schema defaults it to "other"', () => {
    expect(expenseGridConfig.fields.some((f) => f.name === 'expense_category')).toBe(false);
    const parsed = expenseSchema.parse({
      expense_name: 'Mortgage',
      amount: 3000,
      frequency: 'monthly',
      currency_code: 'AUD',
    });
    expect(parsed.expense_category).toBe('other');
  });

  it('Case 1: Mortgage expense $3,000/mo + matching Home Loan liability repayment $3,000/mo → cash-flow impact $3,000, not $6,000', () => {
    const d = computeDashboard(
      {
        ...EMPTY,
        income: [{ amount: 10000, net_amount: 10000, frequency: 'monthly', master_item_key: null }],
        expenses: [
          { expense_name: 'Mortgage', amount: 3000, frequency: 'monthly', is_essential: true, master_item_key: 'mortgage' },
        ],
        liabilities: [
          { balance: 500000, interest_rate: 6, monthly_repayment: 3000, debt_type: 'other', master_item_key: 'home_loan' },
        ],
      },
      'AUD'
    );
    expect(d.totalMonthlyExpenses + d.debtMonthlyRepayments).toBe(3000);
    expect(d.monthlySurplus).toBe(10000 - 3000);
  });

  it('Case 2: Home Insurance expense $200/mo + Insurance premium $200/mo → cash-flow impact $200, not $400 (insurance premiums never subtracted from surplus independently)', () => {
    const d = computeDashboard(
      {
        ...EMPTY,
        income: [{ amount: 10000, net_amount: 10000, frequency: 'monthly', master_item_key: null }],
        expenses: [
          { expense_name: 'Home Insurance', amount: 200, frequency: 'monthly', is_essential: true, master_item_key: 'home_insurance' },
        ],
        insurance: [
          {
            policy_name: 'Home Insurance',
            cover_amount: 500000,
            premium: 200,
            premium_frequency: 'monthly',
            cover_type: 'home',
            renewal_date: null,
          },
        ],
      },
      'AUD'
    );
    expect(d.totalMonthlyExpenses).toBe(200);
    expect(d.monthlySurplus).toBe(10000 - 200);
    // totalAnnualPremium is a separate, parallel metric (insurance adequacy)
    // — it must never be additionally subtracted from monthlySurplus.
    expect(d.totalAnnualPremium).toBe(2400);
  });

  it('Case 3: distinct Home loan $3,000/mo + Car loan $700/mo liabilities must not be incorrectly deduplicated against each other', () => {
    const d = computeDashboard(
      {
        ...EMPTY,
        income: [{ amount: 10000, net_amount: 10000, frequency: 'monthly', master_item_key: null }],
        liabilities: [
          { balance: 500000, interest_rate: 6, monthly_repayment: 3000, debt_type: 'other', master_item_key: 'home_loan' },
          { balance: 20000, interest_rate: 8, monthly_repayment: 700, debt_type: 'other', master_item_key: 'car_loan' },
        ],
      },
      'AUD'
    );
    expect(d.debtMonthlyRepayments).toBe(3700);
  });

  it('does not silently drop a debt-repayment-category expense that has no matching liability on file (avoids the inverse under-count bug)', () => {
    const d = computeDashboard(
      {
        ...EMPTY,
        income: [{ amount: 10000, net_amount: 10000, frequency: 'monthly', master_item_key: null }],
        expenses: [
          { expense_name: 'Car Loan Repayments', amount: 500, frequency: 'monthly', is_essential: true, master_item_key: 'car_loan_repayments' },
        ],
        // No liabilities at all — nothing else already captures this outflow.
      },
      'AUD'
    );
    expect(d.totalMonthlyExpenses).toBe(500);
  });

  it('an unrelated liability (car loan) does not suppress a differently-typed expense (mortgage)', () => {
    const d = computeDashboard(
      {
        ...EMPTY,
        income: [{ amount: 10000, net_amount: 10000, frequency: 'monthly', master_item_key: null }],
        expenses: [
          { expense_name: 'Mortgage', amount: 3000, frequency: 'monthly', is_essential: true, master_item_key: 'mortgage' },
        ],
        liabilities: [
          { balance: 20000, interest_rate: 8, monthly_repayment: 700, debt_type: 'other', master_item_key: 'car_loan' },
        ],
      },
      'AUD'
    );
    // Mortgage expense ($3,000) is NOT excluded (no home-loan-type liability
    // on file), and the car loan repayment ($700) is separately counted.
    expect(d.totalMonthlyExpenses + d.debtMonthlyRepayments).toBe(3700);
  });

  it('legacy custom row with explicit expense_category "debt_repayment" and no master_item_key is still excluded when a liability repayment exists', () => {
    const d = computeDashboard(
      {
        ...EMPTY,
        income: [{ amount: 10000, net_amount: 10000, frequency: 'monthly', master_item_key: null }],
        expenses: [
          { expense_name: 'My custom loan repayment', amount: 400, frequency: 'monthly', is_essential: true, expense_category: 'debt_repayment' },
        ],
        liabilities: [
          { balance: 5000, interest_rate: 10, monthly_repayment: 400, debt_type: 'personal_loan' },
        ],
      },
      'AUD'
    );
    expect(d.totalMonthlyExpenses).toBe(0);
    expect(d.debtMonthlyRepayments).toBe(400);
  });
});
