import { describe, it, expect } from 'vitest';
import { computeDashboard, computeInsuranceAdequacy, type DashboardInput, type DashboardSummary } from '@/lib/engines/dashboard';
import { isHouseholdOperatingCashFlow, SMSF_OWNER } from '@/lib/engines/householdContext';
import { computeHealthScore, type HealthScoreConfig, type HealthScoreInput } from '@/lib/engines/healthScore';
import { computeResilience, type ResilienceConfig, type ResilienceInput } from '@/lib/engines/resilience';
import {
  ALL_SECTIONS,
  effectiveSectionStatus,
  type FinancialSection,
  type FinancialSectionStatus,
} from '@/lib/engines/financialSectionStatus';
import { OWNER_VALUES } from '@/lib/constants';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// LR-FI-1 — SMSF Household Financial Isolation (P0 financial-integrity hotfix)
//
// The rule under test: an `owner='smsf'` row is excluded from the PERSONAL
// household's operating cash flow (income, expenses, loan instalments,
// insurance premiums) but keeps contributing its economic value to household
// wealth (assets, investments, retirement balances, liability balances, Net
// Worth). Spec §4-5 and §28.
//
// Every cash-flow assertion below is written as a genuine NEGATIVE CONTROL:
// a household carrying SMSF rows must produce the SAME figure as an
// otherwise-identical household with those SMSF rows physically deleted, AND
// a DIFFERENT figure from the same rows re-tagged 'self'. The second half is
// what makes this a real proof rather than "a filter exists somewhere" — the
// re-tagged variant reproduces the exact pre-fix behaviour, so if the filter
// were ever removed, `withSmsf` and `smsfRetaggedSelf` would collapse onto
// each other and these tests would fail.
// ---------------------------------------------------------------------------

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

// Matches supabase/migrations/0006_module4_health_score.sql's seed config.
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
  riskOverride: { scoreCapPrimary: 49, scoreCapSecondary: 59, criticalLiquidityWeeks: 2, refinanceExposureMonths: 6 },
};

// A household that has explicitly confirmed each section it has data for —
// the state real accounts reach once they finish reviewing a section, and the
// one that lets every score component actually compute instead of returning
// "missing data". Without the explicit confirmation, effectiveSectionStatus()
// returns 'in_progress', which isReviewed() rejects, so e.g. the Savings
// Behaviour component would never produce a number to compare.
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
    result[section] = effectiveSectionStatus({
      hasRows: hasRows[section],
      explicitConfirmation: hasRows[section] ? 'reviewed_with_data' : 'reviewed_zero',
    });
  }
  return result;
}

function healthScoreFor(dashboard: DashboardSummary) {
  const input: HealthScoreInput = {
    dashboard,
    age: 45,
    dependantsCount: 2,
    isSelfEmployed: false,
    checkIns: null,
    resilienceResult: null,
    config: HEALTH_SCORE_CONFIG,
    sectionStatus: defaultSectionStatus(dashboard),
  };
  return computeHealthScore(input);
}

function resilienceFor(dashboard: DashboardSummary) {
  const input: ResilienceInput = {
    dashboard,
    dependantsCount: 2,
    isSelfEmployed: false,
    commitments: [],
    isCurrentSnapshotRecent: true,
    hasPriorMonthHistory: true,
    config: RESILIENCE_CONFIG,
    sectionStatus: defaultSectionStatus(dashboard),
  };
  return computeResilience(input);
}

// ---------------------------------------------------------------------------
// The LR-FI-1 §20/§21 worked example, expressed as three variants.
// ---------------------------------------------------------------------------

const PERSONAL_SALARY = { source_name: 'Salary', amount: 10000, net_amount: 10000, frequency: 'monthly' as const, master_item_key: 'salary_wages', owner: 'self' };
const PERSONAL_LIVING = { expense_name: 'Living costs', amount: 5000, frequency: 'monthly' as const, is_essential: true, master_item_key: 'groceries', owner: 'self' };

const SMSF_AUDIT_FEE = { expense_name: 'SMSF audit fee', amount: 500, frequency: 'monthly' as const, is_essential: true, master_item_key: 'accounting_fees', owner: SMSF_OWNER };
const SMSF_PROPERTY_LOAN = {
  balance: 365000,
  interest_rate: 6,
  monthly_repayment: 2000,
  debt_type: 'mortgage',
  master_item_key: 'investment_loan',
  currency_code: 'AUD',
  owner: SMSF_OWNER,
};

/** Household + SMSF rows, SMSF correctly tagged. This is the fixed behaviour. */
const withSmsf: DashboardInput = {
  ...EMPTY,
  income: [PERSONAL_SALARY],
  expenses: [PERSONAL_LIVING, SMSF_AUDIT_FEE],
  liabilities: [SMSF_PROPERTY_LOAN],
};

/** The SMSF rows physically removed — the household-only control. */
const withoutSmsf: DashboardInput = {
  ...EMPTY,
  income: [PERSONAL_SALARY],
  expenses: [PERSONAL_LIVING],
  liabilities: [],
};

/**
 * The SMSF rows re-tagged as personal. This reproduces the exact pre-fix
 * behaviour (owner was never read), so it is the negative control that
 * proves the filter is genuinely doing work.
 */
const smsfRetaggedSelf: DashboardInput = {
  ...EMPTY,
  income: [PERSONAL_SALARY],
  expenses: [PERSONAL_LIVING, { ...SMSF_AUDIT_FEE, owner: 'self' }],
  liabilities: [{ ...SMSF_PROPERTY_LOAN, owner: 'self' }],
};

describe('LR-FI-1 §20 — Dashboard hard gate: SMSF costs never reduce household surplus', () => {
  it('produces the spec\'s expected $5,000 surplus, not the contaminated $2,500', () => {
    const d = computeDashboard(withSmsf, 'AUD');
    // 10,000 income - 5,000 personal expenses - 0 household debt repayment.
    expect(d.monthlySurplus).toBe(5000);
    expect(d.totalMonthlyExpenses).toBe(5000);
    expect(d.debtMonthlyRepayments).toBe(0);
  });

  it('reproduces the pre-fix $2,500 when the same rows are tagged personal (negative control)', () => {
    const d = computeDashboard(smsfRetaggedSelf, 'AUD');
    // 10,000 - (5,000 + 500) - 2,000 = 2,500 — the defect the PO observed.
    expect(d.monthlySurplus).toBe(2500);
  });

  it('matches the SMSF-free control exactly on every cash-flow figure (FI-04, FI-06)', () => {
    const a = computeDashboard(withSmsf, 'AUD');
    const b = computeDashboard(withoutSmsf, 'AUD');
    expect(a.grossMonthlyIncome).toBe(b.grossMonthlyIncome);
    expect(a.netMonthlyIncome).toBe(b.netMonthlyIncome);
    expect(a.essentialMonthlyExpenses).toBe(b.essentialMonthlyExpenses);
    expect(a.lifestyleMonthlyExpenses).toBe(b.lifestyleMonthlyExpenses);
    expect(a.totalMonthlyExpenses).toBe(b.totalMonthlyExpenses);
    expect(a.debtMonthlyRepayments).toBe(b.debtMonthlyRepayments);
    expect(a.monthlySurplus).toBe(b.monthlySurplus);
    expect(a.savingsRate).toBe(b.savingsRate);
    expect(a.operatingCashFlow).toBe(b.operatingCashFlow);
    expect(a.disposableIncome).toBe(b.disposableIncome);
    expect(a.cashFlowRatio).toBe(b.cashFlowRatio);
    expect(a.debtServiceRatio).toBe(b.debtServiceRatio);
    expect(a.topExpenses).toEqual(b.topExpenses);
  });
});

describe('LR-FI-1 §21 — Savings Rate hard gate', () => {
  it('is 50%, not the contaminated 25%', () => {
    // Spec's own arithmetic: (10,000 - 5,000) / 10,000 = 50%.
    expect(computeDashboard(withSmsf, 'AUD').savingsRate).toBe(0.5);
    expect(computeDashboard(smsfRetaggedSelf, 'AUD').savingsRate).toBe(0.25);
  });
});

describe('LR-FI-1 §22 — DSR hard gate', () => {
  it('excludes the SMSF loan instalment but keeps a genuine personal mortgage (FI-06, §16)', () => {
    const personalMortgage = {
      balance: 400000,
      interest_rate: 6,
      monthly_repayment: 3000,
      debt_type: 'mortgage',
      master_item_key: 'home_loan',
      currency_code: 'AUD',
      owner: 'self',
    };
    const d = computeDashboard({ ...withSmsf, liabilities: [SMSF_PROPERTY_LOAN, personalMortgage] }, 'AUD');
    // Only the personal $3,000 services household debt.
    expect(d.debtMonthlyRepayments).toBe(3000);
    expect(d.debtServiceRatio).toBe(0.3);
    // ...while BOTH balances remain in household wealth (§28).
    expect(d.totalLiabilities).toBe(765000);
  });
});

describe('LR-FI-1 §5/§28 — SMSF economic value stays in household wealth', () => {
  it('keeps the SMSF liability balance in totalLiabilities and Net Worth (FI-08)', () => {
    const a = computeDashboard(withSmsf, 'AUD');
    const b = computeDashboard(withoutSmsf, 'AUD');
    expect(a.totalLiabilities).toBe(365000);
    expect(b.totalLiabilities).toBe(0);
    // Removing the SMSF row DOES change Net Worth — proving wealth is not
    // being over-filtered. This is the reverse negative control for §5.
    expect(a.netWorth).not.toBe(b.netWorth);
    expect(a.netWorth).toBe(-365000);
  });

  it('leaves every balance-sheet total identical to the pre-fix (retagged) behaviour', () => {
    const fixed = computeDashboard(withSmsf, 'AUD');
    const preFix = computeDashboard(smsfRetaggedSelf, 'AUD');
    // §28: "Expected Net Worth effect of this hotfix: $0 unexplained change."
    expect(fixed.totalAssets).toBe(preFix.totalAssets);
    expect(fixed.totalInvestments).toBe(preFix.totalInvestments);
    expect(fixed.totalRetirement).toBe(preFix.totalRetirement);
    expect(fixed.totalAssetsCombined).toBe(preFix.totalAssetsCombined);
    expect(fixed.totalLiabilities).toBe(preFix.totalLiabilities);
    expect(fixed.netWorth).toBe(preFix.netWorth);
    expect(fixed.liabilityByType).toEqual(preFix.liabilityByType);
    expect(fixed.goodDebt).toBe(preFix.goodDebt);
    expect(fixed.badDebt).toBe(preFix.badDebt);
    expect(fixed.averageInterestRate).toBe(preFix.averageInterestRate);
  });

  // SUPERSEDED BY LR-FI-2 §1. `debtToIncome` was asserted unchanged in the
  // list above when LR-FI-1 shipped, because LR-FI-1's scope was cash flow
  // only and it deliberately deferred the balance-based ratio. The Product
  // Owner then ruled that SMSF liabilities must not sit in the user's
  // PERSONAL debt-to-income, so DTI is no longer a "balance-sheet total that
  // must not move" — it is a household-scoped ratio that must move. The
  // assertion is replaced here rather than deleted, so the coverage LR-FI-1
  // had is inverted and kept rather than lost.
  it('LR-FI-2 §1 — DTI is now household-scoped, while every wealth total above stays whole', () => {
    const fixed = computeDashboard(withSmsf, 'AUD');
    const preFix = computeDashboard(smsfRetaggedSelf, 'AUD');
    // withSmsf's only liability IS the SMSF loan, so the household carries no
    // debt at all and its personal DTI is 0.
    expect(fixed.debtToIncome).toBe(0);
    expect(fixed.householdLiabilityBalance).toBe(0);
    // The pre-fix (retagged-personal) variant reproduces the old figure:
    // 365,000 / (10,000 x 12) = 3.0416...
    expect(preFix.debtToIncome).toBeCloseTo(365000 / 120000, 12);
    expect(fixed.debtToIncome).not.toBe(preFix.debtToIncome);
    // ...and the balance sheet itself is still identical across both, which
    // is what LR-FI-1 §28 actually protects.
    expect(fixed.totalLiabilities).toBe(preFix.totalLiabilities);
    expect(fixed.netWorth).toBe(preFix.netWorth);
  });

  it('keeps SMSF-owned assets, investments and retirement balances whole (FI-08)', () => {
    const d = computeDashboard(
      {
        ...withSmsf,
        assets: [{ current_value: 800000, asset_class: 'property', master_item_key: 'investment_property', owner: SMSF_OWNER }],
        investments: [{ current_value: 250000, cost_base: 200000, investment_type: 'shares', master_item_key: 'shares', country_code: 'AU', annual_contribution: 0, owner: SMSF_OWNER }],
        retirement: [{ current_balance: 1050000, employer_contribution: 0, personal_contribution: 0, contribution_frequency: 'monthly', owner: SMSF_OWNER }],
      },
      'AUD'
    );
    expect(d.totalAssets).toBe(800000);
    expect(d.totalInvestments).toBe(250000);
    expect(d.totalRetirement).toBe(1050000);
    expect(d.netWorth).toBe(800000 + 250000 + 1050000 - 365000);
  });
});

describe('LR-FI-1 §10/§14 — SMSF income never inflates household income (FI-05)', () => {
  const smsfRent = { source_name: 'SMSF property rent', amount: 3000, net_amount: 3000, frequency: 'monthly' as const, master_item_key: 'rental_income', owner: SMSF_OWNER };
  const smsfDividends = { source_name: 'SMSF dividends', amount: 800, net_amount: 800, frequency: 'monthly' as const, master_item_key: 'dividend_income', owner: SMSF_OWNER };

  it('excludes SMSF rent and dividends from gross, net and passive income', () => {
    const withIncome = computeDashboard({ ...EMPTY, income: [PERSONAL_SALARY, smsfRent, smsfDividends], expenses: [PERSONAL_LIVING] }, 'AUD');
    const control = computeDashboard({ ...EMPTY, income: [PERSONAL_SALARY], expenses: [PERSONAL_LIVING] }, 'AUD');
    expect(withIncome.grossMonthlyIncome).toBe(10000);
    expect(withIncome.netMonthlyIncome).toBe(10000);
    expect(withIncome.passiveMonthlyIncome).toBe(0);
    expect(withIncome.rentalMonthlyIncome).toBe(0);
    expect(withIncome.dividendMonthlyIncome).toBe(0);
    expect(withIncome.incomeSourceCount).toBe(control.incomeSourceCount);
    expect(withIncome.largestIncomeSharePct).toBe(control.largestIncomeSharePct);
    expect(withIncome.savingsRate).toBe(control.savingsRate);
  });

  it('negative control — the same rows tagged personal DO inflate income', () => {
    const retagged = computeDashboard(
      { ...EMPTY, income: [PERSONAL_SALARY, { ...smsfRent, owner: 'self' }, { ...smsfDividends, owner: 'self' }], expenses: [PERSONAL_LIVING] },
      'AUD'
    );
    expect(retagged.grossMonthlyIncome).toBe(13800);
    expect(retagged.passiveMonthlyIncome).toBe(3800);
  });
});

describe('LR-FI-1 §15 — SMSF insurance premium excluded, cover retained (FI-07)', () => {
  const personalLife = { policy_name: 'Personal life', cover_amount: 500000, premium: 100, premium_frequency: 'monthly' as const, cover_type: 'life', renewal_date: null, owner: 'self' };
  const smsfLife = { policy_name: 'SMSF life', cover_amount: 400000, premium: 250, premium_frequency: 'monthly' as const, cover_type: 'life', renewal_date: null, owner: SMSF_OWNER };

  it('counts only the household premium', () => {
    const d = computeDashboard({ ...EMPTY, insurance: [personalLife, smsfLife] }, 'AUD');
    expect(d.totalAnnualPremium).toBe(1200); // 100 * 12 only
    const retagged = computeDashboard({ ...EMPTY, insurance: [personalLife, { ...smsfLife, owner: 'self' }] }, 'AUD');
    expect(retagged.totalAnnualPremium).toBe(4200); // negative control
  });

  it('still counts the SMSF policy\'s cover toward household protection (§28)', () => {
    const d = computeDashboard({ ...EMPTY, insurance: [personalLife, smsfLife], income: [PERSONAL_SALARY] }, 'AUD');
    expect(d.insuranceByType.find((i) => i.coverType === 'life')?.coverAmount).toBe(900000);
    expect(computeInsuranceAdequacy(d, 2).lifeCover).toBe(900000);
  });
});

describe('LR-FI-1 §16-18 — household owner values are NOT over-filtered', () => {
  it.each(['self', 'spouse', 'joint', 'child', 'other', 'family_trust', 'company'])(
    'keeps owner=%s in household operating cash flow',
    (owner) => {
      const d = computeDashboard(
        {
          ...EMPTY,
          income: [PERSONAL_SALARY],
          expenses: [{ expense_name: 'Expense', amount: 1000, frequency: 'monthly', is_essential: true, master_item_key: 'groceries', owner }],
          liabilities: [{ balance: 10000, interest_rate: 5, monthly_repayment: 400, debt_type: 'personal_loan', master_item_key: 'personal_loan', owner }],
        },
        'AUD'
      );
      expect(d.totalMonthlyExpenses).toBe(1000);
      expect(d.debtMonthlyRepayments).toBe(400);
      expect(d.monthlySurplus).toBe(10000 - 1000 - 400);
    }
  );

  it('treats a missing/null owner as household context (back-compat fail-safe)', () => {
    expect(isHouseholdOperatingCashFlow({})).toBe(true);
    expect(isHouseholdOperatingCashFlow({ owner: null })).toBe(true);
    expect(isHouseholdOperatingCashFlow({ owner: SMSF_OWNER })).toBe(false);
  });

  it('only one of the eight legal owner values is excluded (§19 scope guard)', () => {
    const excluded = OWNER_VALUES.filter((o) => !isHouseholdOperatingCashFlow({ owner: o }));
    expect(excluded).toEqual(['smsf']);
  });
});

describe('LR-FI-1 — SMSF liability no longer suppresses a genuine household expense', () => {
  it('keeps the personal Mortgage expense when only an SMSF loan is on file', () => {
    // computeDashboard drops a "mortgage" expense row as a double-count when a
    // matching liability carries a repayment. Before this fix an SMSF loan
    // triggered that suppression, silently deleting a real personal outflow.
    const d = computeDashboard(
      {
        ...EMPTY,
        income: [PERSONAL_SALARY],
        expenses: [{ expense_name: 'Mortgage', amount: 2500, frequency: 'monthly', is_essential: true, master_item_key: 'mortgage', owner: 'self' }],
        liabilities: [SMSF_PROPERTY_LOAN],
      },
      'AUD'
    );
    expect(d.totalMonthlyExpenses).toBe(2500);
    expect(d.monthlySurplus).toBe(7500);
  });
});

describe('LR-FI-1 §33 — mixed household, independent oracle', () => {
  // Independently hand-computed expectations, not read back from the engine.
  const mixed: DashboardInput = {
    ...EMPTY,
    income: [
      PERSONAL_SALARY, // 10,000
      { source_name: 'Spouse salary', amount: 6000, net_amount: 5200, frequency: 'monthly', master_item_key: 'salary_wages', owner: 'spouse' },
      { source_name: 'SMSF rent', amount: 3000, net_amount: 3000, frequency: 'monthly', master_item_key: 'rental_income', owner: SMSF_OWNER },
    ],
    expenses: [
      PERSONAL_LIVING, // 5,000 essential
      { expense_name: 'Entertainment', amount: 900, frequency: 'monthly', is_essential: false, master_item_key: 'entertainment', owner: 'joint' },
      SMSF_AUDIT_FEE, // 500, SMSF
      { expense_name: 'SMSF property rates', amount: 300, frequency: 'monthly', is_essential: true, master_item_key: 'council_rates', owner: SMSF_OWNER },
    ],
    liabilities: [
      { balance: 400000, interest_rate: 6, monthly_repayment: 3000, debt_type: 'mortgage', master_item_key: 'home_loan', currency_code: 'AUD', owner: 'joint' },
      SMSF_PROPERTY_LOAN, // 365,000 balance / 2,000 repayment, SMSF
    ],
    assets: [{ current_value: 900000, asset_class: 'property', master_item_key: 'principal_residence', owner: 'joint' }],
    retirement: [{ current_balance: 1050000, employer_contribution: 0, personal_contribution: 0, contribution_frequency: 'monthly' }],
  };

  const d = computeDashboard(mixed, 'AUD');

  it('Household Income — personal + spouse only', () => {
    expect(d.grossMonthlyIncome).toBe(16000); // 10,000 + 6,000
    expect(d.netMonthlyIncome).toBe(15200); // 10,000 + 5,200
  });

  it('Household Expenses — SMSF audit fee and SMSF rates excluded', () => {
    expect(d.essentialMonthlyExpenses).toBe(5000);
    expect(d.lifestyleMonthlyExpenses).toBe(900);
    expect(d.totalMonthlyExpenses).toBe(5900);
  });

  it('Monthly Surplus — 15,200 net - 5,900 expenses - 3,000 household debt', () => {
    expect(d.debtMonthlyRepayments).toBe(3000);
    expect(d.monthlySurplus).toBe(6300);
  });

  it('Savings Rate — 6,300 / 15,200', () => {
    expect(d.savingsRate).toBeCloseTo(6300 / 15200, 12);
  });

  it('DSR — 3,000 / 15,200', () => {
    expect(d.debtServiceRatio).toBeCloseTo(3000 / 15200, 12);
  });

  it('Retirement and Net Worth — SMSF wealth fully retained', () => {
    expect(d.totalRetirement).toBe(1050000);
    // 900,000 assets + 1,050,000 retirement - (400,000 + 365,000) liabilities
    expect(d.netWorth).toBe(1185000);
  });

  it('matches the SMSF-free control on cash flow but NOT on wealth', () => {
    const control = computeDashboard(
      {
        ...mixed,
        income: mixed.income.filter((r) => r.owner !== SMSF_OWNER),
        expenses: mixed.expenses.filter((r) => r.owner !== SMSF_OWNER),
        liabilities: mixed.liabilities.filter((r) => r.owner !== SMSF_OWNER),
      },
      'AUD'
    );
    expect(d.monthlySurplus).toBe(control.monthlySurplus);
    expect(d.savingsRate).toBe(control.savingsRate);
    expect(d.debtServiceRatio).toBe(control.debtServiceRatio);
    expect(d.totalMonthlyExpenses).toBe(control.totalMonthlyExpenses);
    expect(d.grossMonthlyIncome).toBe(control.grossMonthlyIncome);
    // Wealth legitimately differs — the SMSF loan balance is gone from the control.
    expect(control.netWorth).toBe(1550000);
    expect(d.netWorth).not.toBe(control.netWorth);
  });
});

describe('LR-FI-1 §23/§24 — Health Score and Resilience inherit the correction (FI-09, FI-10)', () => {
  // A household complete enough for every component to actually score, so
  // these assertions compare real numbers rather than two "missing data"
  // placeholders. The wealth rows are IDENTICAL across all three variants —
  // only the SMSF cash-flow rows move — which isolates the effect under test.
  const wealth: Partial<DashboardInput> = {
    assets: [
      { current_value: 900000, asset_class: 'property', master_item_key: 'principal_residence', owner: 'joint' },
      { current_value: 40000, asset_class: 'cash', master_item_key: 'savings_account', owner: 'joint' },
    ],
    investments: [{ current_value: 120000, cost_base: 100000, investment_type: 'shares', master_item_key: 'shares', country_code: 'AU', annual_contribution: 6000, owner: 'self' }],
    retirement: [{ current_balance: 300000, employer_contribution: 900, personal_contribution: 200, contribution_frequency: 'monthly' }],
    insurance: [
      { policy_name: 'Life', cover_amount: 900000, premium: 90, premium_frequency: 'monthly', cover_type: 'life', renewal_date: null, owner: 'self' },
      { policy_name: 'Income protection', cover_amount: 120000, premium: 60, premium_frequency: 'monthly', cover_type: 'income_protection', renewal_date: null, waiting_period_days: 30, owner: 'self' },
    ],
    // A genuine personal mortgage, so the debt components have household debt
    // to score in every variant (including the SMSF-free control).
    liabilities: [{ balance: 400000, interest_rate: 6, monthly_repayment: 2400, debt_type: 'mortgage', master_item_key: 'home_loan', currency_code: 'AUD', owner: 'joint' }],
  };

  const fixed = computeDashboard({ ...withSmsf, ...wealth, liabilities: [...wealth.liabilities!, SMSF_PROPERTY_LOAN] }, 'AUD');
  const control = computeDashboard({ ...withoutSmsf, ...wealth }, 'AUD');
  const preFix = computeDashboard(
    { ...smsfRetaggedSelf, ...wealth, liabilities: [...wealth.liabilities!, { ...SMSF_PROPERTY_LOAN, owner: 'self' }] },
    'AUD'
  );

  const hsScore = (d: DashboardSummary, code: string) => healthScoreFor(d).components.find((x) => x.code === code)?.rawScore;
  const resScore = (d: DashboardSummary, code: string) => resilienceFor(d).components.find((x) => x.code === code)?.rawScore;

  it('Health Score cash-flow components match the SMSF-free control exactly', () => {
    for (const code of ['cash_flow', 'savings', 'emergency_fund'] as const) {
      expect(hsScore(fixed, code), code).toBeTypeOf('number');
      expect(hsScore(fixed, code), code).toBe(hsScore(control, code));
    }
  });

  it('Health Score negative control — the pre-fix (retagged) variant genuinely scores worse', () => {
    expect(hsScore(preFix, 'cash_flow')).toBeTypeOf('number');
    expect(hsScore(fixed, 'cash_flow')).not.toBe(hsScore(preFix, 'cash_flow'));
    expect(hsScore(fixed, 'savings')).not.toBe(hsScore(preFix, 'savings'));
    expect(healthScoreFor(fixed).overallScore).toBeGreaterThan(healthScoreFor(preFix).overallScore);
  });

  it('Resilience cash-flow components match the SMSF-free control exactly', () => {
    for (const code of ['emergency_fund', 'liquidity'] as const) {
      expect(resScore(fixed, code), code).toBeTypeOf('number');
      expect(resScore(fixed, code), code).toBe(resScore(control, code));
    }
  });

  it('Resilience negative control — debt pressure differs from the pre-fix variant', () => {
    // Same liability BALANCES in both (§28), so any difference here is purely
    // the SMSF instalment leaving the household DSR.
    expect(fixed.totalLiabilities).toBe(preFix.totalLiabilities);
    expect(resScore(fixed, 'debt_pressure')).toBeTypeOf('number');
    expect(resScore(fixed, 'debt_pressure')).not.toBe(resScore(preFix, 'debt_pressure'));
  });
});

// ---------------------------------------------------------------------------
// Source-level guards. These fail loudly if a future change silently reverts
// the fix in the data layer, where no unit test observes the SQL directly.
// ---------------------------------------------------------------------------
describe('LR-FI-1 — data-layer guards', () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

  it('loadDashboard selects `owner` on all four cash-flow registers', () => {
    const src = read('lib/services/dashboardData.ts');
    for (const table of ['income_sources', 'expense_items', 'liabilities', 'insurance_policies']) {
      const block = src.slice(src.indexOf(`from('${table}')`));
      const select = block.slice(block.indexOf('.select('), block.indexOf('.eq('));
      expect(select, `${table} must select owner`).toContain('owner');
    }
  });

  it('the Twin loads the same four registers with `owner`', () => {
    const src = read('lib/services/twinData.ts');
    const dashboardForTwin = src.slice(src.indexOf('async function loadDashboardForTwin'));
    for (const table of ['income_sources', 'expense_items', 'liabilities', 'insurance_policies']) {
      const block = dashboardForTwin.slice(dashboardForTwin.indexOf(`from('${table}')`));
      expect(block.slice(0, block.indexOf('.eq(')), `${table} must select owner`).toContain('owner');
    }
  });

  it('pure cash-flow registers read outside computeDashboard exclude SMSF at the query level', () => {
    expect(read('lib/services/twinData.ts')).toContain(".neq('owner', SMSF_OWNER)");
    const report = read('lib/services/reportSnapshotResolver.ts');
    expect(report.match(/\.neq\('owner', SMSF_OWNER\)/g)?.length).toBe(2);
  });

  it('the SMSF owner literal lives in exactly one place', () => {
    expect(read('lib/engines/householdContext.ts')).toContain("export const SMSF_OWNER = 'smsf'");
    // The engine never hard-codes the string itself.
    expect(read('lib/engines/dashboard.ts')).not.toContain("'smsf'");
  });

  it('migration 0004 still permits owner=smsf on all seven registers (the rule\'s premise)', () => {
    const sql = read('supabase/migrations/0004_financial_data_grid.sql');
    expect(sql.match(/check \(owner in \('self','spouse','joint','child','family_trust','company','smsf','other'\)\)/g)?.length).toBe(7);
  });

  it('the certified SMSF valuation path never uses owner=smsf, so it cannot be affected', () => {
    // smsf_create_fund()'s owner is constrained to self/spouse/joint, so a
    // fund's retirement_accounts row is never filtered by this rule.
    expect(read('lib/validation/smsf.ts')).toContain("owner: z.enum(['self', 'spouse', 'joint'])");
  });
});
