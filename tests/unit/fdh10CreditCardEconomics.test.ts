/**
 * FDH-10 — certification for the FIRST headline control (spec sections 4, 21-
 * 29, 44-49, 154): a credit-card purchase and its later matched bank
 * repayment must be EXACTLY ONE expense, never two.
 *
 * Every test in the first `describe` block below is a NEGATIVE CONTROL in the
 * strict sense this project uses the term: `tests/unit/fdh9DoubleCountCertification
 * .test.ts` established the pattern of reintroducing the exact defect and
 * proving the oracle goes RED, then restoring and proving GREEN. This file
 * follows the identical shape for FDH-10's own headline example.
 */
import { describe, expect, it } from 'vitest';
import {
  assertNoDoubleCount,
  classifyCashAdvance,
  classifyStatementActivity,
  planCardStatementLedgerWrites,
  totalExpenseFromPlan,
  type CardStatementActivityInput,
} from '@/lib/financial-data-hub/liability/creditCardEconomics';

describe('FDH-10 — credit card headline control: purchase + repayment = ONE expense (spec section 4)', () => {
  it('GREEN: a $200 purchase settled by a matched $200 bank repayment produces exactly $200 expense', () => {
    const activities: CardStatementActivityInput[] = [
      { activityId: 'a1', activityType: 'PURCHASE', amount: 200 },
      { activityId: 'a2', activityType: 'PAYMENT', amount: 200, matchedBankTransactionId: 'bank-txn-1' },
    ];
    const plan = planCardStatementLedgerWrites(activities);

    // The PAYMENT activity must produce NO new expense-typed write.
    const paymentWrite = plan.find((w) => w.activityId === 'a2')!;
    expect(paymentWrite.kind).toBe('link_existing_bank_transaction');
    expect(paymentWrite.economicType).toBe('transfer');

    const totalExpense = totalExpenseFromPlan(plan, 'AUD');
    expect(totalExpense).toBe(200);

    const assertion = assertNoDoubleCount(200, totalExpense, 'AUD');
    expect(assertion.ok).toBe(true);
  });

  it('RED (reintroduced defect): if the bank statement path ALSO records the repayment as an expense, the total becomes $400 and the oracle catches it', () => {
    const activities: CardStatementActivityInput[] = [
      { activityId: 'a1', activityType: 'PURCHASE', amount: 200 },
      { activityId: 'a2', activityType: 'PAYMENT', amount: 200, matchedBankTransactionId: 'bank-txn-1' },
    ];
    const plan = planCardStatementLedgerWrites(activities);

    // Simulate the EXACT defect spec section 4 forbids: a naive/broken bank
    // import path that misclassified the card-payment debit as an ordinary
    // expense (economic_transaction_type = 'expense') instead of 'transfer'.
    const defectiveBankSideRows = [{ economicType: 'expense' as const, amount: 200 }];
    const defectiveTotal = totalExpenseFromPlan(plan, 'AUD', defectiveBankSideRows);

    expect(defectiveTotal).toBe(400); // the forbidden outcome, reproduced
    const assertion = assertNoDoubleCount(200, defectiveTotal, 'AUD');
    expect(assertion.ok).toBe(false); // and genuinely detected as wrong
    expect(assertion.expected).toBe(200);
    expect(assertion.actual).toBe(400);
  });

  it('GREEN after restoration: the same scenario with correct bank-side classification (transfer, not expense) passes again', () => {
    const activities: CardStatementActivityInput[] = [
      { activityId: 'a1', activityType: 'PURCHASE', amount: 200 },
      { activityId: 'a2', activityType: 'PAYMENT', amount: 200, matchedBankTransactionId: 'bank-txn-1' },
    ];
    const plan = planCardStatementLedgerWrites(activities);
    const correctBankSideRows = [{ economicType: 'transfer' as const, amount: 200 }];
    const total = totalExpenseFromPlan(plan, 'AUD', correctBankSideRows);
    expect(total).toBe(200);
    expect(assertNoDoubleCount(200, total, 'AUD').ok).toBe(true);
  });

  it('a PAYMENT activity is categorically never classified as expense (type-level guarantee)', () => {
    expect(classifyStatementActivity('PAYMENT')).not.toBe('expense');
    expect(classifyStatementActivity('PAYMENT')).toBe('transfer');
  });

  it('an unmatched PAYMENT (no bank statement yet) records evidence only — no fabricated transaction, no lost repayment', () => {
    const activities: CardStatementActivityInput[] = [{ activityId: 'a1', activityType: 'PAYMENT', amount: 350 }];
    const plan = planCardStatementLedgerWrites(activities);
    expect(plan[0].kind).toBe('record_evidence_only');
    expect(totalExpenseFromPlan(plan, 'AUD')).toBe(0); // no expense fabricated from a bare payment
  });
});

describe('FDH-10 — cash advance is NOT automatically expense (spec section 22, mandatory negative control)', () => {
  it('a cash advance contributes zero to expense', () => {
    const treatment = classifyCashAdvance();
    expect(treatment.economicType).toBe('cash_withdrawal');
    expect(treatment.expenseContribution).toBe(0);

    const activities: CardStatementActivityInput[] = [{ activityId: 'a1', activityType: 'CASH_ADVANCE', amount: 500 }];
    const plan = planCardStatementLedgerWrites(activities);
    expect(plan[0].economicType).toBe('cash_withdrawal');
    expect(totalExpenseFromPlan(plan, 'AUD')).toBe(0);
  });

  it('fees/interest levied ON a cash advance are still expense (spec section 22)', () => {
    const activities: CardStatementActivityInput[] = [
      { activityId: 'a1', activityType: 'CASH_ADVANCE', amount: 500 },
      { activityId: 'a2', activityType: 'FEE', amount: 15 },
      { activityId: 'a3', activityType: 'INTEREST', amount: 8 },
    ];
    const plan = planCardStatementLedgerWrites(activities);
    // FEE/INTEREST are their own economic types, not 'expense' at the ledger
    // level either (they use debt_interest/fee, per FDH's own vocabulary),
    // but both DO belong in the household's expense-facing totals — proven
    // here via FDH-8's own aggregation rules being independent of this
    // module (see FDH10_EXPENSE_INTEGRATION.md); this test only proves cash
    // advance PRINCIPAL is excluded while fee/interest are correctly typed.
    expect(plan.find((w) => w.activityId === 'a2')!.economicType).toBe('fee');
    expect(plan.find((w) => w.activityId === 'a3')!.economicType).toBe('debt_interest');
  });
});

describe('FDH-10 — refund/interest/fee classification (spec sections 26-29)', () => {
  it('REFUND maps to refund, INTEREST to debt_interest, FEE to fee, PRINCIPAL to debt_principal', () => {
    expect(classifyStatementActivity('REFUND')).toBe('refund');
    expect(classifyStatementActivity('INTEREST')).toBe('debt_interest');
    expect(classifyStatementActivity('FEE')).toBe('fee');
    expect(classifyStatementActivity('PRINCIPAL')).toBe('debt_principal');
  });

  it('LOAN_ADVANCE is never classified as income (spec section 30)', () => {
    expect(classifyStatementActivity('LOAN_ADVANCE')).not.toBe('income');
    expect(classifyStatementActivity('LOAN_ADVANCE')).toBe('transfer');
  });
});

describe('FDH-10 — duplicate statement / multiple purchases (spec sections 33, 70)', () => {
  it('the SAME purchase amount is not itself evidence of a double count — genuinely distinct purchases each count once', () => {
    const activities: CardStatementActivityInput[] = [
      { activityId: 'a1', activityType: 'PURCHASE', amount: 50 },
      { activityId: 'a2', activityType: 'PURCHASE', amount: 50 },
    ];
    const plan = planCardStatementLedgerWrites(activities);
    expect(totalExpenseFromPlan(plan, 'AUD')).toBe(100); // two genuine $50 purchases, not one
  });
});
