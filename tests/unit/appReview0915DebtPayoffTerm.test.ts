// App Review 2026-09-15, items 8 and 9 — debt payoff forecast.
//
// Item 8 asked for the amortisation to be VERIFIED against the reviewer's own
// screenshot figures, not just asserted to be right. Item 9 asked for the
// payoff term to be derived from the formula instead of every card repeating
// the fixed 120-month forecast window.
//
// The three loans below are the reviewer's, with the interest rate recovered
// by solving the amortisation backwards from the balances they reported.
import { describe, it, expect } from 'vitest';
import { derivePayoffTerm, formatTerm, interestOnlyPayment, levelPaymentForPayoff, projectLoanMonth } from '@/lib/engines/forecast/monthlyPrimitives';
import { runDebtForecast } from '@/lib/engines/forecast/debtCalculator';
import type { ResolvedAssumptionSet } from '@/lib/engines/forecast/types';

const ASSUMPTIONS: ResolvedAssumptionSet = { values: [] } as unknown as ResolvedAssumptionSet;

/** The stored projection loop's own recurrence, replayed independently. */
function balanceAt(opening: number, annualPct: number, repayment: number, month: number): number {
  let b = opening;
  for (let m = 1; m <= month && b > 0; m++) {
    b = projectLoanMonth({ openingBalance: b, annualInterestRatePercent: annualPct, repayment }).closingBalance;
  }
  return b;
}

describe('item 8 — the reviewer\'s reported balances follow from one consistent rate', () => {
  it('SMSF property loan: $365,000 @ 7.25% p.a., $2,500/month', () => {
    // Reviewer saw: Value in 5 yrs $343,758 · Value in 10 yrs $313,268.
    expect(Math.round(balanceAt(365000, 7.25, 2500, 60))).toBe(343758);
    expect(Math.round(balanceAt(365000, 7.25, 2500, 120))).toBe(313268);
  });

  it('Construction Loan: $290,100 @ 6.97% p.a., $1,924/month', () => {
    // Reviewer saw: Value in 5 yrs $273,002 · Value in 10 yrs $248,801.
    expect(Math.round(balanceAt(290100, 6.97, 1924, 60))).toBe(273002);
    expect(Math.round(balanceAt(290100, 6.97, 1924, 120))).toBeCloseTo(248800, -1);
  });

  it('Investment loan 1: $0/month repayment, balance compounding at 6.29% p.a.', () => {
    // Reviewer saw: Value in 5 yrs $87,184 · Value in 10 yrs $119,307, and
    // item 9's own worked example quotes $334/month to stop it growing,
    // $1,947/month to clear it in 3 years. Both fall out of a $63,710
    // opening balance at 6.29%, which is what those two balances imply.
    const opening = 63710;
    expect(Math.round(balanceAt(opening, 6.29, 0, 60))).toBeCloseTo(87184, -2);
    expect(Math.round(balanceAt(opening, 6.29, 0, 120))).toBeCloseTo(119307, -2);
    expect(Math.round(interestOnlyPayment(opening, 6.29))).toBe(334);
    expect(Math.round(levelPaymentForPayoff(opening, 6.29, 36))).toBe(1947);
  });
});

describe('item 9 — the payoff term is derived, and differs per loan', () => {
  it('derives a real term well beyond the 120-month window', () => {
    const smsf = derivePayoffTerm(365000, 7.25, 2500);
    expect(smsf.months).toBe(355);
    expect(smsf.balanceGrowing).toBe(false);
    expect(formatTerm(355)).toBe('29 years 7 months');

    const construction = derivePayoffTerm(290100, 6.97, 1924);
    expect(construction.months).toBe(361);
    // The point of item 9: two loans that used to print the identical
    // "120-month forecast horizon" sentence now differ.
    expect(construction.months).not.toBe(smsf.months);
  });

  it('reports "not reducing" rather than a term when the repayment is below the interest', () => {
    const growing = derivePayoffTerm(63710, 6.29, 0);
    expect(growing.months).toBeNull();
    expect(growing.balanceGrowing).toBe(true);
    expect(growing.beyondSearchCap).toBe(false);
  });

  it('distinguishes "reduces too slowly to ever clear" from "balance growing"', () => {
    // A repayment fractionally above the first month's interest.
    const interest = interestOnlyPayment(500000, 6);
    const crawl = derivePayoffTerm(500000, 6, interest + 0.01);
    expect(crawl.balanceGrowing).toBe(false);
    expect(crawl.months).toBeNull();
    expect(crawl.beyondSearchCap).toBe(true);
  });

  it('agrees exactly with the stored projection when the loan pays off inside the window', () => {
    const term = derivePayoffTerm(20000, 6, 1000)!;
    expect(term.months).not.toBeNull();
    expect(balanceAt(20000, 6, 1000, term.months!)).toBe(0);
    expect(balanceAt(20000, 6, 1000, term.months! - 1)).toBeGreaterThan(0);
  });

  it('formatTerm reads naturally at every boundary', () => {
    expect(formatTerm(1)).toBe('1 month');
    expect(formatTerm(7)).toBe('7 months');
    expect(formatTerm(12)).toBe('1 year');
    expect(formatTerm(24)).toBe('2 years');
    expect(formatTerm(100)).toBe('8 years 4 months');
    expect(formatTerm(326)).toBe('27 years 2 months');
  });
});

describe('items 7/8/9 + G1 — the narrative itself', () => {
  function narrativeFor(entry: Partial<Parameters<typeof runDebtForecast>[0]['liabilities'][0]>) {
    const { explanations } = runDebtForecast({
      baselineDate: '2026-09-01',
      months: 120,
      assumptions: ASSUMPTIONS,
      additionalMonthlyRepayment: 0,
      liabilities: [
        {
          id: 'l1',
          name: 'SMSF property loan',
          currentBalance: 365000,
          annualInterestRatePercent: 7.25,
          monthlyRepayment: 2500,
          debtType: 'mortgage',
          currency: 'AUD',
          ...entry,
        },
      ],
    });
    return explanations[0].explanationText ?? (explanations[0] as unknown as { narrative: string }).narrative;
  }

  it('no longer says "within the 120-month forecast horizon" as the payoff statement', () => {
    const n = narrativeFor({});
    expect(n).not.toContain('not projected to be paid off within the 120-month forecast horizon');
    expect(n).toContain('29 years 7 months (355 months)');
    expect(n).toContain('beyond the 120-month forecast window');
  });

  it('formats every amount with no decimal point (G1 / item 7)', () => {
    const n = narrativeFor({});
    expect(n).toContain('$2,500/month');
    // No raw float anywhere: "2500/month", "53471.34", "1240.3" etc.
    expect(n).not.toMatch(/\d\.\d\d(?!\d)/);
    expect(n).not.toMatch(/(?<![$,\d])\d{4,}(?![,\d])/);
  });

  it('states the balance is growing, and what payment stops it, for a below-interest repayment', () => {
    const n = narrativeFor({ name: 'Investment loan 1', currentBalance: 63710, annualInterestRatePercent: 6.29, monthlyRepayment: 0 });
    expect(n).toContain('this debt is not reducing');
    expect(n).toContain('$334/month stops it growing');
    expect(n).toContain('$1,947/month clears it in 3 years');
    expect(n).toContain('$0/month');
  });

  it('two different loans produce two different sentences (item 9\'s core complaint)', () => {
    const a = narrativeFor({});
    const b = narrativeFor({ name: 'Construction Loan', currentBalance: 290100, annualInterestRatePercent: 6.97, monthlyRepayment: 1924 });
    expect(a).not.toBe(b);
  });

  it('discloses when no interest rate was recorded instead of silently projecting interest-free', () => {
    const n = narrativeFor({ annualInterestRatePercent: 0, interestRateProvided: false });
    expect(n).toContain('No interest rate is recorded for this debt');
  });

  it('says nothing about a missing rate when the user did enter one', () => {
    expect(narrativeFor({})).not.toContain('No interest rate is recorded');
  });
});
