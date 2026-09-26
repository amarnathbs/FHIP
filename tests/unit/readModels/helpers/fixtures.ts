/**
 * Synthetic household fixtures for the read-model oracle tests. Every row is
 * snake_case, exactly as PostgREST returns it. Amounts are hand-authored from
 * the brief's oracle numbers -- never produced by running the code under test.
 */
import { explicitWindow } from '@/lib/read-models/core/window';
import type { Row } from './fakeSupabase';

export const USER = '00000000-0000-0000-0000-0000000000u1';
/** The fixed window every oracle uses: Jun-Aug 2026 (three complete months). */
export const WINDOW = explicitWindow('2026-06-01', '2026-08-31', '2026-09-26', 'Australia/Sydney');

export const CAT = {
  food: 'cat-food',
  housing: 'cat-housing',
  fees: 'cat-fees',
  loanInterest: 'cat-loan-interest',
  loanPrincipal: 'cat-loan-principal',
  transfer: 'cat-transfer',
  ccPayment: 'cat-cc-payment',
  income: 'cat-income',
  refund: 'cat-refund',
  cash: 'cat-cash',
  investment: 'cat-investment',
  lifestyle: 'cat-lifestyle',
} as const;
export const SUB = { groceries: 'sub-groceries', restaurants: 'sub-restaurants', salary: 'sub-salary' } as const;

export function taxonomy(): { fdh_categories: Row[]; fdh_subcategories: Row[] } {
  const c = (id: string, key: string, mapping: string, ess: string) => ({ id, category_key: key, display_name: key, fhip_mapping_key: mapping, essential_discretionary: ess });
  return {
    fdh_categories: [
      c(CAT.food, 'food', 'expense.food', 'mixed'),
      c(CAT.housing, 'housing', 'expense.housing', 'essential'),
      c(CAT.fees, 'financial_fees', 'expense.financial_fees', 'not_applicable'),
      c(CAT.loanInterest, 'loan_interest', 'debt.interest', 'essential'),
      c(CAT.loanPrincipal, 'loan_principal', 'debt.principal', 'essential'),
      c(CAT.transfer, 'transfer_own_account', 'transfer.own_account', 'not_applicable'),
      c(CAT.ccPayment, 'credit_card_payment', 'transfer.credit_card_payment', 'not_applicable'),
      c(CAT.income, 'income', 'income.general', 'not_applicable'),
      c(CAT.refund, 'refund_reversal', 'refund.general', 'not_applicable'),
      c(CAT.cash, 'cash_withdrawal', 'cash_withdrawal.general', 'not_applicable'),
      c(CAT.investment, 'investment_purchase', 'investment.purchase', 'not_applicable'),
      c(CAT.lifestyle, 'lifestyle', 'expense.lifestyle', 'discretionary'),
    ],
    fdh_subcategories: [
      { id: SUB.groceries, category_id: CAT.food, display_name: 'Groceries', fhip_mapping_key: 'food.groceries', essential_discretionary: 'essential' },
      { id: SUB.restaurants, category_id: CAT.food, display_name: 'Restaurants', fhip_mapping_key: 'food.restaurants', essential_discretionary: 'discretionary' },
      { id: SUB.salary, category_id: CAT.income, display_name: 'Salary & Wages', fhip_mapping_key: 'income.salary_wages', essential_discretionary: null },
    ],
  };
}

export function profile(currency: 'AUD' | 'INR' = 'AUD', country = 'AU', rate: number | null = 56): Record<string, Row[]> {
  return {
    user_profiles: [{ user_id: USER, preferred_currency: currency, country_of_residence: country }],
    forecast_global_assumptions: rate === null ? [] : [{ assumption_key: 'fx_rate_aud_inr', assumption_value: rate, is_active: true, country_code: null }],
  };
}

export function account(id: string, account_type = 'transaction', extra: Row = {}): Row {
  return { id, user_id: USER, account_type, display_name: `Account ${id}`, currency_code: 'AUD', owner_role: null, liability_id: null, ...extra };
}

/** An APPROVED statement for `accountId` covering [start, end]. */
export function statement(id: string, accountId: string, start: string | null, end: string | null, extra: Row = {}): Row {
  return {
    id, user_id: USER, financial_account_id: accountId, statement_period_start: start, statement_period_end: end,
    document_type: 'bank_statement', processing_status: 'approved', approved_at: `${end ?? '2026-08-31'}T00:00:00Z`, ...extra,
  };
}

let seq = 0;
export function txn(p: {
  id?: string;
  account: string;
  statement?: string | null;
  date: string;
  amount: number;
  type: string;
  cd?: 'credit' | 'debit';
  category?: string | null;
  subcategory?: string | null;
  currency?: string;
  dedup?: string;
  approval?: string;
  userOverride?: boolean;
  description?: string;
}): Row {
  seq += 1;
  return {
    id: p.id ?? `t-${String(seq).padStart(6, '0')}`,
    user_id: USER,
    financial_account_id: p.account,
    statement_upload_id: p.statement ?? null,
    transaction_date: p.date,
    amount_original: p.amount,
    currency_original: p.currency ?? 'AUD',
    credit_debit: p.cd ?? (p.type === 'income' || p.type === 'refund' || p.type === 'asset_sale' ? 'credit' : 'debit'),
    economic_transaction_type: p.type,
    category_id: p.category ?? null,
    subcategory_id: p.subcategory ?? null,
    description_clean: p.description ?? null,
    dedup_status: p.dedup ?? 'unique',
    approval_status: p.approval ?? 'approved',
    user_override: p.userOverride ?? false,
  };
}

export function allocation(transactionId: string, sequence: number, type: string, amount: number, category: string | null = null, currency = 'AUD'): Row {
  return { user_id: USER, transaction_id: transactionId, allocation_sequence: sequence, economic_transaction_type: type, category_id: category, subcategory_id: null, amount, currency_code: currency };
}

export function link(id: string, from: string, to: string | null, link_type: string, status = 'confirmed'): Row {
  return { id, user_id: USER, transaction_id_from: from, transaction_id_to: to, link_type, status };
}

export function expenseItem(id: string, name: string, amount: number, frequency: string, extra: Row = {}): Row {
  return {
    id, user_id: USER, expense_name: name, expense_category: 'other', amount, frequency, currency_code: 'AUD', is_essential: true,
    master_item_key: null, owner: 'self', superseded_by_bank_import: false, is_active: true, ...extra,
  };
}

export function liability(id: string, extra: Row = {}): Row {
  return {
    id, user_id: USER, liability_name: `Liability ${id}`, debt_type: 'personal_loan', master_item_key: null, balance: 10000,
    monthly_repayment: null, minimum_payment: null, interest_rate: null, credit_limit: null, currency_code: 'AUD', owner: 'self',
    source_type: 'manual', is_active: true, ...extra,
  };
}

export function incomeSource(id: string, name: string, amount: number, frequency: string, extra: Row = {}): Row {
  return {
    id, user_id: USER, source_name: name, income_type: 'employment', amount, net_amount: null, frequency, currency_code: 'AUD', owner: 'self',
    master_item_key: 'employment_salary', employer_name: null, source_type: 'manual', superseded_by_bank_import: false, is_active: true, ...extra,
  };
}

/** Merges table maps (arrays concatenated). */
export function tables(...parts: Record<string, Row[]>[]): Record<string, Row[]> {
  const out: Record<string, Row[]> = {};
  for (const p of parts) for (const [k, v] of Object.entries(p)) out[k] = [...(out[k] ?? []), ...v];
  return out;
}
