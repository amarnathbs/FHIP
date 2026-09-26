/**
 * WP-05 / WP-06 golden pair: Household M (everything entered by hand) and
 * Household I (the same economics arriving through approved imports), dated
 * relative to TODAY so the canonical read models' default window (the
 * trailing 3 complete months in the household's timezone) and the legacy
 * Dashboard's current-calendar-month read both see them.
 *
 * Economics (per month, AUD), hand-authored from the brief -- never produced
 * by running the code under test:
 *   net salary 6,000 (M: income_sources gross 8,000 / net 6,000;
 *                     I: an approved 6,000 bank credit each month)
 *   rent 2,000 (housing) and groceries 800 (food)
 *   home loan: balance 400,000 @ 6%, repayment 3,000
 *     (M: manual liability + a manual 'mortgage' expense row that duplicates it;
 *      I: liability Applied from a loan statement, no expense row)
 *   family remittance 500 (planned in both -- the FDH taxonomy has no
 *     remittance category), plus a SUPERSEDED 999 row and an SMSF-owned 700
 *     row that must never count
 *   cash 20,000 AUD (AU) and an India property of INR 5,600,000 (= AUD
 *     100,000 at 56), ETF 50,000 AUD, super 150,000 AUD, a 50%-owned company
 *     (net assets 100,000 AUD)
 * Household I also holds an AU broker position imported into Investment
 * Intelligence but NOT yet added to Net Worth (value 10,000 AUD, PO D-05).
 */
import { defaultWindowFor, monthEnd, monthStart } from '@/lib/read-models/core/window';
import type { Row } from '../readModels/helpers/fakeSupabase';
import { account, CAT, expenseItem, incomeSource, liability, profile, statement, SUB, tables, taxonomy, txn, USER } from '../readModels/helpers/fixtures';

export { USER };

/** The trailing 3 complete months the canonical window uses today (AU). */
export function windowMonths(now = new Date()): string[] {
  return defaultWindowFor('AU', now).months;
}

/** The legacy Dashboard's "current month" (UTC calendar month). */
export function currentUtcMonth(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

function shared(): Record<string, Row[]> {
  return tables(profile('AUD', 'AU', 56), {
    assets: [
      { id: 'as-cash', user_id: USER, asset_name: 'Savings', asset_class: 'cash', current_value: 20000, currency_code: 'AUD', owner: 'self', master_item_key: 'savings_account', source_type: 'manual', linked_liability_id: null, country_code: 'AU', is_active: true },
      { id: 'as-in-prop', user_id: USER, asset_name: 'Pune flat', asset_class: 'property', current_value: 5600000, currency_code: 'INR', owner: 'self', master_item_key: 'investment_property', source_type: 'manual', linked_liability_id: null, country_code: 'IN', is_active: true },
    ],
    investments: [
      { id: 'inv-etf', user_id: USER, investment_name: 'ASX ETF', investment_type: 'etf', current_value: 50000, cost_base: 40000, currency_code: 'AUD', owner: 'self', master_item_key: 'etf', source_type: 'manual', ii_canonical_account_id: null, ii_canonical_instrument_id: null, country_code: 'AU', annual_contribution: 1200, institution: 'Broker', is_active: true },
    ],
    retirement_accounts: [
      { id: 'ret-super', user_id: USER, account_name: 'Super', account_type: 'super', current_balance: 150000, currency_code: 'AUD', owner: 'self', employer_contribution: 1500, personal_contribution: 0, contribution_frequency: 'monthly', source_type: 'manual', retirement_member_id: null, country_code: 'AU', target_retirement_age: null, is_active: true },
    ],
    business_entities: [
      { id: 'be-1', user_id: USER, entity_name: 'Family Co', ownership_percentage: 50, valuation_mode: 'summary', summary_net_asset_value: 100000, currency_code: 'AUD', is_active: true, created_at: '2026-01-01T00:00:00Z' },
    ],
    expense_items: [
      expenseItem('e-remit', 'Family support', 500, 'monthly', { master_item_key: 'family_support_remittance', is_essential: false }),
      expenseItem('e-superseded', 'Old groceries estimate', 999, 'monthly', { master_item_key: 'groceries', superseded_by_bank_import: true }),
      expenseItem('e-smsf', 'SMSF remittance', 700, 'monthly', { master_item_key: 'family_support_remittance', owner: 'smsf' }),
    ],
  });
}

export function householdM(): Record<string, Row[]> {
  return tables(shared(), {
    income_sources: [incomeSource('i-salary', 'Salary', 8000, 'monthly', { net_amount: 6000, employer_name: 'Acme' })],
    expense_items: [
      expenseItem('e-rent', 'Rent', 2000, 'monthly', { master_item_key: 'rent' }),
      expenseItem('e-groc', 'Groceries', 800, 'monthly', { master_item_key: 'groceries' }),
      expenseItem('e-mortgage', 'Mortgage', 3000, 'monthly', { master_item_key: 'mortgage' }),
    ],
    liabilities: [liability('l-home', { liability_name: 'Home loan', debt_type: 'mortgage', master_item_key: 'home_loan', balance: 400000, monthly_repayment: 3000, interest_rate: 6, country_code: 'AU' })],
  });
}

export function householdI(now = new Date()): Record<string, Row[]> {
  const months = windowMonths(now);
  const cur = currentUtcMonth(now);
  const statementMonths = months.includes(cur) ? months : [...months, cur];
  const statements: Row[] = [];
  const txns: Row[] = [];
  for (const m of statementMonths) {
    const sid = `st-${m}`;
    // The current month is only PARTLY covered (a statement to the 10th).
    const end = m === cur && !months.includes(cur) ? `${m}-10` : monthEnd(m);
    statements.push(statement(sid, 'bank', monthStart(m), end));
    txns.push(
      txn({ id: `t-sal-${m}`, account: 'bank', statement: sid, date: `${m}-01`, amount: 6000, type: 'income', category: CAT.income, subcategory: SUB.salary, description: 'ACME PAYROLL' }),
      txn({ id: `t-rent-${m}`, account: 'bank', statement: sid, date: `${m}-02`, amount: 2000, type: 'expense', category: CAT.housing, description: 'RENT PAYMENT' }),
      txn({ id: `t-groc-${m}`, account: 'bank', statement: sid, date: `${m}-03`, amount: 800, type: 'expense', category: CAT.food, subcategory: SUB.groceries, description: 'WOOLWORTHS' }),
    );
  }
  return tables(shared(), taxonomy(), {
    fdh_financial_accounts: [account('bank')],
    fdh_statement_uploads: statements,
    fdh_transactions: txns,
    liabilities: [liability('l-home', { liability_name: 'Home loan', debt_type: 'mortgage', master_item_key: 'home_loan', balance: 400000, monthly_repayment: 3000, interest_rate: 6, country_code: 'AU', source_type: 'liability_statement_import' })],
    ii_holding_snapshots: [
      { id: 'hs-1', user_id: USER, account_id: 'ii-acc', instrument_id: 'ii-vas', as_of_date: `${months[months.length - 1]}-28`, units: 100, value: 10000, currency_code: 'AUD', created_at: `${months[months.length - 1]}-28T00:00:00Z` },
    ],
  });
}
