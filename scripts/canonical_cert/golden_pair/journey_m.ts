/**
 * Golden pair, Household M: the SAME household (economics.ts) typed by hand into the input tabs, through
 * the real LOCALHOST routes each tab's grid posts to (POST /api/income, /api/expenses, /api/liabilities,
 * /api/assets, /api/investments, /api/retirement). Nothing here writes to the database directly.
 *
 *   npx tsx scripts/canonical_cert/golden_pair/journey_m.ts --email <e> --port 3971
 *
 * Every value is what a user types from the household's own papers (payslip, statements, fund
 * statement). Where the user makes a CHOICE, the choice is the same one the Household I user made in
 * journey_i.ts (the ETF is recorded as a share holding, the card's monthly repayment is left blank, the
 * India account and its groceries are the spouse's), so the pair differs only in HOW the data arrived.
 *
 * Catalogue rows are UNIQUE per (user, master_item_key): POSTing a catalogue item the user has had before
 * RESURRECTS that row (lib/services/registry.ts) and keeps every column the form did not send. So:
 *  - a SECOND item of the same kind (the India groceries, the second share holding) is a custom row (no
 *    master_item_key), exactly as the grid adds one;
 *  - every economically relevant column is sent explicitly (annual_contribution 0, risk_profile unknown),
 *    so a resurrected fixture row cannot carry a stale value into the pair. (Run 1 of M did not, and the
 *    fixture's old 'australian_shares' row came back with its 12,960 a year of contributions.)
 */
import fs from 'node:fs';
import path from 'node:path';
import { api } from '../lib/session.mjs';
import { ECON } from './economics';

const args = process.argv.slice(2);
const arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const email = arg('--email')!;
const port = Number(arg('--port'));
const LOG = path.resolve('.canonical-cert', 'gp', 'journey-M.jsonl');

const ENTRIES: [string, Record<string, unknown>][] = [
  ['/api/income', { source_name: 'Salary — FHIP Test Employer', income_type: 'salary', amount: ECON.salary.gross, net_amount: ECON.salary.net, frequency: 'monthly', currency_code: 'AUD', country_code: 'AU', owner: 'self', is_taxable: true, employer_name: ECON.salary.employer, master_item_key: 'employment_salary' }],
  ['/api/expenses', { expense_name: 'Rent', expense_category: 'housing', amount: ECON.spending.rent, frequency: 'monthly', currency_code: 'AUD', country_code: 'AU', owner: 'self', is_essential: true, master_item_key: 'rent' }],
  ['/api/expenses', { expense_name: 'Groceries', expense_category: 'food', amount: ECON.spending.groceriesAud, frequency: 'monthly', currency_code: 'AUD', country_code: 'AU', owner: 'self', is_essential: true, master_item_key: 'groceries' }],
  ['/api/expenses', { expense_name: 'Groceries — India', expense_category: 'food', amount: ECON.spending.groceriesInr, frequency: 'monthly', currency_code: 'INR', country_code: 'IN', owner: ECON.bankInr.owner, is_essential: true }],
  ['/api/liabilities', { liability_name: 'Home loan', debt_type: 'mortgage', balance: ECON.loan.closing, interest_rate: ECON.loan.rate, monthly_repayment: ECON.loan.payment, currency_code: 'AUD', country_code: 'AU', lender: 'FHIP Test Home Loan', owner: 'self' }],
  ['/api/liabilities', { liability_name: 'Credit card', debt_type: 'credit_card', balance: ECON.card.closing, credit_limit: ECON.card.limit, minimum_payment: ECON.card.minimum, monthly_repayment: 0, currency_code: 'AUD', country_code: 'AU', lender: 'FHIP Test Card', owner: 'self' }],
  ['/api/assets', { asset_name: 'FHIP Test Bank account', asset_class: 'cash', current_value: ECON.bankAud.closing, currency_code: 'AUD', country_code: 'AU', owner: 'self' }],
  ['/api/assets', { asset_name: 'India savings account', asset_class: 'cash', current_value: ECON.bankInr.closing, currency_code: 'INR', country_code: 'IN', owner: ECON.bankInr.owner }],
  ['/api/investments', { investment_name: 'BHP Group Ltd', investment_type: 'shares', current_value: 10000, currency_code: 'AUD', country_code: 'AU', institution: 'FHIP Test Broker', owner: 'self', master_item_key: 'australian_shares', annual_contribution: 0, risk_profile: 'unknown' }],
  ['/api/investments', { investment_name: 'FHIP Test Diversified ETF', investment_type: 'shares', current_value: 2500, currency_code: 'AUD', country_code: 'AU', institution: 'FHIP Test Broker', owner: 'self', annual_contribution: 0, risk_profile: 'unknown' }],
  ['/api/retirement', { account_name: ECON.superFund.name, account_type: 'super', current_balance: ECON.superFund.closing, employer_contribution: ECON.superFund.employer, contribution_frequency: 'monthly', currency_code: 'AUD', country_code: 'AU', owner: 'self' }],
];

async function main() {
  for (const [route, json] of ENTRIES) {
    const t0 = Date.now();
    const r = await api(email, 'POST', route, { port, json });
    fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), route, request: json, status: r.status, ms: Date.now() - t0, response: r.json ?? r.text.slice(0, 1000) }) + '\n');
    console.log(`${r.status} ${String(Date.now() - t0).padStart(6)}ms POST ${route} ${JSON.stringify(json).slice(0, 90)}${r.status >= 300 ? '  ' + r.text.slice(0, 300) : ''}`);
    if (r.status >= 300) process.exitCode = 1;
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });
