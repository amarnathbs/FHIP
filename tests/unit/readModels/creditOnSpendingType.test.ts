/**
 * Rule 10 (canonical-cert scale/UI, found live on DEV 2026-09-27): MONEY IN
 * never adds to spending.
 *
 * Live finding: the oracle bank statement's "REFUND WOOLWORTHS FHIP TEST
 * STORE" credit of $20 was classified Food & Dining (type 'expense') by the
 * merchant master, shown fully confident as "Food & Dining · Money in --
 * Counts as spending", and the statement review promised spending $225
 * (200 + 20 + 5) instead of $205. On the 1,000-line scale statement a
 * "Remember this payee" choice on one debit classified the payee's 100
 * CREDITS as Food & Dining too, and approved spending came out 459,505
 * instead of 413,100 (the 46,405 of credits ADDED). amount_original is
 * stored unsigned with credit_debit beside it; the spending rules ignored
 * the direction.
 *
 * Every expected value is hand-computed. Each [NC] case fails on the code
 * before the fix (b7a4a2e) with the numbers named in its comment.
 */
import { describe, expect, it } from 'vitest';

import { selectExpenses, type ExpensesReadModelData } from '@/lib/read-models/expenses';
import { bucketForType, directionalBucket, effectiveBucket } from '@/lib/read-models/core/spendingRules';
import { computeApprovedFinancialSummary } from '@/lib/financial-data-hub/domain/approvedSummary';
import { buildCategoryReview, surplusEffect, type CategoryReviewBlockers, type CategoryReviewTransaction } from '@/lib/financial-data-hub/domain/categoryReview';
import { makeFakeSupabase, type Row } from './helpers/fakeSupabase';
import { account, CAT, link, profile, statement, SUB, tables, taxonomy, txn, USER, WINDOW } from './helpers/fixtures';

async function run(t: Record<string, Row[]>): Promise<ExpensesReadModelData> {
  const { client } = makeFakeSupabase(tables(profile(), taxonomy(), t));
  const res = await selectExpenses(USER, { client, window: WINDOW, basis: 'combined' });
  if (res.status !== 'ok') throw new Error(`unavailable: ${res.reason} ${res.source}`);
  return res;
}

const bankAug = () => tables(
  { fdh_financial_accounts: [account('bank')] },
  { fdh_statement_uploads: [statement('s-aug', 'bank', '2026-08-01', '2026-08-31')] },
);

describe('rule 10 in the canonical spending rules', () => {
  it('a credit of a spending type is a refund; a debit is unchanged; non-spending buckets are unchanged', () => {
    expect(bucketForType('expense', false, 'credit')).toBe('refund');
    expect(bucketForType('fee', false, 'credit')).toBe('refund');
    expect(bucketForType('tax', false, 'credit')).toBe('refund');
    // NOT on a facility: a credit there is a repayment whose interest / fee allocations are cost of debt (D-09).
    expect(bucketForType('debt_interest', true, 'credit')).toBe('cost_of_debt');
    expect(bucketForType('expense', true, 'credit')).toBe('spending');
    expect(bucketForType('expense', false, 'debit')).toBe('spending');
    expect(bucketForType('income', false, 'credit')).toBe('income');
    expect(bucketForType('transfer', false, 'credit')).toBe('transfer');
    expect(directionalBucket('cash_withdrawal', 'credit')).toBe('cash_withdrawal');
    // No direction given: the legacy mapping (callers that have no direction).
    expect(bucketForType('expense', false)).toBe('spending');
  });

  it('effectiveBucket applies it to the base bucket, including a user-settled line', () => {
    const common = { onFacility: false, isSplit: false, links: [], corroborations: [] };
    expect(effectiveBucket({ ...common, type: 'expense', userOverride: true, creditDebit: 'credit' }).bucket).toBe('refund');
    expect(effectiveBucket({ ...common, type: 'expense', userOverride: false, creditDebit: 'debit' }).bucket).toBe('spending');
  });
});

describe('canonical Expense read model (Dashboard / Expenses tab / Score all read this)', () => {
  const purchase = () => txn({ id: 'buy', account: 'bank', statement: 's-aug', date: '2026-08-03', amount: 200, type: 'expense', category: CAT.food, subcategory: SUB.groceries, description: 'WOOLWORTHS FHIP TEST STORE' });
  const refundTypedExpense = () => txn({ id: 'ref', account: 'bank', statement: 's-aug', date: '2026-08-23', amount: 20, type: 'expense', cd: 'credit', category: CAT.food, subcategory: SUB.groceries, description: 'REFUND WOOLWORTHS FHIP TEST STORE' });

  it('[NC] an unlinked credit typed expense is NOT spending: 200, not 220; shown as an unlinked refund of 20', async () => {
    // Before the fix: actual.monthly 220 and refundsUnlinked.count 0.
    const e = await run(tables(bankAug(), { fdh_transactions: [purchase(), refundTypedExpense()] }));
    expect(e.actual.monthly).toBe(200);
    expect(e.actual.lines.map((l) => l.transactionId)).toEqual(['buy']);
    expect(e.actual.refundsUnlinked.count).toBe(1);
    expect(e.actual.refundsUnlinked.totalInWindow).toBe(20);
  });

  it('[NC] with a CONFIRMED refund_original link it nets (D-01): 200 - 20 = 180', async () => {
    // Before the fix: 220 (the credit was spending, and a spending line is never netted).
    const e = await run(tables(bankAug(), { fdh_transactions: [purchase(), refundTypedExpense()], fdh_transaction_links: [link('rl', 'ref', 'buy', 'refund_original')] }));
    expect(e.actual.monthly).toBe(180);
    expect(e.actual.refundsNetted.count).toBe(1);
  });

  it('[NC] the scale-statement shape: 900 debits + 100 credits of one remembered payee -> spending = the debits only', async () => {
    // Before the fix: 90 x 10 + 10 x 5 = 950 (credits added).
    const rows = Array.from({ length: 100 }, (_, i) => txn({
      id: `m${i}`, account: 'bank', statement: 's-aug', date: `2026-08-${String(1 + (i % 28)).padStart(2, '0')}`,
      amount: i % 10 === 0 ? 5 : 10, cd: i % 10 === 0 ? 'credit' : 'debit', type: 'expense', category: CAT.food, subcategory: SUB.groceries,
    }));
    const e = await run(tables(bankAug(), { fdh_transactions: rows }));
    expect(e.actual.monthly).toBe(900);
    expect(e.actual.lines).toHaveLength(90);
    expect(e.actual.refundsUnlinked.count).toBe(10);
    expect(e.actual.refundsUnlinked.totalInWindow).toBe(50);
  });

  it('control: an ordinary debit purchase is unaffected (200)', async () => {
    const e = await run(tables(bankAug(), { fdh_transactions: [purchase()] }));
    expect(e.actual.monthly).toBe(200);
  });
});

describe('category-totals review uses the same rule (one rule for Dashboard, Activity and review -- D-01)', () => {
  const CATS = [{ id: 'cat-food', category_key: 'food', display_name: 'Food & Dining', economic_type: 'expense' }];
  const NO_BLOCKERS: CategoryReviewBlockers = { pendingLinkTypesByTxn: new Map(), pendingDuplicateTxnIds: new Set(), blockingReviewItemTxnIds: new Set(), invalidSplitTxnIds: new Set() };
  const line = (id: string, amount: number, credit_debit: 'credit' | 'debit'): CategoryReviewTransaction => ({
    id, transaction_date: '2026-08-10', description_clean: id, amount_original: amount, currency_original: 'AUD', credit_debit,
    economic_transaction_type: 'expense', category_id: 'cat-food', classification_method: 'merchant_master', classification_confidence: 1,
    user_override: false, review_status: 'not_required', approval_status: 'pending', dedup_status: 'unique',
  });

  it('surplusEffect: money in of a spending type is a refund (unlinked unless linked)', () => {
    expect(surplusEffect('expense', { creditDebit: 'credit' })).toBe('refund_unlinked');
    expect(surplusEffect('expense', { creditDebit: 'credit', refundLinked: true })).toBe('reduces_spending');
    expect(surplusEffect('expense', { creditDebit: 'debit' })).toBe('spending');
  });

  it('[NC] "Food & Dining · Money in" no longer counts as spending: waiting spending 200, not 220', () => {
    // Before the fix: totals[0].waiting_spending 220 and the money-in group counts_toward 'spending'.
    const r = buildCategoryReview([line('buy', 200, 'debit'), line('ref', 20, 'credit')], CATS, NO_BLOCKERS);
    expect(r.totals[0].waiting_spending).toBe(200);
    const moneyIn = r.groups.find((g) => g.direction === 'in')!;
    expect(moneyIn.counts_toward).toBe('refund_unlinked');
    expect(moneyIn.not_counted_reason).toMatch(/not taken off your spending/);
  });

  it('[NC] a linked money-in line reduces spending and is grouped apart from an unlinked one', () => {
    const r = buildCategoryReview(
      [line('buy', 200, 'debit'), line('ref1', 20, 'credit'), line('ref2', 5, 'credit')],
      CATS,
      { ...NO_BLOCKERS, confirmedRefundTxnIds: new Set(['ref1']) },
    );
    expect(r.totals[0].waiting_spending).toBe(180); // 200 - 20 (linked); the unlinked 5 is shown, not counted
    const ins = r.groups.filter((g) => g.direction === 'in').map((g) => g.counts_toward).sort();
    expect(ins).toEqual(['reduces_spending', 'refund_unlinked']);
  });
});

describe('FDH-7 Approved Financial Summary + Activity oracle use the same rule', () => {
  const tx = (id: string, amount: number, credit_debit: 'credit' | 'debit' | undefined) => ({
    id, amount_original: amount, currency_original: 'AUD', economic_transaction_type: 'expense' as const, category_id: 'cat-food',
    dedup_status: 'unique' as const, allocations: [], credit_debit,
  });

  it('[NC] a credit typed expense is a refund, not expense, and not in its category total', () => {
    // Before the fix: expense_total 220, refund_total 0, category_totals['cat-food'] 220.
    const s = computeApprovedFinancialSummary('AUD', [tx('buy', 200, 'debit'), tx('ref', 20, 'credit')]);
    expect(s.expense_total).toBe(200);
    expect(s.refund_total).toBe(20);
    expect(s.category_totals['cat-food']).toBe(200);
  });

  it('[NC] with a confirmed refund link it nets against expense: 180', () => {
    // Before the fix: 220 (the netting loop only accepted type 'refund').
    const s = computeApprovedFinancialSummary('AUD', [tx('buy', 200, 'debit'), tx('ref', 20, 'credit')], [{ refundTransactionId: 'ref', originalTransactionId: 'buy' }]);
    expect(s.expense_total).toBe(180);
  });

  it('control: without a direction (legacy callers) the old mapping is unchanged', () => {
    const s = computeApprovedFinancialSummary('AUD', [tx('buy', 200, undefined)]);
    expect(s.expense_total).toBe(200);
  });
});
