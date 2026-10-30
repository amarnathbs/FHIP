/**
 * "Loan Given" category (31-10-2026): money lent to someone had no category to choose. It is a TRANSFER: it leaves the account, is not spending,
 * and is not income when it comes back. Pinned here: the seed and migration 0314 say the same thing; choosing it files a line as a transfer
 * (never an expense); and it is a real, separate category from "Loan Principal Repayment" (a loan you owe).
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
const CAT = {
  loanGiven: 'c0000000-0000-4000-8000-0000000000a1',
  loanPrincipal: 'c0000000-0000-4000-8000-0000000000a2',
  family: 'c0000000-0000-4000-8000-0000000000a3',
};
const T = { lent: 'f9000000-0000-4000-8000-000000000001' };

type Seed = Record<string, unknown>;
const seed = (key: string) => (seedCategories as Seed[]).find((c) => c.category_key === key)!;

describe('the seed and migration 0314 agree', () => {
  const sql = fs.readFileSync(path.resolve(__dirname, '../../supabase/migrations/0314_fdh_loan_given_category.sql'), 'utf8');
  const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  const loan = seed('loan_given');

  it('the category exists once, as a transfer for both countries', () => {
    expect((seedCategories as Seed[]).filter((c) => c.category_key === 'loan_given')).toHaveLength(1);
    expect(loan).toMatchObject({ economic_type: 'transfer', country_applicability: ['AU', 'IN'], debt_relevance: false });
  });

  it('the migration inserts exactly the seed values', () => {
    for (const field of ['category_key', 'display_name', 'economic_type', 'fhip_mapping_key', 'icon_key', 'description']) {
      expect(code, field).toContain(`$lit$${loan[field]}$lit$`);
    }
    expect(code).toContain(`${loan.display_order}, $lit$${loan.icon_key}$lit$`);
  });

  it('the migration is additive and safe to repeat: one insert, one DO NOTHING, no update, delete or drop', () => {
    expect((code.match(/insert into/gi) ?? []).length).toBe(1);
    expect(/on conflict \(category_key\) do nothing/i.test(code)).toBe(true);
    expect(/\b(update|delete|drop|truncate|alter)\b/i.test(code)).toBe(false);
  });

  it('no other category shares its key, mapping key or display order', () => {
    const others = (seedCategories as Seed[]).filter((c) => c.category_key !== 'loan_given');
    expect(others.some((c) => c.fhip_mapping_key === loan.fhip_mapping_key)).toBe(false);
    expect(others.some((c) => c.display_order === loan.display_order)).toBe(false);
  });

  it('it is not the "loan you owe" category: that one stays debt principal', () => {
    expect(seed('loan_principal')).toMatchObject({ economic_type: 'debt_principal' });
    expect(loan.economic_type).not.toBe(seed('loan_principal').economic_type);
  });
});

describe('choosing it on a statement line', () => {
  beforeEach(() => {
    h.db = createFakeDb();
    const db = h.db;
    const loan = seed('loan_given');
    db.insert('fdh_categories', { id: CAT.loanGiven, category_key: 'loan_given', display_name: loan.display_name, economic_type: loan.economic_type, active: true });
    db.insert('fdh_categories', { id: CAT.loanPrincipal, category_key: 'loan_principal', display_name: 'Loan Principal Repayment', economic_type: 'debt_principal', active: true });
    db.insert('fdh_categories', { id: CAT.family, category_key: 'family', display_name: 'Family & Dependants', economic_type: 'expense', active: true });
    db.insert('fdh_financial_accounts', { id: ACC, user_id: A, institution_id: null, account_type: 'transaction', currency_code: 'AUD', display_name: 'Everyday', masked_identifier: '****4821', active: true });
    db.insert('fdh_statement_uploads', { id: UP, user_id: A, household_id: null, financial_account_id: ACC, source_type: 'csv', currency_code: 'AUD', processing_status: 'review_required', approved_by: null, approved_at: null, approval_version: 0, original_filename_sanitised: 'statement.csv' });
    db.insert('fdh_transactions', {
      id: T.lent, user_id: A, financial_account_id: ACC, statement_upload_id: UP, transaction_date: '2026-08-10', description_clean: 'Osko Payment To Sample Person Loan', description_raw: 'Osko Payment To Sample Person Loan',
      merchant_raw: null, amount_original: 2500, currency_original: 'AUD', credit_debit: 'debit', transaction_type_hint: null, source_reference: null,
      economic_transaction_type: 'unknown', category_id: null, subcategory_id: null, merchant_id: null, classification_method: 'unclassified',
      classification_confidence: null, user_override: false, review_status: 'pending', approval_status: 'pending', approved_at: null, approved_by: null,
      dedup_status: 'unique', recurring_transaction_id: null, recurring_flag: false, subscription_flag: false, transfer_flag: false,
      posting_date: null, value_date: null, balance_after: null, source_row: 1,
    });
  });

  const lent = () => h.db.rows('fdh_transactions').find((r) => r.id === T.lent)!;

  it('files the line as a transfer chosen by the person, not as an expense', async () => {
    const { setTransactionCategory } = await import('@/lib/financial-data-hub/services/categoryReviewService');
    const result = await setTransactionCategory(A, T.lent, { category_id: CAT.loanGiven });
    expect(result).toMatchObject({ category_id: CAT.loanGiven, economic_transaction_type: 'transfer', classification_method: 'user_manual' });
    expect(lent()).toMatchObject({ category_id: CAT.loanGiven, economic_transaction_type: 'transfer', user_override: true, approval_status: 'pending' });
  });

  it('NEGATIVE CONTROL: the same line filed under a spending category becomes an expense, so the assertion above really tells them apart', async () => {
    const { setTransactionCategory } = await import('@/lib/financial-data-hub/services/categoryReviewService');
    await setTransactionCategory(A, T.lent, { category_id: CAT.family });
    expect(lent()).toMatchObject({ category_id: CAT.family, economic_transaction_type: 'expense' });
  });

  it('shows up as its own total on the statement review, not counted as income or spending', async () => {
    const { setTransactionCategory, getStatementCategoryReview } = await import('@/lib/financial-data-hub/services/categoryReviewService');
    await setTransactionCategory(A, T.lent, { category_id: CAT.loanGiven });
    const review = await getStatementCategoryReview(A, UP);
    const group = review.groups.find((g) => g.category_id === CAT.loanGiven)!;
    expect(group).toBeDefined();
    expect(group).toMatchObject({ economic_type: 'transfer', direction: 'out', count: 1, total: 2500 });
    expect(group.counts_toward).toBe('not_counted');
    expect(group.not_counted_reason).toBeTruthy();
    expect(review.groups.some((g) => g.economic_type === 'expense' && g.count > 0)).toBe(false);
  });
});
