/**
 * "Payments to People" category (02-11-2026): a payment to a person (not a shop) had no category, so each such line stayed a question.
 * It is SPENDING (economic type expense). Pinned here: the seed and migration 0315 say the same thing; choosing it files a line as an expense
 * counted as spending; it is separate from "Loan Given" (a transfer) and "Own-Account Transfer".
 * Against the in-memory database that enforces RLS and the authoritative-field triggers. Synthetic data only.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createFakeDb, type FakeDb } from '../support/fdhFakeSupabase';
import { categories as seedCategories } from '../../data/financial-data-hub/categories.mjs';

const h = vi.hoisted(() => ({ db: null as unknown as FakeDb }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => h.db.sessionClient(A) }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => h.db.adminClient() }));
vi.setConfig({ testTimeout: 60000 });

const A = 'a0000000-0000-4000-8000-00000000000a';
const ACC = 'e0000000-0000-4000-8000-0000000000a1';
const UP = 'd0000000-0000-4000-8000-000000000001';
const CAT = { people: 'c0000000-0000-4000-8000-0000000000b1', loan: 'c0000000-0000-4000-8000-0000000000b2' };
const T = { paid: 'f9000000-0000-4000-8000-000000000001' };

type Seed = Record<string, unknown>;
const seed = (key: string) => (seedCategories as Seed[]).find((c) => c.category_key === key)!;

describe('the seed and migration 0315 agree', () => {
  const sql = fs.readFileSync(path.resolve(__dirname, '../../supabase/migrations/0315_fdh_payments_to_people_category.sql'), 'utf8');
  const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  const cat = seed('payments_to_people');

  it('the category exists once, as spending for both countries', () => {
    expect((seedCategories as Seed[]).filter((c) => c.category_key === 'payments_to_people')).toHaveLength(1);
    expect(cat).toMatchObject({ economic_type: 'expense', country_applicability: ['AU', 'IN'] });
  });

  it('the migration inserts exactly the seed values', () => {
    for (const field of ['category_key', 'display_name', 'economic_type', 'fhip_mapping_key', 'icon_key', 'description', 'essential_discretionary', 'fixed_variable']) {
      expect(code, field).toContain(`$lit$${cat[field]}$lit$`);
    }
    expect(code).toContain(`${cat.display_order}, $lit$${cat.icon_key}$lit$`);
  });

  it('the migration is additive and safe to repeat', () => {
    expect((code.match(/insert into/gi) ?? []).length).toBe(1);
    expect(/on conflict \(category_key\) do nothing/i.test(code)).toBe(true);
    expect(/\b(update|delete|drop|truncate|alter)\b/i.test(code)).toBe(false);
  });

  it('no other category shares its mapping key or display order, and it is not a transfer like Loan Given', () => {
    const others = (seedCategories as Seed[]).filter((c) => c.category_key !== 'payments_to_people');
    expect(others.some((c) => c.fhip_mapping_key === cat.fhip_mapping_key)).toBe(false);
    expect(others.some((c) => c.display_order === cat.display_order)).toBe(false);
    expect(seed('loan_given').economic_type).toBe('transfer');
    expect(cat.economic_type).not.toBe(seed('loan_given').economic_type);
  });
});

describe('choosing it on a statement line', () => {
  beforeEach(() => {
    h.db = createFakeDb();
    const db = h.db;
    db.insert('fdh_categories', { id: CAT.people, category_key: 'payments_to_people', display_name: seed('payments_to_people').display_name, economic_type: 'expense', active: true });
    db.insert('fdh_categories', { id: CAT.loan, category_key: 'loan_given', display_name: 'Loan Given', economic_type: 'transfer', active: true });
    db.insert('fdh_financial_accounts', { id: ACC, user_id: A, institution_id: null, account_type: 'transaction', currency_code: 'AUD', display_name: 'Everyday', masked_identifier: '****4821', active: true });
    db.insert('fdh_statement_uploads', { id: UP, user_id: A, household_id: null, financial_account_id: ACC, source_type: 'csv', currency_code: 'AUD', processing_status: 'review_required', approved_by: null, approved_at: null, approval_version: 0, original_filename_sanitised: 'statement.csv' });
    db.insert('fdh_transactions', {
      id: T.paid, user_id: A, financial_account_id: ACC, statement_upload_id: UP, transaction_date: '2026-08-10', description_clean: 'Osko Payment To Sample Person', description_raw: 'Osko Payment To Sample Person',
      merchant_raw: null, amount_original: 80, currency_original: 'AUD', credit_debit: 'debit', transaction_type_hint: null, source_reference: null,
      economic_transaction_type: 'unknown', category_id: null, subcategory_id: null, merchant_id: null, classification_method: 'unclassified',
      classification_confidence: null, user_override: false, review_status: 'pending', approval_status: 'pending', approved_at: null, approved_by: null,
      dedup_status: 'unique', recurring_transaction_id: null, recurring_flag: false, subscription_flag: false, transfer_flag: false,
      posting_date: null, value_date: null, balance_after: null, source_row: 1,
    });
  });

  const paid = () => h.db.rows('fdh_transactions').find((r) => r.id === T.paid)!;

  it('files the line as an expense chosen by the person', async () => {
    const { setTransactionCategory } = await import('@/lib/financial-data-hub/services/categoryReviewService');
    const result = await setTransactionCategory(A, T.paid, { category_id: CAT.people });
    expect(result).toMatchObject({ category_id: CAT.people, economic_transaction_type: 'expense', classification_method: 'user_manual' });
    expect(paid()).toMatchObject({ category_id: CAT.people, economic_transaction_type: 'expense', user_override: true, approval_status: 'pending' });
  });

  it('counts toward spending on the statement review, unlike Loan Given', async () => {
    const { setTransactionCategory, getStatementCategoryReview } = await import('@/lib/financial-data-hub/services/categoryReviewService');
    await setTransactionCategory(A, T.paid, { category_id: CAT.people });
    const group = (await getStatementCategoryReview(A, UP)).groups.find((g) => g.category_id === CAT.people)!;
    expect(group).toMatchObject({ economic_type: 'expense', direction: 'out', count: 1, total: 80, counts_toward: 'spending' });
  });

  it('NEGATIVE CONTROL: the same line filed under Loan Given is a transfer and is not counted, so the assertions really tell them apart', async () => {
    const { setTransactionCategory, getStatementCategoryReview } = await import('@/lib/financial-data-hub/services/categoryReviewService');
    await setTransactionCategory(A, T.paid, { category_id: CAT.loan });
    expect(paid()).toMatchObject({ economic_transaction_type: 'transfer' });
    const group = (await getStatementCategoryReview(A, UP)).groups.find((g) => g.category_id === CAT.loan)!;
    expect(group.counts_toward).toBe('not_counted');
  });
});
