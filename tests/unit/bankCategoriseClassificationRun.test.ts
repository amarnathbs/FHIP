/**
 * The classification RUN (classifyUserTransactions) with the 28-10-2026 coverage work, against the in-memory database that enforces RLS and the
 * authoritative-field triggers: it loads the user's own name and household names (never persisted, never echoed), classifies own-account
 * transfers and ordinary wording with the built-in rules, opens NO pending link for a line it classified, withdraws the engine's own stale open
 * links on such lines, and leaves a line it still cannot classify (and a link a person confirmed) alone. Synthetic data only.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeDb, type FakeDb } from '../support/fdhFakeSupabase';

const h = vi.hoisted(() => ({ db: null as unknown as FakeDb }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => h.db.sessionClient(A) }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => h.db.adminClient() }));
vi.setConfig({ testTimeout: 60000 });

const A = 'a0000000-0000-4000-8000-00000000000a';
const ACC = 'e0000000-0000-4000-8000-0000000000a1';
const UP = 'd0000000-0000-4000-8000-000000000001';
const CAT = { xfer: 'c0000000-0000-4000-8000-000000000005', food: 'c0000000-0000-4000-8000-000000000003', ccpay: 'c0000000-0000-4000-8000-000000000008' };
const T = {
  ownOsko: 'f8000000-0000-4000-8000-000000000001',
  bakery: 'f8000000-0000-4000-8000-000000000002',
  stranger: 'f8000000-0000-4000-8000-000000000003',
  confirmedLinkLine: 'f8000000-0000-4000-8000-000000000004',
  cardRepay: 'f8000000-0000-4000-8000-000000000005',
  retired: 'f8000000-0000-4000-8000-0000000000aa',
};

function row(id: string, description: string, amount: number, cd: 'credit' | 'debit', hint: string) {
  return {
    id, user_id: A, financial_account_id: ACC, statement_upload_id: UP, transaction_date: '2026-08-10', description_clean: description, description_raw: description,
    merchant_raw: null, amount_original: amount, currency_original: 'AUD', credit_debit: cd, transaction_type_hint: hint, source_reference: null,
    economic_transaction_type: 'unknown', category_id: null, subcategory_id: null, merchant_id: null, classification_method: 'unclassified',
    classification_confidence: null, user_override: false, review_status: 'pending', approval_status: 'pending', approved_at: null, approved_by: null,
    dedup_status: 'unique', recurring_transaction_id: null, recurring_flag: false, subscription_flag: false, transfer_flag: false,
    posting_date: null, value_date: null, balance_after: null, source_row: 1,
  };
}
const link = (id: string, txn: string, type: string, over: Record<string, unknown> = {}) => ({
  id, user_id: A, transaction_id_from: txn, transaction_id_to: null, link_type: type, status: 'pending', confidence: 0.3, created_by_method: 'algorithm', user_confirmed: false, ...over,
});
const txn = (id: string) => h.db.rows('fdh_transactions').find((r) => r.id === id)!;
const links = (id: string) => h.db.rows('fdh_transaction_links').filter((l) => l.transaction_id_from === id);

beforeEach(() => {
  h.db = createFakeDb();
  const db = h.db;
  db.insert('fdh_categories', { id: CAT.xfer, category_key: 'transfer_own_account', display_name: 'Own-Account Transfer', economic_type: 'transfer', active: true });
  db.insert('fdh_categories', { id: CAT.food, category_key: 'food', display_name: 'Food & Dining', economic_type: 'expense', active: true });
  db.insert('fdh_categories', { id: CAT.ccpay, category_key: 'credit_card_payment', display_name: 'Credit-Card Payment', economic_type: 'transfer', active: true });
  db.insert('fdh_financial_accounts', { id: ACC, user_id: A, institution_id: null, account_type: 'transaction', currency_code: 'AUD', display_name: 'Everyday', masked_identifier: '****4821', active: true });
  db.insert('fdh_statement_uploads', { id: UP, user_id: A, household_id: null, financial_account_id: ACC, source_type: 'csv', currency_code: 'AUD', processing_status: 'review_required', approved_by: null, approved_at: null, approval_version: 0 });
  db.insert('user_profiles', { user_id: A, full_name: 'Alex Rowan' });
  db.insert('household_members', { id: 'm-1', user_id: A, full_name: 'Casey Jane Rowan', relationship: 'spouse', is_active: true });
  db.insert('household_members', { id: 'm-2', user_id: A, full_name: 'Retired Person', relationship: 'other', is_active: false });
  db.insert('fdh_transactions', row(T.ownOsko, 'Osko Payment To Alex Rowan Account 123456789 NAB Ref#1', 300.11, 'debit', 'transfer_candidate'));
  db.insert('fdh_transactions', row(T.bakery, 'VISA-SQ *COLOR ERA BAKERY Deer Park AU#1(Ref.2) Apple Pay', 12.37, 'debit', 'card_payment_candidate'));
  db.insert('fdh_transactions', row(T.stranger, 'Osko Payment To Jordan Smith Account 987654321 WBC Ref#Gift', 77.43, 'debit', 'transfer_candidate'));
  db.insert('fdh_transactions', row(T.cardRepay, 'Direct Debit GEM VISA 5521 - SCN', 200.29, 'debit', 'direct_debit_candidate'));
  // Earlier runs left the engine's own open candidate links on the purchase and on the stranger.
  db.insert('fdh_transaction_links', link('l-bakery', T.bakery, 'credit_card_settlement'));
  db.insert('fdh_transaction_links', link('l-stranger', T.stranger, 'internal_transfer'));
});

describe('classifyUserTransactions with the built-in rules', () => {
  it('classifies own-account transfers and ordinary wording as PROPOSALS, with no database rule id', async () => {
    const { classifyUserTransactions } = await import('@/lib/financial-data-hub/services/transactionClassificationService');
    await classifyUserTransactions(A);
    expect(txn(T.ownOsko)).toMatchObject({ economic_transaction_type: 'transfer', category_id: CAT.xfer, classification_method: 'global_rule', classification_confidence: 0.6, approval_status: 'pending' });
    expect(txn(T.bakery)).toMatchObject({ economic_transaction_type: 'expense', category_id: CAT.food, classification_confidence: 0.6, approval_status: 'pending' });
    expect(txn(T.cardRepay)).toMatchObject({ economic_transaction_type: 'transfer', category_id: CAT.ccpay });
    const history = h.db.rows('fdh_classification_history').filter((r) => r.transaction_id === T.ownOsko);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ global_rule_id: null, user_rule_id: null, classification_method: 'global_rule', changed_by_type: 'system' });
  });
  it('opens NO pending link for a line it classified, and withdraws its own stale open link on one', async () => {
    const { classifyUserTransactions } = await import('@/lib/financial-data-hub/services/transactionClassificationService');
    await classifyUserTransactions(A);
    expect(links(T.ownOsko)).toHaveLength(0);
    expect(links(T.bakery).map((l) => l.status)).toEqual(['rejected']);
  });
  it('NEGATIVE: a line it still cannot classify keeps its open link and stays unknown; no name is persisted anywhere', async () => {
    const { classifyUserTransactions } = await import('@/lib/financial-data-hub/services/transactionClassificationService');
    await classifyUserTransactions(A);
    expect(txn(T.stranger)).toMatchObject({ economic_transaction_type: 'unknown', category_id: null });
    expect(links(T.stranger).map((l) => l.status)).toEqual(['pending']);
    const persisted = JSON.stringify([h.db.rows('fdh_classification_history'), h.db.rows('fdh_transaction_links'), h.db.rows('fdh_document_audit_events')]);
    expect(persisted).not.toMatch(/Casey|Rowan|Alex/);
  });
  it('NEGATIVE: an inactive household member is not evidence; a link the person CONFIRMED is never withdrawn', async () => {
    h.db.insert('fdh_transactions', row(T.confirmedLinkLine, 'VISA-SQ *COLOR ERA BAKERY Deer Park AU#1(Ref.9)', 9.13, 'debit', 'card_payment_candidate'));
    h.db.insert('fdh_transaction_links', link('l-confirmed', T.confirmedLinkLine, 'credit_card_settlement', { status: 'confirmed', user_confirmed: true }));
    h.db.insert('fdh_transactions', row(T.retired, 'Osko Payment To Retired Person Account 123456789 NAB', 5.55, 'debit', 'transfer_candidate'));
    const { classifyUserTransactions } = await import('@/lib/financial-data-hub/services/transactionClassificationService');
    await classifyUserTransactions(A);
    expect(links(T.confirmedLinkLine)[0]).toMatchObject({ status: 'confirmed', user_confirmed: true });
    expect(txn(T.retired).economic_transaction_type).toBe('unknown');
  });
  it('is idempotent: a second run changes nothing', async () => {
    const { classifyUserTransactions } = await import('@/lib/financial-data-hub/services/transactionClassificationService');
    await classifyUserTransactions(A);
    const before = JSON.stringify([h.db.rows('fdh_transactions'), h.db.rows('fdh_transaction_links')]);
    const historyBefore = h.db.rows('fdh_classification_history').length;
    await classifyUserTransactions(A);
    expect(JSON.stringify([h.db.rows('fdh_transactions'), h.db.rows('fdh_transaction_links')])).toBe(before);
    expect(h.db.rows('fdh_classification_history').length).toBe(historyBefore);
  });
});
