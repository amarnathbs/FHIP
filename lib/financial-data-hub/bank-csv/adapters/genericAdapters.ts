/**
 * R7 — Bank CSV Engine: country-neutral generic structural adapters.
 *
 * EXPERIMENTAL (spec section 60) — these recognise common, non-institution-
 * specific column shapes rather than a proven real bank export. They exist
 * so a plausible, valid bank CSV that happens not to match a certified
 * institution adapter still has a chance at automatic DETECTED status before
 * falling back to MANUAL_MAPPING_REQUIRED. They must never be presented to a
 * user as "we recognised your bank" — only as a structural match.
 */

import type { BankCsvAdapter } from './types';
import { scoreHeaderAgainstSignature } from './types';

export const GENERIC_SINGLE_SIGNED_V1: BankCsvAdapter = {
  id: 'generic_single_signed_v1',
  institutionCode: null,
  country: null,
  version: '1.0.0',
  certificationState: 'experimental',
  displayName: 'Generic — single signed-amount CSV',
  signature: {
    requiredHeaders: ['Date', 'Description', 'Amount'],
    optionalHeaders: ['Balance', 'Reference'],
  },
  amountConvention: 'single_signed',
  dateFormat: 'YYYY-MM-DD',
  delimiter: ',',
  columnRoles: {
    transactionDate: 'Date',
    description: 'Description',
    amount: 'Amount',
    balance: 'Balance',
    reference: 'Reference',
  },
  scoreHeader(header) {
    // A generic experimental fallback is deliberately capped below the
    // detection-confidence floor for a lone match (spec 21/60) — it can
    // still win DETECTED when it is a clean, unambiguous, high-quality
    // match, but never edges out a certified institution adapter.
    return scoreHeaderAgainstSignature(header, this.signature) * 0.95;
  },
};

export const GENERIC_DEBIT_CREDIT_V1: BankCsvAdapter = {
  id: 'generic_debit_credit_v1',
  institutionCode: null,
  country: null,
  version: '1.0.0',
  certificationState: 'experimental',
  displayName: 'Generic — debit/credit column CSV',
  signature: {
    requiredHeaders: ['Date', 'Description', 'Debit', 'Credit'],
    optionalHeaders: ['Balance', 'Reference'],
  },
  amountConvention: 'debit_credit_columns',
  dateFormat: 'YYYY-MM-DD',
  delimiter: ',',
  columnRoles: {
    transactionDate: 'Date',
    description: 'Description',
    debit: 'Debit',
    credit: 'Credit',
    balance: 'Balance',
    reference: 'Reference',
  },
  scoreHeader(header) {
    return scoreHeaderAgainstSignature(header, this.signature) * 0.95;
  },
};

export const GENERIC_ADAPTERS = [GENERIC_SINGLE_SIGNED_V1, GENERIC_DEBIT_CREDIT_V1];
