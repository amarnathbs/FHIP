/**
 * Canonical-upload certification harness: SYNTHETIC document builders.
 *
 * Every document is obviously synthetic: fictional institutions ("FHIP Test Bank", "FHIP Test Card",
 * "FHIP Test Home Loan", "FHIP Test Broker", "FHIP Test Super Fund A/B"), fictional people ("Test Person
 * Alpha") and a fictional employer. Nothing here is, or is derived from, a real person's document.
 *
 * Each builder returns a BuiltDocument: the bytes, the upload recipe the real UI panel uses (route +
 * query parameters, taken from the panel components), and the ORACLE the brief expects for it. The
 * layouts are the ones the native parsers read (reused, not invented):
 *   bank       R7 generic single-signed CSV (Date,Description,Amount,Balance; YYYY-MM-DD)
 *   card/loan  FDH-10 au_credit_card_generic_v1 / au_loan_generic_v1 (tests/unit/fdh10LiabilityAdapters)
 *   broker     FDH-11 au_generic_investment_transaction_csv_v1 / au_generic_portfolio_csv_v1
 *   retirement FDH-12 fdh12_generic_retirement_summary_csv_v1 / ..._transaction_csv_v1
 *   payslip    FDH-9 generic payslip text (the AU-01 column layout in tests/fixtures/fdh9/payslips.ts),
 *              rendered to a real PDF by tests/support/buildMinimalPdf.ts
 * tests/unit/canonicalCertHarnessBuilders.test.ts runs every builder through the real parsers.
 *
 * `salt` (e.g. the certifier range letter) is folded into descriptions / masked identifiers so two
 * certifiers' files are never byte-identical.
 */
import { buildMinimalTextPdf } from '../../../tests/support/buildMinimalPdf';

export interface BuiltDocument {
  key: string;
  filename: string;
  contentType: 'text/csv' | 'application/pdf';
  bytes: Uint8Array;
  upload: { panel: string; route: string; query: Record<string, string>; then: string[] };
  oracle: Record<string, unknown>;
}

export interface Month { year: number; month: number } // month 1-12

export function parseMonth(s: string): Month {
  const m = /^(\d{4})-(\d{2})$/.exec(s);
  if (!m) throw new Error(`month must be YYYY-MM, got ${s}`);
  return { year: Number(m[1]), month: Number(m[2]) };
}

/** The previous COMPLETE calendar month relative to `now` (D-02 uses complete months). */
export function previousCompleteMonth(now = new Date()): Month {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
}

const pad = (n: number) => String(n).padStart(2, '0');
const lastDay = (m: Month) => new Date(Date.UTC(m.year, m.month, 0)).getUTCDate();
export const iso = (m: Month, day: number) => `${m.year}-${pad(m.month)}-${pad(Math.min(day, lastDay(m)))}`;
const dmy = (m: Month, day: number) => `${pad(Math.min(day, lastDay(m)))}/${pad(m.month)}/${m.year}`;
const money = (n: number) => n.toFixed(2);
const enc = (s: string) => new TextEncoder().encode(s);
const csvCell = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
const saltTag = (salt: string) => (salt ? ` ${salt.toUpperCase()}` : '');
const masked = (salt: string, base: number) => `xxxx${String(base + (salt ? salt.toUpperCase().charCodeAt(0) : 0)).slice(-4).padStart(4, '0')}`;

// ---------------------------------------------------------------------------------------------------
// BANK (R7 generic single-signed CSV)
// ---------------------------------------------------------------------------------------------------
export interface BankRow { date: string; description: string; amount: number }

export function bankCsv(rows: readonly BankRow[], openingBalance: number): { csv: string; closingBalance: number } {
  let bal = Math.round(openingBalance * 100);
  const lines = ['Date,Description,Amount,Balance'];
  for (const r of rows) {
    bal += Math.round(r.amount * 100);
    lines.push([r.date, csvCell(r.description), money(r.amount), money(bal / 100)].join(','));
  }
  return { csv: lines.join('\n') + '\n', closingBalance: bal / 100 };
}

const bankUpload = (m: Month, salt: string, owner = 'self') => ({
  panel: 'Expenses -> Import Bank Statement (components/expenses/BankStatementImportPanel.tsx)',
  route: 'POST /api/financial-data-hub/bank-csv/upload?<query>  (Content-Type: text/csv, body = file bytes)',
  query: {
    country_code: 'AU', currency_code: 'AUD', masked_identifier: masked(salt, 4321), owner_role: owner,
    statement_period_start: iso(m, 1), statement_period_end: iso(m, 31),
  },
  then: ['POST /api/financial-data-hub/bank-csv/<documentId>/detect', 'POST /api/financial-data-hub/bank-csv/<documentId>/process', 'review + approve via the Expenses import panel / review queue routes'],
});

/**
 * The economic-oracle bank statement for one household-month. Every row is a leg of an oracle in the
 * brief; the other side of each leg is in the matching card / loan / broker / payslip document.
 */
export function oracleBankStatement(m: Month, salt = '', opts: { salaryNet?: number } = {}): BuiltDocument {
  const net = opts.salaryNet ?? 5000;
  const t = saltTag(salt);
  const rows: BankRow[] = [
    { date: iso(m, 1), description: `FHIP TEST EMPLOYER PTY LTD SALARY${t}`, amount: net },
    { date: iso(m, 3), description: `WOOLWORTHS FHIP TEST STORE${t}`, amount: -200 },
    { date: iso(m, 4), description: `TRANSFER TO FHIP TEST BROKER${t}`, amount: -10000 },
    { date: iso(m, 15), description: `FHIP TEST HOME LOAN REPAYMENT${t}`, amount: -2000 },
    { date: iso(m, 20), description: `FHIP TEST BROKER SALE PROCEEDS${t}`, amount: 15000 },
    { date: iso(m, 21), description: `ATM CASH WITHDRAWAL FHIP TEST${t}`, amount: -100 },
    { date: iso(m, 22), description: `FHIP TEST CARD PAYMENT${t}`, amount: -220 },
    { date: iso(m, 23), description: `REFUND WOOLWORTHS FHIP TEST STORE${t}`, amount: 20 },
    { date: iso(m, 25), description: `FHIP TEST DIVIDEND BHP${t}`, amount: 400 },
    { date: iso(m, 28), description: `FHIP TEST BANK ACCOUNT FEE${t}`, amount: -5 },
  ];
  const { csv, closingBalance } = bankCsv(rows, 20000);
  return {
    key: 'bank_oracle', filename: `fhip-test-bank-oracle-${m.year}-${pad(m.month)}${salt ? '-' + salt : ''}.csv`, contentType: 'text/csv', bytes: enc(csv),
    upload: bankUpload(m, salt),
    oracle: {
      rows: rows.length, openingBalance: 20000, closingBalance,
      salaryCredit: net, groceries: 200, refundOfGroceries: 20,
      transferToBroker: 10000, cardRepayment: 220, loanRepayment: 2000, saleProceeds: 15000, dividend: 400, cashWithdrawal: 100, fee: 5,
      expectations: [
        'payslip net + this salary credit = ONE income event (net ' + net + ')',
        'transfer to broker + broker BUY = household spending 0',
        'broker SELL 15,000 -> ordinary income 0',
        'dividend broker 400 + this bank 400 = one 400 income event',
        'card repayment 220 = liability settlement, NOT expense (card purchases 200+20 are the expense)',
        'loan repayment 2,000 = principal 1,550 (liability) + interest 430 + fee 20 (cost of debt 450); cash outflow 2,000 once',
        'cash withdrawal excluded from spending, shown as "Cash — spending unknown" (D-03)',
        'refund nets only with a CONFIRMED refund_original link (D-01)',
      ],
    },
  };
}

/** A scale statement with exactly `n` unique transaction rows (no two rows share date+description+amount). */
export function scaleBankStatement(m: Month, n: number, salt = ''): BuiltDocument {
  const rows: BankRow[] = [];
  const days = lastDay(m);
  let credits = 0; let debits = 0;
  for (let i = 0; i < n; i++) {
    const day = 1 + (i % days);
    const isCredit = i % 10 === 0;
    const cents = 1000 + ((i * 7919) % 90000); // 10.00 .. 909.99, deterministic
    const amount = (isCredit ? 1 : -1) * cents / 100;
    if (isCredit) credits += cents; else debits += cents;
    rows.push({ date: iso(m, day), description: `FHIP TEST MERCHANT ${String(i + 1).padStart(5, '0')}${saltTag(salt)}`, amount });
  }
  const { csv, closingBalance } = bankCsv(rows, 100000);
  return {
    key: `bank_scale_${n}`, filename: `fhip-test-bank-scale-${n}-${m.year}-${pad(m.month)}${salt ? '-' + salt : ''}.csv`, contentType: 'text/csv', bytes: enc(csv),
    upload: bankUpload(m, salt),
    oracle: { rows: n, dataLines: n, fileLines: n + 1, openingBalance: 100000, closingBalance, totalCredits: credits / 100, totalDebits: debits / 100, expectations: [`exactly ${n} transactions persisted, none truncated`, 'the same file uploaded twice -> 0 new transactions / 0 duplicate effects'] },
  };
}

// ---------------------------------------------------------------------------------------------------
// CREDIT CARD + LOAN (FDH-10 generic AU adapters; balances are user-declared at upload)
// ---------------------------------------------------------------------------------------------------
export function creditCardStatement(m: Month, salt = ''): BuiltDocument {
  const t = saltTag(salt);
  const csv = [
    'Transaction Date,Description,Amount,Transaction Type,Merchant',
    `${dmy(m, 14)},FHIP TEST GROCER${t},200.00,Purchase,FHIP Test Grocer`,
    `${dmy(m, 18)},FHIP TEST CAFE${t},20.00,Purchase,FHIP Test Cafe`,
    `${dmy(m, 22)},Payment Received - Thank You${t},220.00,Payment,`,
  ].join('\n') + '\n';
  return {
    key: 'card', filename: `fhip-test-card-${m.year}-${pad(m.month)}${salt ? '-' + salt : ''}.csv`, contentType: 'text/csv', bytes: enc(csv),
    upload: {
      panel: 'Liabilities -> Import statement (components/liabilities/LiabilityImportPanel.tsx)',
      route: 'POST /api/financial-data-hub/liability-statement/upload?<query>  (Content-Type: text/csv)',
      query: {
        statement_type: 'credit_card', country_code: 'AU', currency_code: 'AUD', institution_name: 'FHIP Test Card',
        masked_identifier: masked(salt, 8765), statement_period_start: iso(m, 1), statement_period_end: iso(m, 31),
        statement_date: iso(m, 31), due_date: iso({ year: m.month === 12 ? m.year + 1 : m.year, month: m.month === 12 ? 1 : m.month + 1 }, 15),
        opening_balance: '0.00', closing_balance: '0.00', credit_limit: '5000.00', minimum_payment: '0.00',
      },
      then: ['POST .../liability-statement/<documentId>/process', 'POST .../<documentId>/match-payment (bank debit 220)', 'POST .../<documentId>/approve', 'POST .../<documentId>/proposal', 'POST /api/financial-data-hub/liability-proposals/<proposalId>/apply'],
    },
    oracle: { purchases: 220, payment: 220, openingBalance: 0, closingBalance: 0, expectations: ['household expense 220, never 440', 'repayment 220 is a liability settlement linked to the bank debit', 'repeat Apply -> no duplicate rows'] },
  };
}

export function loanStatement(m: Month, salt = ''): BuiltDocument {
  const t = saltTag(salt);
  const csv = [
    'Payment Date,Description,Amount,Type,Principal,Interest,Fee',
    `${dmy(m, 15)},Monthly Repayment${t},2000.00,Repayment,1550.00,430.00,20.00`,
  ].join('\n') + '\n';
  return {
    key: 'loan', filename: `fhip-test-home-loan-${m.year}-${pad(m.month)}${salt ? '-' + salt : ''}.csv`, contentType: 'text/csv', bytes: enc(csv),
    upload: {
      panel: 'Liabilities -> Import statement (components/liabilities/LiabilityImportPanel.tsx)',
      route: 'POST /api/financial-data-hub/liability-statement/upload?<query>  (Content-Type: text/csv)',
      query: {
        statement_type: 'loan', country_code: 'AU', currency_code: 'AUD', institution_name: 'FHIP Test Home Loan',
        masked_identifier: masked(salt, 5555), statement_period_start: iso(m, 1), statement_period_end: iso(m, 31), statement_date: iso(m, 31),
        opening_balance: '400000.00', closing_balance: '398450.00', interest_rate: '6.14',
      },
      then: ['process', 'match-payment (bank debit 2,000)', 'approve', 'proposal', 'liability-proposals/<id>/apply'],
    },
    oracle: { payment: 2000, principal: 1550, interest: 430, fee: 20, costOfDebt: 450, openingBalance: 400000, closingBalance: 398450, expectations: ['cost of debt 450 (interest + fee)', 'principal 1,550 reduces the liability, is not expense', 'debt service / cash outflow 2,000 counted once (D-09)'] },
  };
}

// ---------------------------------------------------------------------------------------------------
// AU BROKER (FDH-11 generic transaction + portfolio CSVs)
// ---------------------------------------------------------------------------------------------------
export function brokerTransactionStatement(m: Month, salt = ''): BuiltDocument {
  const csv = [
    'Date,Type,Code,Security Name,Quantity,Price,Amount,Brokerage,Settlement Date,Franking Credit,Withholding Tax',
    `${dmy(m, 4)},CASH_DEPOSIT,,,,,10000.00,,,,`,
    `${dmy(m, 5)},BUY,BHP,BHP Group Ltd,200,49.90,9980.00,19.95,${dmy(m, 7)},,`,
    `${dmy(m, 18)},SELL,CBA,Commonwealth Bank,100,150.00,15000.00,29.95,${dmy(m, 20)},,`,
    `${dmy(m, 25)},DIVIDEND,BHP,BHP Group Ltd,,,400.00,,,171.43,0.00`,
  ].join('\n') + '\n';
  return {
    key: 'broker_transactions', filename: `fhip-test-broker-transactions-${m.year}-${pad(m.month)}${salt ? '-' + salt : ''}.csv`, contentType: 'text/csv', bytes: enc(csv),
    upload: {
      panel: 'Investments -> AU statement import (components/investments/AuInvestmentStatementImportPanel.tsx)',
      route: 'POST /api/financial-data-hub/investment-statement/upload?<query>  (Content-Type: text/csv)',
      query: { csv_kind: 'transaction', currency_code: 'AUD', institution_name: 'FHIP Test Broker', masked_account_identifier: masked(salt, 2468), statement_period_start: iso(m, 1), statement_period_end: iso(m, 31) },
      then: ['POST .../investment-statement/<documentId>/process {csv_kind}', 'POST .../<documentId>/bank-match', 'POST .../<documentId>/approve', 'POST .../<documentId>/apply', '"Add to Net Worth" confirm step (D-05)'],
    },
    oracle: { cashDeposit: 10000, buy: 9980, brokerage: 49.9, sell: 15000, dividend: 400, frankingCredit: 171.43, expectations: ['bank->broker 10,000 + BUY -> expense 0', 'SELL 15,000 -> ordinary income 0', 'dividend broker 400 + bank 400 -> one 400', 'broker cash is explicitly unsupported (E), shown with text (D-11)'] },
  };
}

export function brokerPortfolioStatement(m: Month, salt = ''): BuiltDocument {
  const csv = [
    'Security Name,Code,Quantity,Price,Market Value,Valuation Date',
    `BHP Group Ltd,BHP,200,50.00,10000.00,${dmy(m, 31)}`,
    `FHIP Test Diversified ETF${saltTag(salt)},FTE,100,25.00,2500.00,${dmy(m, 31)}`,
  ].join('\n') + '\n';
  return {
    key: 'broker_portfolio', filename: `fhip-test-broker-portfolio-${m.year}-${pad(m.month)}${salt ? '-' + salt : ''}.csv`, contentType: 'text/csv', bytes: enc(csv),
    upload: {
      panel: 'Investments -> AU statement import (components/investments/AuInvestmentStatementImportPanel.tsx)',
      route: 'POST /api/financial-data-hub/investment-statement/upload?<query>  (Content-Type: text/csv)',
      query: { csv_kind: 'portfolio', currency_code: 'AUD', institution_name: 'FHIP Test Broker', masked_account_identifier: masked(salt, 2468), statement_date: iso(m, 31) },
      then: ['process', 'approve', 'apply', '"Add to Net Worth" (D-05); holdings visible in Investments UI'],
    },
    oracle: { positions: 2, marketValue: 12500, expectations: ['imported holdings visible in Investments UI', 'Net Worth changes only after "Add to Net Worth"'] },
  };
}

// ---------------------------------------------------------------------------------------------------
// RETIREMENT (FDH-12 generic summary CSV; two funds for the rollover-neutral oracle)
// ---------------------------------------------------------------------------------------------------
export function retirementSummaryStatement(m: Month, fund: 'A' | 'B', salt = '', opts: { employerContribution?: number; rollover?: number } = {}): BuiltDocument {
  const period = `${iso(m, 1)} to ${iso(m, 31)}`;
  const rollover = opts.rollover ?? 30000;
  const employer = opts.employerContribution ?? 575;
  const items: [string, number][] = fund === 'A'
    ? [['Opening balance', rollover], ['Rollover out', rollover], ['Closing balance', 0]]
    : [['Opening balance', 100000], ['Employer contributions', employer], ['Rollover in', rollover], ['Investment earnings', 1200], ['Fees', 45], ['Contributions tax', employer * 0.15], ['Closing balance', 100000 + employer + rollover + 1200 - 45 - employer * 0.15]];
  const csv = ['Item,Amount,Period', ...items.map(([k, v]) => `${k},${money(v)},${period}`)].join('\n') + '\n';
  const closing = items.find(([k]) => k === 'Closing balance')![1];
  return {
    key: `retirement_fund_${fund}`, filename: `fhip-test-super-fund-${fund}-${m.year}-${pad(m.month)}${salt ? '-' + salt : ''}.csv`, contentType: 'text/csv', bytes: enc(csv),
    upload: {
      panel: 'Retirement -> Import Statement (components/retirement/RetirementStatementImportPanel.tsx)',
      route: 'POST /api/financial-data-hub/retirement-statement/upload?<query>  (Content-Type: text/csv)',
      query: { jurisdiction: 'AU', currency_code: 'AUD', fund_name: `FHIP Test Super Fund ${fund}`, masked_account_identifier: masked(salt, fund === 'A' ? 1111 : 2222), statement_period_start: iso(m, 1), statement_period_end: iso(m, 31) },
      then: ['process', 'account-match', 'evidence-matches', 'approve', 'proposal', 'bank-leg (if asked)', 'apply with ticked fields (D-12)'],
    },
    oracle: { fund, closingBalance: Math.round(closing * 100) / 100, employerContribution: fund === 'B' ? employer : 0, rollover, expectations: fund === 'A'
      ? ['rollover out of A + rollover into B -> income 0 / expense 0 / net worth 0']
      : ['closing balance -> retirement_accounts (summary register, not a ledger)', `employer super ${employer} on payslip + fund = ONE effect, never income`, 'contributions/earnings/fees/tax visible as statement evidence'] },
  };
}

// ---------------------------------------------------------------------------------------------------
// PAYSLIP (FDH-9 generic text layout rendered to a real PDF)
// ---------------------------------------------------------------------------------------------------
export interface PayslipParams { gross?: number; bonus?: number; tax?: number; employerSuper?: number; ytdMonths?: number }

export function payslipLines(m: Month, salt = '', p: PayslipParams = {}): string[] {
  const base = p.gross ?? 6700;
  const bonus = p.bonus ?? 0;
  const gross = base + bonus;
  const tax = p.tax ?? 1700;
  const net = gross - tax;
  const sup = p.employerSuper ?? 575;
  const ytd = Math.max(1, p.ytdMonths ?? 2);
  const f = (n: number) => n.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const row = (label: string, cur: number, y?: number) => `${label.padEnd(26)}${f(cur).padStart(12)}${y === undefined ? '' : f(y).padStart(18)}`;
  return [
    'FHIP TEST EMPLOYER PTY LTD',
    'Payslip',
    'Employer: FHIP Test Employer Pty Ltd',
    'ABN 00 000 000 000',
    `Employee: Test Person Alpha${saltTag(salt)}`,
    `Pay Period: ${dmy(m, 1)} - ${dmy(m, 31)}`,
    `Payment Date: ${dmy(m, 1)}`,
    'Pay Frequency: Monthly',
    '',
    `${'Description'.padEnd(26)}${'This Period'.padStart(12)}${'Year to Date'.padStart(18)}`,
    row('Base Salary', base, base * ytd),
    ...(bonus ? [row('Bonus', bonus, bonus)] : []),
    row('Total Earnings', gross, base * ytd + bonus),
    '',
    'Deductions',
    row('PAYG Withholding', tax, tax * ytd),
    row('Total Deductions', tax),
    '',
    row('Net Pay', net, net * ytd),
    '',
    'Superannuation',
    row('Employer Superannuation', sup, sup * ytd),
  ];
}

export function payslipPdf(m: Month, salt = '', p: PayslipParams = {}): BuiltDocument {
  const gross = (p.gross ?? 6700) + (p.bonus ?? 0);
  const tax = p.tax ?? 1700;
  const bytes = new Uint8Array(buildMinimalTextPdf([payslipLines(m, salt, p)]));
  return {
    key: 'payslip', filename: `fhip-test-payslip-${m.year}-${pad(m.month)}${salt ? '-' + salt : ''}.pdf`, contentType: 'application/pdf', bytes,
    upload: {
      panel: 'Income -> Import payslip (components/income/PayslipImportPanel.tsx)',
      route: 'POST /api/financial-data-hub/documents/upload-sessions {source_type:"pdf_native", ...panel body} then POST .../upload-sessions/<sessionId>/complete (Content-Type: application/pdf, body = file)',
      query: {},
      then: ['POST /api/financial-data-hub/payslip/<documentId>/process', 'POST .../payslip/<documentId>/approve', 'POST .../payslip/<documentId>/proposal', 'POST /api/financial-data-hub/income-proposals/<proposalId>/apply'],
    },
    oracle: { gross, tax, net: gross - tax, employerSuper: p.employerSuper ?? 575, bonus: p.bonus ?? 0, paymentDate: iso(m, 1), frequency: 'monthly', expectations: ['current period != current + YTD', 'payslip net + matching bank salary credit = ONE income event, in either upload order', 'employer super never becomes income', 'bonus is a dated one-off ACTUAL (D-06)'] },
  };
}

/** The whole oracle pack for one household-month. */
export function oraclePack(m: Month, salt = ''): BuiltDocument[] {
  return [
    payslipPdf(m, salt),
    oracleBankStatement(m, salt),
    creditCardStatement(m, salt),
    loanStatement(m, salt),
    brokerTransactionStatement(m, salt),
    brokerPortfolioStatement(m, salt),
    retirementSummaryStatement(m, 'A', salt),
    retirementSummaryStatement(m, 'B', salt),
  ];
}
