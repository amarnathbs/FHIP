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

export const AU_ADAPTERS = [AU_CBA_DEBIT_CREDIT_V1, AU_WESTPAC_SINGLE_SIGNED_V1, AU_NAB_DEBIT_CREDIT_V1];
