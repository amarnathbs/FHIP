/**
 * The golden pair (WP-03 / WP-04): Household M enters its finances by hand,
 * Household I imports the same economics. Every downstream engine must give
 * them the same answer.
 *
 *   income   gross 9,000 / net 7,000 a month (one salary)
 *   spending groceries 800 (essential), restaurants 300 (lifestyle), rent 2,000 (essential)
 *   loan     2,000 a month (I: 1,550 principal + 430 interest + 20 fee on the loan statement)
 *   card     balance 1,500, minimum 220; I's groceries include $200 + $20 on the card, repaid $220 from the bank
 *   cash     12,000
 *
 * Dates: the previous UTC calendar month P, always a complete month inside
 * the trailing-3-complete-month window, fully covered by approved statements.
 */
import { monthEnd } from '@/lib/read-models/core/window';
import type { Row } from './fakeSupabase';
import { account, CAT, expenseItem, incomeSource, liability, link, profile, statement, SUB, tables, taxonomy, txn, USER } from './fixtures';

const now = new Date();
const prior = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
export const P = `${prior.getUTCFullYear()}-${String(prior.getUTCMonth() + 1).padStart(2, '0')}`;
export const P_START = `${P}-01`;
export const P_END = monthEnd(P);
export const P_DAY = `${P}-15`;

export function cashAsset(value: number): Row {
  return {
    id: 'cash', user_id: USER, asset_name: 'Savings', asset_class: 'cash', current_value: value, currency_code: 'AUD', owner: 'self',
    master_item_key: 'savings_account', source_type: 'manual', linked_liability_id: null, country_code: 'AU', is_active: true,
  };
}

const LIABILITIES = (source: string) => [
  liability('L', { liability_name: 'Car loan', debt_type: 'personal_loan', master_item_key: 'personal_loan', balance: 30000, monthly_repayment: 2000, source_type: source }),
  liability('C', { liability_name: 'Visa', debt_type: 'credit_card', master_item_key: 'credit_card', balance: 1500, monthly_repayment: 220, minimum_payment: 220, credit_limit: 10000, source_type: source }),
];

export function householdM(): Record<string, Row[]> {
  return tables(profile(), taxonomy(), {
    income_sources: [incomeSource('m-sal', 'Salary', 9000, 'monthly', { net_amount: 7000, employer_name: 'Acme' })],
    expense_items: [
      expenseItem('m-g', 'Groceries', 800, 'monthly', { master_item_key: 'groceries', is_essential: true }),
      expenseItem('m-r', 'Restaurants', 300, 'monthly', { master_item_key: 'restaurants', is_essential: false }),
      expenseItem('m-rent', 'Rent', 2000, 'monthly', { master_item_key: 'rent', is_essential: true }),
    ],
    liabilities: LIABILITIES('manual'),
    assets: [cashAsset(12000)],
  });
}

export function householdI(): Record<string, Row[]> {
  return tables(profile(), taxonomy(), {
    income_sources: [incomeSource('i-sal', 'Acme salary', 9000, 'monthly', { net_amount: 7000, employer_name: 'Acme', source_type: 'payslip_import' })],
    fdh_payroll_events: [{
      id: 'pe', user_id: USER, employer_name: 'Acme', currency_code: 'AUD', payment_date: P_DAY, pay_period_end: P_DAY, gross_pay: 9000, net_pay: 7000,
      bonus_pay: null, overtime_pay: null, commission_pay: null, other_earnings: null, approval_status: 'approved', superseded_by_payroll_event_id: null,
      bank_match_transaction_id: 'sal', bank_match_status: 'matched',
    }],
    fhip_import_applications: [{ user_id: USER, target_domain: 'income', source_payroll_event_id: 'pe', target_entity_id: 'i-sal' }],
    liabilities: LIABILITIES('liability_statement_import'),
    assets: [cashAsset(12000)],
    fdh_financial_accounts: [account('bank'), account('card', 'credit_card', { liability_id: 'C' }), account('loan', 'personal_loan', { liability_id: 'L' })],
    fdh_statement_uploads: [statement('sb', 'bank', P_START, P_END), statement('sc', 'card', P_START, P_END), statement('sl', 'loan', P_START, P_END)],
    fdh_transactions: [
      txn({ id: 'sal', account: 'bank', statement: 'sb', date: P_DAY, amount: 7000, type: 'income', category: CAT.income, subcategory: SUB.salary }),
      txn({ id: 'g1', account: 'bank', statement: 'sb', date: P_DAY, amount: 580, type: 'expense', category: CAT.food, subcategory: SUB.groceries }),
      txn({ id: 'r1', account: 'bank', statement: 'sb', date: P_DAY, amount: 300, type: 'expense', category: CAT.food, subcategory: SUB.restaurants }),
      txn({ id: 'rent', account: 'bank', statement: 'sb', date: P_DAY, amount: 2000, type: 'expense', category: CAT.housing }),
      // Card: purchases $200 + $20 on the card, repaid $220 from the bank (confirmed settlement link).
      txn({ id: 'p1', account: 'card', statement: 'sc', date: P_DAY, amount: 200, type: 'expense', category: CAT.food, subcategory: SUB.groceries }),
      txn({ id: 'p2', account: 'card', statement: 'sc', date: P_DAY, amount: 20, type: 'expense', category: CAT.food, subcategory: SUB.groceries }),
      txn({ id: 'pc', account: 'card', statement: 'sc', date: P_DAY, amount: 220, type: 'transfer', cd: 'credit' }),
      txn({ id: 'pb', account: 'bank', statement: 'sb', date: P_DAY, amount: 220, type: 'expense', category: CAT.ccPayment }),
      // Loan: $2,000 = principal 1,550 + interest 430 + fee 20 on the facility; the bank leg is a transfer.
      txn({ id: 'lp', account: 'loan', statement: 'sl', date: P_DAY, amount: 1550, type: 'debt_principal', cd: 'credit', category: CAT.loanPrincipal }),
      txn({ id: 'li', account: 'loan', statement: 'sl', date: P_DAY, amount: 430, type: 'debt_interest', category: CAT.loanInterest }),
      txn({ id: 'lf', account: 'loan', statement: 'sl', date: P_DAY, amount: 20, type: 'fee', category: CAT.fees }),
      txn({ id: 'lb', account: 'bank', statement: 'sb', date: P_DAY, amount: 2000, type: 'transfer' }),
    ],
    fdh_transaction_links: [link('lnk', 'pb', 'pc', 'credit_card_settlement')],
  });
}
