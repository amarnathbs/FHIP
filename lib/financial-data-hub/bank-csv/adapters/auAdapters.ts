/**
 * R7 — Bank CSV Engine: Australian bank adapters.
 *
 * FIXTURE PRIVACY (spec 63). These adapters describe STRUCTURAL formats
 * (column names/order, date/amount conventions) inferred from each
 * institution's own publicly documented CSV-export column headers. No real
 * customer statement, account number or transaction history is embedded
 * here or in any certification fixture — every test fixture using these
 * adapters is entirely synthetic (see tests/fixtures/r7-bank-csv/).
 */

import type { BankCsvAdapter } from './types';
import { scoreHeaderAgainstSignature } from './types';

export const AU_CBA_DEBIT_CREDIT_V1: BankCsvAdapter = {
  id: 'au_cba_debit_credit_v1',
  institutionCode: 'cba',
  country: 'AU',
  version: '1.0.0',
  certificationState: 'certified',
  displayName: 'Commonwealth Bank — Debit/Credit CSV export',
  signature: {
    requiredHeaders: ['Date', 'Description', 'Debit Amount', 'Credit Amount'],
    optionalHeaders: ['Balance'],
    expectedColumnCount: 5,
  },
  amountConvention: 'debit_credit_columns',
  dateFormat: 'DD/MM/YYYY',
  delimiter: ',',
  columnRoles: {
    transactionDate: 'Date',
    description: 'Description',
    debit: 'Debit Amount',
    credit: 'Credit Amount',
    balance: 'Balance',
  },
  scoreHeader(header) {
    return scoreHeaderAgainstSignature(header, this.signature);
  },
};

export const AU_WESTPAC_SINGLE_SIGNED_V1: BankCsvAdapter = {
  id: 'au_westpac_single_signed_v1',
  institutionCode: 'westpac',
  country: 'AU',
  version: '1.0.0',
  certificationState: 'certified',
  displayName: 'Westpac — Single-signed-amount CSV export',
  signature: {
    requiredHeaders: ['Date', 'Narrative', 'Amount'],
    optionalHeaders: ['Balance', 'Categories', 'Serial'],
    expectedColumnCount: 6,
  },
  amountConvention: 'single_signed',
  dateFormat: 'DD/MM/YYYY',
  delimiter: ',',
  columnRoles: {
    transactionDate: 'Date',
    description: 'Narrative',
    amount: 'Amount',
    balance: 'Balance',
    reference: 'Serial',
  },
  scoreHeader(header) {
    return scoreHeaderAgainstSignature(header, this.signature);
  },
};

export const AU_NAB_DEBIT_CREDIT_V1: BankCsvAdapter = {
  id: 'au_nab_debit_credit_v1',
  institutionCode: 'nab',
  country: 'AU',
  version: '1.0.0',
  certificationState: 'certified',
  displayName: 'National Australia Bank — Debit/Credit CSV export',
  signature: {
    requiredHeaders: ['Date', 'Transaction Details', 'Debit', 'Credit', 'Balance'],
    expectedColumnCount: 5,
  },
  amountConvention: 'debit_credit_columns',
  dateFormat: 'DD/MM/YYYY',
  delimiter: ',',
  columnRoles: {
    transactionDate: 'Date',
    description: 'Transaction Details',
    debit: 'Debit',
    credit: 'Credit',
    balance: 'Balance',
  },
  scoreHeader(header) {
    return scoreHeaderAgainstSignature(header, this.signature);
  },
};

export const AU_ANZ_DEBIT_CREDIT_V1: BankCsvAdapter = {
  id: 'au_anz_debit_credit_v1',
  institutionCode: 'anz',
  country: 'AU',
  version: '1.0.0',
  certificationState: 'certified',
  displayName: 'ANZ — Debit/Credit CSV export',
  signature: {
    requiredHeaders: ['Date', 'Transaction Description', 'Debit Amount', 'Credit Amount', 'Balance'],
    expectedColumnCount: 5,
  },
  amountConvention: 'debit_credit_columns',
  dateFormat: 'DD/MM/YYYY',
  delimiter: ',',
  columnRoles: {
    transactionDate: 'Date',
    description: 'Transaction Description',
    debit: 'Debit Amount',
    credit: 'Credit Amount',
    balance: 'Balance',
  },
  scoreHeader(header) {
    return scoreHeaderAgainstSignature(header, this.signature);
  },
};

export const AU_MACQUARIE_DEBIT_CREDIT_V1: BankCsvAdapter = {
  id: 'au_macquarie_debit_credit_v1',
  institutionCode: 'macquarie_bank',
  country: 'AU',
  version: '1.0.0',
  certificationState: 'certified',
  displayName: 'Macquarie Bank — Business daily-file CSV export',
  signature: {
    requiredHeaders: ['Transaction Date', 'Transaction Description', 'Debit Amount', 'Credit Amount'],
    optionalHeaders: ['Account Number', 'Account Name', 'Cheque/Reference Number'],
    expectedColumnCount: 7,
  },
  amountConvention: 'debit_credit_columns',
  dateFormat: 'DD/MM/YYYY',
  delimiter: ',',
  columnRoles: {
    transactionDate: 'Transaction Date',
    description: 'Transaction Description',
    debit: 'Debit Amount',
    credit: 'Credit Amount',
    reference: 'Cheque/Reference Number',
  },
  scoreHeader(header) {
    return scoreHeaderAgainstSignature(header, this.signature);
  },
};

/**
 * Bank Australia -- transaction export (CSV). EXPERIMENTAL (28-10-2026): built from ONE real export the Product Owner supplied, which
 * confirmed the bank. It is not certified, and because it names a bank it is never allowed to certify an import on its own: a file read
 * through it always lands in review (see `decideCertification`). Nothing from that real file is embedded here: the structure only (column
 * headings, the way dates and amounts are written). Every fixture is synthetic.
 *
 * What the sample showed, and what is assumed:
 *  - eleven columns: Account number, Transaction type, Effective date, Create date, Reference no, Debit amount, Credit amount,
 *    Balance after transfer, Description, Long description, Cheque number;
 *  - dates like "12:00am Tue 30 June, 2026" (a time, a weekday, the day, the month spelled out, the year), in both date columns;
 *  - money out in "Debit amount" and money in in "Credit amount", plain numbers, the unused one holding 0.
 *  ASSUMED (not seen): that the Transaction date to use is "Effective date" (the other date, "Create date", is kept as extra detail); that
 *  "Debit amount" is never negative; that headings are written exactly as above (case and spacing are ignored, wording is not).
 *  A variant with a different heading, a missing required column, or a different date style does NOT match: it falls to the column
 *  mapping screen, where the person chooses the columns. The optional columns (Create date, Reference no, Balance after transfer, Long
 *  description, Cheque number) may be absent without losing the match.
 */
export const AU_BANK_AUSTRALIA_DEBIT_CREDIT_V1: BankCsvAdapter = {
  id: 'au_bank_australia_debit_credit_v1',
  institutionCode: 'bank_australia',
  country: 'AU',
  version: '1.0.0',
  certificationState: 'experimental',
  displayName: 'Bank Australia \u2014 Transaction export (CSV)',
  signature: {
    // Distinctive on purpose: the account number and the transaction type are required so that another bank's file that merely shares
    // "Effective date" and "Debit amount" is never read with this bank's date style.
    requiredHeaders: ['Account number', 'Transaction type', 'Effective date', 'Debit amount', 'Credit amount', 'Description'],
    optionalHeaders: ['Create date', 'Reference no', 'Balance after transfer', 'Long description', 'Cheque number'],
    expectedColumnCount: 11,
  },
  amountConvention: 'debit_credit_columns',
  dateFormat: 'h:mma ddd D MMMM, YYYY',
  delimiter: ',',
  columnRoles: {
    transactionDate: 'Effective date',
    postedDate: 'Create date',
    description: 'Description',
    extraDescription: 'Long description',
    accountIdentifier: 'Account number',
    debit: 'Debit amount',
    credit: 'Credit amount',
    balance: 'Balance after transfer',
    reference: 'Reference no',
  },
  scoreHeader(header) {
    return scoreHeaderAgainstSignature(header, this.signature);
  },
};

export const AU_ADAPTERS = [
  AU_CBA_DEBIT_CREDIT_V1,
  AU_WESTPAC_SINGLE_SIGNED_V1,
  AU_NAB_DEBIT_CREDIT_V1,
  AU_ANZ_DEBIT_CREDIT_V1,
  AU_MACQUARIE_DEBIT_CREDIT_V1,
  AU_BANK_AUSTRALIA_DEBIT_CREDIT_V1,
];
