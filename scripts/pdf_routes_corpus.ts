/**
 * SYNTHETIC ACCURACY CORPUS for the PDF routes of liability, retirement and Australian investment statements
 * (docs/ai/pdf_routes_liab_ret_auinv/).
 *
 * Written BEFORE the readers. Every person, institution, security, number and address is INVENTED; no real PAN, TFN,
 * account or card number appears (the numbers shown are made-up and fail their real check digits on purpose). Planted
 * "personal" details exist only to prove the masking step on the real request path.
 *
 * DETERMINISTIC: the same bytes on every run (no timestamp, no random tag). The SHA-256 of each file is in
 * docs/ai/pdf_routes_liab_ret_auinv/corpus/MANIFEST.sha256 and a test regenerates the files and compares.
 *
 * EXPECTED VALUES are written by hand in this file, with the arithmetic in the comment next to each document. They
 * are NEVER read back from a parser or a model. tests/unit/pdfRoutesCorpus.test.ts recomputes every identity in
 * integer cents, independently of every reader, and checks that each expected figure is printed on its page.
 *
 *   npx tsx scripts/pdf_routes_corpus.ts <output-folder>      writes the PDFs, MANIFEST.sha256 and EXPECTED_VALUES.md
 *
 * Needs NO environment variable, NO network and NO credential.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { buildMinimalTextPdf } from '../tests/support/buildMinimalPdf';

export type CorpusClass = 'liability' | 'retirement' | 'au_investment';
export type CorpusRole = 'clean' | 'needs_fallback' | 'wrong_on_page' | 'multi' | 'trap' | 'negative_control';

/** What the deterministic reader MUST do with the file (the legitimate outcome, never forced by breaking the reader). */
export type DeterministicExpectation = 'reads' | 'layout_unsupported' | 'unread_lines' | 'not_this_class' | 'multiple_accounts';

export interface RouteExpectation {
  deterministic: DeterministicExpectation;
  /** True when only the AI fallback can produce a draft (the deterministic reader legitimately cannot read it). */
  aiRequired: boolean;
  /** The reconciliation verdict of a correct reading (the writer's own vocabulary), or null when nothing is written. */
  reconciliation: 'reconciled' | 'variance' | 'insufficient_data' | null;
  /** certified = deterministic, reconciled, no warning. review_required = everything else that is written. refused = nothing written. */
  outcome: 'certified' | 'review_required' | 'refused';
}

export interface CorpusDocBase {
  id: string;
  cls: CorpusClass;
  filename: string;
  role: CorpusRole;
  /** One line in plain words. */
  summary: string;
  /** What the person chooses on the screen before uploading. */
  declared: Record<string, string>;
  pages: string[][];
  /** Synthetic personal details printed in the text; none may survive masking. */
  planted: readonly string[];
  route: RouteExpectation;
  /** Arithmetic shown by hand, line by line. */
  hand: readonly string[];
}

// ---------------------------------------------------------------------------------------------------------------
// LIABILITY
// ---------------------------------------------------------------------------------------------------------------

export type LiabilityType = 'PURCHASE' | 'REFUND' | 'PAYMENT' | 'CASH_ADVANCE' | 'INTEREST' | 'FEE' | 'PRINCIPAL' | 'LOAN_ADVANCE' | 'ADJUSTMENT' | 'OTHER';
export interface LiabilityExpectedActivity { date: string; type: LiabilityType; amount: number }
export interface LiabilityExpected {
  statementType: 'credit_card' | 'loan';
  institution: string;
  last4: string;
  periodStart: string;
  periodEnd: string;
  /** Present only when the page prints it. */
  statementDate?: string;
  dueDate?: string;
  opening: number;
  /** The closing balance the PAGE prints. */
  printedClosing: number;
  /** The closing balance the LINES give (equal to printedClosing unless the page is wrong). */
  closingByLines: number;
  creditLimit?: number;
  minimumPayment?: number;
  interestRate?: number;
  activities: readonly LiabilityExpectedActivity[];
}
export interface LiabilityDoc extends CorpusDocBase {
  cls: 'liability';
  expected: LiabilityExpected | null;
}

const PII_CARD = (name: string, email: string, phone: string): string[] => [
  `Account holder: ${name}`,
  'Address: 14 Imaginary Street, Exampleton NSW 2000',
  `Email: ${email}`,
  `Phone: ${phone}`,
];

/**
 * LB-01 clean credit card statement (layout CARD-1).
 *   purchases 84.20 + 61.35 + 329.00 = 474.55
 *   opening 1,250.40 + purchases 474.55 + cash advance 200.00 + interest 27.85 + fees 4.00 - payments 500.00 - refunds 49.00
 *   = 1,250.40 + 474.55 = 1,724.95; + 200.00 = 1,924.95; + 27.85 = 1,952.80; + 4.00 = 1,956.80; - 500.00 = 1,456.80; - 49.00 = 1,407.80
 */
const LB01: LiabilityDoc = {
  id: 'LB-01', cls: 'liability', filename: 'LB-01_credit_card_clean_wattlebird_jul2026.pdf', role: 'clean',
  summary: 'Clean credit card statement in the certified card layout; reconciles to the cent.',
  declared: { statement_type: 'credit_card', country: 'AU', currency: 'AUD' },
  planted: ['JORDAN SAMPLE-ONE', 'jordan.sample.one@example.invalid', '0400 000 001', '5999 0000 1111 4821', '14 Imaginary Street'],
  route: { deterministic: 'reads', aiRequired: false, reconciliation: 'reconciled', outcome: 'certified' },
  pages: [[
    'Wattlebird Credit Union',
    'CREDIT CARD STATEMENT',
    ...PII_CARD('JORDAN SAMPLE-ONE', 'jordan.sample.one@example.invalid', '0400 000 001'),
    'Card number: 5999 0000 1111 4821',
    'Statement period: 01/07/2026 to 31/07/2026',
    'Statement date: 31/07/2026',
    'Payment due date: 25/08/2026',
    'Credit limit: $8,000.00',
    'Opening balance: $1,250.40',
    'Date Description Amount',
    '03/07/2026 FICTIONAL GROCER 84.20',
    '06/07/2026 SAMPLE FUEL STOP 61.35',
    '09/07/2026 PAYMENT RECEIVED - THANK YOU 500.00 CR',
    '14/07/2026 IMAGINARY APPLIANCES 329.00',
    '17/07/2026 REFUND IMAGINARY APPLIANCES 49.00 CR',
    '21/07/2026 CASH ADVANCE ATM SAMPLE 200.00',
    '21/07/2026 CASH ADVANCE FEE 4.00',
    '28/07/2026 INTEREST CHARGES 27.85',
    'Closing balance: $1,407.80',
    'Minimum payment: $35.00',
  ]],
  hand: [
    'purchases 84.20 + 61.35 + 329.00 = 474.55',
    'opening 1,250.40 + 474.55 = 1,724.95; + cash advance 200.00 = 1,924.95; + interest 27.85 = 1,952.80; + fee 4.00 = 1,956.80',
    '- payment 500.00 = 1,456.80; - refund 49.00 = 1,407.80 = printed closing',
  ],
  expected: {
    statementType: 'credit_card', institution: 'Wattlebird Credit Union', last4: '4821', periodStart: '2026-07-01', periodEnd: '2026-07-31',
    statementDate: '2026-07-31', dueDate: '2026-08-25', opening: 1250.4, printedClosing: 1407.8, closingByLines: 1407.8, creditLimit: 8000, minimumPayment: 35,
    activities: [
      { date: '2026-07-03', type: 'PURCHASE', amount: 84.2 },
      { date: '2026-07-06', type: 'PURCHASE', amount: 61.35 },
      { date: '2026-07-09', type: 'PAYMENT', amount: 500 },
      { date: '2026-07-14', type: 'PURCHASE', amount: 329 },
      { date: '2026-07-17', type: 'REFUND', amount: 49 },
      { date: '2026-07-21', type: 'CASH_ADVANCE', amount: 200 },
      { date: '2026-07-21', type: 'FEE', amount: 4 },
      { date: '2026-07-28', type: 'INTEREST', amount: 27.85 },
    ],
  },
};

/**
 * LB-02 clean home loan statement (layout LOAN-1, running balance after each line).
 *   412,300.00 - 2,650.00 = 409,650.00; - 2,650.00 = 407,000.00; + 2,142.50 = 409,142.50; + 8.00 = 409,150.50
 *   check by identity: 412,300.00 + (2,142.50 + 8.00) - (2,650.00 + 2,650.00) = 412,300.00 + 2,150.50 - 5,300.00 = 409,150.50
 */
const LB02: LiabilityDoc = {
  id: 'LB-02', cls: 'liability', filename: 'LB-02_home_loan_clean_pelican_bay_aug2026.pdf', role: 'clean',
  summary: 'Clean home loan statement in the certified loan layout (running balance after every line); reconciles to the cent.',
  declared: { statement_type: 'loan', facility_type: 'home_loan', country: 'AU', currency: 'AUD' },
  planted: ['ALEX SAMPLE-TWO', 'alex.sample.two@example.invalid', '0 Imaginary Court'],
  route: { deterministic: 'reads', aiRequired: false, reconciliation: 'reconciled', outcome: 'certified' },
  pages: [[
    'Pelican Bay Home Loans',
    'HOME LOAN STATEMENT',
    'Borrower: ALEX SAMPLE-TWO',
    'Address: 0 Imaginary Court, Exampleton VIC 3000',
    'Email: alex.sample.two@example.invalid',
    'Loan account: 0099 7712',
    'Statement period: 01/08/2026 to 31/08/2026',
    'Statement date: 31/08/2026',
    'Interest rate: 6.29% p.a.',
    'Opening balance: $412,300.00',
    'Date Description Amount Balance',
    '05/08/2026 REPAYMENT RECEIVED 2,650.00 409,650.00',
    '19/08/2026 REPAYMENT RECEIVED 2,650.00 407,000.00',
    '31/08/2026 INTEREST CHARGED 2,142.50 409,142.50',
    '31/08/2026 ACCOUNT KEEPING FEE 8.00 409,150.50',
    'Closing balance: $409,150.50',
  ]],
  hand: [
    '412,300.00 - 2,650.00 = 409,650.00; - 2,650.00 = 407,000.00; + 2,142.50 = 409,142.50; + 8.00 = 409,150.50',
    'identity: 412,300.00 + (2,142.50 + 8.00) - (2,650.00 + 2,650.00) = 412,300.00 + 2,150.50 - 5,300.00 = 409,150.50',
  ],
  expected: {
    statementType: 'loan', institution: 'Pelican Bay Home Loans', last4: '7712', periodStart: '2026-08-01', periodEnd: '2026-08-31',
    statementDate: '2026-08-31', opening: 412300, printedClosing: 409150.5, closingByLines: 409150.5, interestRate: 6.29,
    activities: [
      { date: '2026-08-05', type: 'PAYMENT', amount: 2650 },
      { date: '2026-08-19', type: 'PAYMENT', amount: 2650 },
      { date: '2026-08-31', type: 'INTEREST', amount: 2142.5 },
      { date: '2026-08-31', type: 'FEE', amount: 8 },
    ],
  },
};

/**
 * LB-03 credit card statement in a layout the certified reader legitimately cannot read: no "Date Description Amount"
 * table, dates have no year ("02 Aug"), debits and credits sit under section headings. A model must complete the year
 * from the printed period.
 *   debits 18.50 + 142.00 + 67.25 + 299.99 = 527.74 ; credit 842.10
 *   opening 842.10 + 527.74 - 842.10 = 527.74 = printed new balance
 */
const LB03: LiabilityDoc = {
  id: 'LB-03', cls: 'liability', filename: 'LB-03_credit_card_needs_fallback_heron_point_aug2026.pdf', role: 'needs_fallback',
  summary: 'Credit card statement with year-less dates and section headings; the certified reader cannot read it, the AI fallback must.',
  declared: { statement_type: 'credit_card', country: 'AU', currency: 'AUD' },
  planted: ['CASEY SAMPLE-THREE', 'casey.sample.three@example.invalid', '0400 000 003'],
  route: { deterministic: 'layout_unsupported', aiRequired: true, reconciliation: 'reconciled', outcome: 'review_required' },
  pages: [[
    'Heron Point Bank',
    'VISA CREDIT CARD - STATEMENT OF ACCOUNT',
    'Cardholder: CASEY SAMPLE-THREE',
    'Email: casey.sample.three@example.invalid',
    'Mobile: 0400 000 003',
    'Card ending 3305',
    'Statement from 1 Aug 2026 to 31 Aug 2026',
    'Credit limit $5,000.00',
    'Balance brought forward from last statement $842.10',
    'Purchases and charges',
    '02 Aug FICTIONAL CAFE 18.50',
    '05 Aug SAMPLE SUPERMARKET 142.00',
    '11 Aug IMAGINARY PHARMACY 67.25',
    '22 Aug FICTIONAL ELECTRONICS 299.99',
    'Payments and credits',
    '15 Aug PAYMENT - THANK YOU 842.10',
    'New balance $527.74',
    'Minimum payment due $25.00',
    'Payment due 21 Sep 2026',
  ]],
  hand: [
    'debits 18.50 + 142.00 = 160.50; + 67.25 = 227.75; + 299.99 = 527.74',
    'opening 842.10 + 527.74 = 1,369.84; - payment 842.10 = 527.74 = printed new balance',
  ],
  expected: {
    statementType: 'credit_card', institution: 'Heron Point Bank', last4: '3305', periodStart: '2026-08-01', periodEnd: '2026-08-31',
    dueDate: '2026-09-21', opening: 842.1, printedClosing: 527.74, closingByLines: 527.74, creditLimit: 5000, minimumPayment: 25,
    activities: [
      { date: '2026-08-02', type: 'PURCHASE', amount: 18.5 },
      { date: '2026-08-05', type: 'PURCHASE', amount: 142 },
      { date: '2026-08-11', type: 'PURCHASE', amount: 67.25 },
      { date: '2026-08-22', type: 'PURCHASE', amount: 299.99 },
      { date: '2026-08-15', type: 'PAYMENT', amount: 842.1 },
    ],
  },
};

/**
 * LB-04 WRONG ON THE PAGE: CARD-1 layout, but the printed closing balance is not what the lines give (digits slipped).
 *   by lines: 2,010.00 + 120.40 = 2,130.40; + 85.60 = 2,216.00; + 33.10 = 2,249.10; - 300.00 = 1,949.10
 *   the page prints 1,993.05 ; difference (lines - printed) = 1,949.10 - 1,993.05 = -43.95
 */
const LB04: LiabilityDoc = {
  id: 'LB-04', cls: 'liability', filename: 'LB-04_credit_card_wrong_on_page_mallee_ridge_jul2026.pdf', role: 'wrong_on_page',
  summary: 'Certified card layout, but the page prints a closing balance 43.95 away from its own lines; must be read as printed and must NOT certify.',
  declared: { statement_type: 'credit_card', country: 'AU', currency: 'AUD' },
  planted: ['MORGAN SAMPLE-FOUR', '5999 0000 2222 7390'],
  route: { deterministic: 'reads', aiRequired: false, reconciliation: 'variance', outcome: 'review_required' },
  pages: [[
    'Mallee Ridge Bank',
    'CREDIT CARD STATEMENT',
    'Account holder: MORGAN SAMPLE-FOUR',
    'Card number: 5999 0000 2222 7390',
    'Statement period: 01/07/2026 to 31/07/2026',
    'Statement date: 31/07/2026',
    'Payment due date: 24/08/2026',
    'Credit limit: $10,000.00',
    'Opening balance: $2,010.00',
    'Date Description Amount',
    '08/07/2026 SAMPLE HARDWARE 120.40',
    '12/07/2026 PAYMENT RECEIVED - THANK YOU 300.00 CR',
    '19/07/2026 FICTIONAL GARDEN SUPPLIES 85.60',
    '27/07/2026 INTEREST CHARGES 33.10',
    'Closing balance: $1,993.05',
    'Minimum payment: $40.00',
  ]],
  hand: [
    'by the lines: 2,010.00 + 120.40 = 2,130.40; + 85.60 = 2,216.00; + 33.10 = 2,249.10; - 300.00 = 1,949.10',
    'the page prints 1,993.05; lines minus printed = 1,949.10 - 1,993.05 = -43.95 (variance)',
  ],
  expected: {
    statementType: 'credit_card', institution: 'Mallee Ridge Bank', last4: '7390', periodStart: '2026-07-01', periodEnd: '2026-07-31',
    statementDate: '2026-07-31', dueDate: '2026-08-24', opening: 2010, printedClosing: 1993.05, closingByLines: 1949.1, creditLimit: 10000, minimumPayment: 40,
    activities: [
      { date: '2026-07-08', type: 'PURCHASE', amount: 120.4 },
      { date: '2026-07-12', type: 'PAYMENT', amount: 300 },
      { date: '2026-07-19', type: 'PURCHASE', amount: 85.6 },
      { date: '2026-07-27', type: 'INTEREST', amount: 33.1 },
    ],
  },
};

/**
 * LB-05 MULTI-ACCOUNT: two cards (two identifiers, two opening balances, two closing balances) in one PDF. One statement
 * row cannot hold two accounts, so the route refuses and asks for one account at a time. Nothing is written, no AI.
 *   card 1: 500.00 + 60.00 = 560.00 ; card 2: 120.00 + 12.50 = 132.50
 */
const LB05: LiabilityDoc = {
  id: 'LB-05', cls: 'liability', filename: 'LB-05_credit_card_two_accounts_quokka_coast_jul2026.pdf', role: 'multi',
  summary: 'Two separate card accounts in one PDF; refused with "one account at a time", nothing written, no AI.',
  declared: { statement_type: 'credit_card', country: 'AU', currency: 'AUD' },
  planted: ['5999 0000 3333 1101', '5999 0000 4444 2202'],
  route: { deterministic: 'multiple_accounts', aiRequired: false, reconciliation: null, outcome: 'refused' },
  pages: [[
    'Quokka Coast Bank',
    'CREDIT CARD STATEMENT',
    'Card number: 5999 0000 3333 1101',
    'Statement period: 01/07/2026 to 31/07/2026',
    'Opening balance: $500.00',
    'Date Description Amount',
    '05/07/2026 FICTIONAL BOOKS 60.00',
    'Closing balance: $560.00',
    'Card number: 5999 0000 4444 2202',
    'Statement period: 01/07/2026 to 31/07/2026',
    'Opening balance: $120.00',
    'Date Description Amount',
    '09/07/2026 SAMPLE CAFE 12.50',
    'Closing balance: $132.50',
  ]],
  hand: ['card 1: 500.00 + 60.00 = 560.00', 'card 2: 120.00 + 12.50 = 132.50'],
  expected: null,
};

/**
 * LB-06 TRAP (invented / dropped lines): date-led SUMMARY lines that look like activities (balance carried forward,
 * balance brought forward, total purchases, total fees and interest), a page break with a repeated header, and two
 * identical GENUINE lines (a deposit charged twice on the same day). Summary lines must not become activities; the
 * identical pair must both be kept (a de-duplicating reader would drop 255.00 and fail the identity).
 *   purchases 130.30 + 255.00 + 255.00 = 640.30 (the page's own "total purchases" line says 640.30)
 *   fees and interest 22.60 + 15.50 = 38.10 (the page's own line says 38.10)
 *   980.00 + 130.30 = 1,110.30 (carried forward); + 255.00 + 255.00 = 1,620.30; + 22.60 = 1,642.90; + 15.50 = 1,658.40; - 700.00 = 958.40
 */
const LB06: LiabilityDoc = {
  id: 'LB-06', cls: 'liability', filename: 'LB-06_credit_card_summary_lines_trap_bunyip_creek_jul2026.pdf', role: 'trap',
  summary: 'Two pages; date-led carried/brought-forward and total lines that must NOT be activities; two identical genuine lines that must BOTH be kept.',
  declared: { statement_type: 'credit_card', country: 'AU', currency: 'AUD' },
  planted: ['5999 0000 5555 6643'],
  route: { deterministic: 'reads', aiRequired: false, reconciliation: 'reconciled', outcome: 'certified' },
  pages: [
    [
      'Bunyip Creek Bank',
      'CREDIT CARD STATEMENT',
      'Card number: 5999 0000 5555 6643',
      'Statement period: 01/07/2026 to 31/07/2026',
      'Statement date: 31/07/2026',
      'Payment due date: 25/08/2026',
      'Credit limit: $6,000.00',
      'Opening balance: $980.00',
      'Date Description Amount',
      '04/07/2026 FICTIONAL PET SUPPLIES 130.30',
      '04/07/2026 BALANCE CARRIED FORWARD 1,110.30',
      'Continued on next page',
    ],
    [
      'Bunyip Creek Bank',
      'CREDIT CARD STATEMENT (continued)',
      'Date Description Amount',
      '04/07/2026 BALANCE BROUGHT FORWARD 1,110.30',
      '15/07/2026 SAMPLE FURNITURE DEPOSIT 255.00',
      '15/07/2026 SAMPLE FURNITURE DEPOSIT 255.00',
      '22/07/2026 PAYMENT RECEIVED - THANK YOU 700.00 CR',
      '29/07/2026 INTEREST CHARGES 22.60',
      '30/07/2026 ANNUAL FEE 15.50',
      '31/07/2026 TOTAL PURCHASES THIS PERIOD 640.30',
      '31/07/2026 TOTAL FEES AND INTEREST 38.10',
      'Closing balance: $958.40',
      'Minimum payment: $30.00',
    ],
  ],
  hand: [
    'purchases 130.30 + 255.00 + 255.00 = 640.30 (matches the printed total line)',
    'fees and interest 22.60 + 15.50 = 38.10 (matches the printed total line)',
    '980.00 + 130.30 = 1,110.30; + 510.00 = 1,620.30; + 22.60 = 1,642.90; + 15.50 = 1,658.40; - 700.00 = 958.40 = printed closing',
  ],
  expected: {
    statementType: 'credit_card', institution: 'Bunyip Creek Bank', last4: '6643', periodStart: '2026-07-01', periodEnd: '2026-07-31',
    statementDate: '2026-07-31', dueDate: '2026-08-25', opening: 980, printedClosing: 958.4, closingByLines: 958.4, creditLimit: 6000, minimumPayment: 30,
    activities: [
      { date: '2026-07-04', type: 'PURCHASE', amount: 130.3 },
      { date: '2026-07-15', type: 'PURCHASE', amount: 255 },
      { date: '2026-07-15', type: 'PURCHASE', amount: 255 },
      { date: '2026-07-22', type: 'PAYMENT', amount: 700 },
      { date: '2026-07-29', type: 'INTEREST', amount: 22.6 },
      { date: '2026-07-30', type: 'FEE', amount: 15.5 },
    ],
  },
};

/**
 * LB-07 TRAP (unreadable line): certified card layout, but one amount carries a footnote asterisk and a footnote line
 * sits inside the table. The certified reader must NOT drop or guess that line: it fails as unread lines and the fallback
 * reads it. A model that drops the 1,299.00 line fails the identity.
 *   300.00 + 45.00 = 345.00; + 1,299.00 = 1,644.00; - 300.00 = 1,344.00
 */
const LB07: LiabilityDoc = {
  id: 'LB-07', cls: 'liability', filename: 'LB-07_credit_card_footnote_amount_trap_currawong_jul2026.pdf', role: 'trap',
  summary: 'Card layout with a footnote asterisk on one amount and a footnote line inside the table; the certified reader must refuse to guess, the fallback must keep the 1,299.00 line.',
  declared: { statement_type: 'credit_card', country: 'AU', currency: 'AUD' },
  planted: ['5999 0000 6666 8819', 'drew.sample.five@example.invalid'],
  route: { deterministic: 'unread_lines', aiRequired: true, reconciliation: 'reconciled', outcome: 'review_required' },
  pages: [[
    'Currawong Finance Card',
    'CREDIT CARD STATEMENT',
    'Email: drew.sample.five@example.invalid',
    'Card number: 5999 0000 6666 8819',
    'Statement period: 01/07/2026 to 31/07/2026',
    'Statement date: 31/07/2026',
    'Payment due date: 24/08/2026',
    'Credit limit: $4,000.00',
    'Opening balance: $300.00',
    'Date Description Amount',
    '02/07/2026 SAMPLE GROCER 45.00',
    '18/07/2026 FICTIONAL ELECTRONICS 1,299.00*',
    '25/07/2026 PAYMENT RECEIVED - THANK YOU 300.00 CR',
    '* Amount is part of a 12 month interest free promotional plan',
    'Closing balance: $1,344.00',
    'Minimum payment: $50.00',
  ]],
  hand: ['300.00 + 45.00 = 345.00; + 1,299.00 = 1,644.00; - 300.00 = 1,344.00 = printed closing'],
  expected: {
    statementType: 'credit_card', institution: 'Currawong Finance Card', last4: '8819', periodStart: '2026-07-01', periodEnd: '2026-07-31',
    statementDate: '2026-07-31', dueDate: '2026-08-24', opening: 300, printedClosing: 1344, closingByLines: 1344, creditLimit: 4000, minimumPayment: 50,
    activities: [
      { date: '2026-07-02', type: 'PURCHASE', amount: 45 },
      { date: '2026-07-18', type: 'PURCHASE', amount: 1299 },
      { date: '2026-07-25', type: 'PAYMENT', amount: 300 },
    ],
  },
};

/** LB-08 NEGATIVE CONTROL: a bank transaction account statement is not a card or loan statement. Refused, no AI, nothing charged. */
const LB08: LiabilityDoc = {
  id: 'LB-08', cls: 'liability', filename: 'LB-08_negative_control_bank_account_statement_gumleaf_aug2026.pdf', role: 'negative_control',
  summary: 'A bank transaction account statement (not a card or loan statement): refused as not this kind of document, no AI call, nothing charged.',
  declared: { statement_type: 'credit_card', country: 'AU', currency: 'AUD' },
  planted: ['062-000 1234 5678'],
  route: { deterministic: 'not_this_class', aiRequired: false, reconciliation: null, outcome: 'refused' },
  pages: [[
    'Gumleaf Community Bank',
    'TRANSACTION ACCOUNT STATEMENT',
    'BSB: 062-000 Account number: 1234 5678',
    'Statement period: 01/08/2026 to 31/08/2026',
    'Opening balance: $3,215.40',
    'Date Description Debit Credit Balance',
    '03/08/2026 SALARY SYNTHETIC WORKS PTY LTD 2,450.00 5,665.40',
    '05/08/2026 RENT IMAGINARY REALTY 1,380.00 4,285.40',
    '09/08/2026 FICTIONAL GROCER 164.85 4,120.55',
    'Closing balance: $4,120.55',
  ]],
  hand: ['3,215.40 + 2,450.00 = 5,665.40; - 1,380.00 = 4,285.40; - 164.85 = 4,120.55'],
  expected: null,
};

export const LIABILITY_DOCS: readonly LiabilityDoc[] = [LB01, LB02, LB03, LB04, LB05, LB06, LB07, LB08];

// ---------------------------------------------------------------------------------------------------------------
// RETIREMENT
// ---------------------------------------------------------------------------------------------------------------

export interface RetirementExpectedOption { name: string; units: number; unitPrice: number; value: number }
export interface RetirementExpectedActivity { date: string; type: string; amount: number }
export interface RetirementExpected {
  jurisdiction: 'AU' | 'IN';
  currency: 'AUD' | 'INR';
  fund: string;
  last4: string;
  periodStart: string;
  periodEnd: string;
  opening: number;
  /** The closing balance the PAGE prints. */
  printedClosing: number;
  /** The closing balance the movement figures give. */
  closingByMovements: number;
  /** Period movement figures as positive magnitudes except earnings, which keep their sign. Only the ones printed. */
  employer?: number;
  personal?: number;
  salarySacrifice?: number;
  government?: number;
  rolloversIn?: number;
  earnings?: number;
  fees?: number;
  insurance?: number;
  tax?: number;
  withdrawals?: number;
  pensionPayments?: number;
  options: readonly RetirementExpectedOption[];
  /** Line form (transaction history layout); empty for the summary layout. */
  activities: readonly RetirementExpectedActivity[];
}
export interface RetirementDoc extends CorpusDocBase {
  cls: 'retirement';
  expected: RetirementExpected | null;
}

/**
 * RT-01 clean annual member statement (layout RET-1).
 *   fees 231.00 + 154.20 = 385.20
 *   48,210.55 + 7,820.00 = 56,030.55; + 1,000.00 = 57,030.55; + 500.00 = 57,530.55; + 4,012.30 = 61,542.85
 *   - 385.20 = 61,157.65; - 312.00 = 60,845.65; - 1,173.00 = 59,672.65
 *   options: 24,000.0000 x 1.6500 = 39,600.00 ; 12,500.0500 x 1.0000 = 12,500.05 ; 3,500.0000 x 2.1636 = 7,572.60
 *   39,600.00 + 12,500.05 = 52,100.05; + 7,572.60 = 59,672.65 = closing
 */
const RT01: RetirementDoc = {
  id: 'RT-01', cls: 'retirement', filename: 'RT-01_super_annual_clean_banksia_fy2026.pdf', role: 'clean',
  summary: 'Clean annual super member statement in the certified summary layout, with investment options; reconciles to the cent.',
  declared: { jurisdiction: 'AU', currency: 'AUD' },
  planted: ['PAT SAMPLE-SIX', 'pat.sample.six@example.invalid', '2204 5517', '0400 000 006'],
  route: { deterministic: 'reads', aiRequired: false, reconciliation: 'reconciled', outcome: 'certified' },
  pages: [[
    'Banksia Industry Super Fund',
    'ANNUAL MEMBER STATEMENT',
    'Member name: PAT SAMPLE-SIX',
    'Email: pat.sample.six@example.invalid',
    'Phone: 0400 000 006',
    'Member number: 2204 5517',
    'Statement period: 01/07/2025 to 30/06/2026',
    'Account type: Accumulation',
    'Opening balance: $48,210.55',
    'Employer contributions: $7,820.00',
    'Personal contributions: $1,000.00',
    'Government co-contribution: $500.00',
    'Investment earnings: $4,012.30',
    'Administration fees: ($231.00)',
    'Investment fees: ($154.20)',
    'Insurance premiums: ($312.00)',
    'Tax on contributions: ($1,173.00)',
    'Closing balance: $59,672.65',
    'Investment options',
    'Option Units Unit price Balance',
    'Balanced Growth 24,000.0000 1.6500 $39,600.00',
    'Cash Account 12,500.0500 1.0000 $12,500.05',
    'Australian Shares 3,500.0000 2.1636 $7,572.60',
  ]],
  hand: [
    'fees 231.00 + 154.20 = 385.20',
    '48,210.55 + 7,820.00 = 56,030.55; + 1,000.00 = 57,030.55; + 500.00 = 57,530.55; + 4,012.30 = 61,542.85',
    '- 385.20 = 61,157.65; - 312.00 = 60,845.65; - 1,173.00 = 59,672.65 = printed closing',
    'options 39,600.00 + 12,500.05 + 7,572.60 = 59,672.65',
  ],
  expected: {
    jurisdiction: 'AU', currency: 'AUD', fund: 'Banksia Industry Super Fund', last4: '5517', periodStart: '2025-07-01', periodEnd: '2026-06-30',
    opening: 48210.55, printedClosing: 59672.65, closingByMovements: 59672.65, employer: 7820, personal: 1000, government: 500, earnings: 4012.3,
    fees: 385.2, insurance: 312, tax: 1173,
    options: [
      { name: 'Balanced Growth', units: 24000, unitPrice: 1.65, value: 39600 },
      { name: 'Cash Account', units: 12500.05, unitPrice: 1, value: 12500.05 },
      { name: 'Australian Shares', units: 3500, unitPrice: 2.1636, value: 7572.6 },
    ],
    activities: [],
  },
};

/**
 * RT-02 clean account-based pension statement (layout RET-1, income stream: pension payments, no contributions).
 *   fees 980.00 + 440.00 = 1,420.00
 *   312,480.10 + 18,310.45 = 330,790.55; - 24,000.00 = 306,790.55; - 1,420.00 = 305,370.55
 *   options: 20,000.0000 x 1.0000 = 20,000.00 ; 185,000.0000 x 1.5400 = 284,900.00 ; 470.5500 x 1.0000 = 470.55
 *   20,000.00 + 284,900.00 = 304,900.00; + 470.55 = 305,370.55 = closing
 */
const RT02: RetirementDoc = {
  id: 'RT-02', cls: 'retirement', filename: 'RT-02_pension_clean_casuarina_fy2026.pdf', role: 'clean',
  summary: 'Clean account-based pension statement (pension payments out, earnings in); reconciles to the cent.',
  declared: { jurisdiction: 'AU', currency: 'AUD' },
  planted: ['SAM SAMPLE-SEVEN', '7710 2288'],
  route: { deterministic: 'reads', aiRequired: false, reconciliation: 'reconciled', outcome: 'certified' },
  pages: [[
    'Casuarina Retirement Income Fund',
    'PENSION STATEMENT',
    'Member name: SAM SAMPLE-SEVEN',
    'Member number: 7710 2288',
    'Statement period: 01/07/2025 to 30/06/2026',
    'Account type: Account-based pension',
    'Opening balance: $312,480.10',
    'Pension payments: ($24,000.00)',
    'Investment earnings: $18,310.45',
    'Administration fees: ($980.00)',
    'Investment fees: ($440.00)',
    'Closing balance: $305,370.55',
    'Investment options',
    'Option Units Unit price Balance',
    'Cash 20,000.0000 1.0000 $20,000.00',
    'Balanced 185,000.0000 1.5400 $284,900.00',
    'Term Deposit Pool 470.5500 1.0000 $470.55',
  ]],
  hand: [
    'fees 980.00 + 440.00 = 1,420.00',
    '312,480.10 + 18,310.45 = 330,790.55; - 24,000.00 = 306,790.55; - 1,420.00 = 305,370.55 = printed closing',
    'options 20,000.00 + 284,900.00 + 470.55 = 305,370.55',
  ],
  expected: {
    jurisdiction: 'AU', currency: 'AUD', fund: 'Casuarina Retirement Income Fund', last4: '2288', periodStart: '2025-07-01', periodEnd: '2026-06-30',
    opening: 312480.1, printedClosing: 305370.55, closingByMovements: 305370.55, earnings: 18310.45, fees: 1420, pensionPayments: 24000,
    options: [
      { name: 'Cash', units: 20000, unitPrice: 1, value: 20000 },
      { name: 'Balanced', units: 185000, unitPrice: 1.54, value: 284900 },
      { name: 'Term Deposit Pool', units: 470.55, unitPrice: 1, value: 470.55 },
    ],
    activities: [],
  },
};

/**
 * RT-03 super account activity in a transaction-history layout (no opening/closing movement block): the certified summary
 * reader legitimately cannot read it; the fallback must.
 *   20,115.00 + 950.00 = 21,065.00; + 950.00 = 22,015.00; + 310.40 = 22,325.40; - 42.00 = 22,283.40; - 36.50 = 22,246.90
 */
const RT03: RetirementDoc = {
  id: 'RT-03', cls: 'retirement', filename: 'RT-03_super_activity_needs_fallback_lyrebird_oct2025.pdf', role: 'needs_fallback',
  summary: 'Super account activity listed line by line with a running balance; the certified summary reader cannot read it, the AI fallback must.',
  declared: { jurisdiction: 'AU', currency: 'AUD' },
  planted: ['RIVER SAMPLE-EIGHT', 'river.sample.eight@example.invalid', '5530 9021'],
  route: { deterministic: 'layout_unsupported', aiRequired: true, reconciliation: 'reconciled', outcome: 'review_required' },
  pages: [[
    'Lyrebird Super',
    'YOUR ACCOUNT ACTIVITY',
    'Member: RIVER SAMPLE-EIGHT',
    'Email: river.sample.eight@example.invalid',
    'Member number: 5530 9021',
    'Activity from 1 July 2025 to 31 October 2025',
    'Account balance at 1 July 2025 $20,115.00',
    'Date Transaction Amount Balance',
    '15 Jul 2025 Employer contribution 950.00 21,065.00',
    '15 Aug 2025 Employer contribution 950.00 22,015.00',
    '30 Sep 2025 Investment earnings 310.40 22,325.40',
    '30 Sep 2025 Administration fee -42.00 22,283.40',
    '31 Oct 2025 Insurance premium -36.50 22,246.90',
    'Account balance at 31 October 2025 $22,246.90',
  ]],
  hand: ['20,115.00 + 950.00 = 21,065.00; + 950.00 = 22,015.00; + 310.40 = 22,325.40; - 42.00 = 22,283.40; - 36.50 = 22,246.90 = printed closing'],
  expected: {
    jurisdiction: 'AU', currency: 'AUD', fund: 'Lyrebird Super', last4: '9021', periodStart: '2025-07-01', periodEnd: '2025-10-31',
    opening: 20115, printedClosing: 22246.9, closingByMovements: 22246.9, options: [],
    activities: [
      { date: '2025-07-15', type: 'EMPLOYER_CONTRIBUTION', amount: 950 },
      { date: '2025-08-15', type: 'EMPLOYER_CONTRIBUTION', amount: 950 },
      { date: '2025-09-30', type: 'INVESTMENT_EARNINGS', amount: 310.4 },
      { date: '2025-09-30', type: 'FEE', amount: 42 },
      { date: '2025-10-31', type: 'INSURANCE_PREMIUM', amount: 36.5 },
    ],
  },
};

/**
 * RT-04 WRONG ON THE PAGE: certified layout, but the printed closing balance has two digits transposed.
 *   by movements: 15,000.00 + 3,200.00 = 18,200.00; + 640.00 = 18,840.00; - 120.00 = 18,720.00; - 480.00 = 18,240.00
 *   the page prints 18,420.00 ; movements minus printed = 18,240.00 - 18,420.00 = -180.00
 */
const RT04: RetirementDoc = {
  id: 'RT-04', cls: 'retirement', filename: 'RT-04_super_wrong_on_page_mulga_valley_fy2026.pdf', role: 'wrong_on_page',
  summary: 'Certified layout, but the printed closing balance (18,420.00) is 180.00 away from what the movements give (18,240.00); read as printed, must NOT certify.',
  declared: { jurisdiction: 'AU', currency: 'AUD' },
  planted: ['9981 3340'],
  route: { deterministic: 'reads', aiRequired: false, reconciliation: 'variance', outcome: 'review_required' },
  pages: [[
    'Mulga Valley Super',
    'MEMBER STATEMENT',
    'Member number: 9981 3340',
    'Statement period: 01/07/2025 to 30/06/2026',
    'Opening balance: $15,000.00',
    'Employer contributions: $3,200.00',
    'Investment earnings: $640.00',
    'Administration fees: ($120.00)',
    'Tax on contributions: ($480.00)',
    'Closing balance: $18,420.00',
  ]],
  hand: [
    'by movements: 15,000.00 + 3,200.00 = 18,200.00; + 640.00 = 18,840.00; - 120.00 = 18,720.00; - 480.00 = 18,240.00',
    'the page prints 18,420.00; movements minus printed = 18,240.00 - 18,420.00 = -180.00 (variance)',
  ],
  expected: {
    jurisdiction: 'AU', currency: 'AUD', fund: 'Mulga Valley Super', last4: '3340', periodStart: '2025-07-01', periodEnd: '2026-06-30',
    opening: 15000, printedClosing: 18420, closingByMovements: 18240, employer: 3200, earnings: 640, fees: 120, tax: 480, options: [], activities: [],
  },
};

/**
 * RT-05 MULTI-OPTION with a YEAR-TO-DATE column: the period figure is the FIRST amount; the year-to-date figure must
 * never be used.
 *   90,400.00 + 2,400.00 = 92,800.00; + 1,950.75 = 94,750.75; - 96.00 = 94,654.75; - 360.00 = 94,294.75
 *   options: 30,000.0000 x 1.2500 = 37,500.00 ; 25,000.0000 x 1.3400 = 33,500.00 ; 12,000.0000 x 1.1200 = 13,440.00 ; 9,854.7500 x 1.0000 = 9,854.75
 *   37,500.00 + 33,500.00 = 71,000.00; + 13,440.00 = 84,440.00; + 9,854.75 = 94,294.75 = closing
 */
const RT05: RetirementDoc = {
  id: 'RT-05', cls: 'retirement', filename: 'RT-05_super_quarterly_ytd_column_waratah_jun2026.pdf', role: 'multi',
  summary: 'Quarterly statement with a "This period / Year to date" pair of columns and four investment options; the period figure must be used, never the year to date.',
  declared: { jurisdiction: 'AU', currency: 'AUD' },
  planted: ['4402 7761', 'robin.sample.nine@example.invalid'],
  route: { deterministic: 'reads', aiRequired: false, reconciliation: 'reconciled', outcome: 'certified' },
  pages: [[
    'Waratah Retirement Fund',
    'QUARTERLY MEMBER STATEMENT',
    'Email: robin.sample.nine@example.invalid',
    'Member number: 4402 7761',
    'Statement period: 01/04/2026 to 30/06/2026',
    'Opening balance: $90,400.00',
    'This period Year to date',
    'Employer contributions: $2,400.00 $9,300.00',
    'Investment earnings: $1,950.75 $5,880.10',
    'Administration fees: ($96.00) ($380.00)',
    'Tax on contributions: ($360.00) ($1,395.00)',
    'Closing balance: $94,294.75',
    'Investment options',
    'Option Units Unit price Balance',
    'High Growth 30,000.0000 1.2500 $37,500.00',
    'Balanced 25,000.0000 1.3400 $33,500.00',
    'Conservative 12,000.0000 1.1200 $13,440.00',
    'Cash 9,854.7500 1.0000 $9,854.75',
  ]],
  hand: [
    '90,400.00 + 2,400.00 = 92,800.00; + 1,950.75 = 94,750.75; - 96.00 = 94,654.75; - 360.00 = 94,294.75 = printed closing',
    'options 37,500.00 + 33,500.00 = 71,000.00; + 13,440.00 = 84,440.00; + 9,854.75 = 94,294.75',
    'year-to-date figures (9,300.00 / 5,880.10 / 380.00 / 1,395.00) are NOT period figures',
  ],
  expected: {
    jurisdiction: 'AU', currency: 'AUD', fund: 'Waratah Retirement Fund', last4: '7761', periodStart: '2026-04-01', periodEnd: '2026-06-30',
    opening: 90400, printedClosing: 94294.75, closingByMovements: 94294.75, employer: 2400, earnings: 1950.75, fees: 96, tax: 360,
    options: [
      { name: 'High Growth', units: 30000, unitPrice: 1.25, value: 37500 },
      { name: 'Balanced', units: 25000, unitPrice: 1.34, value: 33500 },
      { name: 'Conservative', units: 12000, unitPrice: 1.12, value: 13440 },
      { name: 'Cash', units: 9854.75, unitPrice: 1, value: 9854.75 },
    ],
    activities: [],
  },
};

/**
 * RT-06 TRAP (double counting): printed SUBTOTALS ("Total contributions", "Total fees") sit beside their parts. Each part
 * is shown AND the subtotal is shown; adding both would double count.
 *   contributions 2,000.00 + 500.00 = 2,500.00 (= printed subtotal) ; fees 95.00 + 60.00 = 155.00 (= printed subtotal)
 *   30,000.00 + 2,500.00 = 32,500.00; + 1,100.00 = 33,600.00; - 155.00 = 33,445.00; - 110.00 = 33,335.00
 */
const RT06: RetirementDoc = {
  id: 'RT-06', cls: 'retirement', filename: 'RT-06_super_subtotals_trap_boobook_fy2026.pdf', role: 'trap',
  summary: 'Printed subtotals next to their parts (contributions and fees); a reader that adds both double counts and fails the identity.',
  declared: { jurisdiction: 'AU', currency: 'AUD' },
  planted: ['3318 0095'],
  route: { deterministic: 'reads', aiRequired: false, reconciliation: 'reconciled', outcome: 'certified' },
  pages: [[
    'Boobook Super',
    'ANNUAL MEMBER STATEMENT',
    'Member number: 3318 0095',
    'Statement period: 01/07/2025 to 30/06/2026',
    'Opening balance: $30,000.00',
    'Employer contributions: $2,000.00',
    'Personal contributions: $500.00',
    'Total contributions: $2,500.00',
    'Investment earnings: $1,100.00',
    'Administration fees: ($95.00)',
    'Investment fees: ($60.00)',
    'Total fees: ($155.00)',
    'Insurance premiums: ($110.00)',
    'Closing balance: $33,335.00',
  ]],
  hand: [
    'contributions 2,000.00 + 500.00 = 2,500.00 (printed subtotal); fees 95.00 + 60.00 = 155.00 (printed subtotal)',
    '30,000.00 + 2,500.00 = 32,500.00; + 1,100.00 = 33,600.00; - 155.00 = 33,445.00; - 110.00 = 33,335.00 = printed closing',
  ],
  expected: {
    jurisdiction: 'AU', currency: 'AUD', fund: 'Boobook Super', last4: '0095', periodStart: '2025-07-01', periodEnd: '2026-06-30',
    opening: 30000, printedClosing: 33335, closingByMovements: 33335, employer: 2000, personal: 500, earnings: 1100, fees: 155, insurance: 110, options: [], activities: [],
  },
};

/** RT-07 NEGATIVE CONTROL: a credit card statement is not a retirement statement. Refused, no AI, nothing charged. */
const RT07: RetirementDoc = {
  id: 'RT-07', cls: 'retirement', filename: 'RT-07_negative_control_credit_card_statement_dingo_flat_jul2026.pdf', role: 'negative_control',
  summary: 'A credit card statement: refused as not a retirement statement, no AI call, nothing charged.',
  declared: { jurisdiction: 'AU', currency: 'AUD' },
  planted: ['5999 0000 7777 3030'],
  route: { deterministic: 'not_this_class', aiRequired: false, reconciliation: null, outcome: 'refused' },
  pages: [[
    'Dingo Flat Bank',
    'CREDIT CARD STATEMENT',
    'Card number: 5999 0000 7777 3030',
    'Statement period: 01/07/2026 to 31/07/2026',
    'Credit limit: $3,000.00',
    'Opening balance: $200.00',
    'Date Description Amount',
    '05/07/2026 FICTIONAL BOOKS 60.00',
    'Closing balance: $260.00',
    'Minimum payment: $25.00',
  ]],
  hand: ['200.00 + 60.00 = 260.00'],
  expected: null,
};

/** RT-08 MULTI-ACCOUNT: an accumulation account and a pension account in one PDF, each with its own opening and closing balance. Refused, one account at a time. */
const RT08: RetirementDoc = {
  id: 'RT-08', cls: 'retirement', filename: 'RT-08_two_accounts_in_one_pdf_kookaburra_fy2026.pdf', role: 'multi',
  summary: 'Accumulation and pension accounts in one PDF, each with its own opening and closing balance; refused with "one account at a time", nothing written.',
  declared: { jurisdiction: 'AU', currency: 'AUD' },
  planted: ['6600 1111', '6600 2222'],
  route: { deterministic: 'multiple_accounts', aiRequired: false, reconciliation: null, outcome: 'refused' },
  pages: [[
    'Kookaburra Super and Pension',
    'COMBINED MEMBER STATEMENT',
    'Statement period: 01/07/2025 to 30/06/2026',
    'Accumulation account',
    'Member number: 6600 1111',
    'Opening balance: $10,000.00',
    'Employer contributions: $1,000.00',
    'Closing balance: $11,000.00',
    'Pension account',
    'Member number: 6600 2222',
    'Opening balance: $200,000.00',
    'Pension payments: ($20,000.00)',
    'Closing balance: $180,000.00',
  ]],
  hand: ['accumulation 10,000.00 + 1,000.00 = 11,000.00', 'pension 200,000.00 - 20,000.00 = 180,000.00'],
  expected: null,
};

/**
 * RT-09 INDIA provident fund passbook (jurisdiction IN, INR, dd-mm-yyyy, lakh grouping). There is no certified deterministic
 * India layout: the fallback must read it.
 *   3,45,210.00 + 62,400.00 = 4,07,610.00; + 21,360.00 = 4,28,970.00; + 29,310.00 = 4,58,280.00
 */
const RT09: RetirementDoc = {
  id: 'RT-09', cls: 'retirement', filename: 'RT-09_india_pf_passbook_needs_fallback_fy2025_26.pdf', role: 'needs_fallback',
  summary: 'India provident fund passbook summary (INR, dd-mm-yyyy, lakh grouping); no certified deterministic India layout exists, so the fallback must read it.',
  declared: { jurisdiction: 'IN', currency: 'INR' },
  planted: ['1012 3456 7890', 'kiran.sample.ten@example.invalid'],
  route: { deterministic: 'layout_unsupported', aiRequired: true, reconciliation: 'reconciled', outcome: 'review_required' },
  pages: [[
    'Sample Provident Fund Passbook',
    'MEMBER PASSBOOK',
    'Member: KIRAN SAMPLE-TEN',
    'Email: kiran.sample.ten@example.invalid',
    'UAN: 1012 3456 7890',
    'Establishment: SYNTHETIC WORKS PRIVATE LIMITED',
    'Passbook period: 01-04-2025 to 31-03-2026',
    'Opening balance Rs. 3,45,210.00',
    'Employee contribution Rs. 62,400.00',
    'Employer contribution Rs. 21,360.00',
    'Interest credited Rs. 29,310.00',
    'Closing balance Rs. 4,58,280.00',
  ]],
  hand: ['3,45,210.00 + 62,400.00 = 4,07,610.00; + 21,360.00 = 4,28,970.00; + 29,310.00 = 4,58,280.00 = printed closing'],
  expected: {
    jurisdiction: 'IN', currency: 'INR', fund: 'Sample Provident Fund Passbook', last4: '7890', periodStart: '2025-04-01', periodEnd: '2026-03-31',
    opening: 345210, printedClosing: 458280, closingByMovements: 458280, employer: 21360, personal: 62400, earnings: 29310, options: [], activities: [],
  },
};

export const RETIREMENT_DOCS: readonly RetirementDoc[] = [RT01, RT02, RT03, RT04, RT05, RT06, RT07, RT08, RT09];

// ---------------------------------------------------------------------------------------------------------------
// AUSTRALIAN INVESTMENT
// ---------------------------------------------------------------------------------------------------------------

export interface InvestmentExpectedHolding { code: string; name: string; quantity: number; price: number; value: number }
export interface InvestmentExpectedTxn { date: string; type: string; code: string | null; quantity: number | null; price: number | null; brokerage: number | null; amount: number }
export interface InvestmentExpected {
  kind: 'holdings' | 'transactions';
  institution: string;
  last4: string;
  /** Valuation date (holdings) or period end. */
  date?: string;
  periodStart?: string;
  periodEnd?: string;
  holdings: readonly InvestmentExpectedHolding[];
  cash?: number;
  /** The total the PAGE prints (holdings). */
  printedTotal?: number;
  /** Sum of the holding values AS PRINTED plus cash. */
  sumOfPrinted?: number;
  transactions: readonly InvestmentExpectedTxn[];
  totalBuys?: number;
  totalSells?: number;
  totalBrokerage?: number;
}
export interface InvestmentDoc extends CorpusDocBase {
  cls: 'au_investment';
  expected: InvestmentExpected | null;
}

/**
 * AI-01 clean HOLDINGS statement (layout HOLD-1).
 *   500.0000 x 18.4200 = 9,210.00 ; 1,200.0000 x 98.7500 = 118,500.00 ; 850.0000 x 4.3100 = 3,663.50
 *   2,345.6789 x 1.8750 = 4,398.1479375 -> 4,398.15
 *   9,210.00 + 118,500.00 = 127,710.00; + 3,663.50 = 131,373.50; + 4,398.15 = 135,771.65; + cash 1,250.00 = 137,021.65 = printed total
 */
const AI01: InvestmentDoc = {
  id: 'AI-01', cls: 'au_investment', filename: 'AI-01_holdings_clean_mulgrave_street_jun2026.pdf', role: 'clean',
  summary: 'Clean broker holdings statement in the certified layout (four holdings, one with fractional units, and cash); units x price = value and the total ties.',
  declared: { statement_kind: 'portfolio', currency: 'AUD' },
  planted: ['SAMPLE INVESTOR ELEVEN', 'X0000 4417', 'inv.sample.eleven@example.invalid', '0400 000 011'],
  route: { deterministic: 'reads', aiRequired: false, reconciliation: 'reconciled', outcome: 'certified' },
  pages: [[
    'Mulgrave Street Securities',
    'HOLDINGS STATEMENT',
    'Account: SAMPLE INVESTOR ELEVEN   HIN: X0000 4417',
    'Email: inv.sample.eleven@example.invalid',
    'Phone: 0400 000 011',
    'Valuation date: 30/06/2026',
    'Code Security Quantity Price Value',
    'ARX Arrowroot Industries Limited 500.0000 18.4200 9,210.00',
    'BMT Bellmouth Index ETF 1,200.0000 98.7500 118,500.00',
    'CNP Corvine Property Trust 850.0000 4.3100 3,663.50',
    'DLK Delphic Global Fund 2,345.6789 1.8750 4,398.15',
    'Cash balance: $1,250.00',
    'Total portfolio value: $137,021.65',
  ]],
  hand: [
    '500 x 18.42 = 9,210.00 ; 1,200 x 98.75 = 118,500.00 ; 850 x 4.31 = 3,663.50 ; 2,345.6789 x 1.875 = 4,398.1479375, rounds to 4,398.15',
    '9,210.00 + 118,500.00 = 127,710.00; + 3,663.50 = 131,373.50; + 4,398.15 = 135,771.65; + cash 1,250.00 = 137,021.65 = printed total',
  ],
  expected: {
    kind: 'holdings', institution: 'Mulgrave Street Securities', last4: '4417', date: '2026-06-30',
    holdings: [
      { code: 'ARX', name: 'Arrowroot Industries Limited', quantity: 500, price: 18.42, value: 9210 },
      { code: 'BMT', name: 'Bellmouth Index ETF', quantity: 1200, price: 98.75, value: 118500 },
      { code: 'CNP', name: 'Corvine Property Trust', quantity: 850, price: 4.31, value: 3663.5 },
      { code: 'DLK', name: 'Delphic Global Fund', quantity: 2345.6789, price: 1.875, value: 4398.15 },
    ],
    cash: 1250, printedTotal: 137021.65, sumOfPrinted: 137021.65, transactions: [],
  },
};

/**
 * AI-02 clean TRANSACTIONS statement (layout TXN-1).
 *   BUY 100 x 98.10 = 9,810.00 + 19.95 = 9,829.95 ; SELL 200 x 18.90 = 3,780.00 - 19.95 = 3,760.05 ; BUY 400 x 4.25 = 1,700.00 + 19.95 = 1,719.95
 *   total buys 9,829.95 + 1,719.95 = 11,549.90 ; total sells 3,760.05 ; brokerage 19.95 x 3 = 59.85
 */
const AI02: InvestmentDoc = {
  id: 'AI-02', cls: 'au_investment', filename: 'AI-02_transactions_clean_mulgrave_street_jul2026.pdf', role: 'clean',
  summary: 'Clean broker transaction statement in the certified layout (two buys, a sell, a dividend and interest) with printed totals; every line and total ties.',
  declared: { statement_kind: 'transaction', currency: 'AUD' },
  planted: ['SAMPLE INVESTOR ELEVEN', 'X0000 4417'],
  route: { deterministic: 'reads', aiRequired: false, reconciliation: 'insufficient_data', outcome: 'review_required' },
  pages: [[
    'Mulgrave Street Securities',
    'TRANSACTION STATEMENT',
    'Account: SAMPLE INVESTOR ELEVEN   HIN: X0000 4417',
    'Statement period: 01/07/2026 to 31/07/2026',
    'Date Type Code Quantity Price Brokerage Amount',
    '02/07/2026 BUY BMT 100.0000 98.1000 19.95 9,829.95',
    '09/07/2026 SELL ARX 200.0000 18.9000 19.95 3,760.05',
    '15/07/2026 DIVIDEND CNP - - - 127.50',
    '22/07/2026 BUY CNP 400.0000 4.2500 19.95 1,719.95',
    '31/07/2026 INTEREST - - - - 3.12',
    'Total buys: $11,549.90',
    'Total sells: $3,760.05',
    'Total brokerage: $59.85',
  ]],
  hand: [
    '100 x 98.10 = 9,810.00 + 19.95 = 9,829.95 ; 200 x 18.90 = 3,780.00 - 19.95 = 3,760.05 ; 400 x 4.25 = 1,700.00 + 19.95 = 1,719.95',
    'total buys 9,829.95 + 1,719.95 = 11,549.90 ; total sells 3,760.05 ; brokerage 3 x 19.95 = 59.85',
  ],
  expected: {
    kind: 'transactions', institution: 'Mulgrave Street Securities', last4: '4417', periodStart: '2026-07-01', periodEnd: '2026-07-31', holdings: [],
    transactions: [
      { date: '2026-07-02', type: 'BUY', code: 'BMT', quantity: 100, price: 98.1, brokerage: 19.95, amount: 9829.95 },
      { date: '2026-07-09', type: 'SELL', code: 'ARX', quantity: 200, price: 18.9, brokerage: 19.95, amount: 3760.05 },
      { date: '2026-07-15', type: 'DIVIDEND', code: 'CNP', quantity: null, price: null, brokerage: null, amount: 127.5 },
      { date: '2026-07-22', type: 'BUY', code: 'CNP', quantity: 400, price: 4.25, brokerage: 19.95, amount: 1719.95 },
      { date: '2026-07-31', type: 'INTEREST', code: null, quantity: null, price: null, brokerage: null, amount: 3.12 },
    ],
    totalBuys: 11549.9, totalSells: 3760.05, totalBrokerage: 59.85,
  },
};

/**
 * AI-03 holdings statement in a layout the certified reader legitimately cannot read: one labelled block per holding
 * (no table), units without decimals, 2-4 decimal prices.
 *   500 x 18.42 = 9,210.00 ; 1,500 x 3.20 = 4,800.00 ; 10,000 x 1.2345 = 12,345.00
 *   9,210.00 + 4,800.00 = 14,010.00; + 12,345.00 = 26,355.00; + cash 500.00 = 26,855.00 = printed total
 */
const AI03: InvestmentDoc = {
  id: 'AI-03', cls: 'au_investment', filename: 'AI-03_holdings_needs_fallback_pinnacle_jun2026.pdf', role: 'needs_fallback',
  summary: 'Portfolio summary printed as one labelled block per holding (no table); the certified reader cannot read it, the AI fallback must.',
  declared: { statement_kind: 'portfolio', currency: 'AUD' },
  planted: ['SAMPLE INVESTOR TWELVE', 'X0000 8052', 'inv.sample.twelve@example.invalid'],
  route: { deterministic: 'layout_unsupported', aiRequired: true, reconciliation: 'reconciled', outcome: 'review_required' },
  pages: [[
    'Pinnacle Wealth Brokerage',
    'Portfolio summary as at 30 June 2026',
    'Client: SAMPLE INVESTOR TWELVE   HIN: X0000 8052',
    'Email: inv.sample.twelve@example.invalid',
    'Holding 1',
    'Security: ARX - Arrowroot Industries Limited',
    'Units held: 500',
    'Last price: $18.42',
    'Market value: $9,210.00',
    'Holding 2',
    'Security: EQT - Equator Telecom Limited',
    'Units held: 1,500',
    'Last price: $3.20',
    'Market value: $4,800.00',
    'Holding 3',
    'Security: FBM - Fernbank Managed Growth Fund',
    'Units held: 10,000',
    'Last price: $1.2345',
    'Market value: $12,345.00',
    'Cash account balance: $500.00',
    'Total: $26,855.00',
  ]],
  hand: [
    '500 x 18.42 = 9,210.00 ; 1,500 x 3.20 = 4,800.00 ; 10,000 x 1.2345 = 12,345.00',
    '9,210.00 + 4,800.00 = 14,010.00; + 12,345.00 = 26,355.00; + cash 500.00 = 26,855.00 = printed total',
  ],
  expected: {
    kind: 'holdings', institution: 'Pinnacle Wealth Brokerage', last4: '8052', date: '2026-06-30',
    holdings: [
      { code: 'ARX', name: 'Arrowroot Industries Limited', quantity: 500, price: 18.42, value: 9210 },
      { code: 'EQT', name: 'Equator Telecom Limited', quantity: 1500, price: 3.2, value: 4800 },
      { code: 'FBM', name: 'Fernbank Managed Growth Fund', quantity: 10000, price: 1.2345, value: 12345 },
    ],
    cash: 500, printedTotal: 26855, sumOfPrinted: 26855, transactions: [],
  },
};

/**
 * AI-04 WRONG ON THE PAGE: certified layout; one holding's printed value is not units x price and the printed total does not
 * equal the sum of the printed lines.
 *   300 x 12.50 = 3,750.00 but the page prints 3,570.00 ; 1,000 x 6.40 = 6,400.00
 *   true: 3,750.00 + 6,400.00 = 10,150.00; + cash 100.00 = 10,250.00 = printed total
 *   as printed: 3,570.00 + 6,400.00 = 9,970.00; + 100.00 = 10,070.00 ; printed total 10,250.00 ; difference 180.00
 */
const AI04: InvestmentDoc = {
  id: 'AI-04', cls: 'au_investment', filename: 'AI-04_holdings_wrong_on_page_gidgee_jun2026.pdf', role: 'wrong_on_page',
  summary: 'Certified layout, but one holding prints 3,570.00 for 300 x 12.50 (should be 3,750.00) and the printed total is 180.00 away from the printed lines; read as printed, must NOT certify.',
  declared: { statement_kind: 'portfolio', currency: 'AUD' },
  planted: ['X0000 2290'],
  route: { deterministic: 'reads', aiRequired: false, reconciliation: 'variance', outcome: 'review_required' },
  pages: [[
    'Gidgee Brokerage',
    'HOLDINGS STATEMENT',
    'Account: SAMPLE INVESTOR THIRTEEN   HIN: X0000 2290',
    'Valuation date: 30/06/2026',
    'Code Security Quantity Price Value',
    'GRV Gravel Creek Resources 300.0000 12.5000 3,570.00',
    'HLM Helm Industries Limited 1,000.0000 6.4000 6,400.00',
    'Cash balance: $100.00',
    'Total portfolio value: $10,250.00',
  ]],
  hand: [
    '300 x 12.50 = 3,750.00 but the page prints 3,570.00 ; 1,000 x 6.40 = 6,400.00',
    'true total 3,750.00 + 6,400.00 + 100.00 = 10,250.00 (the printed total)',
    'as printed 3,570.00 + 6,400.00 = 9,970.00; + 100.00 = 10,070.00; printed total 10,250.00; difference 180.00',
  ],
  expected: {
    kind: 'holdings', institution: 'Gidgee Brokerage', last4: '2290', date: '2026-06-30',
    holdings: [
      { code: 'GRV', name: 'Gravel Creek Resources', quantity: 300, price: 12.5, value: 3570 },
      { code: 'HLM', name: 'Helm Industries Limited', quantity: 1000, price: 6.4, value: 6400 },
    ],
    cash: 100, printedTotal: 10250, sumOfPrinted: 10070, transactions: [],
  },
};

/**
 * AI-05 MULTI-HOLDING over two pages (repeated header, "continued" markers).
 *   1,000 x 5.25 = 5,250.00 ; 750 x 9.80 = 7,350.00 ; 120 x 142.30 = 17,076.00 ; 4,000 x 0.85 = 3,400.00
 *   2,200 x 3.75 = 8,250.00 ; 310 x 61.20 = 18,972.00 ; 95 x 33.00 = 3,135.00
 *   5,250.00 + 7,350.00 = 12,600.00; + 17,076.00 = 29,676.00; + 3,400.00 = 33,076.00; + 8,250.00 = 41,326.00
 *   + 18,972.00 = 60,298.00; + 3,135.00 = 63,433.00; + cash 412.60 = 63,845.60 = printed total
 */
const AI05: InvestmentDoc = {
  id: 'AI-05', cls: 'au_investment', filename: 'AI-05_holdings_seven_over_two_pages_tamarind_jun2026.pdf', role: 'multi',
  summary: 'Seven holdings over two pages with a repeated table header and continued markers, plus cash; all rows read, total ties.',
  declared: { statement_kind: 'portfolio', currency: 'AUD' },
  planted: ['X0000 7733'],
  route: { deterministic: 'reads', aiRequired: false, reconciliation: 'reconciled', outcome: 'certified' },
  pages: [
    [
      'Tamarind Online Broking',
      'HOLDINGS STATEMENT',
      'Account: SAMPLE INVESTOR FOURTEEN   HIN: X0000 7733',
      'Valuation date: 30/06/2026',
      'Code Security Quantity Price Value',
      'AAB Aabbott Foods Limited 1,000.0000 5.2500 5,250.00',
      'BCD Bicord Energy Limited 750.0000 9.8000 7,350.00',
      'CDE Cordell Health Group 120.0000 142.3000 17,076.00',
      'DEF Defiance Mining Limited 4,000.0000 0.8500 3,400.00',
      'Continued on next page',
    ],
    [
      'Tamarind Online Broking',
      'HOLDINGS STATEMENT (continued)',
      'Code Security Quantity Price Value',
      'EFG Efgrove Property Trust 2,200.0000 3.7500 8,250.00',
      'FGH Fairgate Global ETF 310.0000 61.2000 18,972.00',
      'GHI Gannet International Limited 95.0000 33.0000 3,135.00',
      'Cash balance: $412.60',
      'Total portfolio value: $63,845.60',
    ],
  ],
  hand: [
    '1,000 x 5.25 = 5,250.00 ; 750 x 9.80 = 7,350.00 ; 120 x 142.30 = 17,076.00 ; 4,000 x 0.85 = 3,400.00 ; 2,200 x 3.75 = 8,250.00 ; 310 x 61.20 = 18,972.00 ; 95 x 33.00 = 3,135.00',
    '5,250.00 + 7,350.00 = 12,600.00; + 17,076.00 = 29,676.00; + 3,400.00 = 33,076.00; + 8,250.00 = 41,326.00; + 18,972.00 = 60,298.00; + 3,135.00 = 63,433.00; + cash 412.60 = 63,845.60',
  ],
  expected: {
    kind: 'holdings', institution: 'Tamarind Online Broking', last4: '7733', date: '2026-06-30',
    holdings: [
      { code: 'AAB', name: 'Aabbott Foods Limited', quantity: 1000, price: 5.25, value: 5250 },
      { code: 'BCD', name: 'Bicord Energy Limited', quantity: 750, price: 9.8, value: 7350 },
      { code: 'CDE', name: 'Cordell Health Group', quantity: 120, price: 142.3, value: 17076 },
      { code: 'DEF', name: 'Defiance Mining Limited', quantity: 4000, price: 0.85, value: 3400 },
      { code: 'EFG', name: 'Efgrove Property Trust', quantity: 2200, price: 3.75, value: 8250 },
      { code: 'FGH', name: 'Fairgate Global ETF', quantity: 310, price: 61.2, value: 18972 },
      { code: 'GHI', name: 'Gannet International Limited', quantity: 95, price: 33, value: 3135 },
    ],
    cash: 412.6, printedTotal: 63845.6, sumOfPrinted: 63845.6, transactions: [],
  },
};

/**
 * AI-06 TRAP (invented / dropped rows): a subtotal line, a footnote and TWO IDENTICAL genuine rows (the same security
 * held under two registrations). Subtotal, cash and footnote are not holdings; both identical rows are.
 *   1,500 x 2.20 = 3,300.00 (twice) ; 600 x 7.50 = 4,500.00
 *   3,300.00 + 3,300.00 + 4,500.00 = 11,100.00 (= printed subtotal); + cash 900.00 = 12,000.00 = printed total
 */
const AI06: InvestmentDoc = {
  id: 'AI-06', cls: 'au_investment', filename: 'AI-06_holdings_subtotal_and_duplicate_rows_trap_lorikeet_jun2026.pdf', role: 'trap',
  summary: 'Subtotal and footnote lines that are not holdings, and two identical genuine rows (one security under two registrations) that must BOTH be kept.',
  declared: { statement_kind: 'portfolio', currency: 'AUD' },
  planted: ['X0000 5518'],
  route: { deterministic: 'reads', aiRequired: false, reconciliation: 'reconciled', outcome: 'certified' },
  pages: [[
    'Lorikeet Securities',
    'HOLDINGS STATEMENT',
    'Account: SAMPLE INVESTOR FIFTEEN   HIN: X0000 5518',
    'Valuation date: 30/06/2026',
    'Code Security Quantity Price Value',
    'KLM Kelmscott Retail Trust 1,500.0000 2.2000 3,300.00',
    'KLM Kelmscott Retail Trust 1,500.0000 2.2000 3,300.00',
    'NOP Nopalea Limited 600.0000 7.5000 4,500.00',
    'Subtotal equities: $11,100.00',
    'Cash balance: $900.00',
    'Total portfolio value: $12,000.00',
    'Note: the two KLM lines are held under separate registrations',
  ]],
  hand: [
    '1,500 x 2.20 = 3,300.00 (twice) ; 600 x 7.50 = 4,500.00',
    '3,300.00 + 3,300.00 + 4,500.00 = 11,100.00 (printed subtotal); + cash 900.00 = 12,000.00 = printed total',
  ],
  expected: {
    kind: 'holdings', institution: 'Lorikeet Securities', last4: '5518', date: '2026-06-30',
    holdings: [
      { code: 'KLM', name: 'Kelmscott Retail Trust', quantity: 1500, price: 2.2, value: 3300 },
      { code: 'KLM', name: 'Kelmscott Retail Trust', quantity: 1500, price: 2.2, value: 3300 },
      { code: 'NOP', name: 'Nopalea Limited', quantity: 600, price: 7.5, value: 4500 },
    ],
    cash: 900, printedTotal: 12000, sumOfPrinted: 12000, transactions: [],
  },
};

/** AI-07 NEGATIVE CONTROL: a superannuation statement is not a broker statement. Refused, no AI, nothing charged. */
const AI07: InvestmentDoc = {
  id: 'AI-07', cls: 'au_investment', filename: 'AI-07_negative_control_super_statement_emu_plains_fy2026.pdf', role: 'negative_control',
  summary: 'A superannuation member statement: refused as not a broker statement, no AI call, nothing charged.',
  declared: { statement_kind: 'portfolio', currency: 'AUD' },
  planted: ['8801 4402'],
  route: { deterministic: 'not_this_class', aiRequired: false, reconciliation: null, outcome: 'refused' },
  pages: [[
    'Emu Plains Super',
    'MEMBER STATEMENT',
    'Member number: 8801 4402',
    'Statement period: 01/07/2025 to 30/06/2026',
    'Opening balance: $5,000.00',
    'Employer contributions: $600.00',
    'Investment earnings: $200.00',
    'Closing balance: $5,800.00',
  ]],
  hand: ['5,000.00 + 600.00 + 200.00 = 5,800.00'],
  expected: null,
};

/** AI-08 MULTI-ACCOUNT: two HINs, each with its own table and total, in one PDF. Refused, one account at a time. */
const AI08: InvestmentDoc = {
  id: 'AI-08', cls: 'au_investment', filename: 'AI-08_two_accounts_in_one_pdf_bilby_jun2026.pdf', role: 'multi',
  summary: 'Two broker accounts (two HINs, two totals) in one PDF; refused with "one account at a time", nothing written.',
  declared: { statement_kind: 'portfolio', currency: 'AUD' },
  planted: ['X0000 1101', 'X0000 2202'],
  route: { deterministic: 'multiple_accounts', aiRequired: false, reconciliation: null, outcome: 'refused' },
  pages: [[
    'Bilby Brokers',
    'HOLDINGS STATEMENT',
    'Account: FIRST SAMPLE   HIN: X0000 1101',
    'Valuation date: 30/06/2026',
    'Code Security Quantity Price Value',
    'AAB Aabbott Foods Limited 100.0000 5.0000 500.00',
    'Total portfolio value: $500.00',
    'Account: SECOND SAMPLE   HIN: X0000 2202',
    'Valuation date: 30/06/2026',
    'Code Security Quantity Price Value',
    'BCD Bicord Energy Limited 200.0000 10.0000 2,000.00',
    'Total portfolio value: $2,000.00',
  ]],
  hand: ['100 x 5.00 = 500.00', '200 x 10.00 = 2,000.00'],
  expected: null,
};

export const INVESTMENT_DOCS: readonly InvestmentDoc[] = [AI01, AI02, AI03, AI04, AI05, AI06, AI07, AI08];

export const ALL_CORPUS_DOCS: readonly CorpusDocBase[] = [...LIABILITY_DOCS, ...RETIREMENT_DOCS, ...INVESTMENT_DOCS];

// ---------------------------------------------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------------------------------------------

export function buildCorpusPdf(doc: CorpusDocBase): Buffer {
  return buildMinimalTextPdf(doc.pages.map((p) => [...p]));
}

export function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

export function manifestText(): string {
  return ALL_CORPUS_DOCS.map((d) => `${sha256(buildCorpusPdf(d))}  ${d.filename}`).join('\n') + '\n';
}

function fmtDayFirst(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}
const money = (n: number) => n.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** The committed expected-value sheet, generated from the hand-written data above (so it can never disagree with it). */
export function expectedValuesMarkdown(): string {
  const out: string[] = [];
  out.push('# Expected values: PDF routes accuracy corpus (hand-computed)');
  out.push('');
  out.push('Generated by `scripts/pdf_routes_corpus.ts` from values written BY HAND in that file. Nothing here was read back from a parser or a model.');
  out.push('`tests/unit/pdfRoutesCorpus.test.ts` recomputes every identity below in integer cents and checks each figure is printed on its page.');
  out.push('SHA-256 of every file: `corpus/MANIFEST.sha256`. Dates are shown day-first.');
  out.push('');
  out.push('Outcome vocabulary: **certified** = read by the certified reader, reconciles exactly, no warning. **review_required** = written, but needs the person (every AI-read statement is review required by design). **refused** = nothing written.');
  out.push('');
  for (const cls of ['liability', 'retirement', 'au_investment'] as const) {
    out.push(`## ${cls === 'liability' ? 'Liability statements' : cls === 'retirement' ? 'Retirement statements' : 'Australian investment statements'}`);
    out.push('');
    out.push('| Id | Role | Certified reader | AI needed | Reconciliation of a correct reading | Outcome |');
    out.push('|---|---|---|---|---|---|');
    for (const d of ALL_CORPUS_DOCS.filter((x) => x.cls === cls)) {
      out.push(`| ${d.id} | ${d.role} | ${d.route.deterministic} | ${d.route.aiRequired ? 'yes' : 'no'} | ${d.route.reconciliation ?? 'n/a'} | ${d.route.outcome} |`);
    }
    out.push('');
    for (const d of ALL_CORPUS_DOCS.filter((x) => x.cls === cls)) {
      out.push(`### ${d.id}: ${d.summary}`);
      out.push('');
      out.push(`File: \`${d.filename}\`. The person chooses: ${Object.entries(d.declared).map(([k, v]) => `${k} = ${v}`).join(', ')}.`);
      out.push('');
      out.push('Hand arithmetic:');
      for (const h of d.hand) out.push(`* ${h}`);
      out.push('');
      const e = (d as LiabilityDoc | RetirementDoc | InvestmentDoc).expected;
      if (!e) {
        out.push('Expected result: nothing is written, no AI call, nothing charged.');
        out.push('');
        continue;
      }
      if (d.cls === 'liability') {
        const x = e as LiabilityExpected;
        out.push(`Header: ${x.institution}; identifier ending ${x.last4}; period ${fmtDayFirst(x.periodStart)} to ${fmtDayFirst(x.periodEnd)}${x.statementDate ? `; statement date ${fmtDayFirst(x.statementDate)}` : ''}${x.dueDate ? `; due ${fmtDayFirst(x.dueDate)}` : ''}; opening ${money(x.opening)}; printed closing ${money(x.printedClosing)}${x.closingByLines !== x.printedClosing ? ` (the lines give ${money(x.closingByLines)})` : ''}${x.creditLimit !== undefined ? `; limit ${money(x.creditLimit)}` : ''}${x.minimumPayment !== undefined ? `; minimum ${money(x.minimumPayment)}` : ''}${x.interestRate !== undefined ? `; rate ${x.interestRate}%` : ''}.`);
        out.push('');
        out.push('| Date | Type | Amount |');
        out.push('|---|---|---|');
        for (const a of x.activities) out.push(`| ${fmtDayFirst(a.date)} | ${a.type} | ${money(a.amount)} |`);
      } else if (d.cls === 'retirement') {
        const x = e as RetirementExpected;
        out.push(`Header: ${x.fund}; identifier ending ${x.last4}; ${x.jurisdiction}/${x.currency}; period ${x.jurisdiction === 'IN' ? fmtDayFirst(x.periodStart).replace(/\//g, '-') : fmtDayFirst(x.periodStart)} to ${x.jurisdiction === 'IN' ? fmtDayFirst(x.periodEnd).replace(/\//g, '-') : fmtDayFirst(x.periodEnd)}; opening ${money(x.opening)}; printed closing ${money(x.printedClosing)}${x.closingByMovements !== x.printedClosing ? ` (the movements give ${money(x.closingByMovements)})` : ''}.`);
        const mv: string[] = [];
        for (const [k, v] of Object.entries({ employer: x.employer, personal: x.personal, salarySacrifice: x.salarySacrifice, government: x.government, rolloversIn: x.rolloversIn, earnings: x.earnings, fees: x.fees, insurance: x.insurance, tax: x.tax, withdrawals: x.withdrawals, pensionPayments: x.pensionPayments })) {
          if (v !== undefined) mv.push(`${k} ${money(v)}`);
        }
        out.push('');
        out.push(`Period movements: ${mv.join('; ') || 'none (line form)'}.`);
        if (x.options.length) {
          out.push('');
          out.push('| Option | Units | Unit price | Balance |');
          out.push('|---|---|---|---|');
          for (const o of x.options) out.push(`| ${o.name} | ${o.units} | ${o.unitPrice} | ${money(o.value)} |`);
        }
        if (x.activities.length) {
          out.push('');
          out.push('| Date | Type | Amount |');
          out.push('|---|---|---|');
          for (const a of x.activities) out.push(`| ${fmtDayFirst(a.date)} | ${a.type} | ${money(a.amount)} |`);
        }
      } else {
        const x = e as InvestmentExpected;
        out.push(`Header: ${x.institution}; identifier ending ${x.last4}; ${x.kind}${x.date ? `; valuation ${fmtDayFirst(x.date)}` : ''}${x.periodStart ? `; period ${fmtDayFirst(x.periodStart)} to ${fmtDayFirst(x.periodEnd!)}` : ''}.`);
        if (x.holdings.length) {
          out.push('');
          out.push('| Code | Security | Quantity | Price | Printed value |');
          out.push('|---|---|---|---|---|');
          for (const h of x.holdings) out.push(`| ${h.code} | ${h.name} | ${h.quantity} | ${h.price} | ${money(h.value)} |`);
          out.push('');
          out.push(`Cash ${x.cash !== undefined ? money(x.cash) : 'not printed'}; printed total ${x.printedTotal !== undefined ? money(x.printedTotal) : 'not printed'}; sum of the printed lines plus cash ${x.sumOfPrinted !== undefined ? money(x.sumOfPrinted) : 'n/a'}.`);
        }
        if (x.transactions.length) {
          out.push('');
          out.push('| Date | Type | Code | Quantity | Price | Brokerage | Amount |');
          out.push('|---|---|---|---|---|---|---|');
          for (const t of x.transactions) out.push(`| ${fmtDayFirst(t.date)} | ${t.type} | ${t.code ?? '-'} | ${t.quantity ?? '-'} | ${t.price ?? '-'} | ${t.brokerage ?? '-'} | ${money(t.amount)} |`);
          out.push('');
          out.push(`Printed totals: buys ${money(x.totalBuys!)}; sells ${money(x.totalSells!)}; brokerage ${money(x.totalBrokerage!)}.`);
        }
      }
      out.push('');
    }
  }
  return out.join('\n') + '\n';
}

function main(): void {
  const dir = process.argv[2];
  if (!dir) {
    console.error('usage: npx tsx scripts/pdf_routes_corpus.ts <output-folder>');
    process.exit(2);
  }
  fs.mkdirSync(dir, { recursive: true });
  for (const d of ALL_CORPUS_DOCS) fs.writeFileSync(path.join(dir, d.filename), buildCorpusPdf(d));
  fs.writeFileSync(path.join(dir, 'MANIFEST.sha256'), manifestText());
  fs.writeFileSync(path.join(dir, '..', 'EXPECTED_VALUES.md'), expectedValuesMarkdown());
  console.log(`wrote ${ALL_CORPUS_DOCS.length} PDFs, MANIFEST.sha256 and EXPECTED_VALUES.md`);
}

if (process.argv[1] && /pdf_routes_corpus\.ts$/.test(process.argv[1].replace(/\\/g, '/'))) main();
