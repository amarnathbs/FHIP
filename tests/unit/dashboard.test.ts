import { describe, it, expect } from 'vitest';
import { computeDashboard, type DashboardInput } from '@/lib/engines/dashboard';

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
