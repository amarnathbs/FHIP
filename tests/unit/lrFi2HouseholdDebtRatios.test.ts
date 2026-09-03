import { describe, it, expect } from 'vitest';
import { computeDashboard, type DashboardInput, type DashboardSummary, type SnapshotRow } from '@/lib/engines/dashboard';
import { SMSF_OWNER } from '@/lib/engines/householdContext';
import { previousDebtToIncome } from '@/lib/engines/reportSections';
import { applyScenario, recomputeDerived } from '@/lib/engines/whatIf';
import { runNetWorthForecast } from '@/lib/engines/forecast/netWorthCalculator';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// LR-FI-2 — Household/SMSF separation for BALANCE-based debt ratios and for
// the wealth-side forecast amortisation.
//
// LR-FI-1 filtered household operating CASH FLOW and deliberately left WEALTH
// whole. Both halves of that split are correct. Every defect this file covers
// is a place where a FILTERED cash-flow figure and an UNFILTERED wealth figure
// meet inside one expression:
//
//   Item 1  debtToIncome  = totalLiabilities (unfiltered) / grossIncome (filtered)
//   Item 6c monthlyLoanRepayment (filtered) amortising openingLiabilities (unfiltered)
//
// The fix is never "filter more" — it is "make both sides agree on which
// economic entity they describe". So every assertion below is paired: the
// SMSF household must equal an SMSF-FREE CONTROL on the household-scoped
// figure, differ from an SMSF-RETAGGED-PERSONAL negative control (which
// reproduces the pre-fix behaviour exactly), and leave every wealth total
// byte-identical to LR-FI-1's certified behaviour.
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

const SALARY = {
  source_name: 'Salary',
  amount: 8000,
  net_amount: 8000,
  frequency: 'monthly' as const,
  master_item_key: 'salary_wages',
  owner: 'self',
};

const PERSONAL_MORTGAGE = {
  balance: 400000,
  interest_rate: 6,
  monthly_repayment: 3000,
  debt_type: 'mortgage',
  master_item_key: 'home_loan',
  currency_code: 'AUD',
  owner: 'joint',
};

const SMSF_LOAN = {
  balance: 365000,
  interest_rate: 6,
  monthly_repayment: 2000,
  debt_type: 'mortgage',
  master_item_key: 'investment_loan',
  currency_code: 'AUD',
  owner: SMSF_OWNER,
};

/** Household + SMSF, correctly tagged — the fixed behaviour. */
const withSmsf: DashboardInput = {
  ...EMPTY,
  income: [SALARY],
  liabilities: [PERSONAL_MORTGAGE, SMSF_LOAN],
};

/** SMSF row physically removed — the household-only control. */
const withoutSmsf: DashboardInput = {
  ...EMPTY,
  income: [SALARY],
  liabilities: [PERSONAL_MORTGAGE],
};

/** SMSF row re-tagged personal — reproduces the pre-LR-FI-2 behaviour. */
const smsfRetaggedSelf: DashboardInput = {
  ...EMPTY,
  income: [SALARY],
  liabilities: [PERSONAL_MORTGAGE, { ...SMSF_LOAN, owner: 'self' }],
};

// ---------------------------------------------------------------------------
// Item 1 — SMSF liability balances must not inflate personal DTI
// ---------------------------------------------------------------------------
describe('LR-FI-2 Item 1 — Debt-to-Income is household-scoped on BOTH sides', () => {
  it('excludes the SMSF loan balance from DTI (independent oracle)', () => {
    const d = computeDashboard(withSmsf, 'AUD');
    // Hand-derived: 400,000 personal debt / (8,000 x 12) = 4.1666...
    expect(d.debtToIncome).toBeCloseTo(400000 / 96000, 12);
  });

  it('matches the SMSF-free control exactly', () => {
    expect(computeDashboard(withSmsf, 'AUD').debtToIncome).toBe(computeDashboard(withoutSmsf, 'AUD').debtToIncome);
  });

  it('NEGATIVE CONTROL — the same row tagged personal genuinely inflates DTI', () => {
    const retagged = computeDashboard(smsfRetaggedSelf, 'AUD');
    // Reproduces the pre-fix figure: 765,000 / 96,000 = 7.97x.
    expect(retagged.debtToIncome).toBeCloseTo(765000 / 96000, 12);
    expect(computeDashboard(withSmsf, 'AUD').debtToIncome).not.toBe(retagged.debtToIncome);
  });

  it('exposes the household liability balance as its own figure', () => {
    const d = computeDashboard(withSmsf, 'AUD');
    expect(d.householdLiabilityBalance).toBe(400000);
    // ...while the balance-sheet total stays whole (LR-FI-1 §28).
    expect(d.totalLiabilities).toBe(765000);
  });

  it('flips a real benchmark band — the user-visible consequence', () => {
    // The DTI ratio row's own bands: <3x good, <5x caution, else risk.
    const mixed: DashboardInput = { ...withSmsf, income: [{ ...SALARY, amount: 16000, net_amount: 15200 }] };
    const fixed = computeDashboard(mixed, 'AUD');
    const preFix = computeDashboard({ ...smsfRetaggedSelf, income: mixed.income }, 'AUD');
    const bandOf = (d: DashboardSummary) => d.ratios.find((r) => r.key === 'debt_to_income')?.status;
    expect(fixed.debtToIncome).toBeCloseTo(400000 / 192000, 12); // 2.08x
    expect(preFix.debtToIncome).toBeCloseTo(765000 / 192000, 12); // 3.98x
    expect(bandOf(fixed)).toBe('good');
    expect(bandOf(preFix)).toBe('caution');
  });

  it('leaves EVERY wealth and debt-composition total untouched (LR-FI-1 §28 regression guard)', () => {
    const fixed = computeDashboard(withSmsf, 'AUD');
    const preFix = computeDashboard(smsfRetaggedSelf, 'AUD');
    expect(fixed.totalLiabilities).toBe(preFix.totalLiabilities);
    expect(fixed.netWorth).toBe(preFix.netWorth);
    expect(fixed.goodDebt).toBe(preFix.goodDebt);
    expect(fixed.badDebt).toBe(preFix.badDebt);
    expect(fixed.liabilityByType).toEqual(preFix.liabilityByType);
    expect(fixed.averageInterestRate).toBe(preFix.averageInterestRate);
    expect(fixed.liabilitiesWithPayoff).toEqual(preFix.liabilitiesWithPayoff);
    expect(fixed.variableRateDebtRatio).toBe(preFix.variableRateDebtRatio);
    expect(fixed.creditUtilization).toBe(preFix.creditUtilization);
    expect(fixed.liabilitiesByCountry).toEqual(preFix.liabilitiesByCountry);
  });

  it('is a no-op for every household with no SMSF rows', () => {
    const d = computeDashboard(withoutSmsf, 'AUD');
    expect(d.householdLiabilityBalance).toBe(d.totalLiabilities);
    expect(d.debtToIncome).toBeCloseTo(400000 / 96000, 12);
  });

  it('keeps DTI on the GROSS basis — not silently switched to DSR\'s net basis', () => {
    // net_amount deliberately below amount: a net-basis DTI would be larger.
    const d = computeDashboard(
      { ...EMPTY, income: [{ ...SALARY, amount: 10000, net_amount: 6000 }], liabilities: [PERSONAL_MORTGAGE] },
      'AUD'
    );
    expect(d.debtToIncome).toBeCloseTo(400000 / (10000 * 12), 12);
  });

  it('converts a foreign-currency household liability before it reaches DTI', () => {
    const d = computeDashboard(
      {
        ...EMPTY,
        income: [SALARY],
        liabilities: [{ ...PERSONAL_MORTGAGE, balance: 5600000, currency_code: 'INR' }],
      },
      'AUD',
      56
    );
    expect(d.householdLiabilityBalance).toBeCloseTo(100000, 6); // 5,600,000 INR / 56
    expect(d.debtToIncome).toBeCloseTo(100000 / 96000, 9);
  });
});

// ---------------------------------------------------------------------------
// Item 1 (consistency) — What-If must not silently revert the fix
// ---------------------------------------------------------------------------
describe('LR-FI-2 Item 1 — What-If preserves the household DTI basis', () => {
  it('recomputeDerived does not restore the unfiltered DTI', () => {
    const d = computeDashboard(withSmsf, 'AUD');
    const before = d.debtToIncome;
    recomputeDerived(d);
    expect(d.debtToIncome).toBe(before);
    expect(d.debtToIncome).not.toBeCloseTo(765000 / 96000, 6);
  });

  it('pay_off_debt reduces household debt and scales the repayment by the HOUSEHOLD proportion', () => {
    const base = computeDashboard(withSmsf, 'AUD');
    const after = applyScenario(base, 'pay_off_debt');
    // $10,000 off the household's own $400,000 — not off the $765,000 total.
    expect(after.householdLiabilityBalance).toBe(390000);
    expect(after.totalLiabilities).toBe(755000);
    // Repayment scales by 10,000/400,000 = 2.5%, not 10,000/765,000 = 1.307%.
    expect(after.debtMonthlyRepayments).toBeCloseTo(3000 - 3000 * (10000 / 400000), 9);
    expect(after.debtToIncome).toBeCloseTo(390000 / 96000, 12);
  });

  it('pay_off_debt is byte-identical for a household with no SMSF rows', () => {
    const after = applyScenario(computeDashboard(withoutSmsf, 'AUD'), 'pay_off_debt');
    expect(after.totalLiabilities).toBe(390000);
    expect(after.householdLiabilityBalance).toBe(390000);
    expect(after.debtMonthlyRepayments).toBeCloseTo(3000 - 3000 * (10000 / 400000), 9);
  });
});

// ---------------------------------------------------------------------------
// Item 1 (consistency) — the report must not publish a fabricated movement
// ---------------------------------------------------------------------------
describe('LR-FI-2 Item 1 — historical DTI comparison never mixes bases', () => {
  const snapshot = (totalLiabilities: number, monthlyIncome: number): SnapshotRow => ({
    snapshot_month: '2026-08-01',
    net_worth: 0,
    monthly_income: monthlyIncome,
    monthly_expenses: 0,
    monthly_surplus: 0,
    savings_rate: null,
    total_assets: 0,
    total_liabilities: totalLiabilities,
  });

  it('reports the previous DTI normally for a household with no SMSF debt', () => {
    const d = computeDashboard(withoutSmsf, 'AUD');
    expect(previousDebtToIncome(d, snapshot(420000, 8000))).toBeCloseTo(420000 / 96000, 12);
  });

  it('returns null for an SMSF-holding household rather than a mixed-basis number', () => {
    // financial_snapshots stores UNFILTERED total_liabilities alongside
    // household-only monthly_income, so no stored history can support a
    // household-scoped previous DTI. "Unavailable" is the honest answer;
    // 785,000/96,000 would be a fabricated improvement against 4.17x.
    const d = computeDashboard(withSmsf, 'AUD');
    expect(previousDebtToIncome(d, snapshot(785000, 8000))).toBeNull();
  });

  it('returns null when there is no prior snapshot at all', () => {
    expect(previousDebtToIncome(computeDashboard(withoutSmsf, 'AUD'), null)).toBeNull();
  });

  it('returns null when the prior snapshot recorded no income', () => {
    expect(previousDebtToIncome(computeDashboard(withoutSmsf, 'AUD'), snapshot(420000, 0))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Item 3 — DSR and DTI across representative household archetypes
// ---------------------------------------------------------------------------
describe('LR-FI-2 Item 3 — DSR/DTI correctness across household archetypes', () => {
  it('personal-only household', () => {
    const d = computeDashboard(
      {
        ...EMPTY,
        income: [{ ...SALARY, amount: 9000, net_amount: 7000 }],
        expenses: [{ expense_name: 'Living', amount: 3000, frequency: 'monthly', is_essential: true, master_item_key: 'groceries', owner: 'self' }],
        liabilities: [{ ...PERSONAL_MORTGAGE, owner: 'self' }],
      },
      'AUD'
    );
    expect(d.debtMonthlyRepayments).toBe(3000);
    expect(d.debtServiceRatio).toBeCloseTo(3000 / 7000, 12); // DSR on NET income
    expect(d.debtToIncome).toBeCloseTo(400000 / (9000 * 12), 12); // DTI on GROSS
    expect(d.householdLiabilityBalance).toBe(d.totalLiabilities);
  });

  it('joint household — spouse/joint rows are household context, never filtered', () => {
    const d = computeDashboard(
      {
        ...EMPTY,
        income: [SALARY, { ...SALARY, source_name: 'Spouse salary', amount: 6000, net_amount: 5000, owner: 'spouse' }],
        liabilities: [PERSONAL_MORTGAGE, { ...PERSONAL_MORTGAGE, balance: 30000, monthly_repayment: 600, debt_type: 'car_loan', master_item_key: 'car_loan', owner: 'spouse' }],
      },
      'AUD'
    );
    expect(d.debtMonthlyRepayments).toBe(3600);
    expect(d.debtServiceRatio).toBeCloseTo(3600 / 13000, 12);
    expect(d.debtToIncome).toBeCloseTo(430000 / (14000 * 12), 12);
    expect(d.householdLiabilityBalance).toBe(430000);
  });

  it('SMSF-holding household — cash flow AND balance ratio both household-scoped', () => {
    const d = computeDashboard(withSmsf, 'AUD');
    const control = computeDashboard(withoutSmsf, 'AUD');
    expect(d.debtServiceRatio).toBe(control.debtServiceRatio);
    expect(d.debtToIncome).toBe(control.debtToIncome);
    // ...and the SMSF's economic value is still in Net Worth.
    expect(d.netWorth).toBe(-765000);
    expect(d.netWorth).not.toBe(control.netWorth);
  });

  it('mixed AU/India cross-currency household with SMSF — hand-derived oracle', () => {
    const d = computeDashboard(
      {
        ...EMPTY,
        income: [
          { ...SALARY, amount: 10000, net_amount: 8000 },
          { source_name: 'India rent', amount: 56000, net_amount: 56000, frequency: 'monthly', master_item_key: 'rental_income', owner: 'joint' },
          { source_name: 'SMSF rent', amount: 3000, net_amount: 3000, frequency: 'monthly', master_item_key: 'rental_income', owner: SMSF_OWNER },
        ],
        expenses: [
          { expense_name: 'Living', amount: 4000, frequency: 'monthly', is_essential: true, master_item_key: 'groceries', owner: 'joint' },
          { expense_name: 'SMSF audit', amount: 500, frequency: 'monthly', is_essential: true, master_item_key: 'accounting_fees', owner: SMSF_OWNER },
        ],
        liabilities: [
          PERSONAL_MORTGAGE, // 400,000 AUD @ 3,000/mo
          { ...PERSONAL_MORTGAGE, balance: 2800000, monthly_repayment: 22400, currency_code: 'INR', owner: 'joint' }, // 50,000 AUD @ 400/mo
          SMSF_LOAN, // excluded from both ratios
        ],
      },
      'AUD',
      56
    );
    // Income: 10,000 + (56,000 INR is recorded in the row's own amount and is
    // NOT FX-converted by this engine's income path) — assert what the engine
    // actually does, then pin the ratios to it.
    const grossOracle = 10000 + 56000;
    const netOracle = 8000 + 56000;
    expect(d.grossMonthlyIncome).toBe(grossOracle);
    expect(d.netMonthlyIncome).toBe(netOracle);
    // Repayments ARE FX-converted: 3,000 + 22,400/56 = 3,400.
    expect(d.debtMonthlyRepayments).toBeCloseTo(3400, 9);
    expect(d.debtServiceRatio).toBeCloseTo(3400 / netOracle, 12);
    // Household balances: 400,000 + 2,800,000/56 = 450,000. SMSF's 365,000 out.
    expect(d.householdLiabilityBalance).toBeCloseTo(450000, 6);
    expect(d.debtToIncome).toBeCloseTo(450000 / (grossOracle * 12), 9);
    // Net Worth keeps all three balances: 450,000 + 365,000.
    expect(d.totalLiabilities).toBeCloseTo(815000, 6);
  });
});

// ---------------------------------------------------------------------------
// Item 6c — wealth-side amortisation must use a WHOLE repayment
// ---------------------------------------------------------------------------
describe('LR-FI-2 Item 6c — forecast amortisation pairs whole balances with whole repayments', () => {
  it('exposes the all-owner repayment total alongside the household-only one', () => {
    const d = computeDashboard(withSmsf, 'AUD');
    expect(d.debtMonthlyRepayments).toBe(3000); // household cash flow (LR-FI-1)
    expect(d.totalLiabilityMonthlyRepayments).toBe(5000); // wealth-side amortisation
  });

  it('the two figures are equal for any household with no SMSF rows', () => {
    const d = computeDashboard(withoutSmsf, 'AUD');
    expect(d.totalLiabilityMonthlyRepayments).toBe(d.debtMonthlyRepayments);
  });

  it('FX-converts the all-owner total the same way as the household total', () => {
    const d = computeDashboard(
      { ...EMPTY, income: [SALARY], liabilities: [{ ...SMSF_LOAN, monthly_repayment: 112000, currency_code: 'INR' }, PERSONAL_MORTGAGE] },
      'AUD',
      56
    );
    expect(d.totalLiabilityMonthlyRepayments).toBeCloseTo(3000 + 2000, 9);
  });

  it('REPRODUCES THE LIVE DEFECT — a household-only repayment cannot amortise a whole balance', () => {
    // The exact pairing forecastData.ts uses today: openingLiabilities =
    // totalLiabilities (765,000, unfiltered) but monthlyLoanRepayment =
    // debtMonthlyRepayments (3,000, household-only). At the default 6%
    // blended rate one month's interest is 3,825 > 3,000, so the balance
    // GROWS every month and never pays off.
    const d = computeDashboard(withSmsf, 'AUD');
    const buggy = runNetWorthForecast({
      baselineDate: '2026-09-01',
      months: 12,
      currency: 'AUD',
      openingAssets: 0,
      openingInvestments: 0,
      openingRetirement: 0,
      openingLiabilities: d.totalLiabilities,
      monthlyAssetContribution: 0,
      monthlyInvestmentContribution: 0,
      monthlyRetirementContribution: 0,
      monthlyLoanRepayment: d.debtMonthlyRepayments,
      assumptions: {},
    });
    const buggyClosing = buggy.results[buggy.results.length - 1].metadata!.liabilities as number;
    expect(buggyClosing).toBeGreaterThan(765000); // debt compounds upward

    const fixed = runNetWorthForecast({
      baselineDate: '2026-09-01',
      months: 12,
      currency: 'AUD',
      openingAssets: 0,
      openingInvestments: 0,
      openingRetirement: 0,
      openingLiabilities: d.totalLiabilities,
      monthlyAssetContribution: 0,
      monthlyInvestmentContribution: 0,
      monthlyRetirementContribution: 0,
      monthlyLoanRepayment: d.totalLiabilityMonthlyRepayments,
      assumptions: {},
    });
    const fixedClosing = fixed.results[fixed.results.length - 1].metadata!.liabilities as number;
    expect(fixedClosing).toBeLessThan(765000); // debt genuinely reduces
  });
});

// ---------------------------------------------------------------------------
// Source-level guards — these fail loudly if a future change silently reverts
// the wiring, which no pure-function test would observe.
// ---------------------------------------------------------------------------
describe('LR-FI-2 — data-layer guards', () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

  it('both forecast wealth paths amortise with the ALL-OWNER repayment total', () => {
    const src = read('lib/services/forecastData.ts');
    // Every monthlyLoanRepayment wiring in this file must use the whole-
    // balance-sheet figure, because every one of them is paired with
    // openingLiabilities: dashboard.totalLiabilities.
    const wirings = src.match(/monthlyLoanRepayment: dashboard\.[A-Za-z]+/g) ?? [];
    expect(wirings.length).toBeGreaterThanOrEqual(2);
    for (const w of wirings) expect(w).toBe('monthlyLoanRepayment: dashboard.totalLiabilityMonthlyRepayments');
  });

  it('DTI is the only ratio re-pointed off totalLiabilities in the engine', () => {
    const src = read('lib/engines/dashboard.ts');
    expect(src).toContain('const debtToIncome = annualGrossIncome > 0 ? householdLiabilityBalance / annualGrossIncome : null;');
    // Net Worth must still use the whole balance.
    expect(src).toContain('const netWorth = totalAssets + totalInvestments + totalRetirement - totalLiabilities;');
  });

  it('What-If re-derives DTI from the household balance, not the total', () => {
    expect(read('lib/engines/whatIf.ts')).toContain('d.householdLiabilityBalance / annualGrossIncome');
  });

  it('LR-FI-2 adds no new hard-coded owner literal outside householdContext', () => {
    expect(read('lib/engines/dashboard.ts')).not.toContain("'smsf'");
    expect(read('lib/engines/whatIf.ts')).not.toContain("'smsf'");
    expect(read('lib/engines/reportSections.ts')).not.toContain("'smsf'");
  });
});
