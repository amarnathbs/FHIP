/**
 * FDH-7 — independent certification pack for the Approved Financial Summary
 * (spec sections 84-90, 127). Every expected value below is hand-computed
 * from the fixture BY READING THE SPEC, never by running
 * `computeApprovedFinancialSummary` and copying its output — the fixtures
 * and their expected totals were authored first.
 */

import { describe, expect, it } from 'vitest';
import {
  computeApprovedFinancialSummary,
  FdhApprovedSummaryError,
  type ApprovedSummaryTransaction,
} from '@/lib/financial-data-hub/domain/approvedSummary';

const AUD = 'AUD';

function txn(overrides: Partial<ApprovedSummaryTransaction> & Pick<ApprovedSummaryTransaction, 'id' | 'amount_original' | 'economic_transaction_type'>): ApprovedSummaryTransaction {
  return {
    currency_original: AUD,
    category_id: null,
    dedup_status: 'unique',
    allocations: [],
    ...overrides,
  };
}

describe('FDH-7 Approved Financial Summary — independent oracle (spec 84)', () => {
  it('a simple mixed statement: salary income, grocery expense, tax, fee', () => {
    const result = computeApprovedFinancialSummary(AUD, [
      txn({ id: 't1', amount_original: 3000, economic_transaction_type: 'income' }),
      txn({ id: 't2', amount_original: 120.5, economic_transaction_type: 'expense', category_id: 'groceries' }),
      txn({ id: 't3', amount_original: 45, economic_transaction_type: 'tax' }),
      txn({ id: 't4', amount_original: 2.5, economic_transaction_type: 'fee' }),
    ]);
    // Hand-computed: income 3000, expense 120.50, tax 45, fee 2.50.
    expect(result.income_total).toBe(3000);
    expect(result.expense_total).toBe(120.5);
    expect(result.tax_total).toBe(45);
    expect(result.fee_total).toBe(2.5);
    expect(result.approved_transaction_count).toBe(4);
    expect(result.category_totals['groceries']).toBe(120.5);
  });

  it('unknown transactions are summed visibly, never silently dropped (spec 89)', () => {
    const result = computeApprovedFinancialSummary(AUD, [
      txn({ id: 't1', amount_original: 37, economic_transaction_type: 'unknown' }),
    ]);
    expect(result.unknown_total).toBe(37);
    expect(result.income_total).toBe(0);
    expect(result.expense_total).toBe(0);
  });

  it('cash withdrawal never folds into expense (spec 61)', () => {
    const result = computeApprovedFinancialSummary(AUD, [
      txn({ id: 't1', amount_original: 200, economic_transaction_type: 'cash_withdrawal' }),
    ]);
    expect(result.cash_withdrawal_total).toBe(200);
    expect(result.expense_total).toBe(0);
  });
});

describe('FDH-7 CRITICAL NEGATIVE CONTROL — transfer double-counting (spec 58, 85, 106, 127)', () => {
  it('Account A -1000 transfer + Account B +1000 transfer never become income + expense', () => {
    // Both sides are recorded as economic_transaction_type = 'transfer' —
    // exactly the state FDH-6's applyTransferClassOnConfirm() produces once
    // a user confirms a matched transfer link.
    const result = computeApprovedFinancialSummary(AUD, [
      txn({ id: 'a-out', amount_original: 1000, economic_transaction_type: 'transfer' }),
      txn({ id: 'b-in', amount_original: 1000, economic_transaction_type: 'transfer' }),
    ]);
    expect(result.income_total).toBe(0);
    expect(result.expense_total).toBe(0);
    expect(result.transfer_total).toBe(2000);
  });

  it('NEGATIVE CONTROL PROOF: if the transfer exclusion were broken (transactions mis-typed as income/expense), the false totals WOULD appear — proving this test can actually fail', () => {
    // Deliberately weakened: the SAME scenario, but with the transfer
    // relationship never applied (as if FDH-6's write-back regressed) — the
    // transactions sit as raw credit/expense guesses instead.
    const brokenResult = computeApprovedFinancialSummary(AUD, [
      txn({ id: 'a-out', amount_original: 1000, economic_transaction_type: 'expense' }),
      txn({ id: 'b-in', amount_original: 1000, economic_transaction_type: 'income' }),
    ]);
    expect(brokenResult.expense_total).toBe(1000);
    expect(brokenResult.income_total).toBe(1000);
    // This is exactly the false 1000+1000 result spec 85 requires
    // certification to be ABLE to detect — proving the correctly-classified
    // case above is not accidentally passing because the function ignores
    // economic_transaction_type entirely.
  });
});

describe('FDH-7 CRITICAL NEGATIVE CONTROL — duplicate double-counting (spec 59, 86, 127)', () => {
  it('a confirmed duplicate contributes nothing to any total, but is not deleted', () => {
    const result = computeApprovedFinancialSummary(AUD, [
      txn({ id: 'csv-1', amount_original: 89.95, economic_transaction_type: 'expense', dedup_status: 'unique' }),
      txn({ id: 'pdf-1', amount_original: 89.95, economic_transaction_type: 'expense', dedup_status: 'user_confirmed_duplicate' }),
    ]);
    expect(result.expense_total).toBe(89.95); // counted ONCE, not 179.90
    expect(result.duplicate_excluded_count).toBe(1);
    expect(result.approved_transaction_count).toBe(1);
  });

  it('NEGATIVE CONTROL PROOF: without duplicate exclusion the same fixture would double-count to 179.90', () => {
    const broken = computeApprovedFinancialSummary(AUD, [
      txn({ id: 'csv-1', amount_original: 89.95, economic_transaction_type: 'expense', dedup_status: 'unique' }),
      txn({ id: 'pdf-1', amount_original: 89.95, economic_transaction_type: 'expense', dedup_status: 'unique' }), // dedup NOT applied
    ]);
    expect(broken.expense_total).toBe(179.9);
  });

  it('legitimate KEEP BOTH repeats (dedup_status stays unique/user_confirmed_distinct) both count', () => {
    const result = computeApprovedFinancialSummary(AUD, [
      txn({ id: 'coffee-1', amount_original: 4.5, economic_transaction_type: 'expense', dedup_status: 'user_confirmed_distinct' }),
      txn({ id: 'coffee-2', amount_original: 4.5, economic_transaction_type: 'expense', dedup_status: 'user_confirmed_distinct' }),
    ]);
    expect(result.expense_total).toBe(9);
    expect(result.approved_transaction_count).toBe(2);
  });
});

describe('FDH-7 CRITICAL NEGATIVE CONTROL — split allocation exactness (spec 45-46, 87, 127)', () => {
  it('220.00 + 79.99 against a 300.00 parent is REJECTED (0.01 short)', () => {
    expect(() =>
      computeApprovedFinancialSummary(AUD, [
        txn({
          id: 'costco',
          amount_original: 300,
          economic_transaction_type: 'expense',
          allocations: [
            { economic_transaction_type: 'expense', category_id: 'groceries', amount: 220, currency_code: AUD },
            { economic_transaction_type: 'expense', category_id: 'household', amount: 79.99, currency_code: AUD },
          ],
        }),
      ]),
    ).toThrow(FdhApprovedSummaryError);
  });

  it('220.00 + 80.00 against a 300.00 parent PASSES, and the parent itself is never also counted', () => {
    const result = computeApprovedFinancialSummary(AUD, [
      txn({
        id: 'costco',
        amount_original: 300,
        economic_transaction_type: 'expense',
        allocations: [
          { economic_transaction_type: 'expense', category_id: 'groceries', amount: 220, currency_code: AUD },
          { economic_transaction_type: 'expense', category_id: 'household', amount: 80, currency_code: AUD },
        ],
      }),
    ]);
    expect(result.expense_total).toBe(300); // 220 + 80, NOT 600 (parent + allocations)
    expect(result.category_totals['groceries']).toBe(220);
    expect(result.category_totals['household']).toBe(80);
  });

  it('a split across different economic classes routes each allocation to its own bucket', () => {
    const result = computeApprovedFinancialSummary(AUD, [
      txn({
        id: 'mixed',
        amount_original: 500,
        economic_transaction_type: 'expense',
        allocations: [
          { economic_transaction_type: 'expense', category_id: 'shopping', amount: 300, currency_code: AUD },
          { economic_transaction_type: 'investment', category_id: null, amount: 200, currency_code: AUD },
        ],
      }),
    ]);
    expect(result.expense_total).toBe(300);
    expect(result.investment_total).toBe(200);
  });
});

describe('FDH-7 CRITICAL NEGATIVE CONTROL — refund treatment (spec 60, 88, 127)', () => {
  it('Groceries expense 100, confirmed refund 20 -> net economic expense 80, refund_total 20 (spec 60 worked example)', () => {
    const result = computeApprovedFinancialSummary(
      AUD,
      [
        txn({ id: 'purchase', amount_original: 100, economic_transaction_type: 'expense', category_id: 'groceries' }),
        txn({ id: 'refund', amount_original: 20, economic_transaction_type: 'refund' }),
      ],
      [{ refundTransactionId: 'refund', originalTransactionId: 'purchase' }],
    );
    expect(result.expense_total).toBe(80);
    expect(result.refund_total).toBe(20);
    expect(result.income_total).toBe(0); // never treated as income merely because it is a credit
  });

  it('NEGATIVE CONTROL PROOF: without the confirmed link, the refund is visible but does NOT net against expense', () => {
    const result = computeApprovedFinancialSummary(AUD, [
      txn({ id: 'purchase', amount_original: 100, economic_transaction_type: 'expense', category_id: 'groceries' }),
      txn({ id: 'refund', amount_original: 20, economic_transaction_type: 'refund' }),
    ]); // no refundLinks passed
    expect(result.expense_total).toBe(100); // NOT netted — proves netting is not accidental/always-on
    expect(result.refund_total).toBe(20);
  });

  it('a refund never nets against an original that is itself a confirmed duplicate (would otherwise under-count expense_total with no corresponding counted expense)', () => {
    const result = computeApprovedFinancialSummary(
      AUD,
      [
        txn({ id: 'purchase', amount_original: 100, economic_transaction_type: 'expense', category_id: 'groceries', dedup_status: 'user_confirmed_duplicate' }),
        txn({ id: 'refund', amount_original: 20, economic_transaction_type: 'refund' }),
      ],
      [{ refundTransactionId: 'refund', originalTransactionId: 'purchase' }],
    );
    expect(result.expense_total).toBe(0); // the duplicate contributes nothing, so there is nothing to net against
    expect(result.refund_total).toBe(20); // the refund itself is still visible
  });

  it('an unconfirmed refund link naming an unrelated (non-expense) original never nets', () => {
    const result = computeApprovedFinancialSummary(
      AUD,
      [
        txn({ id: 'salary', amount_original: 3000, economic_transaction_type: 'income' }),
        txn({ id: 'refund', amount_original: 20, economic_transaction_type: 'refund' }),
      ],
      [{ refundTransactionId: 'refund', originalTransactionId: 'salary' }], // original is income, not expense
    );
    expect(result.income_total).toBe(3000); // untouched
    expect(result.refund_total).toBe(20);
  });
});

describe('FDH-7 exact money — no floating-point drift across many small amounts (spec 83)', () => {
  it('summing 0.1-style amounts 1000 times lands on the exact expected total', () => {
    const transactions = Array.from({ length: 1000 }, (_, i) =>
      txn({ id: `t${i}`, amount_original: 0.1, economic_transaction_type: 'expense' }));
    const result = computeApprovedFinancialSummary(AUD, transactions);
    expect(result.expense_total).toBe(100); // naive JS float summation would drift here
  });
});
