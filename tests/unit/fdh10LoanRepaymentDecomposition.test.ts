/**
 * FDH-10 — certification for the SECOND headline control (spec sections 5,
 * 30-38, 154): a $2,000 loan payment disclosed as principal $1,550 +
 * interest $430 + fee $20 must decompose to EXACTLY $1,550 liability
 * reduction + $450 expense + $2,000 cash outflow — never $2,450, never
 * $2,000 flat expense.
 */
import { describe, expect, it } from 'vitest';
import {
  classifyLoanAdvance,
  decomposeLoanPayment,
} from '@/lib/financial-data-hub/liability/repaymentDecomposition';

describe('FDH-10 — loan headline control: repayment decomposition (spec section 5)', () => {
  it('GREEN: $2,000 payment / $1,550 principal / $430 interest / $20 fee decomposes exactly', () => {
    const result = decomposeLoanPayment({
      totalPayment: 2000,
      principalComponent: 1550,
      interestComponent: 430,
      feeComponent: 20,
      currencyCode: 'AUD',
    });

    expect(result.outcome).toBe('decomposed');
    expect(result.liabilityReductionTotal).toBe(1550);
    expect(result.expenseTotal).toBe(450); // 430 + 20 — principal excluded
    expect(result.allocations).toEqual(
      expect.arrayContaining([
        { economicType: 'debt_principal', amount: 1550 },
        { economicType: 'debt_interest', amount: 430 },
        { economicType: 'fee', amount: 20 },
      ]),
    );
    // The forbidden outcomes, explicitly disproven:
    expect(result.expenseTotal).not.toBe(2000); // never the full payment as expense
    expect(result.expenseTotal! + result.liabilityReductionTotal!).not.toBe(2450); // never double-counted
    expect(result.expenseTotal! + result.liabilityReductionTotal!).toBe(2000); // sums to the real cash outflow
  });

  it('RED (reintroduced defect) then GREEN (restored): component mismatch is genuinely detected', () => {
    // Defect: statement components do not actually sum to the payment
    // (e.g. an extraction bug dropped the fee line).
    const defective = decomposeLoanPayment({
      totalPayment: 2000,
      principalComponent: 1550,
      interestComponent: 430,
      // feeComponent omitted/lost — sums to 1980, not 2000
      currencyCode: 'AUD',
    });
    expect(defective.outcome).toBe('component_mismatch');
    expect(defective.allocations).toHaveLength(0);
    expect(defective.expenseTotal).toBeNull();
    expect(defective.liabilityReductionTotal).toBeNull();

    // Restored: correct evidence decomposes cleanly again.
    const restored = decomposeLoanPayment({
      totalPayment: 2000, principalComponent: 1550, interestComponent: 430, feeComponent: 20, currencyCode: 'AUD',
    });
    expect(restored.outcome).toBe('decomposed');
  });

  it('never treats the full payment as expense when evidence is insufficient (spec section 5 forbidden outcome applies regardless of evidence)', () => {
    const result = decomposeLoanPayment({ totalPayment: 2000, currencyCode: 'AUD' });
    expect(result.outcome).toBe('insufficient_evidence');
    expect(result.expenseTotal).toBeNull(); // NEVER defaults to totalPayment (2000)
    expect(result.liabilityReductionTotal).toBeNull();
  });

  it('interest-only payment: 100% of the payment is expense, $0 liability reduction', () => {
    const result = decomposeLoanPayment({ totalPayment: 300, interestComponent: 300, currencyCode: 'AUD' });
    expect(result.outcome).toBe('decomposed');
    expect(result.expenseTotal).toBe(300);
    expect(result.liabilityReductionTotal).toBe(0);
  });

  it('EMI-style principal+interest split with no fee line', () => {
    const result = decomposeLoanPayment({ totalPayment: 25000, principalComponent: 18000, interestComponent: 7000, currencyCode: 'INR' });
    expect(result.outcome).toBe('decomposed');
    expect(result.liabilityReductionTotal).toBe(18000);
    expect(result.expenseTotal).toBe(7000);
  });

  it('0.01 mismatch is genuinely detected, not rounded away', () => {
    const result = decomposeLoanPayment({
      totalPayment: 2000, principalComponent: 1550, interestComponent: 430, feeComponent: 20.01, currencyCode: 'AUD',
    });
    expect(result.outcome).toBe('component_mismatch');
  });
});

describe('FDH-10 — loan drawdown is NOT income (spec section 30, mandatory negative control)', () => {
  it('a $50,000 drawdown contributes exactly $0 to income', () => {
    const classification = classifyLoanAdvance(50000);
    expect(classification.economicType).toBe('transfer');
    expect(classification.incomeContribution).toBe(0);
    expect(classification.liabilityIncrease).toBe(50000);
    // Type-level guarantee: 'income' is not a member of LoanAdvanceEconomicType
    // at all, so this is not merely a runtime check — see the module's own
    // type declaration.
  });

  it('rejects a non-positive drawdown amount rather than silently producing a nonsensical classification', () => {
    expect(() => classifyLoanAdvance(0)).toThrow();
    expect(() => classifyLoanAdvance(-100)).toThrow();
  });
});

describe('FDH-10 — interest is never mistaken for principal (spec section 32, mandatory negative control)', () => {
  it('an interest-heavy payment never reduces the liability by more than its disclosed principal component', () => {
    // A $2,000 payment where interest ($1,900) dwarfs principal ($100) — the
    // liability reduction must still be exactly $100, not some blended or
    // interest-inflated figure.
    const result = decomposeLoanPayment({ totalPayment: 2000, principalComponent: 100, interestComponent: 1900, currencyCode: 'AUD' });
    expect(result.liabilityReductionTotal).toBe(100);
    expect(result.expenseTotal).toBe(1900);
  });
});
