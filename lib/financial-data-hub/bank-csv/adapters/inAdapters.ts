/**
 * R7 — Bank CSV Engine: Indian bank adapters. See auAdapters.ts for the
 * fixture-privacy note (spec 63) — structural formats only, no real
 * customer data anywhere in this file or its fixtures.
 */

import type { BankCsvAdapter } from './types';
import { scoreHeaderAgainstSignature } from './types';

export const IN_SBI_DR_CR_V1: BankCsvAdapter = {
  id: 'in_sbi_dr_cr_v1',
  institutionCode: 'sbi',
  country: 'IN',
  version: '1.0.0',
  certificationState: 'certified',
  displayName: 'State Bank of India — Dr/Cr indicator CSV export',
  signature: {
    requiredHeaders: ['Txn Date', 'Description', 'Amount', 'Dr/Cr'],
    optionalHeaders: ['Balance', 'Ref No'],
    expectedColumnCount: 6,
  },
  amountConvention: 'dr_cr_indicator',
  dateFormat: 'DD/MM/YYYY',
  delimiter: ',',
  columnRoles: {
    transactionDate: 'Txn Date',
    description: 'Description',
    amount: 'Amount',
    drCrIndicator: 'Dr/Cr',
    balance: 'Balance',
    reference: 'Ref No',
  },
  scoreHeader(header) {
    return scoreHeaderAgainstSignature(header, this.signature);
  },
};

export const IN_HDFC_DEBIT_CREDIT_V1: BankCsvAdapter = {
  id: 'in_hdfc_debit_credit_v1',
  institutionCode: 'hdfc_bank',
  country: 'IN',
  version: '1.0.0',
  certificationState: 'certified',
  displayName: 'HDFC Bank — Withdrawal/Deposit CSV export',
  signature: {
    requiredHeaders: ['Date', 'Narration', 'Withdrawal Amt', 'Deposit Amt', 'Closing Balance'],
    expectedColumnCount: 6,
  },
  amountConvention: 'debit_credit_columns',
  dateFormat: 'DD/MM/YYYY',
  delimiter: ',',
  columnRoles: {
    transactionDate: 'Date',
    description: 'Narration',
    debit: 'Withdrawal Amt',
    credit: 'Deposit Amt',
    balance: 'Closing Balance',
  },
  scoreHeader(header) {
    return scoreHeaderAgainstSignature(header, this.signature);
  },
};

export const IN_ICICI_DR_CR_V1: BankCsvAdapter = {
  id: 'in_icici_dr_cr_v1',
  institutionCode: 'icici_bank',
  country: 'IN',
  version: '1.0.0',
  certificationState: 'certified',
  displayName: 'ICICI Bank — Dr/Cr indicator CSV export',
  signature: {
    requiredHeaders: ['Value Date', 'Transaction Remarks', 'Withdrawal Amount', 'Deposit Amount', 'Balance'],
    expectedColumnCount: 6,
  },
  amountConvention: 'debit_credit_columns',
  dateFormat: 'DD/MM/YYYY',
  delimiter: ',',
  columnRoles: {
    transactionDate: 'Value Date',
    description: 'Transaction Remarks',
    debit: 'Withdrawal Amount',
    credit: 'Deposit Amount',
    balance: 'Balance',
  },
  scoreHeader(header) {
    return scoreHeaderAgainstSignature(header, this.signature);
  },
};

export const IN_AXIS_DEBIT_CREDIT_V1: BankCsvAdapter = {
  id: 'in_axis_debit_credit_v1',
  institutionCode: 'axis_bank',
  country: 'IN',
  version: '1.0.0',
  certificationState: 'certified',
  displayName: 'Axis Bank — Debit/Credit CSV export',
  signature: {
    requiredHeaders: ['Tran Date', 'Particulars', 'Debit', 'Credit', 'Balance'],
    optionalHeaders: ['Chq No'],
    expectedColumnCount: 6,
  },
  amountConvention: 'debit_credit_columns',
  dateFormat: 'DD/MM/YYYY',
  delimiter: ',',
  columnRoles: {
    transactionDate: 'Tran Date',
    description: 'Particulars',
    debit: 'Debit',
    credit: 'Credit',
    balance: 'Balance',
    reference: 'Chq No',
  },
  scoreHeader(header) {
    return scoreHeaderAgainstSignature(header, this.signature);
  },
};

export const IN_KOTAK_DEBIT_CREDIT_V1: BankCsvAdapter = {
  id: 'in_kotak_debit_credit_v1',
  institutionCode: 'kotak_mahindra_bank',
  country: 'IN',
  version: '1.0.0',
  certificationState: 'certified',
  displayName: 'Kotak Mahindra Bank — Withdrawal(Dr)/Deposit(Cr) CSV export',
  signature: {
    requiredHeaders: ['Date', 'Narration', 'Withdrawal (Dr)', 'Deposit (Cr)', 'Balance'],
    optionalHeaders: ['Chq/Ref No.'],
    expectedColumnCount: 6,
  },
  amountConvention: 'debit_credit_columns',
  dateFormat: 'DD/MM/YYYY',
  delimiter: ',',
  columnRoles: {
    transactionDate: 'Date',
    description: 'Narration',
    debit: 'Withdrawal (Dr)',
    credit: 'Deposit (Cr)',
    balance: 'Balance',
    reference: 'Chq/Ref No.',
  },
  scoreHeader(header) {
    return scoreHeaderAgainstSignature(header, this.signature);
  },
};

export const IN_ADAPTERS = [
  IN_SBI_DR_CR_V1,
  IN_HDFC_DEBIT_CREDIT_V1,
  IN_ICICI_DR_CR_V1,
  IN_AXIS_DEBIT_CREDIT_V1,
  IN_KOTAK_DEBIT_CREDIT_V1,
];
