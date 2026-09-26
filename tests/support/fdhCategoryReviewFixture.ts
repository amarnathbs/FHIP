/**
 * The synthetic 8-line bank statement (same lines, amounts and payees as the
 * certified synthetic PDF `bank_statement_real_layout_synthetic.pdf`, dated in
 * the current month so Monthly Surplus inputs are meaningful), seeded into the
 * in-memory fake in the state an import + R8 classification leaves it:
 * four lines the engine could not classify, two recognised merchants (HIGH),
 * two approved-global-rule matches (MEDIUM, 0.6).
 */
import type { FakeDb } from './fdhFakeSupabase';

export const CAT = {
  income: 'c0000000-0000-4000-8000-000000000001',
  housing: 'c0000000-0000-4000-8000-000000000002',
  food: 'c0000000-0000-4000-8000-000000000003',
  utilities: 'c0000000-0000-4000-8000-000000000004',
  transfer: 'c0000000-0000-4000-8000-000000000005',
  cash: 'c0000000-0000-4000-8000-000000000006',
  fees: 'c0000000-0000-4000-8000-000000000007',
  ccpay: 'c0000000-0000-4000-8000-000000000008',
  unknown: 'c0000000-0000-4000-8000-000000000009',
} as const;

export const USER_A = 'a0000000-0000-4000-8000-00000000000a';
export const USER_B = 'b0000000-0000-4000-8000-00000000000b';
export const STATEMENT_A = 'd0000000-0000-4000-8000-0000000000a1';
export const STATEMENT_B = 'd0000000-0000-4000-8000-0000000000b1';
const ACCOUNT_A = 'e0000000-0000-4000-8000-0000000000a1';
const ACCOUNT_B = 'e0000000-0000-4000-8000-0000000000b1';

export const TXN = {
  salary1: 'f0000000-0000-4000-8000-000000000001',
  toSavings: 'f0000000-0000-4000-8000-000000000002',
  rent: 'f0000000-0000-4000-8000-000000000003',
  energy: 'f0000000-0000-4000-8000-000000000004',
  groceries: 'f0000000-0000-4000-8000-000000000005',
  salary2: 'f0000000-0000-4000-8000-000000000006',
  cash: 'f0000000-0000-4000-8000-000000000007',
  fee: 'f0000000-0000-4000-8000-000000000008',
} as const;

export function monthDay(day: number): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), day)).toISOString().slice(0, 10);
}

function seedCategories(db: FakeDb) {
  const cats: Array<[string, string, string, string]> = [
    [CAT.income, 'income', 'Income', 'income'],
    [CAT.housing, 'housing', 'Housing', 'expense'],
    [CAT.food, 'food', 'Food & Dining', 'expense'],
    [CAT.utilities, 'utilities', 'Utilities', 'expense'],
    [CAT.transfer, 'transfer_own_account', 'Own-Account Transfer', 'transfer'],
    [CAT.cash, 'cash_withdrawal', 'Cash Withdrawal', 'cash_withdrawal'],
    [CAT.fees, 'financial_fees', 'Bank & Financial Fees', 'fee'],
    [CAT.ccpay, 'credit_card_payment', 'Credit-Card Payment', 'transfer'],
    [CAT.unknown, 'unknown', 'Unknown', 'unknown'],
  ];
  for (const [id, key, name, type] of cats) {
    db.insert('fdh_categories', { id, category_key: key, display_name: name, economic_type: type, active: true });
  }
}

function txn(
  userId: string,
  statementId: string,
  accountId: string,
  id: string,
  day: number,
  description: string,
  amount: number,
  direction: 'credit' | 'debit',
  cls: { type: string; category: string | null; method: string; confidence: number | null },
) {
  return {
    id,
    user_id: userId,
    financial_account_id: accountId,
    statement_upload_id: statementId,
    transaction_date: monthDay(day),
    description_clean: description,
    description_raw: description,
    merchant_raw: null,
    amount_original: amount,
    currency_original: 'AUD',
    credit_debit: direction,
    transaction_type_hint: 'unknown',
    source_reference: null,
    economic_transaction_type: cls.type,
    category_id: cls.category,
    subcategory_id: null,
    merchant_id: null,
    classification_method: cls.method,
    classification_confidence: cls.confidence,
    user_override: false,
    review_status: cls.type === 'unknown' ? 'pending' : 'not_required',
    approval_status: 'pending',
    approved_at: null,
    approved_by: null,
    dedup_status: 'unique',
    recurring_transaction_id: null,
    recurring_flag: false,
    subscription_flag: false,
    transfer_flag: false,
  };
}

const UNKNOWN = { type: 'unknown', category: null, method: 'unclassified', confidence: null };

export function seedStatement(db: FakeDb, userId = USER_A, statementId = STATEMENT_A, idPrefix?: string) {
  const accountId = userId === USER_A ? ACCOUNT_A : ACCOUNT_B;
  const id = (base: string) => (idPrefix ? `${idPrefix}${base.slice(idPrefix.length)}` : base);
  db.insert('fdh_financial_accounts', { id: accountId, user_id: userId, institution_id: null, account_type: 'transaction', active: true });
  db.insert('fdh_statement_uploads', {
    id: statementId,
    user_id: userId,
    household_id: null,
    financial_account_id: accountId,
    source_type: 'bank_pdf',
    currency_code: 'AUD',
    original_filename_sanitised: 'bank_statement_real_layout_synthetic.pdf',
    statement_period_start: monthDay(1),
    statement_period_end: monthDay(28),
    processing_status: 'review_required',
    reconciliation_status: 'reconciled',
    approved_by: null,
    approved_at: null,
    approval_version: 0,
  });
  const rows = [
    txn(userId, statementId, accountId, id(TXN.salary1), 3, 'Quillfeather Studio Pty Ltd', 1850, 'credit', UNKNOWN),
    txn(userId, statementId, accountId, id(TXN.toSavings), 5, 'Linked Acc Trns To Savings', 500, 'debit', UNKNOWN),
    txn(userId, statementId, accountId, id(TXN.rent), 7, 'Little Harbour Realty', 950, 'debit', UNKNOWN),
    txn(userId, statementId, accountId, id(TXN.energy), 10, 'Origin Energy Holdings', 184.3, 'debit', { type: 'expense', category: CAT.utilities, method: 'merchant_master', confidence: 1 }),
    txn(userId, statementId, accountId, id(TXN.groceries), 12, 'Woolworths', 123.45, 'debit', { type: 'expense', category: CAT.food, method: 'merchant_master', confidence: 1 }),
    txn(userId, statementId, accountId, id(TXN.salary2), 17, 'Quillfeather Studio Pty Ltd', 1850, 'credit', UNKNOWN),
    txn(userId, statementId, accountId, id(TXN.cash), 21, 'Cash Withdrawal', 60, 'debit', { type: 'cash_withdrawal', category: CAT.cash, method: 'global_rule', confidence: 0.6 }),
    txn(userId, statementId, accountId, id(TXN.fee), 28, 'Monthly Account Fee', 5, 'debit', { type: 'fee', category: CAT.fees, method: 'global_rule', confidence: 0.6 }),
  ];
  for (const r of rows) db.insert('fdh_transactions', r);
  return rows;
}

export function seedAll(db: FakeDb) {
  seedCategories(db);
  seedStatement(db, USER_A, STATEMENT_A);
  seedStatement(db, USER_B, STATEMENT_B, 'f1');
}
