/**
 * "Check the categories again" (30-10-2026): the re-run of the classification engine over a statement imported BEFORE the rules improved.
 * Against the in-memory database that enforces RLS and the authoritative-field triggers. Synthetic data only.
 *
 * Pinned here: a household member's Osko transfer is proposed as an own-account transfer (PO decision 30-10-2026); an earlier engine guess that
 * no rule supports now goes back to "needs your choice" ONLY on this explicit re-run; and an approved line, a person's own choice, an AI
 * proposal and another person's data are never touched.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeDb, type FakeDb } from '../support/fdhFakeSupabase';

const h = vi.hoisted(() => ({ db: null as unknown as FakeDb }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => h.db.sessionClient(A) }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => h.db.adminClient() }));
vi.setConfig({ testTimeout: 60000 });

const A = 'a0000000-0000-4000-8000-00000000000a';
const B = 'b0000000-0000-4000-8000-00000000000b';
const ACC = 'e0000000-0000-4000-8000-0000000000a1';
const UP = 'd0000000-0000-4000-8000-000000000001';
const CAT = {
  xfer: 'c0000000-0000-4000-8000-000000000005',
  food: 'c0000000-0000-4000-8000-000000000003',
  transport: 'c0000000-0000-4000-8000-000000000004',
};
const T = {
  household: 'f9000000-0000-4000-8000-000000000001',
  staleGuess: 'f9000000-0000-4000-8000-000000000002',
  approved: 'f9000000-0000-4000-8000-000000000003',
  chosen: 'f9000000-0000-4000-8000-000000000004',
  aiProposal: 'f9000000-0000-4000-8000-000000000005',
  stillGood: 'f9000000-0000-4000-8000-000000000006',
  otherUser: 'f9000000-0000-4000-8000-0000000000bb',
};
const UNRECOGNISED = 'ZXQ HOLDINGS PTY LTD INV 5521';

function row(id: string, description: string, over: Record<string, unknown> = {}) {
  return {
    id, user_id: A, financial_account_id: ACC, statement_upload_id: UP, transaction_date: '2026-08-10', description_clean: description, description_raw: description,
    merchant_raw: null, amount_original: 25.5, currency_original: 'AUD', credit_debit: 'debit', transaction_type_hint: null, source_reference: null,
    economic_transaction_type: 'unknown', category_id: null, subcategory_id: null, merchant_id: null, classification_method: 'unclassified',
    classification_confidence: null, user_override: false, review_status: 'pending', approval_status: 'pending', approved_at: null, approved_by: null,
    dedup_status: 'unique', recurring_transaction_id: null, recurring_flag: false, subscription_flag: false, transfer_flag: false,
    posting_date: null, value_date: null, balance_after: null, source_row: 1, ...over,
  };
}
const guess = { economic_transaction_type: 'expense', category_id: CAT.transport, classification_method: 'global_rule', classification_confidence: 0.9 };
const txn = (id: string) => h.db.rows('fdh_transactions').find((r) => r.id === id)!;

beforeEach(() => {
  h.db = createFakeDb();
  const db = h.db;
  db.insert('fdh_categories', { id: CAT.xfer, category_key: 'transfer_own_account', display_name: 'Own-Account Transfer', economic_type: 'transfer', active: true });
  db.insert('fdh_categories', { id: CAT.food, category_key: 'food', display_name: 'Food & Dining', economic_type: 'expense', active: true });
  db.insert('fdh_categories', { id: CAT.transport, category_key: 'transport', display_name: 'Transport', economic_type: 'expense', active: true });
  db.insert('fdh_financial_accounts', { id: ACC, user_id: A, institution_id: null, account_type: 'transaction', currency_code: 'AUD', display_name: 'Everyday', masked_identifier: '****4821', active: true });
  db.insert('fdh_statement_uploads', { id: UP, user_id: A, household_id: null, financial_account_id: ACC, source_type: 'csv', currency_code: 'AUD', processing_status: 'review_required', approved_by: null, approved_at: null, approval_version: 0, original_filename_sanitised: 'statement.csv' });
  db.insert('user_profiles', { user_id: A, full_name: 'Alex Rowan' });
  db.insert('household_members', { id: 'm-1', user_id: A, full_name: 'Casey Jane Rowan', relationship: 'spouse', is_active: true });

  // The household member's transfer, imported before the evidence existed.
  db.insert('fdh_transactions', row(T.household, 'Osko Payment To Casey Jane Rowan Account 123456789 NAB Ref#1', { transaction_type_hint: 'transfer_candidate', amount_original: 300 }));
  // An earlier engine guess that today's rules no longer support (a BPAY line once matched the "BP" fuel brand).
  db.insert('fdh_transactions', row(T.staleGuess, UNRECOGNISED, guess));
  // Must never change:
  db.insert('fdh_transactions', row(T.approved, UNRECOGNISED, { ...guess, approval_status: 'approved', approved_by: A, approved_at: '2026-09-01T00:00:00Z' }));
  db.insert('fdh_transactions', row(T.chosen, UNRECOGNISED, { ...guess, category_id: CAT.food, classification_method: 'user_manual', user_override: true, review_status: 'resolved' }));
  db.insert('fdh_transactions', row(T.aiProposal, UNRECOGNISED, { ...guess, category_id: CAT.food, classification_method: 'ai', classification_confidence: 0.6 }));
  // Still supported by today's rules: stays as it is.
  db.insert('fdh_transactions', row(T.stillGood, 'VISA-SQ *COLOR ERA BAKERY Deer Park AU#1(Ref.2) Apple Pay', { transaction_type_hint: 'card_payment_candidate', economic_transaction_type: 'expense', category_id: CAT.food, classification_method: 'global_rule', classification_confidence: 0.6 }));
  // Another person's line that looks identical: never read or written by this user's run.
  db.insert('fdh_transactions', { ...row(T.otherUser, UNRECOGNISED, guess), user_id: B });
});

async function run(retractStale?: boolean) {
  const { classifyUserTransactions } = await import('@/lib/financial-data-hub/services/transactionClassificationService');
  return classifyUserTransactions(A, retractStale ? { retractStale: true } : {});
}

describe('household members count as own-account evidence', () => {
  it('proposes a household member\'s Osko transfer as an own-account transfer (a proposal, never an approval)', async () => {
    await run();
    expect(txn(T.household)).toMatchObject({ economic_transaction_type: 'transfer', category_id: CAT.xfer, approval_status: 'pending', classification_confidence: 0.6 });
  });
});

describe('retractStale (the re-run button)', () => {
  it('sends a pending engine guess that no rule supports back to "needs your choice", with a history row', async () => {
    const summary = await run(true);
    expect(txn(T.staleGuess)).toMatchObject({ economic_transaction_type: 'unknown', category_id: null, subcategory_id: null, classification_method: 'unclassified', classification_confidence: null, review_status: 'pending', transfer_flag: false });
    expect(summary.transactionsRetracted).toBe(1);
    const history = h.db.rows('fdh_classification_history').filter((r) => r.transaction_id === T.staleGuess);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ previous_category_id: CAT.transport, new_category_id: null, new_economic_transaction_type: 'unknown', changed_by_type: 'system' });
  });

  it('NEGATIVE: an ordinary run (every import, every save) leaves that guess exactly as it was; only the explicit re-run withdraws it', async () => {
    const summary = await run();
    expect(txn(T.staleGuess)).toMatchObject({ category_id: CAT.transport, classification_method: 'global_rule' });
    expect(summary.transactionsRetracted).toBeUndefined();
  });

  it('NEGATIVE: an approved line, a person\'s own choice, an AI proposal and a line the rules still support are never touched', async () => {
    await run(true);
    expect(txn(T.approved)).toMatchObject({ category_id: CAT.transport, approval_status: 'approved', classification_method: 'global_rule' });
    expect(txn(T.chosen)).toMatchObject({ category_id: CAT.food, classification_method: 'user_manual', user_override: true });
    expect(txn(T.aiProposal)).toMatchObject({ category_id: CAT.food, classification_method: 'ai' });
    expect(txn(T.stillGood)).toMatchObject({ category_id: CAT.food, economic_transaction_type: 'expense' });
  });

  it('NEGATIVE: another person\'s identical line is not touched', async () => {
    await run(true);
    expect(txn(T.otherUser)).toMatchObject({ user_id: B, category_id: CAT.transport, classification_method: 'global_rule' });
  });

  it('is idempotent: pressing it twice changes nothing the second time', async () => {
    await run(true);
    const snapshot = JSON.stringify(h.db.rows('fdh_transactions'));
    const historyBefore = h.db.rows('fdh_classification_history').length;
    const second = await run(true);
    expect(JSON.stringify(h.db.rows('fdh_transactions'))).toBe(snapshot);
    expect(h.db.rows('fdh_classification_history').length).toBe(historyBefore);
    expect(second.transactionsRetracted).toBe(0);
  });
});

describe('isStaleEngineGuess', () => {
  it('is true only for a pending, engine-made, non-empty classification', async () => {
    const { isStaleEngineGuess } = await import('@/lib/financial-data-hub/services/transactionClassificationService');
    const base = { classification_method: 'global_rule', user_override: false, approval_status: 'pending', economic_transaction_type: 'expense', category_id: CAT.transport } as const;
    expect(isStaleEngineGuess(base)).toBe(true);
    expect(isStaleEngineGuess({ ...base, classification_method: 'merchant_master' })).toBe(true);
    for (const method of ['user_rule', 'user_manual', 'ai', 'source', 'admin_master_data', 'unclassified'] as const) {
      expect(isStaleEngineGuess({ ...base, classification_method: method })).toBe(false);
    }
    expect(isStaleEngineGuess({ ...base, user_override: true })).toBe(false);
    expect(isStaleEngineGuess({ ...base, approval_status: 'approved' })).toBe(false);
    expect(isStaleEngineGuess({ ...base, economic_transaction_type: 'unknown', category_id: null })).toBe(false);
  });
});

describe('recheckStatementCategories', () => {
  it('reports the lines needing a choice before and after for THIS statement, and approves nothing', async () => {
    const { recheckStatementCategories } = await import('@/lib/financial-data-hub/services/categoryRecheckService');
    const result = await recheckStatementCategories(A, UP);
    expect(result.status).toBe('done');
    expect(result.guesses_withdrawn).toBe(1);
    expect(result.approved_untouched).toBe(1);
    // The household transfer moved into a total; the stale guess is back as a question.
    expect(result.needs_decision_after).toBeGreaterThanOrEqual(1);
    expect(h.db.rows('fdh_transactions').filter((r) => r.user_id === A && r.approval_status === 'approved')).toHaveLength(1);
  });

  it('refuses a statement that is not this person\'s', async () => {
    const { recheckStatementCategories } = await import('@/lib/financial-data-hub/services/categoryRecheckService');
    await expect(recheckStatementCategories(B, UP)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('with nothing waiting for approval it does nothing and says so', async () => {
    const classify = vi.fn();
    const { recheckStatementCategories } = await import('@/lib/financial-data-hub/services/categoryRecheckService');
    const counts = { transactions: 3, approved: 3, waiting_for_approval: 0, needs_decision: 0, uncategorised: 0, low_confidence: 0, ready_to_approve: 0, duplicates_removed: 0 };
    const result = await recheckStatementCategories(A, UP, {
      getReview: async () => ({ counts }) as never,
      classify: classify as never,
    });
    expect(result).toMatchObject({ status: 'nothing_to_check', approved_untouched: 3 });
    expect(classify).not.toHaveBeenCalled();
  });
});

describe('recheckResultText', () => {
  it('says what changed in plain words and always that nothing was approved', async () => {
    const { recheckResultText } = await import('@/lib/financial-data-hub/domain/recheckText');
    const fewer = recheckResultText({ status: 'done', needs_decision_before: 271, needs_decision_after: 47, guesses_withdrawn: 0 });
    expect(fewer).toContain('271 transactions needed your choice before; now 47 do.');
    expect(fewer).toContain('Nothing was approved for you');
    expect(recheckResultText({ status: 'done', needs_decision_before: 2, needs_decision_after: 2, guesses_withdrawn: 0 })).toContain('Nothing needed to change');
    expect(recheckResultText({ status: 'done', needs_decision_before: 1, needs_decision_after: 3, guesses_withdrawn: 2 })).toContain('2 transactions had an earlier guess');
    expect(recheckResultText({ status: 'nothing_to_check', needs_decision_before: 0, needs_decision_after: 0, guesses_withdrawn: 0 })).toContain('already approved');
  });
});
