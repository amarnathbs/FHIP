import { describe, it, expect } from 'vitest';
import { computeDashboard, type DashboardInput } from '@/lib/engines/dashboard';
import { runNetWorthForecast, type NetWorthCalculatorInput } from '@/lib/engines/forecast/netWorthCalculator';
import type { ResolvedAssumption, ResolvedAssumptionSet } from '@/lib/engines/forecast/types';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// LR-FI-3 — Net Worth forecast contribution exactly-once integrity.
//
// Closes LR-FI-2 Residual Finding R4 (docs/production-apply/LR_FI_2_SCOPE_DECISION.md)
// per the fresh trace and worked numeric example in
// docs/production-apply/LR_FI_3_DISCOVERY_REPORT.md §8.
//
// THE INVARIANT UNDER TEST: one dollar of economic cash enters projected
// wealth exactly once. `dashboard.monthlySurplus` never subtracts an
// investment or personal-retirement contribution (they are funded from the
// same net income already inside it — dashboard.ts:599, and the same
// reasoning healthScore.ts:202-207 already applies for the employer/personal
// retirement split). Before this fix, forecastData.ts's net_worth branch
// swept the WHOLE surplus into the general-assets bucket AND separately grew
// the investment/retirement buckets from the same underlying dollars — a
// household-funded contribution was credited to projected wealth twice.
// Only the EMPLOYER portion of a retirement contribution is genuinely
// additive (never part of take-home pay to begin with), and must stay so.
//
// Every scenario below is a matched pair (buggy formula literally
// reconstructed vs. the fixed formula this file's fix implements), so a test
// cannot pass by coincidence — the buggy pairing is asserted to reproduce the
// exact pre-fix number first, then the fixed pairing is asserted to differ
// from it by exactly the household-funded contribution amount.
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
  amount: 10000,
  net_amount: 10000,
  frequency: 'monthly' as const,
  master_item_key: 'salary_wages',
  owner: 'self',
};

const LIVING = {
  expense_name: 'Living costs',
  amount: 6000,
  frequency: 'monthly' as const,
  is_essential: true,
  master_item_key: 'groceries',
  owner: 'self',
};

const INVESTMENT_SIP = {
  current_value: 0,
  cost_base: null,
  investment_type: 'managed_fund',
  country_code: null,
  annual_contribution: 12000, // $1,000/month
  currency_code: 'AUD',
  owner: 'self',
};

/** Reproduces exactly the pre-fix line: `Math.max(0, dashboard.monthlySurplus)`. */
function buggyMonthlyAssetContribution(monthlySurplus: number): number {
  return Math.max(0, monthlySurplus);
}

/** The fix implemented in lib/services/forecastData.ts's net_worth branch. */
function fixedMonthlyAssetContribution(
  monthlySurplus: number,
  investmentAnnualContribution: number,
  retirementPersonalMonthlyContribution: number
): number {
  const householdFundedMonthlyContribution = investmentAnnualContribution / 12 + retirementPersonalMonthlyContribution;
  return Math.max(0, monthlySurplus - householdFundedMonthlyContribution);
}

function zeroAssumption(key: string): ResolvedAssumption {
  return { key, category: 'test', value: 0, valueType: 'percentage', unit: null, sourceType: 'user_override', sourceReference: null };
}
function assumptionSet(...keys: string[]): ResolvedAssumptionSet {
  const set: ResolvedAssumptionSet = {};
  for (const key of keys) set[key] = zeroAssumption(key);
  return set;
}
const ZERO_RETURN_ASSUMPTIONS = assumptionSet('property_growth', 'equity', 'retirement', 'liability_interest_rate');

function baseNetWorthInput(overrides: Partial<NetWorthCalculatorInput>): NetWorthCalculatorInput {
  return {
    baselineDate: '2026-09-01',
    months: 1,
    currency: 'AUD',
    openingAssets: 0,
    openingInvestments: 0,
    openingRetirement: 0,
    openingLiabilities: 0,
    monthlyAssetContribution: 0,
    monthlyInvestmentContribution: 0,
    monthlyRetirementContribution: 0,
    monthlyLoanRepayment: 0,
    assumptions: ZERO_RETURN_ASSUMPTIONS,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The zero-return oracle (dispatch's own worked case): household with $3,000
// truly available cash and a $1,000/month investment contribution — one
// month's asset-bucket principal growth (zero return, so growth = the
// contribution itself) must be exactly $3,000, never $4,000.
// ---------------------------------------------------------------------------
describe('LR-FI-3 — zero-return oracle (dispatch worked case)', () => {
  const d = computeDashboard(
    { ...EMPTY, income: [SALARY], expenses: [LIVING], investments: [INVESTMENT_SIP] },
    'AUD'
  );

  it('the traced dashboard figures match the oracle exactly', () => {
    expect(d.monthlySurplus).toBe(4000); // 10,000 - 6,000, never nets the SIP
    expect(d.investmentAnnualContribution).toBe(12000);
    expect(d.retirementPersonalMonthlyContribution).toBe(0);
  });

  it('NEGATIVE CONTROL — the pre-fix formula genuinely produces $4,000, not $3,000', () => {
    const buggy = runNetWorthForecast(
      baseNetWorthInput({ monthlyAssetContribution: buggyMonthlyAssetContribution(d.monthlySurplus) })
    );
    // Zero return: closingValue = openingValue(0) + contributions, exactly.
    expect(buggy.results[0].closingValue).toBe(4000);
    expect(buggy.results[0].contributions).toBe(4000);
  });

  it('the fixed formula nets the SIP out of the residual swept into assets: exactly $3,000', () => {
    const fixed = runNetWorthForecast(
      baseNetWorthInput({
        monthlyAssetContribution: fixedMonthlyAssetContribution(
          d.monthlySurplus,
          d.investmentAnnualContribution,
          d.retirementPersonalMonthlyContribution
        ),
      })
    );
    expect(fixed.results[0].closingValue).toBe(3000);
    expect(fixed.results[0].contributions).toBe(3000);
  });
});

// ---------------------------------------------------------------------------
// The whole-household invariant: total new wealth credited across every
// bucket (assets + investments + retirement) in one month must equal
// monthlySurplus, PLUS the employer retirement contribution (the only
// genuinely additive term) — never more.
// ---------------------------------------------------------------------------
describe('LR-FI-3 — total credited wealth equals monthlySurplus + employer contribution, never more', () => {
  it('investment-only household: fixed total == monthlySurplus; buggy total is $1,000 too high', () => {
    const d = computeDashboard(
      { ...EMPTY, income: [SALARY], expenses: [LIVING], investments: [INVESTMENT_SIP] },
      'AUD'
    );
    const runTotal = (monthlyAssetContribution: number) => {
      const r = runNetWorthForecast(
        baseNetWorthInput({
          monthlyAssetContribution,
          monthlyInvestmentContribution: d.investmentAnnualContribution / 12,
          monthlyRetirementContribution: d.retirementEmployerMonthlyContribution + d.retirementPersonalMonthlyContribution,
        })
      );
      return r.results[0].contributions;
    };
    const buggyTotal = runTotal(buggyMonthlyAssetContribution(d.monthlySurplus));
    const fixedTotal = runTotal(
      fixedMonthlyAssetContribution(d.monthlySurplus, d.investmentAnnualContribution, d.retirementPersonalMonthlyContribution)
    );
    expect(buggyTotal).toBe(5000); // 4,000 (surplus, unmodified) + 1,000 (investment bucket) — $1,000 invented
    expect(fixedTotal).toBe(4000); // == monthlySurplus exactly, no employer contribution in this scenario
    expect(fixedTotal).toBe(d.monthlySurplus + d.retirementEmployerMonthlyContribution);
  });

  it('mixed household (investment + employer + personal retirement contributions): the invariant holds exactly', () => {
    const RETIREMENT = {
      current_balance: 0,
      employer_contribution: 300,
      personal_contribution: 700,
      contribution_frequency: 'monthly' as const,
      currency_code: 'AUD',
      owner: 'self',
    };
    const investment = { ...INVESTMENT_SIP, annual_contribution: 6000 }; // $500/month
    const d = computeDashboard(
      { ...EMPTY, income: [SALARY], expenses: [LIVING], investments: [investment], retirement: [RETIREMENT] },
      'AUD'
    );
    expect(d.monthlySurplus).toBe(4000);
    expect(d.investmentAnnualContribution).toBe(6000);
    expect(d.retirementEmployerMonthlyContribution).toBe(300);
    expect(d.retirementPersonalMonthlyContribution).toBe(700);

    const fixedAssetContribution = fixedMonthlyAssetContribution(
      d.monthlySurplus,
      d.investmentAnnualContribution,
      d.retirementPersonalMonthlyContribution
    );
    expect(fixedAssetContribution).toBe(2800); // 4,000 - (500 + 700)

    const fixed = runNetWorthForecast(
      baseNetWorthInput({
        monthlyAssetContribution: fixedAssetContribution,
        monthlyInvestmentContribution: d.investmentAnnualContribution / 12,
        monthlyRetirementContribution: d.retirementEmployerMonthlyContribution + d.retirementPersonalMonthlyContribution,
      })
    );
    // 2,800 (assets) + 500 (investment) + 1,000 (retirement, 300 employer + 700 personal) = 4,300
    expect(fixed.results[0].contributions).toBe(4300);
    // == monthlySurplus (4,000) + the employer contribution (300), the ONLY additive term.
    expect(fixed.results[0].contributions).toBe(d.monthlySurplus + d.retirementEmployerMonthlyContribution);
  });
});

// ---------------------------------------------------------------------------
// Employer contributions must NOT be netted out — they were never part of
// take-home pay, so there is nothing to subtract.
// ---------------------------------------------------------------------------
describe('LR-FI-3 — employer retirement contributions stay additive, never netted', () => {
  it('an employer-only contribution does not reduce monthlyAssetContribution at all', () => {
    const RETIREMENT_EMPLOYER_ONLY = {
      current_balance: 0,
      employer_contribution: 300,
      personal_contribution: 0,
      contribution_frequency: 'monthly' as const,
      currency_code: 'AUD',
      owner: 'self',
    };
    const d = computeDashboard(
      { ...EMPTY, income: [{ ...SALARY, amount: 8000, net_amount: 8000 }], expenses: [{ ...LIVING, amount: 6000 }], retirement: [RETIREMENT_EMPLOYER_ONLY] },
      'AUD'
    );
    expect(d.monthlySurplus).toBe(2000);
    expect(d.retirementEmployerMonthlyContribution).toBe(300);
    expect(d.retirementPersonalMonthlyContribution).toBe(0);

    const fixedAssetContribution = fixedMonthlyAssetContribution(d.monthlySurplus, d.investmentAnnualContribution, d.retirementPersonalMonthlyContribution);
    // Unaffected by the employer contribution — householdFundedMonthlyContribution is 0.
    expect(fixedAssetContribution).toBe(2000);

    const fixed = runNetWorthForecast(
      baseNetWorthInput({
        monthlyAssetContribution: fixedAssetContribution,
        monthlyRetirementContribution: d.retirementEmployerMonthlyContribution + d.retirementPersonalMonthlyContribution,
      })
    );
    // 2,000 (assets, full surplus) + 300 (employer, genuinely additive) = 2,300.
    expect(fixed.results[0].contributions).toBe(2300);
    expect(fixed.results[0].contributions).toBe(d.monthlySurplus + d.retirementEmployerMonthlyContribution);
  });
});

// ---------------------------------------------------------------------------
// The Math.max(0, ...) floor must still apply post-fix: a household whose
// contributions exceed its surplus must show $0 swept into assets, never a
// negative contribution.
// ---------------------------------------------------------------------------
describe('LR-FI-3 — the floor at zero still holds after netting', () => {
  it('contributions larger than the surplus floor monthlyAssetContribution at 0, not negative', () => {
    const d = computeDashboard(
      { ...EMPTY, income: [{ ...SALARY, amount: 6500, net_amount: 6500 }], expenses: [LIVING], investments: [INVESTMENT_SIP] },
      'AUD'
    );
    expect(d.monthlySurplus).toBe(500); // 6,500 - 6,000
    expect(d.investmentAnnualContribution).toBe(12000); // $1,000/month, exceeds the surplus
    const fixedAssetContribution = fixedMonthlyAssetContribution(d.monthlySurplus, d.investmentAnnualContribution, d.retirementPersonalMonthlyContribution);
    expect(fixedAssetContribution).toBe(0); // floored, not -500
  });
});

// ---------------------------------------------------------------------------
// Regression guard: a household with no investment/personal-retirement
// contribution at all must be byte-identical before and after the fix.
// ---------------------------------------------------------------------------
describe('LR-FI-3 — byte-identical for a household with no household-funded contributions', () => {
  it('no investments, no retirement: buggy === fixed', () => {
    const d = computeDashboard({ ...EMPTY, income: [SALARY], expenses: [LIVING] }, 'AUD');
    expect(d.investmentAnnualContribution).toBe(0);
    expect(d.retirementPersonalMonthlyContribution).toBe(0);
    expect(buggyMonthlyAssetContribution(d.monthlySurplus)).toBe(
      fixedMonthlyAssetContribution(d.monthlySurplus, d.investmentAnnualContribution, d.retirementPersonalMonthlyContribution)
    );
  });

  it('employer-only retirement contribution: buggy === fixed on monthlyAssetContribution (only the retirement bucket differs, which this fix does not touch)', () => {
    const RETIREMENT_EMPLOYER_ONLY = {
      current_balance: 0,
      employer_contribution: 300,
      personal_contribution: 0,
      contribution_frequency: 'monthly' as const,
      currency_code: 'AUD',
      owner: 'self',
    };
    const d = computeDashboard({ ...EMPTY, income: [SALARY], expenses: [LIVING], retirement: [RETIREMENT_EMPLOYER_ONLY] }, 'AUD');
    expect(buggyMonthlyAssetContribution(d.monthlySurplus)).toBe(
      fixedMonthlyAssetContribution(d.monthlySurplus, d.investmentAnnualContribution, d.retirementPersonalMonthlyContribution)
    );
  });
});

// ---------------------------------------------------------------------------
// The defect compounds over time if unfixed: with a nonzero return, the extra
// principal the buggy formula invents each month itself earns growth in
// every subsequent month, so the gap between the buggy and fixed projections
// grows FASTER than linearly (strictly more than N x the monthly over-credit).
// ---------------------------------------------------------------------------
describe('LR-FI-3 — the defect compounds month over month if left unfixed', () => {
  it('the buggy/fixed gap after 12 months exceeds the flat 12 x $1,000 the bug adds each month', () => {
    const d = computeDashboard(
      { ...EMPTY, income: [SALARY], expenses: [LIVING], investments: [INVESTMENT_SIP] },
      'AUD'
    );
    const householdFundedMonthlyContribution = d.investmentAnnualContribution / 12 + d.retirementPersonalMonthlyContribution;
    expect(householdFundedMonthlyContribution).toBe(1000);

    // A real, non-zero default growth rate this time (property_growth default
    // is 3% — DEFAULT_ASSET_GROWTH in netWorthCalculator.ts), so the extra
    // principal the bug invents each month itself compounds forward.
    const run = (monthlyAssetContribution: number) =>
      runNetWorthForecast(
        baseNetWorthInput({
          months: 12,
          monthlyAssetContribution,
          monthlyInvestmentContribution: d.investmentAnnualContribution / 12,
          assumptions: {}, // defaults apply — non-zero asset growth
        })
      );

    const buggy = run(buggyMonthlyAssetContribution(d.monthlySurplus));
    const fixed = run(
      fixedMonthlyAssetContribution(d.monthlySurplus, d.investmentAnnualContribution, d.retirementPersonalMonthlyContribution)
    );

    const gapAtMonth = (n: number) => buggy.results[n - 1].closingValue - fixed.results[n - 1].closingValue;

    // Flat/uncompounded, the bug's constant $1,000/month over-credit would
    // produce a $12,000 gap after 12 months. With growth applied every month
    // to a running balance that already includes the extra principal, the
    // true gap must exceed that flat figure.
    expect(gapAtMonth(12)).toBeGreaterThan(12000);

    // The MARGINAL month-over-month gap growth must itself be increasing —
    // proof this is genuine compounding, not merely a constant $1,000/month
    // difference that happens to sum past $12,000 in the total contributions
    // column alone.
    const marginalGap = (n: number) => gapAtMonth(n) - gapAtMonth(n - 1);
    expect(marginalGap(12)).toBeGreaterThan(marginalGap(2));
  });
});

// ---------------------------------------------------------------------------
// Source-level guard — fails loudly if a future change silently reverts the
// wiring, which no pure-function test would observe (mirrors the pattern
// tests/unit/lrFi2HouseholdDebtRatios.test.ts already uses for LR-FI-2).
// ---------------------------------------------------------------------------
describe('LR-FI-3 — data-layer guard', () => {
  const src = readFileSync(join(process.cwd(), 'lib/services/forecastData.ts'), 'utf8');

  it('the net-worth branch nets household-funded contributions out of the surplus before sweeping it into assets', () => {
    expect(src).toContain(
      'const householdFundedMonthlyContribution =\n    dashboard.investmentAnnualContribution / 12 + dashboard.retirementPersonalMonthlyContribution;'
    );
    expect(src).toContain('monthlyAssetContribution: Math.max(0, dashboard.monthlySurplus - householdFundedMonthlyContribution),');
    // The pre-fix literal must no longer appear anywhere in the file.
    expect(src).not.toContain('monthlyAssetContribution: Math.max(0, dashboard.monthlySurplus),');
  });

  it('monthlyInvestmentContribution / monthlyRetirementContribution / the LR-FI-2 §6c wiring are untouched by this fix', () => {
    expect(src).toContain('monthlyInvestmentContribution: dashboard.investmentAnnualContribution / 12,');
    expect(src).toContain(
      'monthlyRetirementContribution: dashboard.retirementEmployerMonthlyContribution + dashboard.retirementPersonalMonthlyContribution,'
    );
    expect(src).toContain('monthlyLoanRepayment: dashboard.totalLiabilityMonthlyRepayments,');
  });
});
