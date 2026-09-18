// App Review 2026-09-15, item 8 requirement 4:
//
//   "Extend the same verification to all other forecast sections (Net Worth,
//    Retirement, Goals) as the reviewer suspects broader inaccuracy. Report
//    findings per section."
//
// The audit is written up in full in the response document. This file pins
// the two Net Worth defects that were fixed on this branch, so neither can
// come back, and demonstrates the two that were found but deliberately NOT
// changed here (they are product decisions, flagged for the Product Owner).
import { describe, it, expect } from 'vitest';
import { runNetWorthForecast, type NetWorthCalculatorInput } from '@/lib/engines/forecast/netWorthCalculator';
import { runGoalForecast } from '@/lib/engines/forecast/goalCalculator';
import type { ResolvedAssumptionSet } from '@/lib/engines/forecast/types';

// An empty assumption set: every getAssumptionValue falls through to its
// hard-coded default, which is exactly the live situation for
// 'liability_interest_rate' (seeded in no migration, zero rows on DEV).
const NO_ASSUMPTIONS = { values: [] } as unknown as ResolvedAssumptionSet;

function netWorthInput(overrides: Partial<NetWorthCalculatorInput> = {}): NetWorthCalculatorInput {
  return {
    baselineDate: '2026-09-01',
    months: 12,
    currency: 'AUD',
    openingAssets: 0,
    openingInvestments: 0,
    openingRetirement: 0,
    openingLiabilities: 100000,
    monthlyAssetContribution: 0,
    monthlyInvestmentContribution: 0,
    monthlyRetirementContribution: 0,
    monthlyLoanRepayment: 1000,
    assumptions: NO_ASSUMPTIONS,
    ...overrides,
  };
}

describe('Net Worth — the liability rate is the household\'s own, not a hard-coded default', () => {
  it('uses the supplied balance-weighted rate rather than the 6% fallback', () => {
    const cheap = runNetWorthForecast(netWorthInput({ liabilityRatePercent: 3.2 }));
    const fallback = runNetWorthForecast(netWorthInput());
    // A 3.2% loan must amortise faster than the same balance at the 6%
    // default. Before the fix these two were byte-identical.
    const cheapClosing = cheap.results[11].closingValue;
    const fallbackClosing = fallback.results[11].closingValue;
    expect(cheapClosing).toBeGreaterThan(fallbackClosing);
  });

  it('agrees with the Debt section on the same loan, which it previously could not', () => {
    // Debt amortises B_(n+1) = B_n(1 + r/12) - P at the user's own rate.
    let expected = 100000;
    for (let m = 0; m < 12; m++) {
      const interest = (expected * 3.2) / 100 / 12;
      expected = Math.round((Math.max(0, expected - (1000 - interest)) + Number.EPSILON) * 100) / 100;
    }
    const nw = runNetWorthForecast(netWorthInput({ liabilityRatePercent: 3.2 }));
    // Net worth here is 0 assets minus the liability, so closing = -balance.
    expect(-nw.results[11].closingValue).toBeCloseTo(expected, 2);
  });

  it('falls back only when the household records no rate at all, and says so', () => {
    const none = runNetWorthForecast(netWorthInput({ liabilityRatePercent: null }));
    expect(none.explanations.some((e) => (e.explanationText ?? '').includes('a default rate, because no interest rate is recorded'))).toBe(true);
  });

  it('names the rate it used in the narrative, instead of "the standard reducing-balance formula"', () => {
    const nw = runNetWorthForecast(netWorthInput({ liabilityRatePercent: 3.2 }));
    const narrative = nw.explanations.map((e) => e.explanationText ?? '').join(' ');
    expect(narrative).toContain('3.2% p.a.');
    expect(narrative).toContain('your own recorded loan rates, weighted by balance');
  });
});

describe('Net Worth — the per-period movement columns reconcile to closingValue', () => {
  it('opening + contributions + investmentReturn + interest + otherMovement === closing', () => {
    const { results } = runNetWorthForecast(
      netWorthInput({
        openingAssets: 50000,
        monthlyAssetContribution: 500,
        liabilityRatePercent: 6,
      })
    );
    for (const r of results) {
      const reconstructed = r.openingValue + r.contributions + r.investmentReturn + r.interest + r.otherMovement - r.withdrawals;
      expect(reconstructed, `period ${r.periodNumber} movements must sum to closingValue`).toBeCloseTo(r.closingValue, 1);
    }
  });

  it('records interest as a reduction and the repayment as the offsetting movement', () => {
    const { results } = runNetWorthForecast(netWorthInput({ liabilityRatePercent: 6 }));
    const first = results[0];
    expect(first.interest).toBeCloseTo(-500, 2); // 100,000 x 6% / 12
    expect(first.otherMovement).toBeCloseTo(1000, 2); // the repayment
    // -500 + 1000 = +500 = principalReduction, the loan leg's true effect on
    // net worth. Before the fix this pair summed to -1,000.
    expect(first.interest + first.otherMovement).toBeCloseTo(500, 2);
  });
});

// ---------------------------------------------------------------------------
// Found and reported, NOT changed on this branch — each needs a product
// decision, not a bug fix. Pinned here so the response document's claims are
// reproducible and so the current behaviour is explicit rather than assumed.
// ---------------------------------------------------------------------------

describe('Goals — findings reported for Product Owner decision (current behaviour pinned)', () => {
  it('a zero-target goal currently reports "already reached its target amount"', () => {
    const { explanations } = runGoalForecast({
      baselineDate: '2026-09-01',
      months: 12,
      assumptions: NO_ASSUMPTIONS,
      goals: [{ id: 'g1', name: 'Untargeted goal', currentAmount: 0, targetAmount: 0, targetDate: null, monthlyContribution: 100, currency: 'AUD' }],
    });
    // goalCalculator.ts's `balance >= goal.targetAmount ? 0 : null` is true for
    // 0 >= 0. The row-level variancePercentage IS guarded on targetAmount > 0;
    // this completion check is not. Reported, not fixed: whether a goal may
    // exist with no target at all is a product question.
    expect(explanations[0].explanationText).toContain('already reached its target amount');
  });

  it('an overdue goal loses its required-contribution advice', () => {
    const { explanations } = runGoalForecast({
      baselineDate: '2026-09-01',
      months: 12,
      assumptions: NO_ASSUMPTIONS,
      goals: [{ id: 'g2', name: 'Overdue goal', currentAmount: 1000, targetAmount: 50000, targetDate: '2020-01-01', monthlyContribution: 100, currency: 'AUD' }],
    });
    // monthsToTargetDate is negative, so requiredContribution is null and the
    // gap clause never renders. Reported, not fixed.
    expect(explanations[0].explanationText).not.toContain('required monthly contribution');
  });
});
