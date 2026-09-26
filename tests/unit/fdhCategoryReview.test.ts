/**
 * Category-totals review — the pure grouping/definitions module
 * (lib/financial-data-hub/domain/categoryReview.ts). Expected values are
 * hand-computed from the fixtures, never copied from a run.
 * Written to FAIL on origin/main (15fa64b), where the module does not exist.
 */
import { describe, it, expect } from 'vitest';
import {
  buildCategoryReview,
  derivePayeeKey,
  groupKeyFor,
  isLowConfidence,
  isUncategorised,
  linkDecisionForChosenType,
  looksLikeOwnAccountTransfer,
  pendingIdsForGroup,
  surplusEffect,
  SURPLUS_INCOME_TYPES,
  SURPLUS_REFUND_TYPE,
  SURPLUS_SPENDING_TYPES,
  type CategoryReviewBlockers,
  type CategoryReviewTransaction,
} from '@/lib/financial-data-hub/domain/categoryReview';
import { BANK_EXPENSE_TRANSACTION_TYPES, BANK_INCOME_TRANSACTION_TYPES, BANK_REFUND_TRANSACTION_TYPE } from '@/lib/services/dashboardData';

const CATS = [
  { id: 'cat-food', category_key: 'food', display_name: 'Food & Dining', economic_type: 'expense' },
  { id: 'cat-income', category_key: 'income', display_name: 'Income', economic_type: 'income' },
  { id: 'cat-transfer', category_key: 'transfer_own_account', display_name: 'Own-Account Transfer', economic_type: 'transfer' },
  { id: 'cat-cc', category_key: 'credit_card_payment', display_name: 'Credit-Card Payment', economic_type: 'transfer' },
  { id: 'cat-refund', category_key: 'refund_reversal', display_name: 'Refund / Reversal', economic_type: 'refund' },
];

let seq = 0;
function t(over: Partial<CategoryReviewTransaction>): CategoryReviewTransaction {
  seq += 1;
  return {
    id: `t${String(seq).padStart(3, '0')}`,
    transaction_date: '2026-09-10',
    description_clean: 'Something',
    amount_original: 10,
    currency_original: 'AUD',
    credit_debit: 'debit',
    economic_transaction_type: 'expense',
    category_id: 'cat-food',
    classification_method: 'merchant_master',
    classification_confidence: 1,
    user_override: false,
    review_status: 'not_required',
    approval_status: 'pending',
    dedup_status: 'unique',
    ...over,
  };
}
const NO_BLOCKERS: CategoryReviewBlockers = {
  pendingLinkTypesByTxn: new Map(),
  pendingDuplicateTxnIds: new Set(),
  blockingReviewItemTxnIds: new Set(),
  invalidSplitTxnIds: new Set(),
};

describe('shared definitions', () => {
  it('Monthly Surplus mapping is exactly the dashboard\'s own constants', () => {
    expect([...SURPLUS_SPENDING_TYPES].sort()).toEqual([...BANK_EXPENSE_TRANSACTION_TYPES].sort());
    expect([...SURPLUS_INCOME_TYPES].sort()).toEqual([...BANK_INCOME_TRANSACTION_TYPES].sort());
    expect(SURPLUS_REFUND_TYPE).toBe(BANK_REFUND_TRANSACTION_TYPE);
    expect(surplusEffect('transfer')).toBe('not_counted');
    expect(surplusEffect('cash_withdrawal')).toBe('not_counted');
    expect(surplusEffect('debt_principal')).toBe('not_counted');
    expect(surplusEffect('fee')).toBe('spending');
    expect(surplusEffect('refund')).toBe('reduces_spending');
  });

  it('uncategorised means the economic type is unknown, even when a category id is set', () => {
    expect(isUncategorised(t({ economic_transaction_type: 'unknown', category_id: 'cat-food' }))).toBe(true);
    expect(isUncategorised(t({}))).toBe(false);
  });

  it("low confidence is FDH-6's LOW boundary (0.3), never a general-rule match (0.6), never a person's decision", () => {
    expect(isLowConfidence(t({ classification_method: 'global_rule', classification_confidence: 0.6 }))).toBe(false);
    expect(isLowConfidence(t({ classification_method: 'global_rule', classification_confidence: 0.3 }))).toBe(true);
    expect(isLowConfidence(t({ classification_method: 'global_rule', classification_confidence: '0.3000' }))).toBe(true);
    expect(isLowConfidence(t({ classification_method: 'user_manual', classification_confidence: 0.3 }))).toBe(false);
    expect(isLowConfidence(t({ economic_transaction_type: 'unknown', classification_confidence: 0 }))).toBe(false);
  });

  it('recognises own-account transfer wording, including the production example', () => {
    expect(looksLikeOwnAccountTransfer('Linked Acc Trns To Savings')).toBe(true);
    expect(looksLikeOwnAccountTransfer('Transfer to Savings Q...')).toBe(true);
    expect(looksLikeOwnAccountTransfer('Woolworths 1234 Melbourne')).toBe(false);
  });

  it('payee keys drop reference numbers so the rule matches next month', () => {
    expect(derivePayeeKey('Quillfeather Studio Pty Ltd')).toBe('QUILLFEATHER STUDIO PTY LTD');
    expect(derivePayeeKey('WOOLWORTHS 1234 MELBOURNE 03/09')).toBe('WOOLWORTHS MELBOURNE');
    expect(derivePayeeKey('12345678')).toBeNull();
    expect(derivePayeeKey(null)).toBeNull();
  });

  it('a category choice settles a transfer match only in the direction it answers', () => {
    expect(linkDecisionForChosenType('internal_transfer', 'transfer')).toBe('confirm');
    expect(linkDecisionForChosenType('internal_transfer', 'expense')).toBe('reject');
    expect(linkDecisionForChosenType('loan_payment', 'debt_principal')).toBe('confirm');
    expect(linkDecisionForChosenType('refund_original', 'refund')).toBeNull();
  });
});

describe('buildCategoryReview', () => {
  it('groups by category, direction and currency with exact cent totals', () => {
    const rows = [
      t({ amount_original: 0.1 }),
      t({ amount_original: 0.2 }),
      t({ amount_original: 123.45, approval_status: 'approved' }),
      t({ credit_debit: 'credit', economic_transaction_type: 'refund', category_id: 'cat-refund', amount_original: 20 }),
      t({ credit_debit: 'credit', economic_transaction_type: 'income', category_id: 'cat-income', amount_original: 1850 }),
      t({ economic_transaction_type: 'transfer', category_id: 'cat-transfer', amount_original: 500 }),
      t({ amount_original: 7, currency_original: 'INR' }),
    ];
    const r = buildCategoryReview(rows, CATS, NO_BLOCKERS);
    const food = r.groups.find((g) => g.label === 'Food & Dining' && g.currency === 'AUD')!;
    expect(food).toMatchObject({ count: 3, total: 123.75, pending_count: 2, pending_total: 0.3, approved_count: 1, status: 'partly_approved', counts_toward: 'spending' });
    expect(r.groups.map((g) => g.counts_toward)).toEqual(['income', 'spending', 'spending', 'reduces_spending', 'not_counted']);
    expect(r.totals).toEqual([
      { currency: 'AUD', waiting_income: 1850, waiting_spending: -19.7, approved_income: 0, approved_spending: 123.45 },
      { currency: 'INR', waiting_income: 0, waiting_spending: 7, approved_income: 0, approved_spending: 0 },
    ]);
    expect(r.counts).toMatchObject({ transactions: 7, approved: 1, waiting_for_approval: 6, needs_decision: 0, ready_to_approve: 6 });
  });

  it('lists every line that needs a person separately and keeps it out of every group', () => {
    const unknown = t({ economic_transaction_type: 'unknown', category_id: null, classification_method: 'unclassified', classification_confidence: null, description_clean: 'Linked Acc Trns To Savings' });
    const low = t({ classification_method: 'global_rule', classification_confidence: 0.3 });
    const dup = t({});
    const linked = t({ description_clean: 'CC PAYMENT' });
    const refund = t({ economic_transaction_type: 'refund', category_id: 'cat-refund', credit_debit: 'credit' });
    const split = t({});
    const clean = t({});
    const blockers: CategoryReviewBlockers = {
      pendingLinkTypesByTxn: new Map([[linked.id, ['credit_card_settlement']], [refund.id, ['refund_original']]]),
      pendingDuplicateTxnIds: new Set([dup.id]),
      blockingReviewItemTxnIds: new Set(),
      invalidSplitTxnIds: new Set([split.id]),
    };
    const r = buildCategoryReview([unknown, low, dup, linked, refund, split, clean], CATS, blockers);
    const reasons = Object.fromEntries(r.needs_decision.map((i) => [i.id, i.reason]));
    expect(reasons).toEqual({
      [unknown.id]: 'uncategorised',
      [low.id]: 'low_confidence',
      [dup.id]: 'possible_duplicate',
      [linked.id]: 'transfer_check',
      [refund.id]: 'refund_check',
      [split.id]: 'other_check',
    });
    const grouped = r.groups.flatMap((g) => g.lines.map((l) => l.id));
    expect(grouped).toEqual([clean.id]);
    const byId = Object.fromEntries(r.needs_decision.map((i) => [i.id, i]));
    expect(byId[unknown.id].suggested_category_id).toBe('cat-transfer');
    expect(byId[linked.id].suggested_category_id).toBe('cat-cc');
    expect(byId[dup.id].can_choose_category).toBe(false);
    expect(byId[refund.id].can_choose_category).toBe(false);
    expect(r.counts).toMatchObject({ needs_decision: 6, uncategorised: 1, low_confidence: 1, ready_to_approve: 1 });
  });

  it('never lists or counts an already-approved line as needing a decision, and excludes removed duplicates', () => {
    const approvedUnknown = t({ approval_status: 'approved' });
    const removed = t({ dedup_status: 'user_confirmed_duplicate', economic_transaction_type: 'unknown' });
    const r = buildCategoryReview([approvedUnknown, removed], CATS, { ...NO_BLOCKERS, pendingDuplicateTxnIds: new Set([approvedUnknown.id]) });
    expect(r.needs_decision).toEqual([]);
    expect(r.counts).toMatchObject({ approved: 1, waiting_for_approval: 0, duplicates_removed: 1, uncategorised: 0 });
  });

  it('marks a group fully confident only when every line is a person\'s decision or a HIGH match', () => {
    const r = buildCategoryReview([
      t({ classification_method: 'user_manual', classification_confidence: 1, user_override: true }),
      t({ classification_method: 'user_rule', classification_confidence: 1 }),
    ], CATS, NO_BLOCKERS);
    expect(r.groups[0].fully_confident).toBe(true);
    const r2 = buildCategoryReview([t({}), t({ classification_method: 'global_rule', classification_confidence: 0.6 })], CATS, NO_BLOCKERS);
    expect(r2.groups[0].fully_confident).toBe(false);
  });

  it('a group approval may approve only that group\'s still-pending lines', () => {
    const a = t({});
    const b = t({ approval_status: 'approved' });
    const other = t({ category_id: 'cat-income', economic_transaction_type: 'income', credit_debit: 'credit' });
    const r = buildCategoryReview([a, b, other], CATS, NO_BLOCKERS);
    expect(pendingIdsForGroup(r, groupKeyFor(a))).toEqual([a.id]);
    expect(pendingIdsForGroup(r, 'cat:nope|out|AUD')).toBeNull();
    const done = buildCategoryReview([b], CATS, NO_BLOCKERS);
    expect(pendingIdsForGroup(done, groupKeyFor(b))).toEqual([]);
  });
});
