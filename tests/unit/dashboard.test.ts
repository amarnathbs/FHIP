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

// AR-0 §3.3 (Spec 1 App Review, most financially material Chunk 1 fix):
// nonDebtExpenses used to filter on expense_category !== 'debt_repayment',
// but expense_category is never collected by the grid (lib/grid/configs.ts's
// expenseGridConfig.fields has no expense_category field), so it always
// Zod-defaulted to 'other' and the filter was dead code. A household that
// logged the exact same loan repayment as both a "Mortgage" expense row and
// a liability's monthly_repayment had it subtracted from monthlySurplus
// twice. Fixed by deriving the exclusion from master_item_key instead,
// mirroring this file's existing MASTER_ASSET_ITEM_TO_BUCKET-style pattern.
describe('computeDashboard debt-repayment expense/liability double-counting (AR-0 §3.3)', () => {
  it('Spec 1 Test Case 1: a Mortgage expense row and its matching Home Loan liability repayment are deducted once, not twice', () => {
    const d = computeDashboard(
      {
        ...EMPTY,
        income: [{ amount: 8000, net_amount: 8000, frequency: 'monthly', master_item_key: null }],
        expenses: [
          { expense_name: 'Mortgage', amount: 3000, frequency: 'monthly', is_essential: true, master_item_key: 'mortgage' },
          { expense_name: 'Groceries', amount: 2000, frequency: 'monthly', is_essential: true, master_item_key: 'groceries' },
        ],
        liabilities: [
          { balance: 500000, interest_rate: 6, monthly_repayment: 3000, debt_type: 'other', master_item_key: 'home_loan' },
        ],
      },
      'AUD'
    );
    // income 8000 - groceries 2000 - debtMonthlyRepayments 3000 = 3000
    // (mortgage expense row excluded from totalMonthlyExpenses, not 6000)
    expect(d.monthlySurplus).toBe(3000);
    expect(d.totalMonthlyExpenses).toBe(2000);
    expect(d.debtMonthlyRepayments).toBe(3000);
  });

  it('Spec 1 Test Case 3: two genuinely distinct liabilities are both counted, not deduplicated against each other', () => {
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
    expect(d.monthlySurplus).toBe(10000 - 3700);
  });

  it('excludes a Car Loan Repayments expense row from totalMonthlyExpenses via master_item_key', () => {
    const d = computeDashboard(
      {
        ...EMPTY,
        expenses: [
          { expense_name: 'Car Loan Repayments', amount: 700, frequency: 'monthly', is_essential: true, master_item_key: 'car_loan_repayments' },
        ],
        liabilities: [{ balance: 20000, interest_rate: 8, monthly_repayment: 700, debt_type: 'other', master_item_key: 'car_loan' }],
      },
      'AUD'
    );
    expect(d.totalMonthlyExpenses).toBe(0);
    expect(d.debtMonthlyRepayments).toBe(700);
  });

  it('does NOT exclude a Rent expense row — rent has no liability-side counterpart to double-count against', () => {
    const d = computeDashboard(
      {
        ...EMPTY,
        expenses: [{ expense_name: 'Rent', amount: 2200, frequency: 'monthly', is_essential: true, master_item_key: 'rent' }],
      },
      'AUD'
    );
    expect(d.totalMonthlyExpenses).toBe(2200);
    expect(d.essentialMonthlyExpenses).toBe(2200);
  });

  it('no regression: a household with no expense-side debt-repayment items is byte-for-byte unchanged', () => {
    const d = computeDashboard(
      {
        ...EMPTY,
        income: [{ amount: 6000, net_amount: 6000, frequency: 'monthly', master_item_key: null }],
        expenses: [
          { expense_name: 'Groceries', amount: 1200, frequency: 'monthly', is_essential: true, master_item_key: 'groceries' },
          { expense_name: 'Streaming Services', amount: 50, frequency: 'monthly', is_essential: false, master_item_key: 'streaming_services' },
        ],
        liabilities: [{ balance: 10000, interest_rate: 12, monthly_repayment: 300, debt_type: 'other', master_item_key: 'personal_loan' }],
      },
      'AUD'
    );
    expect(d.totalMonthlyExpenses).toBe(1250);
    expect(d.debtMonthlyRepayments).toBe(300);
    expect(d.monthlySurplus).toBe(6000 - 1250 - 300);
  });

  it('still honours expense_category=debt_repayment as a fallback when master_item_key is absent (custom rows)', () => {
    const d = computeDashboard(
      {
        ...EMPTY,
        income: [{ amount: 5000, net_amount: 5000, frequency: 'monthly', master_item_key: null }],
        expenses: [
          { expense_name: 'Custom loan repayment', amount: 400, frequency: 'monthly', is_essential: true, expense_category: 'debt_repayment' },
        ],
      },
      'AUD'
    );
    expect(d.totalMonthlyExpenses).toBe(0);
  });
});

// Chunk 3b (Spec 2 §34-36, item 6): retirement's Class-F contribution-type
// catalogue items (employer_contributions, salary_sacrifice,
// personal_concessional, non_concessional, government_co_contribution,
// spouse_contribution) were previously tickable, flat retirement_accounts
// rows summed straight into totalRetirement by current_balance — a genuine
// live phantom-balance double-count defect confirmed against real DEV data
// (45 affected rows / 39 users) both by Chunk 3a's design pass and Chunk
// 3b's own read-only audit (docs/app-review-2026-08/CHUNK3B_MIGRATION_AUDIT.md).
describe('computeDashboard Class-F retirement contribution-row exclusion (Chunk 3b phantom-balance fix)', () => {
  it('does NOT double-count a contribution-type row as a real balance in totalRetirement', () => {
    const d = computeDashboard(
      {
        ...EMPTY,
        retirement: [
          {
            current_balance: 200000,
            employer_contribution: null,
            personal_contribution: null,
            contribution_frequency: null,
            master_item_key: 'industry_super', // the real account
          },
          {
            current_balance: 12000, // "$1,000/month x 12" phantom balance, per Chunk 3a's worked example
            employer_contribution: null,
            personal_contribution: null,
            contribution_frequency: 'monthly',
            master_item_key: 'employer_contributions', // the Class-F row that used to double-count
          },
        ],
      },
      'AUD'
    );
    // Before this fix: totalRetirement would have been 212000 (200000 + 12000).
    expect(d.totalRetirement).toBe(200000);
    expect(d.netWorth).toBe(200000);
  });

  it('excludes all 6 Class-F contribution keys, not just one', () => {
    const contributionKeys = [
      'employer_contributions',
      'salary_sacrifice',
      'personal_concessional',
      'non_concessional',
      'government_co_contribution',
      'spouse_contribution',
    ];
    const d = computeDashboard(
      {
        ...EMPTY,
        retirement: contributionKeys.map((key) => ({
          current_balance: 5000,
          employer_contribution: null,
          personal_contribution: null,
          contribution_frequency: 'monthly' as const,
          master_item_key: key,
        })),
      },
      'AUD'
    );
    expect(d.totalRetirement).toBe(0);
  });

  it('a row with no master_item_key (custom row) is never excluded — only the 6 named catalogue keys are', () => {
    const d = computeDashboard(
      {
        ...EMPTY,
        retirement: [
          { current_balance: 50000, employer_contribution: null, personal_contribution: null, contribution_frequency: null, master_item_key: null },
        ],
      },
      'AUD'
    );
    expect(d.totalRetirement).toBe(50000);
  });

  it('a legacy row saved before catalogue deprecation is corrected immediately — the fix keys off master_item_key, not catalogue is_active', () => {
    // This is the point of keying the exclusion on master_item_key directly
    // rather than requiring migration 0073 to be applied first: a household
    // whose contribution row predates any migration still gets the correct
    // totalRetirement the moment this code ships.
    const d = computeDashboard(
      {
        ...EMPTY,
        retirement: [
          { current_balance: 100000, employer_contribution: null, personal_contribution: null, contribution_frequency: null, master_item_key: 'smsf' },
          { current_balance: 6000, employer_contribution: null, personal_contribution: null, contribution_frequency: 'monthly', master_item_key: 'salary_sacrifice' },
        ],
      },
      'AUD'
    );
    expect(d.totalRetirement).toBe(100000);
  });
});

// Chunk 3b item 3 (SMSF three-way overlap, discovery §3.6): asset.smsf_balance
// / investment.smsf_investments / retirement.smsf historically overlapped in
// the catalogue, but computeDashboard sums totalAssets/totalInvestments/
// totalRetirement independently by TABLE, not by master_item_key — so
// Net Worth (totalAssets + totalInvestments + totalRetirement - totalLiabilities)
// is structurally invariant no matter which of the three modules an
// SMSF-labelled row happens to sit in. This is what makes Chunk 3b's
// deprecate-the-catalogue-entry-only migration (0073) safe: it never moves
// a row between tables, so it cannot change any total.
describe('computeDashboard SMSF three-way overlap — Net Worth invariant under module placement', () => {
  it('the same total SMSF value produces the same Net Worth whether recorded via the asset, investment, or retirement module', () => {
    const viaAsset = computeDashboard(
      { ...EMPTY, assets: [{ current_value: 700000, asset_class: 'super', master_item_key: 'smsf_balance' }] },
      'AUD'
    );
    const viaInvestment = computeDashboard(
      {
        ...EMPTY,
        investments: [
          { current_value: 700000, cost_base: null, investment_type: 'super', master_item_key: 'smsf_investments', country_code: null, annual_contribution: null },
        ],
      },
      'AUD'
    );
    const viaRetirement = computeDashboard(
      {
        ...EMPTY,
        retirement: [
          { current_balance: 700000, employer_contribution: null, personal_contribution: null, contribution_frequency: null, master_item_key: 'smsf' },
        ],
      },
      'AUD'
    );
    expect(viaAsset.netWorth).toBe(700000);
    expect(viaInvestment.netWorth).toBe(700000);
    expect(viaRetirement.netWorth).toBe(700000);
  });

  it('a user who genuinely has all three legacy rows is NOT double- or triple-counted beyond their real combined value', () => {
    const d = computeDashboard(
      {
        ...EMPTY,
        assets: [{ current_value: 100000, asset_class: 'super', master_item_key: 'smsf_balance' }],
        investments: [
          { current_value: 200000, cost_base: null, investment_type: 'super', master_item_key: 'smsf_investments', country_code: null, annual_contribution: null },
        ],
        retirement: [
          { current_balance: 400000, employer_contribution: null, personal_contribution: null, contribution_frequency: null, master_item_key: 'smsf' },
        ],
      },
      'AUD'
    );
    // Each row is a distinct real holding recorded once — summed once each,
    // total = 100000 + 200000 + 400000, not inflated or deflated by the
    // catalogue overlap.
    expect(d.netWorth).toBe(700000);
  });
});

// Chunk 3b (Spec 2 §60 zero-Net-Worth-variance gate): a pure catalogue
// module/key reclassification (deprecating one side of a duplicate-concept
// pair, e.g. asset.term_deposits in favour of investment.term_deposits)
// must never, by itself, change Net Worth for any existing row — migration
// 0073 never moves or edits a user's stored row, so this is definitionally
// true, but this test proves the invariant computeDashboard itself relies
// on: total value is summed independently per table, so relabelling which
// catalogue module is "canonical" going forward cannot retroactively change
// an already-saved row's contribution to Net Worth.
describe('computeDashboard pure-reclassification zero-variance (Chunk 3b Spec 2 §60 gate)', () => {
  it('a deprecated-key asset row still contributes its full value to Net Worth (migration 0073 never touches the row itself)', () => {
    const before = computeDashboard(
      { ...EMPTY, assets: [{ current_value: 45000, asset_class: 'shares', master_item_key: 'shares' }] },
      'AUD'
    );
    // Simulates "after migration 0073": the catalogue's asset.shares item is
    // now is_active=false, but the row's own master_item_key is untouched —
    // computeDashboard has no is_active concept at all, it only sees the
    // row, so the value is unaffected.
    const after = computeDashboard(
      { ...EMPTY, assets: [{ current_value: 45000, asset_class: 'shares', master_item_key: 'shares' }] },
      'AUD'
    );
    expect(after.netWorth).toBe(before.netWorth);
    expect(after.totalAssets).toBe(45000);
  });
});
