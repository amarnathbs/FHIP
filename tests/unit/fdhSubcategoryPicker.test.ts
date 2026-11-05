/**
 * Subcategory ("Type") choice on the statement review (PO 05-11-2026): the person picks the category, then optionally the type under it
 * (Income > Salary & Wages). Reports stay by main category; the type is detail. Pinned here: the server accepts a type only if it is a real, active
 * one OF the chosen category; the choice is stored and written to the classification history; leaving it out keeps the old behaviour; the screen shows
 * the second dropdown only when the category has types and sends the id; and migration 0316 matches the seed and is additive.
 * Against the in-memory database that enforces RLS and the authoritative-field triggers. Synthetic data only.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createFakeDb, type FakeDb } from '../support/fdhFakeSupabase';
import { subcategories as seedSubs } from '../../data/financial-data-hub/subcategories.mjs';

const h = vi.hoisted(() => ({ db: null as unknown as FakeDb }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => h.db.sessionClient(A) }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => h.db.adminClient() }));
vi.setConfig({ testTimeout: 60000 });

const A = 'a0000000-0000-4000-8000-00000000000a';
const ACC = 'e0000000-0000-4000-8000-0000000000a1';
const UP = 'd0000000-0000-4000-8000-000000000001';
const CAT = { income: 'c0000000-0000-4000-8000-0000000000b1', food: 'c0000000-0000-4000-8000-0000000000b2' };
const SUB = {
  salary: 'b0000000-0000-4000-8000-0000000000b1',
  groceries: 'b0000000-0000-4000-8000-0000000000b2',
  oldFood: 'b0000000-0000-4000-8000-0000000000b3', // inactive
};
const T = { pay: 'f9000000-0000-4000-8000-000000000001' };

const root = path.resolve(__dirname, '../..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
type Seed = Record<string, unknown>;

describe('the two new types: seed and migration 0316 agree, and it is additive', () => {
  const sql = read('supabase/migrations/0316_fdh_reimbursement_and_pets_subcategories.sql');
  const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  const find = (cat: string, key: string) => (seedSubs as Seed[]).find((s) => s.category_key === cat && s.subcategory_key === key)!;

  it('Reimbursement sits under Refund / Reversal, never under Income (it is not earnings)', () => {
    expect(find('refund_reversal', 'reimbursement')).toMatchObject({ display_name: 'Reimbursement (expenses paid back to you)' });
    expect((seedSubs as Seed[]).some((s) => s.category_key === 'income' && /reimburse/i.test(String(s.display_name)))).toBe(false);
    expect(code).toContain("category_key = 'refund_reversal'), $lit$reimbursement$lit$");
  });

  it('Pets sits under Lifestyle', () => {
    expect(find('lifestyle', 'pets')).toMatchObject({ display_name: 'Pets' });
    expect(code).toContain("category_key = 'lifestyle'), $lit$pets$lit$");
  });

  it('the migration inserts exactly the seed values (name, mapping key, order)', () => {
    for (const [cat, key] of [['refund_reversal', 'reimbursement'], ['lifestyle', 'pets']] as const) {
      const s = find(cat, key);
      expect(code, key).toContain(`$lit$${s.display_name}$lit$`);
      expect(code, key).toContain(`$lit$${s.fhip_mapping_key}$lit$, ${s.display_order},`);
    }
  });

  it('is additive and safe to repeat: one insert, DO NOTHING on the unique key, no update, delete or drop', () => {
    expect((code.match(/insert into/gi) ?? []).length).toBe(1);
    expect(/on conflict \(category_id, subcategory_key\) do nothing/i.test(code)).toBe(true);
    expect(/\b(update|delete|drop|truncate|alter)\b/i.test(code)).toBe(false);
  });

  it('no two types under one category share a key', () => {
    const seen = new Set<string>();
    for (const s of seedSubs as Seed[]) {
      const k = `${s.category_key}|${s.subcategory_key}`;
      expect(seen.has(k), k).toBe(false);
      seen.add(k);
    }
  });
});

describe('saving a category with a type', () => {
  beforeEach(() => {
    h.db = createFakeDb();
    const db = h.db;
    db.insert('fdh_categories', { id: CAT.income, category_key: 'income', display_name: 'Income', economic_type: 'income', active: true });
    db.insert('fdh_categories', { id: CAT.food, category_key: 'food', display_name: 'Food & Dining', economic_type: 'expense', active: true });
    db.insert('fdh_subcategories', { id: SUB.salary, category_id: CAT.income, subcategory_key: 'salary_wages', display_name: 'Salary & Wages', active: true, display_order: 10 });
    db.insert('fdh_subcategories', { id: SUB.groceries, category_id: CAT.food, subcategory_key: 'groceries', display_name: 'Groceries', active: true, display_order: 10 });
    db.insert('fdh_subcategories', { id: SUB.oldFood, category_id: CAT.food, subcategory_key: 'retired', display_name: 'Retired type', active: false, display_order: 90 });
    db.insert('fdh_financial_accounts', { id: ACC, user_id: A, institution_id: null, account_type: 'transaction', currency_code: 'AUD', display_name: 'Everyday', masked_identifier: '****4821', active: true });
    db.insert('fdh_statement_uploads', { id: UP, user_id: A, household_id: null, financial_account_id: ACC, source_type: 'csv', currency_code: 'AUD', processing_status: 'review_required', approved_by: null, approved_at: null, approval_version: 0, original_filename_sanitised: 'statement.csv' });
    db.insert('fdh_transactions', {
      id: T.pay, user_id: A, financial_account_id: ACC, statement_upload_id: UP, transaction_date: '2026-08-10', description_clean: 'Sample Employer Pty Ltd Pay', description_raw: 'Sample Employer Pty Ltd Pay',
      merchant_raw: null, amount_original: 3000, currency_original: 'AUD', credit_debit: 'credit', transaction_type_hint: null, source_reference: null,
      economic_transaction_type: 'unknown', category_id: null, subcategory_id: null, merchant_id: null, classification_method: 'unclassified',
      classification_confidence: null, user_override: false, review_status: 'pending', approval_status: 'pending', approved_at: null, approved_by: null,
      dedup_status: 'unique', recurring_transaction_id: null, recurring_flag: false, subscription_flag: false, transfer_flag: false,
      posting_date: null, value_date: null, balance_after: null, source_row: 1,
    });
  });

  const pay = () => h.db.rows('fdh_transactions').find((r) => r.id === T.pay)!;
  const historyForPay = () => h.db.rows('fdh_classification_history').filter((r) => r.transaction_id === T.pay);

  it('stores the type under the chosen category and writes it to the classification history', async () => {
    const { setTransactionCategory } = await import('@/lib/financial-data-hub/services/categoryReviewService');
    await setTransactionCategory(A, T.pay, { category_id: CAT.income, subcategory_id: SUB.salary });
    expect(pay()).toMatchObject({ category_id: CAT.income, subcategory_id: SUB.salary, economic_transaction_type: 'income', user_override: true });
    expect(historyForPay().at(-1)).toMatchObject({ new_category_id: CAT.income, new_subcategory_id: SUB.salary, changed_by_type: 'user' });
  });

  it('a type from ANOTHER category is refused and the line is left exactly as it was', async () => {
    const { setTransactionCategory } = await import('@/lib/financial-data-hub/services/categoryReviewService');
    await expect(setTransactionCategory(A, T.pay, { category_id: CAT.income, subcategory_id: SUB.groceries })).rejects.toMatchObject({ code: 'invalid_input' });
    expect(pay()).toMatchObject({ category_id: null, subcategory_id: null, economic_transaction_type: 'unknown', user_override: false });
    expect(historyForPay()).toHaveLength(0);
  });

  it('an inactive type is refused', async () => {
    const { setTransactionCategory } = await import('@/lib/financial-data-hub/services/categoryReviewService');
    await expect(setTransactionCategory(A, T.pay, { category_id: CAT.food, subcategory_id: SUB.oldFood })).rejects.toMatchObject({ code: 'invalid_input' });
    expect(pay().subcategory_id).toBeNull();
  });

  it('a type id that does not exist is refused', async () => {
    const { setTransactionCategory } = await import('@/lib/financial-data-hub/services/categoryReviewService');
    await expect(setTransactionCategory(A, T.pay, { category_id: CAT.income, subcategory_id: 'b0000000-0000-4000-8000-0000000000ff' })).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('without a type the old behaviour is unchanged: no type is stored, and a stale one under a different category is cleared', async () => {
    const { setTransactionCategory } = await import('@/lib/financial-data-hub/services/categoryReviewService');
    await setTransactionCategory(A, T.pay, { category_id: CAT.income, subcategory_id: SUB.salary });
    await setTransactionCategory(A, T.pay, { category_id: CAT.food });
    expect(pay()).toMatchObject({ category_id: CAT.food, subcategory_id: null });
  });

  it('the reports are by main category: the same line is income whichever type is chosen (type is detail, not a new total)', async () => {
    const { setTransactionCategory } = await import('@/lib/financial-data-hub/services/categoryReviewService');
    await setTransactionCategory(A, T.pay, { category_id: CAT.income });
    const withoutType = pay().economic_transaction_type;
    await setTransactionCategory(A, T.pay, { category_id: CAT.income, subcategory_id: SUB.salary });
    expect(pay().economic_transaction_type).toBe(withoutType);
  });
});

describe('the screen', () => {
  const ui = read('app/(app)/financial-data-hub/review/StatementCategoryReview.tsx');
  const page = read('app/(app)/financial-data-hub/review/page.tsx');
  const route = read('lib/financial-data-hub/validation/transactions.ts');

  it('shows the second dropdown only when the chosen category has types, labelled optional, with a "no specific type" choice', () => {
    expect(ui).toContain('subsOfChosen.length > 0');
    expect(ui).toContain('Type (optional)');
    expect(ui).toContain('No specific type');
  });

  it('starts with no type when the category is changed, and sends the type only if it belongs to the saved category', () => {
    expect(ui).toMatch(/setSubChoices\(\(s\) => \(\{ \.\.\.s, \[item\.id\]: '' \}\)\)/);
    expect(ui).toContain('s.categoryId === categoryId');
    expect(ui).toContain('subcategory_id: sub.id');
  });

  it('the page loads the types and hands them to the statement review only', () => {
    expect(page).toContain('subcategoriesRepository.listActiveAll()');
    expect(page).toContain('subcategories={subcategoryOptions}');
  });

  it('the request schema takes an optional type id and still never takes an economic type from the browser', () => {
    const schema = route.slice(route.indexOf('export const fdhSetTransactionCategorySchema'), route.indexOf('export type FdhSetTransactionCategoryInput'));
    expect(schema).toContain('subcategory_id: fdhUuid.optional()');
    expect(schema).not.toContain('economic_transaction_type');
  });
});
