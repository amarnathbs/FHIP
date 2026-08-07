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
