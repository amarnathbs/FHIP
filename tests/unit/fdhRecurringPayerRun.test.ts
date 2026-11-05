/**
 * The repeating-payer rule inside the real classification pass (PO 05-11-2026), against the in-memory database that enforces RLS and the
 * authoritative-field triggers. Synthetic data only.
 *
 * Pinned here: a regular payer's lines are written as MEDIUM proposals (method global_rule, never approved) under Income / Salary & Wages or Loan
 * Principal Repayment, with a history row; a person's own choice, an approved line and another person's lines are never touched; a "check the categories
 * again" re-run withdraws and re-proposes them (they do not vanish); and a fixed repeating debit with no loan wording stays a question.
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
const CAT = { income: 'c0000000-0000-4000-8000-0000000000c1', loan: 'c0000000-0000-4000-8000-0000000000c2' };
const SUB = { salary: 'b0000000-0000-4000-8000-0000000000c1', loan: 'b0000000-0000-4000-8000-0000000000c2' };

let seq = 0;
const id = () => `f9000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
function row(description: string, date: string, over: Record<string, unknown> = {}) {
  return {
    id: id(), user_id: A, financial_account_id: ACC, statement_upload_id: UP, transaction_date: date, description_clean: description, description_raw: description,
    merchant_raw: null, amount_original: 3800, currency_original: 'AUD', credit_debit: 'credit', transaction_type_hint: 'credit', source_reference: null,
    economic_transaction_type: 'unknown', category_id: null, subcategory_id: null, merchant_id: null, classification_method: 'unclassified',
    classification_confidence: null, user_override: false, review_status: 'pending', approval_status: 'pending', approved_at: null, approved_by: null,
    dedup_status: 'unique', recurring_transaction_id: null, recurring_flag: false, subscription_flag: false, transfer_flag: false,
    posting_date: null, value_date: null, balance_after: null, source_row: 1, ...over,
  };
}
const dateAt = (i: number, step: number, start = '2026-01-01') => new Date(Date.parse(start) + i * step * 86_400_000).toISOString().slice(0, 10);
const all = () => h.db.rows('fdh_transactions');

function seedSeries(prefix: string, count: number, step: number, mk: (i: number) => Record<string, unknown>) {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const r = row(`${prefix} ${1000 + i}`, dateAt(i, step), mk(i));
    ids.push(r.id as string);
    h.db.insert('fdh_transactions', r);
  }
  return ids;
}

beforeEach(() => {
  seq = 0;
  h.db = createFakeDb();
  const db = h.db;
  db.insert('fdh_categories', { id: CAT.income, category_key: 'income', display_name: 'Income', economic_type: 'income', active: true });
  db.insert('fdh_categories', { id: CAT.loan, category_key: 'loan_principal', display_name: 'Loan Principal Repayment', economic_type: 'debt_principal', active: true });
  db.insert('fdh_subcategories', { id: SUB.salary, category_id: CAT.income, subcategory_key: 'salary_wages', display_name: 'Salary & Wages', active: true, display_order: 10 });
  db.insert('fdh_subcategories', { id: SUB.loan, category_id: CAT.loan, subcategory_key: 'other_loan_principal', display_name: 'Other Loan Principal', active: true, display_order: 40 });
  db.insert('fdh_financial_accounts', { id: ACC, user_id: A, institution_id: null, account_type: 'transaction', currency_code: 'AUD', display_name: 'Everyday', masked_identifier: '****4821', active: true });
  db.insert('fdh_statement_uploads', { id: UP, user_id: A, household_id: null, financial_account_id: ACC, source_type: 'csv', currency_code: 'AUD', processing_status: 'review_required', approved_by: null, approved_at: null, approval_version: 0, original_filename_sanitised: 'statement.csv' });
  db.insert('user_profiles', { user_id: A, full_name: 'Alex Rowan' });
});

describe('through the classification pass', () => {
  it('fortnightly pay from one payer is proposed as Income / Salary & Wages at MEDIUM, pending, with a history row', async () => {
    const ids = seedSeries('00112932 Zephyr Payroll Services', 8, 14, (i) => ({ amount_original: 3800 + (i % 3) * 25 }));
    const { classifyUserTransactions } = await import('@/lib/financial-data-hub/services/transactionClassificationService');
    const summary = await classifyUserTransactions(A);
    for (const tid of ids) {
      expect(all().find((r) => r.id === tid)).toMatchObject({
        economic_transaction_type: 'income', category_id: CAT.income, subcategory_id: SUB.salary, classification_method: 'global_rule', classification_confidence: 0.6, approval_status: 'pending',
      });
    }
    expect(summary.transactionsClassified).toBeGreaterThanOrEqual(8);
    const hist = h.db.rows('fdh_classification_history').filter((r) => ids.includes(r.transaction_id as string));
    expect(hist).toHaveLength(8);
    expect(hist[0]).toMatchObject({ new_category_id: CAT.income, new_subcategory_id: SUB.salary, changed_by_type: 'system' });
  });

  it('a fixed monthly debit to a payee that says loan is Loan Principal Repayment; the same series with no loan wording stays unclassified', async () => {
    const loanIds = seedSeries('Sample Vehicle Finance Pty', 6, 30, () => ({ credit_debit: 'debit', amount_original: 410.25, transaction_type_hint: 'debit' }));
    const mysteryIds = seedSeries('Mystery Payee Pty', 6, 30, () => ({ credit_debit: 'debit', amount_original: 410.25, transaction_type_hint: 'debit' }));
    const { classifyUserTransactions } = await import('@/lib/financial-data-hub/services/transactionClassificationService');
    await classifyUserTransactions(A);
    for (const tid of loanIds) expect(all().find((r) => r.id === tid)).toMatchObject({ economic_transaction_type: 'debt_principal', category_id: CAT.loan, subcategory_id: SUB.loan });
    for (const tid of mysteryIds) expect(all().find((r) => r.id === tid)).toMatchObject({ economic_transaction_type: 'unknown', category_id: null });
  });

  it('a person\'s own choice, an approved line and another user\'s lines are never touched', async () => {
    const ids = seedSeries('Zephyr Payroll Services', 8, 14, () => ({}));
    const chosen = ids[2];
    const approved = ids[3];
    const mine = h.db.rows('fdh_transactions');
    Object.assign(mine.find((r) => r.id === chosen)!, { user_override: true, classification_method: 'user_manual', economic_transaction_type: 'refund', review_status: 'resolved' });
    Object.assign(mine.find((r) => r.id === approved)!, { approval_status: 'approved', approved_by: A, approved_at: '2026-09-01T00:00:00Z', economic_transaction_type: 'expense' });
    const other = row('Zephyr Payroll Services 9', '2026-01-01', { user_id: B });
    h.db.insert('fdh_transactions', other);
    const { classifyUserTransactions } = await import('@/lib/financial-data-hub/services/transactionClassificationService');
    await classifyUserTransactions(A);
    expect(all().find((r) => r.id === chosen)).toMatchObject({ economic_transaction_type: 'refund', classification_method: 'user_manual' });
    expect(all().find((r) => r.id === approved)).toMatchObject({ economic_transaction_type: 'expense', approval_status: 'approved' });
    expect(all().find((r) => r.id === other.id)).toMatchObject({ economic_transaction_type: 'unknown', category_id: null });
  });

  it('"check the categories again" withdraws and re-proposes: the lines are still Income afterwards', async () => {
    const ids = seedSeries('Zephyr Payroll Services', 8, 14, () => ({}));
    const { classifyUserTransactions } = await import('@/lib/financial-data-hub/services/transactionClassificationService');
    await classifyUserTransactions(A);
    await classifyUserTransactions(A, { retractStale: true });
    for (const tid of ids) expect(all().find((r) => r.id === tid)).toMatchObject({ economic_transaction_type: 'income', category_id: CAT.income, subcategory_id: SUB.salary });
  });

  it('LOOK-ALIKE: three fortnightly credits, or irregular ones, are not proposed', async () => {
    const few = seedSeries('Zephyr Payroll Services', 3, 14, () => ({}));
    const irregularDates = ['2026-01-01', '2026-01-05', '2026-02-20', '2026-02-22', '2026-05-30', '2026-06-01'];
    const irregular = irregularDates.map((d, i) => {
      const r = row(`Quill Studio ${i}`, d);
      h.db.insert('fdh_transactions', r);
      return r.id as string;
    });
    const { classifyUserTransactions } = await import('@/lib/financial-data-hub/services/transactionClassificationService');
    await classifyUserTransactions(A);
    for (const tid of [...few, ...irregular]) expect(all().find((r) => r.id === tid)).toMatchObject({ economic_transaction_type: 'unknown', category_id: null });
  });
});
