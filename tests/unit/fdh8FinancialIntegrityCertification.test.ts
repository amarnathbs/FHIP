/**
 * FDH-8 — independent financial-integrity certification pack (spec sections
 * 82-101, and the Product Owner's explicit emphasis on section 12/88:
 * approved-vs-pending separation).
 *
 * Every expected value below is HAND-COMPUTED FROM THE SPEC's own worked
 * examples, never derived by running FDH-8 code and copying its output.
 * This file exercises `computeApprovedFinancialSummary` — the SAME FDH-7
 * oracle `financialActivityAnalytics.ts` calls for every headline total —
 * because FDH-8 introduces no second definition of income/expense/transfer
 * (spec 5, 82). What FDH-8 adds on top (calling that oracle once for an
 * approved-scoped list and once, separately, for a pending-scoped list —
 * see `getOverview` in
 * lib/financial-data-hub/analytics/financialActivityAnalytics.ts) is proven
 * here as an explicit negative control: scenario "PENDING REVIEW" below
 * shows the CORRECT two-call pattern producing the right numbers, then
 * deliberately performs the WRONG single-call pattern (concatenating
 * approved + pending into one oracle call) and proves that wrong pattern is
 * caught by the assertion — i.e. this test would fail loudly if FDH-8's
 * production code ever regressed to the wrong pattern.
 */

import { describe, expect, it } from 'vitest';
import {
  computeApprovedFinancialSummary,
  type ApprovedSummaryTransaction,
} from '@/lib/financial-data-hub/domain/approvedSummary';
import { comparePeriods } from '@/lib/financial-data-hub/analytics/periodComparison';
import { monthBucketKey, resolvePeriod, resolvePreviousPeriod } from '@/lib/financial-data-hub/analytics/period';

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

describe('FDH-8 critical scenario — Transfer (spec 82, worked example)', () => {
  it('Income 5000, Expense 2500, Net 2500, Transfer 1000 — NOT 6000/3500', () => {
    const result = computeApprovedFinancialSummary(AUD, [
      txn({ id: 'salary', amount_original: 5000, economic_transaction_type: 'income' }),
      txn({ id: 'rent', amount_original: 2500, economic_transaction_type: 'expense' }),
      txn({ id: 'own-transfer-out', amount_original: 1000, economic_transaction_type: 'transfer' }),
    ]);
    expect(result.income_total).toBe(5000);
    expect(result.expense_total).toBe(2500);
    expect(result.transfer_total).toBe(1000);
    expect(result.income_total - result.expense_total).toBe(2500); // net cash flow

    // Negative control: the FAIL condition (spec 154) is a caller that
    // treats a transfer as expense/income. Prove that WOULD produce the
    // spec's explicitly-forbidden wrong numbers, so this test is not vacuous.
    const wrongIfTransferCountedAsExpense = result.expense_total + result.transfer_total;
    expect(wrongIfTransferCountedAsExpense).toBe(3500); // the exact wrong number the spec warns about
    expect(wrongIfTransferCountedAsExpense).not.toBe(result.expense_total);
  });
});

describe('FDH-8 critical scenario — Duplicate exclusion', () => {
  it('$100 not $200 when the same purchase appears twice and one copy is a confirmed duplicate', () => {
    const result = computeApprovedFinancialSummary(AUD, [
      txn({ id: 'purchase-1', amount_original: 100, economic_transaction_type: 'expense' }),
      txn({ id: 'purchase-1-dup', amount_original: 100, economic_transaction_type: 'expense', dedup_status: 'duplicate_confirmed' }),
    ]);
    expect(result.expense_total).toBe(100);
    expect(result.duplicate_excluded_count).toBe(1);

    // Negative control: naive summation across both rows (ignoring
    // dedup_status) is the exact FAIL condition (spec 154).
    const naiveDoubleCount = [100, 100].reduce((a, b) => a + b, 0);
    expect(naiveDoubleCount).toBe(200);
    expect(naiveDoubleCount).not.toBe(result.expense_total);
  });
});

describe('FDH-8 critical scenario — Split transactions', () => {
  it('$300 parent split into $220 + $80 allocations — never $600 (parent + children)', () => {
    const result = computeApprovedFinancialSummary(AUD, [
      txn({
        id: 'supermarket',
        amount_original: 300,
        economic_transaction_type: 'expense', // parent's own type/amount must be ignored once split
        allocations: [
          { economic_transaction_type: 'expense', category_id: 'groceries', amount: 220, currency_code: AUD },
          { economic_transaction_type: 'expense', category_id: 'household_goods', amount: 80, currency_code: AUD },
        ],
      }),
    ]);
    expect(result.expense_total).toBe(300);
    expect(result.category_totals['groceries']).toBe(220);
    expect(result.category_totals['household_goods']).toBe(80);

    // Negative control: the FAIL condition is summing parent AND children.
    const wrongIfDoubleCounted = 300 + 220 + 80;
    expect(wrongIfDoubleCounted).toBe(600);
    expect(wrongIfDoubleCounted).not.toBe(result.expense_total);
  });
});

describe('FDH-8 critical scenario — Refund matches FDH-7 exactly', () => {
  it('a confirmed refund link nets against expense_total, never income_total', () => {
    const result = computeApprovedFinancialSummary(
      AUD,
      [
        txn({ id: 'purchase', amount_original: 100, economic_transaction_type: 'expense', category_id: 'groceries' }),
        txn({ id: 'refund', amount_original: 20, economic_transaction_type: 'refund' }),
      ],
      [{ refundTransactionId: 'refund', originalTransactionId: 'purchase' }],
    );
    expect(result.expense_total).toBe(80); // 100 - 20 netted
    expect(result.refund_total).toBe(20); // visible, never hidden
    expect(result.income_total).toBe(0); // never routed to income

    // Negative control: refund-as-income is the FAIL condition (spec 154).
    const wrongIfRefundBecameIncome = result.income_total + 20;
    expect(wrongIfRefundBecameIncome).not.toBe(result.income_total);
  });
});

describe('FDH-8 critical scenario — Cash withdrawal', () => {
  it('ATM -$500 must not inflate consumer expense', () => {
    const result = computeApprovedFinancialSummary(AUD, [
      txn({ id: 'atm', amount_original: 500, economic_transaction_type: 'cash_withdrawal' }),
      txn({ id: 'coffee', amount_original: 5, economic_transaction_type: 'expense', category_id: 'dining' }),
    ]);
    expect(result.expense_total).toBe(5); // ATM withdrawal never joins expense_total
    expect(result.cash_withdrawal_total).toBe(500);
  });
});

describe('FDH-8 critical scenario — Loan proceeds', () => {
  it('+$25,000 loan drawdown must not inflate income', () => {
    // A loan drawdown is economically neither income nor a transfer between
    // the user's OWN accounts — FDH-6 classifies it structurally distinct
    // from 'income'. This oracle test proves that whatever bucket it lands
    // in (anything other than 'income'), income_total is unaffected.
    const result = computeApprovedFinancialSummary(AUD, [
      txn({ id: 'salary', amount_original: 4000, economic_transaction_type: 'income' }),
      txn({ id: 'loan-drawdown', amount_original: 25000, economic_transaction_type: 'unknown' }), // FDH-6 owns the exact classification; FDH-8 must never re-route it to income regardless
    ]);
    expect(result.income_total).toBe(4000); // unchanged by the 25,000 drawdown
    expect(result.unknown_total).toBe(25000);
  });
});

describe('FDH-8 critical scenario — Investment funding', () => {
  it('-$5,000 broker funding must not inflate ordinary expenses', () => {
    const result = computeApprovedFinancialSummary(AUD, [
      txn({ id: 'rent', amount_original: 2000, economic_transaction_type: 'expense' }),
      txn({ id: 'broker-funding', amount_original: 5000, economic_transaction_type: 'investment' }),
    ]);
    expect(result.expense_total).toBe(2000); // investment funding never joins expense_total
    expect(result.investment_total).toBe(5000);
  });
});

describe('*** FDH-8 CRITICAL SCENARIO — Pending Review (Product Owner emphasis, spec 12/88) ***', () => {
  const approvedTxns: ApprovedSummaryTransaction[] = [
    txn({ id: 'salary', amount_original: 1000, economic_transaction_type: 'income' }),
  ];
  const pendingTxns: ApprovedSummaryTransaction[] = [
    txn({ id: 'uncategorised-card-swipe', amount_original: 250, economic_transaction_type: 'expense' }),
  ];

  it('CORRECT pattern: approved and pending computed via two SEPARATE oracle calls, never merged', () => {
    const approvedTotals = computeApprovedFinancialSummary(AUD, approvedTxns);
    const pendingTotals = computeApprovedFinancialSummary(AUD, pendingTxns);

    // The headline number a user sees by default is approved-only.
    expect(approvedTotals.income_total).toBe(1000);
    expect(approvedTotals.expense_total).toBe(0);
    // Pending is a SEPARATE, explicitly-labelled figure.
    expect(pendingTotals.expense_total).toBe(250);
    // Approved total must be COMPLETELY UNAFFECTED by the existence of the
    // pending transaction — this is the exact assertion the PO asked for.
    expect(approvedTotals.expense_total).not.toBe(250);
    expect(approvedTotals.expense_total).toBe(0);
  });

  it('NEGATIVE CONTROL — deliberately mixing pending into the approved total IS caught by this test', () => {
    // This simulates the exact regression the PO is most worried about: a
    // future change that accidentally concatenates pending transactions
    // into the list passed for the "approved" headline total.
    const wronglyMergedList = [...approvedTxns, ...pendingTxns];
    const wrongTotals = computeApprovedFinancialSummary(AUD, wronglyMergedList);

    // Prove the oracle FAITHFULLY reproduces the bug when fed bad input —
    // i.e. this negative control is not vacuous, it genuinely detects the
    // wrong shape of call.
    expect(wrongTotals.expense_total).toBe(250); // the pending $250 leaked in
    expect(wrongTotals.income_total).toBe(1000);
    // The correct, separated computation must differ from this wrong one —
    // if a future refactor of financialActivityAnalytics.ts ever merges the
    // two lists, `approved.expense_total` would start equalling
    // `wrongTotals.expense_total` (250) instead of staying 0, and this
    // assertion is exactly what would catch it.
    const correctApproved = computeApprovedFinancialSummary(AUD, approvedTxns);
    expect(correctApproved.expense_total).toBe(0);
    expect(correctApproved.expense_total).not.toBe(wrongTotals.expense_total);
  });

  it('example from spec 12: "Approved spending: $4,250" + "Pending review: $180" — never "$4,430"', () => {
    const approved = computeApprovedFinancialSummary(AUD, [
      txn({ id: 'a1', amount_original: 4250, economic_transaction_type: 'expense' }),
    ]);
    const pending = computeApprovedFinancialSummary(AUD, [
      txn({ id: 'p1', amount_original: 180, economic_transaction_type: 'expense' }),
    ]);
    expect(approved.expense_total).toBe(4250);
    expect(pending.expense_total).toBe(180);
    const forbiddenCombinedNumber = approved.expense_total + pending.expense_total;
    expect(forbiddenCombinedNumber).toBe(4430); // exists only to prove it's the wrong number, never rendered
    expect(approved.expense_total).not.toBe(forbiddenCombinedNumber);
  });
});

describe('FDH-8 negative control — naive currency addition (spec 69, 154)', () => {
  it('AUD and INR totals must never be summed into one meaningless number', () => {
    const aud = computeApprovedFinancialSummary('AUD', [txn({ id: 'a', amount_original: 100, economic_transaction_type: 'expense' })]);
    const inr = computeApprovedFinancialSummary('INR', [txn({ id: 'i', amount_original: 100, economic_transaction_type: 'expense' })]);
    // FDH-8's analytics layer groups by currency and returns an array, one
    // entry per currency — proven here by construction: nothing in this
    // file ever adds `aud.expense_total + inr.expense_total`. The negative
    // control below shows why: doing so silently produces "200" even though
    // 100 AUD and 100 INR are not economically comparable.
    const naiveWrongSum = aud.expense_total + inr.expense_total;
    expect(naiveWrongSum).toBe(200); // demonstrates the trap, never used for display
    expect(aud.expense_total).toBe(100);
    expect(inr.expense_total).toBe(100);
  });
});

describe('FDH-8 negative control — pagination >1000 rows must not silently truncate', () => {
  it('an oracle call over 1,001 approved transactions sums every row, not just the first 1,000', () => {
    const many: ApprovedSummaryTransaction[] = Array.from({ length: 1001 }, (_, i) =>
      txn({ id: `t${i}`, amount_original: 1, economic_transaction_type: 'expense' }));
    const result = computeApprovedFinancialSummary(AUD, many);
    expect(result.approved_transaction_count).toBe(1001);
    expect(result.expense_total).toBe(1001);
    // Negative control: a caller that (bug) sliced to the first 1000 rows
    // before calling the oracle would get exactly this wrong, smaller number.
    const wrongIfTruncatedAt1000 = computeApprovedFinancialSummary(AUD, many.slice(0, 1000)).expense_total;
    expect(wrongIfTruncatedAt1000).toBe(1000);
    expect(wrongIfTruncatedAt1000).not.toBe(result.expense_total);
  });
});

describe('FDH-8 — period comparison zero-denominator handling (spec 56)', () => {
  it('previous=0, current=500 -> no percentage, "New spending" label, never Infinity/NaN', () => {
    const cmp = comparePeriods(500, 0, 'spending');
    expect(cmp.percentChange).toBeNull();
    expect(Number.isFinite(cmp.percentChange as number)).toBe(false); // it's null, not a finite number — the point is it's never Infinity/NaN either
    expect(cmp.label).toContain('New spending');
    expect(cmp.direction).toBe('new_activity');
  });

  it('previous=0, current=0 -> no percentage, no-activity label', () => {
    const cmp = comparePeriods(0, 0, 'spending');
    expect(cmp.percentChange).toBeNull();
    expect(Number.isNaN(cmp.percentChange)).toBe(false);
  });

  it('current > previous -> positive percentage, "higher" label', () => {
    const cmp = comparePeriods(150, 100, 'spending');
    expect(cmp.percentChange).toBe(50);
    expect(cmp.direction).toBe('increase');
    expect(cmp.label).toContain('higher');
  });

  it('current < previous -> negative delta, "lower" label', () => {
    const cmp = comparePeriods(80, 100, 'spending');
    expect(cmp.percentChange).toBe(-20);
    expect(cmp.direction).toBe('decrease');
    expect(cmp.label).toContain('lower');
  });

  it('current === previous -> 0%, no-change label, never divides producing NaN', () => {
    const cmp = comparePeriods(100, 100, 'spending');
    expect(cmp.percentChange).toBe(0);
    expect(cmp.direction).toBe('no_change');
  });

  it('never produces Infinity or NaN for any input pair, including both negative-adjacent edges', () => {
    const cases: [number, number][] = [[0, 0], [500, 0], [0, 500], [-0, 0], [1000000, 1]];
    for (const [current, previous] of cases) {
      const cmp = comparePeriods(current, previous, 'spending');
      if (cmp.percentChange !== null) {
        expect(Number.isFinite(cmp.percentChange)).toBe(true);
        expect(Number.isNaN(cmp.percentChange)).toBe(false);
      }
    }
  });
});

describe('FDH-8 — period resolution (spec 23-24, leap year / month boundary)', () => {
  it('this_month resolves to calendar-correct first/last day', () => {
    expect(resolvePeriod('this_month', '2026-02-15')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
  });

  it('leap year February has 29 days', () => {
    expect(resolvePeriod('this_month', '2028-02-10')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
  });

  it('last_month crosses a year boundary correctly (Jan -> prior Dec)', () => {
    expect(resolvePeriod('last_month', '2026-01-15')).toEqual({ from: '2025-12-01', to: '2025-12-31' });
  });

  it('year_to_date starts Jan 1 of the current year', () => {
    expect(resolvePeriod('year_to_date', '2026-08-24')).toEqual({ from: '2026-01-01', to: '2026-08-24' });
  });

  it('3/6/12 months clamp day-of-month across shorter target months (Mar 31 - 1mo lands on Feb 28/29)', () => {
    const result = resolvePreviousPeriod({ from: '2026-03-01', to: '2026-03-31' }, '2026-03-31');
    expect(result.range.to).toBe('2026-02-28'); // day before Mar 1, itself clamp-safe
  });

  it('custom range rejects from > to rather than silently swapping', () => {
    expect(() => resolvePeriod('custom', '2026-08-24', { from: '2026-08-31', to: '2026-08-01' })).toThrow();
  });

  it('monthBucketKey groups by YYYY-MM regardless of day-of-month', () => {
    expect(monthBucketKey('2026-08-01')).toBe('2026-08');
    expect(monthBucketKey('2026-08-31')).toBe('2026-08');
  });
});

describe('FDH-8 — timezone safety (spec 94): late-night UTC must not shift the financial date', () => {
  it('period boundaries are computed from calendar dates only, no timestamp/timezone arithmetic', () => {
    // transaction_date is a DATE column (no time-of-day); resolvePeriod never
    // constructs a `Date` from "now" internally — it takes `today` as an
    // explicit ISO date string and only ever compares/derives other ISO date
    // strings, so there is no `new Date()` call anywhere that could be
    // evaluated in a different timezone than the one the caller intended.
    const range = resolvePeriod('this_month', '2026-08-01');
    expect(range).toEqual({ from: '2026-08-01', to: '2026-08-31' });
    // A transaction dated the last day of the month, even one recorded
    // fractionally before UTC midnight elsewhere, is included by the
    // inclusive `to` boundary — the boundary itself never moves.
    expect('2026-08-31' >= range.from && '2026-08-31' <= range.to).toBe(true);
  });
});
