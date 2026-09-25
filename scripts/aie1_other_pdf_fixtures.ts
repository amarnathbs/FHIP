/**
 * AIE other-PDF AI proof (2026-09-25) -- SYNTHETIC "AI-needed" fixtures, one
 * per document type, each with INDEPENDENTLY hand-computed expected values
 * (arithmetic in the comments, never read back from any parser or model).
 *
 * Every person, institution, number, address and amount is invented. Each
 * fixture plants synthetic personal details so the masking step is exercised
 * on the real request path; `planted` lists them so a check can prove none of
 * them reached (or came back from) the model.
 *
 * WHY THE DETERMINISTIC PARSERS CANNOT READ THESE. They are written as a
 * letter in sentences -- no column table, no header row, no per-line
 * date/amount/balance grid -- so no layout adapter can segment them. Nothing
 * in any parser was changed to make them fail.
 */
import { buildMinimalTextPdf } from '../tests/support/buildMinimalPdf';

export const PLANTED_PII = {
  name: 'Zelda Quarrington',
  email: 'zelda.q@example.invalid',
  mobile: '0412 555 019',
  address: '12 Imaginary Lane, Nowhere NSW 2999',
  bsbAccount: '062-000 12345678',
  tfn: '123 456 782',
  memberNumber: '99887766',
  hin: 'X0001234567',
} as const;

function piiHeader(extra: string[] = []): string[] {
  return [
    `Name: ${PLANTED_PII.name}`,
    `Address: ${PLANTED_PII.address}`,
    `Email: ${PLANTED_PII.email}`,
    `Mobile: ${PLANTED_PII.mobile}`,
    ...extra,
  ];
}

// ---------------------------------------------------------------- bank (PDF)
/**
 * EXPECTED (by hand):
 *   opening 2,000.00
 *   2026-08-03 credit 1,850.00  (salary)
 *   2026-08-07 debit    950.00  (rent)
 *   2026-08-12 debit    123.45  (groceries)
 *   closing = 2,000.00 + 1,850.00 - 950.00 - 123.45 = 2,776.55
 *   period 2026-08-01 .. 2026-08-31; 3 transactions; debits 1,073.45; credits 1,850.00
 */
export const BANK_EXPECTED = {
  openingBalance: 2000,
  closingBalance: 2776.55,
  periodStart: '2026-08-01',
  periodEnd: '2026-08-31',
  transactions: [
    { date: '2026-08-03', amount: 1850, direction: 'credit' },
    { date: '2026-08-07', amount: 950, direction: 'debit' },
    { date: '2026-08-12', amount: 123.45, direction: 'debit' },
  ],
  debits: 1073.45,
  credits: 1850,
} as const;

export function bankLetterPdf(runTag: string, opts: { closingPrinted?: string } = {}): Buffer {
  const closing = opts.closingPrinted ?? '2776.55';
  return buildMinimalTextPdf([[
    'Harbourline Mutual Bank (synthetic test institution)',
    'Everyday account letter',
    ...piiHeader([`BSB/Account: ${PLANTED_PII.bsbAccount}`]),
    'This letter covers your everyday account from 1 August 2026 to 31 August 2026.',
    'You began the month with 2000.00 in the account.',
    'On 3 August 2026 your employer, Synthetic Works Pty Ltd, paid in 1850.00 as salary.',
    'On 7 August 2026 you paid 950.00 to Imaginary Realty for rent.',
    'On 12 August 2026 you spent 123.45 at Fictional Grocer.',
    `You finished the month with ${closing} in the account.`,
    `Reference: ${runTag}`,
  ]]);
}

/** NON-RECONCILING variant: the printed closing balance is 2,800.00, but the
 * printed lines give 2,776.55 (variance 23.45). The model must report 2,800.00
 * as printed, and the deterministic reconciliation must then FAIL -- the
 * figure stays unresolved; nothing is balanced. */
export const BANK_NON_RECONCILING_PRINTED_CLOSING = 2800;
export const BANK_NON_RECONCILING_VARIANCE = 23.45;

/** INSUFFICIENT variant: balances only, no transaction lines at all. A
 * faithful read has zero transactions, which the adapter refuses to offer as a
 * draft (`insufficient_fields`) -- nothing may be written. */
export function bankNoTransactionsPdf(runTag: string): Buffer {
  return buildMinimalTextPdf([[
    'Harbourline Mutual Bank (synthetic test institution)',
    'Balance confirmation letter',
    ...piiHeader([`BSB/Account: ${PLANTED_PII.bsbAccount}`]),
    'We confirm that on 31 August 2026 the balance of your everyday account was 2776.55.',
    'This letter is a balance confirmation only and does not list any transactions.',
    `Reference: ${runTag}`,
  ]]);
}

// ----------------------------------------------------- liability (CSV only)
/**
 * The liability, retirement and AU-investment upload surfaces accept CSV
 * only (their panels' file pickers are CSV-only and their services refuse a
 * PDF before any text is read). Their AI fallback therefore runs on an
 * unreadable CSV export, and these fixtures are CSV files whose "rows" are
 * sentences.
 *
 * EXPECTED (by hand), credit card:
 *   opening 500.00
 *   2026-07-05 PURCHASE  85.40
 *   2026-07-09 PURCHASE  42.10
 *   2026-07-15 PAYMENT  200.00
 *   closing = 500.00 + 85.40 + 42.10 - 200.00 = 427.50
 *   purchases 127.50, payments 200.00
 */
export const LIABILITY_EXPECTED = {
  openingBalance: 500,
  closingBalance: 427.5,
  purchases: 127.5,
  payments: 200,
  activities: [
    { date: '2026-07-05', type: 'PURCHASE', amount: 85.4 },
    { date: '2026-07-09', type: 'PURCHASE', amount: 42.1 },
    { date: '2026-07-15', type: 'PAYMENT', amount: 200 },
  ],
} as const;

export function liabilityLetterCsv(runTag: string): Buffer {
  return Buffer.from([
    'Synthetic Card Co - card account letter (synthetic test institution)',
    `Card holder: ${PLANTED_PII.name}`,
    `Email: ${PLANTED_PII.email}`,
    `Mobile: ${PLANTED_PII.mobile}`,
    'Statement period 1 July 2026 to 31 July 2026. You owed 500.00 at the start of the period',
    'On 5 July 2026 you made a purchase of 85.40 at Fictional Grocer',
    'On 9 July 2026 you made a purchase of 42.10 at Imaginary Pharmacy',
    'On 15 July 2026 we received your payment of 200.00 - thank you',
    'At the end of the period you owed 427.50',
    `Reference ${runTag}`,
    '',
  ].join('\n'));
}

// ---------------------------------------------------- retirement (CSV only)
/**
 * EXPECTED (by hand), super:
 *   opening 10,000.00
 *   2026-07-01 EMPLOYER_CONTRIBUTION 500.00
 *   2026-07-15 PERSONAL_CONTRIBUTION 200.00
 *   2026-07-31 FEE                    12.50
 *   closing = 10,000.00 + 500.00 + 200.00 - 12.50 = 10,687.50
 */
export const RETIREMENT_EXPECTED = {
  openingBalance: '10000.00',
  closingBalance: '10687.50',
  activities: [
    { type: 'EMPLOYER_CONTRIBUTION', amount: '500.00' },
    { type: 'PERSONAL_CONTRIBUTION', amount: '200.00' },
    { type: 'FEE', amount: '12.50' },
  ],
} as const;

export function retirementLetterCsv(runTag: string): Buffer {
  return Buffer.from([
    'Imaginary Super Fund - member letter (synthetic test fund)',
    `Member: ${PLANTED_PII.name}`,
    `Member number: ${PLANTED_PII.memberNumber}`,
    `TFN: ${PLANTED_PII.tfn}`,
    `Email: ${PLANTED_PII.email}`,
    'This letter covers 1 July 2026 to 31 July 2026. Your balance on 1 July 2026 was 10000.00',
    'On 1 July 2026 your employer Synthetic Works Pty Ltd paid a super guarantee contribution of 500.00',
    'On 15 July 2026 you made a personal after-tax contribution of 200.00',
    'On 31 July 2026 an administration fee of 12.50 was deducted',
    'Your balance on 31 July 2026 was 10687.50',
    `Reference ${runTag}`,
    '',
  ].join('\n'));
}

// ------------------------------------------------ AU investment (CSV only)
/**
 * EXPECTED (by hand), broker:
 *   2026-07-02 BUY 50 x 40.00 = 2,000.00, brokerage 9.95
 *   2026-07-20 DIVIDEND 120.00
 */
export const INVESTMENT_EXPECTED = {
  buy: { date: '2026-07-02', quantity: '50', unitPrice: '40.00', amount: '2000.00', brokerage: '9.95' },
  dividend: { date: '2026-07-20', amount: '120.00' },
} as const;

export function investmentLetterCsv(runTag: string): Buffer {
  return Buffer.from([
    'Imaginary Broking - activity letter (synthetic test broker)',
    `Client: ${PLANTED_PII.name}`,
    `Your account HIN ${PLANTED_PII.hin}`,
    `Email: ${PLANTED_PII.email}`,
    'On 2 July 2026 you bought 50 shares of SYNTHETIC LTD (code SYN) at 40.00 each for 2000.00 plus brokerage of 9.95',
    'On 20 July 2026 SYNTHETIC LTD paid you a cash dividend of 120.00',
    `Reference ${runTag}`,
    '',
  ].join('\n'));
}
