/**
 * THE GOLDEN PAIR'S ECONOMICS -- one household, one complete month (the previous complete month P),
 * hand-authored from the brief. Household M types these numbers into the input tabs; Household I receives
 * them ONLY as documents (this file renders them in the layouts the native parsers read, reusing the
 * shared certification builders). Neither side is ever derived by running the code under test.
 *
 *   Salary          gross 6,700 / PAYG 1,700 / net 5,000 a month, employer super 575 a month
 *   AUD bank        opening 20,000: salary +5,000 (1st), rent -2,000 (2nd), groceries -600 (3rd),
 *                   loan repayment -2,000 (15th), card repayment -220 (22nd)          -> closing 20,180
 *   Card            opening 1,500: groceries 200 (14th) + 20 (18th), payment -220 (22nd) -> closing 1,500
 *                   limit 5,000, minimum 30
 *   Home loan       opening 400,000: repayment 2,000 = principal 1,550 + interest 430 + fee 20 (15th)
 *                   -> closing 398,450, rate 6.14%
 *   INR bank        (SPOUSE-owned, India) opening INR 100,000: groceries -5,600 (5th) -> closing INR 94,400
 *   Broker          BHP 200 x 50 = 10,000; FHIP Test ETF 100 x 25 = 2,500 -> 12,500 AUD
 *   Super fund      opening 100,000 + employer 575 + earnings 1,200 - fees 45 - contributions tax 86.25
 *                   -> closing 101,643.75
 *
 * Per month the household therefore has: net income 5,000; spending rent 2,000 + groceries 820 (AUD) +
 * groceries INR 5,600; debt service 2,000 (the loan; the revolving card's minimum is excluded under D-08
 * because the card's purchases are counted as spending).
 */
import { bankCsv, iso, payslipPdf, type BuiltDocument, type Month } from '../documents/builders';

export const ECON = {
  salary: { gross: 6700, tax: 1700, net: 5000, employerSuper: 575, employer: 'FHIP Test Employer Pty Ltd' },
  bankAud: { opening: 20000, closing: 20180, masked: 'xxxx4401' },
  card: { opening: 1500, closing: 1500, limit: 5000, minimum: 30, masked: 'xxxx8801', purchases: [200, 20], payment: 220 },
  loan: { opening: 400000, closing: 398450, rate: 6.14, payment: 2000, principal: 1550, interest: 430, fee: 20, masked: 'xxxx5501' },
  bankInr: { opening: 100000, closing: 94400, groceries: 5600, masked: 'xxxx9901', owner: 'spouse' as const },
  broker: { holdings: [{ code: 'BHP', name: 'BHP Group Ltd', qty: 200, price: 50 }, { code: 'FTE', name: 'FHIP Test Diversified ETF', qty: 100, price: 25 }], masked: 'xxxx2401' },
  superFund: { opening: 100000, employer: 575, earnings: 1200, fees: 45, tax: 86.25, closing: 101643.75, masked: 'xxxx3301', name: 'FHIP Test Super Fund G' },
  spending: { rent: 2000, groceriesAud: 820, groceriesInr: 5600 },
} as const;

const pad = (n: number) => String(n).padStart(2, '0');
const lastDay = (m: Month) => new Date(Date.UTC(m.year, m.month, 0)).getUTCDate();
const dmy = (m: Month, d: number) => `${pad(Math.min(d, lastDay(m)))}/${pad(m.month)}/${m.year}`;
const enc = (s: string) => new TextEncoder().encode(s);
const tag = (m: Month, run: string) => `${m.year}-${pad(m.month)}-${run}`;

/** UI-exact upload parameters (what each import panel actually sends -- see the panel components). */
export function goldenDocuments(m: Month, run = 'GP2'): BuiltDocument[] {
  // `run` keeps every run's files byte-distinct and its accounts distinct (masked ids end in the run's
  // digit), so a later run is never matched to an earlier run's statements or accounts.
  const d = (s: string) => s.replace(/ GP(2?)(?=$| )/g, ` ${run}`).replace(/ GP2$/, ` ${run}`);
  const mk = (base: string) => base.slice(0, -1) + (run.match(/\d$/)?.[0] ?? '1');
  const period = { statement_period_start: iso(m, 1), statement_period_end: iso(m, 31) };
  const bank = bankCsv([
    { date: iso(m, 1), description: d('FHIP TEST EMPLOYER PTY LTD SALARY GP'), amount: 5000 },
    { date: iso(m, 2), description: d('RENT FHIP TEST REALTY GP'), amount: -2000 },
    { date: iso(m, 3), description: d('WOOLWORTHS FHIP TEST STORE GP'), amount: -600 },
    { date: iso(m, 15), description: d('FHIP TEST HOME LOAN REPAYMENT GP'), amount: -2000 },
    { date: iso(m, 22), description: d('FHIP TEST CARD PAYMENT GP'), amount: -220 },
  ], ECON.bankAud.opening);
  if (bank.closingBalance !== ECON.bankAud.closing) throw new Error(`AUD bank closing ${bank.closingBalance}`);
  const inr = bankCsv([{ date: iso(m, 5), description: d('BIGBASKET FHIP TEST GROCERY GP'), amount: -5600 }], ECON.bankInr.opening);
  if (inr.closingBalance !== ECON.bankInr.closing) throw new Error(`INR bank closing ${inr.closingBalance}`);

  const card = ['Transaction Date,Description,Amount,Transaction Type,Merchant',
    `${dmy(m, 14)},WOOLWORTHS FHIP TEST GROCER ${run},200.00,Purchase,Woolworths FHIP Test Grocer`,
    `${dmy(m, 18)},WOOLWORTHS FHIP TEST GROCER ${run}B,20.00,Purchase,Woolworths FHIP Test Grocer`,
    `${dmy(m, 22)},Payment Received - Thank You ${run},220.00,Payment,`].join('\n') + '\n';
  const loan = ['Payment Date,Description,Amount,Type,Principal,Interest,Fee',
    `${dmy(m, 15)},Monthly Repayment ${run},2000.00,Repayment,1550.00,430.00,20.00`].join('\n') + '\n';
  const portfolio = ['Security Name,Code,Quantity,Price,Market Value,Valuation Date',
    ...ECON.broker.holdings.map((h) => `${h.name},${h.code},${h.qty},${h.price.toFixed(2)},${(h.qty * h.price).toFixed(2)},${dmy(m, 31)}`)].join('\n') + '\n';
  const superPeriod = `${iso(m, 1)} to ${iso(m, 31)}`;
  const s = ECON.superFund;
  const sup = ['Item,Amount,Period', ...([['Opening balance', s.opening], ['Employer contributions', s.employer], ['Investment earnings', s.earnings], ['Fees', s.fees], ['Contributions tax', s.tax], ['Closing balance', s.closing]] as const)
    .map(([k, v]) => `${k},${v.toFixed(2)},${superPeriod}`)].join('\n') + '\n';

  const up = (route: string, query: Record<string, string>) => ({ panel: '', route, query, then: [] as string[] });
  return [
    { ...payslipPdf(m, run, { gross: ECON.salary.gross, tax: ECON.salary.tax, employerSuper: ECON.salary.employerSuper, ytdMonths: 2 }), key: 'payslip' },
    { key: 'bank_aud', filename: `fhip-test-bank-${tag(m, run)}.csv`, contentType: 'text/csv', bytes: enc(bank.csv),
      upload: up('/api/financial-data-hub/bank-csv/upload', { country_code: 'AU', currency_code: 'AUD', masked_identifier: mk(ECON.bankAud.masked), owner_role: 'self', ...period }), oracle: { closing: ECON.bankAud.closing } },
    { key: 'bank_inr', filename: `fhip-test-bank-inr-${tag(m, run)}.csv`, contentType: 'text/csv', bytes: enc(inr.csv),
      upload: up('/api/financial-data-hub/bank-csv/upload', { country_code: 'IN', currency_code: 'INR', masked_identifier: mk(ECON.bankInr.masked), owner_role: ECON.bankInr.owner, ...period }), oracle: { closing: ECON.bankInr.closing } },
    { key: 'card', filename: `fhip-test-card-${tag(m, run)}.csv`, contentType: 'text/csv', bytes: enc(card),
      upload: up('/api/financial-data-hub/liability-statement/upload', { statement_type: 'credit_card', country_code: 'AU', currency_code: 'AUD', institution_name: 'FHIP Test Card', masked_identifier: mk(ECON.card.masked), ...period, opening_balance: ECON.card.opening.toFixed(2), closing_balance: ECON.card.closing.toFixed(2), credit_limit: ECON.card.limit.toFixed(2), minimum_payment: ECON.card.minimum.toFixed(2) }), oracle: {} },
    { key: 'loan', filename: `fhip-test-home-loan-${tag(m, run)}.csv`, contentType: 'text/csv', bytes: enc(loan),
      upload: up('/api/financial-data-hub/liability-statement/upload', { statement_type: 'loan', country_code: 'AU', currency_code: 'AUD', institution_name: 'FHIP Test Home Loan', masked_identifier: mk(ECON.loan.masked), ...period, opening_balance: ECON.loan.opening.toFixed(2), closing_balance: ECON.loan.closing.toFixed(2), interest_rate: String(ECON.loan.rate) }), oracle: {} },
    { key: 'broker_portfolio', filename: `fhip-test-broker-portfolio-${tag(m, run)}.csv`, contentType: 'text/csv', bytes: enc(portfolio),
      upload: up('/api/financial-data-hub/investment-statement/upload', { csv_kind: 'portfolio', currency_code: 'AUD', institution_name: 'FHIP Test Broker', masked_account_identifier: mk(ECON.broker.masked) }), oracle: {} },
    { key: 'super', filename: `fhip-test-super-${tag(m, run)}.csv`, contentType: 'text/csv', bytes: enc(sup),
      upload: up('/api/financial-data-hub/retirement-statement/upload', { jurisdiction: 'AU', currency_code: 'AUD', fund_name: s.name, masked_account_identifier: mk(s.masked), statement_period_start: iso(m, 1), statement_period_end: iso(m, 31) }), oracle: { closing: s.closing } },
  ];
}
