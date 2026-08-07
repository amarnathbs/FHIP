import { describe, it, expect } from 'vitest';
import { interestOnlyPayment, levelPaymentForPayoff, projectLoanMonth } from '@/lib/engines/forecast/monthlyPrimitives';

describe('interestOnlyPayment', () => {
  it('computes the interest-only "cure payment" for a balance and rate', () => {
    // 100000 * 6% / 12 = 500
    expect(interestOnlyPayment(100000, 6)).toBe(500);
  });

  it('adds fees on top of the interest component', () => {
    expect(interestOnlyPayment(100000, 6, 25)).toBe(525);
  });

  it('matches the interest component projectLoanMonth would compute for the same inputs', () => {
    const month = projectLoanMonth({ openingBalance: 50000, annualInterestRatePercent: 8, repayment: 0 });
    expect(interestOnlyPayment(50000, 8)).toBe(month.interest);
  });
});

describe('levelPaymentForPayoff', () => {
  it('computes the standard level payment (PMT) to clear a balance in N months', () => {
    // Standard PMT formula: r*PV / (1 - (1+r)^-n), r=6%/12=0.5%, PV=100000, n=36
    const payment = levelPaymentForPayoff(100000, 6, 36);
    expect(payment).toBeCloseTo(3042.19, 1);
  });

  it('a level payment that clears a balance over more months is smaller than over fewer months', () => {
    const payment3yr = levelPaymentForPayoff(100000, 6, 36);
    const payment5yr = levelPaymentForPayoff(100000, 6, 60);
    expect(payment5yr).toBeLessThan(payment3yr);
  });

  it('paying the computed level payment actually clears the balance within the target month, within rounding', () => {
    const balance = 50000;
    const rate = 7.5;
    const months = 24;
    const payment = levelPaymentForPayoff(balance, rate, months);
    let remaining = balance;
    for (let m = 0; m < months; m++) {
      const month = projectLoanMonth({ openingBalance: remaining, annualInterestRatePercent: rate, repayment: payment });
      remaining = month.closingBalance;
    }
    expect(remaining).toBeLessThan(1); // fully amortised, modulo cent-level rounding
  });

  it('returns 0 for an already-paid-off balance', () => {
    expect(levelPaymentForPayoff(0, 6, 36)).toBe(0);
  });

  it('divides evenly when the rate is 0', () => {
    expect(levelPaymentForPayoff(12000, 0, 12)).toBe(1000);
  });
});
