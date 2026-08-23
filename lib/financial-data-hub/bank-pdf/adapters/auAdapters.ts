/**
 * FDH-5 — AU priority-bank PDF adapters (spec sections 49, 52-56).
 *
 * EVIDENCE STANDARD (spec 52-54). No real customer bank statement was used
 * to build or certify these adapters. Each layout below is a SYNTHETIC
 * structural fixture built from each bank's well-documented, publicly
 * observable statement CONVENTIONS (institution branding text, standard
 * "Date / Transaction Details / Debit / Credit / Balance"-shaped column
 * layout, standard AU date/currency formatting) — the exact same evidence
 * tier R7's own CSV adapters shipped with (migration 0064: "R7 initial
 * certification against synthetic representative fixtures — no real
 * customer statement used"). No real statement of any kind — sanitised or
 * otherwise — enters this repository (spec 54).
 *
 * Each adapter's `certificationState` is `'certified'` only for the
 * NATIVE-TEXT extraction method it is actually certified against in this
 * phase (`certifiedExtractionMethods: ['native_text']`) — none claim OCR
 * certification (spec 55-56; OCR fallback is architecture-only in this
 * phase, see `FDH5_OCR_ARCHITECTURE.md`).
 */

import type { PdfBankAdapter } from './types';
import { scoreTextAgainstSignature } from './types';

export const AU_CBA_PDF_V1: PdfBankAdapter = {
  id: 'au_cba_pdf_v1',
  institutionCode: 'cba',
  country: 'AU',
  version: '1.0.0',
  certificationState: 'certified',
  displayName: 'Commonwealth Bank — PDF statement (V1)',
  certifiedExtractionMethods: ['native_text'],
  signature: {
    requiredMarkers: ['Commonwealth Bank', 'Statement of Account'],
    optionalMarkers: ['Date', 'Transaction Details', 'Debit', 'Credit', 'Balance'],
  },
  amountConvention: 'dr_cr_indicator',
  dateFormat: 'DD Mon YYYY',
  // "10 Aug 2026  CARD PURCHASE WOOLWORTHS 1234   45.20 DR   1,234.56"
  dateLineRegex: /^(\d{1,2}\s+[A-Za-z]{3,4}\s+\d{4})\s*(.*)$/,
  headerFooterPatterns: [
    /^Date\s+Transaction Details\s+Debit\s+Credit\s+Balance$/i,
    /^Page \d+ of \d+$/i,
    /^Commonwealth Bank of Australia/i,
  ],
  metadataPatterns: {
    openingBalance: /Opening Balance[:\s]+\$?([\d,]+\.\d{2})/i,
    closingBalance: /Closing Balance[:\s]+\$?([\d,]+\.\d{2})/i,
    maskedAccountIdentifier: /Account Number[:\s]+(\*{2,}\d{2,4})/i,
  },
  scoreText: (fullText) =>
    scoreTextAgainstSignature(fullText, {
      requiredMarkers: ['Commonwealth Bank', 'Statement of Account'],
      optionalMarkers: ['Date', 'Transaction Details', 'Debit', 'Credit', 'Balance'],
    }),
};

export const AU_ANZ_PDF_V1: PdfBankAdapter = {
  id: 'au_anz_pdf_v1',
  institutionCode: 'anz',
  country: 'AU',
  version: '1.0.0',
  certificationState: 'certified',
  displayName: 'ANZ — PDF statement (V1)',
  certifiedExtractionMethods: ['native_text'],
  signature: {
    requiredMarkers: ['Australia and New Zealand Banking Group', 'Account Statement'],
    optionalMarkers: ['Date', 'Narrative', 'Amount', 'Balance'],
  },
  amountConvention: 'single_signed',
  dateFormat: 'DD/MM/YYYY',
  // "10/08/2026  DIRECT DEBIT XYZ INSURANCE   -45.20   1,234.56"
  dateLineRegex: /^(\d{1,2}\/\d{1,2}\/\d{4})\s*(.*)$/,
  headerFooterPatterns: [/^Date\s+Narrative\s+Amount\s+Balance$/i, /^Page \d+ of \d+$/i, /^ANZ Bank$/i],
  metadataPatterns: {
    openingBalance: /Opening Balance[:\s]+\$?([\d,]+\.\d{2})/i,
    closingBalance: /Closing Balance[:\s]+\$?([\d,]+\.\d{2})/i,
    maskedAccountIdentifier: /Account[:\s]+(\*{2,}[\d\s]{2,6})/i,
  },
  scoreText: (fullText) =>
    scoreTextAgainstSignature(fullText, {
      requiredMarkers: ['Australia and New Zealand Banking Group', 'Account Statement'],
      optionalMarkers: ['Date', 'Narrative', 'Amount', 'Balance'],
    }),
};

export const AU_NAB_PDF_V1: PdfBankAdapter = {
  id: 'au_nab_pdf_v1',
  institutionCode: 'nab',
  country: 'AU',
  version: '1.0.0',
  certificationState: 'certified',
  displayName: 'National Australia Bank — PDF statement (V1)',
  certifiedExtractionMethods: ['native_text'],
  signature: {
    requiredMarkers: ['National Australia Bank', 'Transaction Listing'],
    optionalMarkers: ['Date', 'Description', 'Debit', 'Credit', 'Balance'],
  },
  amountConvention: 'dr_cr_indicator',
  dateFormat: 'DD-MM-YYYY',
  // "10-08-2026  EFTPOS PURCHASE COLES 442   67.10 DR   2,345.67"
  dateLineRegex: /^(\d{1,2}-\d{1,2}-\d{4})\s*(.*)$/,
  headerFooterPatterns: [/^Date\s+Description\s+Debit\s+Credit\s+Balance$/i, /^Page \d+ of \d+$/i, /^National Australia Bank Limited/i],
  metadataPatterns: {
    openingBalance: /Opening Balance[:\s]+\$?([\d,]+\.\d{2})/i,
    closingBalance: /Closing Balance[:\s]+\$?([\d,]+\.\d{2})/i,
    maskedAccountIdentifier: /BSB\/Account[:\s]+(\*{2,}[\d\s-]{2,10})/i,
  },
  scoreText: (fullText) =>
    scoreTextAgainstSignature(fullText, {
      requiredMarkers: ['National Australia Bank', 'Transaction Listing'],
      optionalMarkers: ['Date', 'Description', 'Debit', 'Credit', 'Balance'],
    }),
};

export const AU_WESTPAC_PDF_V1: PdfBankAdapter = {
  id: 'au_westpac_pdf_v1',
  institutionCode: 'westpac',
  country: 'AU',
  version: '1.0.0',
  certificationState: 'certified',
  displayName: 'Westpac — PDF statement (V1)',
  certifiedExtractionMethods: ['native_text'],
  signature: {
    requiredMarkers: ['Westpac Banking Corporation', 'Account Transactions'],
    optionalMarkers: ['Date', 'Details', 'Amount', 'Balance'],
  },
  amountConvention: 'single_signed',
  dateFormat: 'DD/MM/YYYY',
  // "10/08/2026  SALARY XYZ PTY LTD   2500.00   6,234.56"
  dateLineRegex: /^(\d{1,2}\/\d{1,2}\/\d{4})\s*(.*)$/,
  headerFooterPatterns: [/^Date\s+Details\s+Amount\s+Balance$/i, /^Page \d+ of \d+$/i, /^Westpac Banking Corporation ABN/i],
  metadataPatterns: {
    openingBalance: /Opening Balance[:\s]+\$?([\d,]+\.\d{2})/i,
    closingBalance: /Closing Balance[:\s]+\$?([\d,]+\.\d{2})/i,
    maskedAccountIdentifier: /Account[:\s]+(\*{2,}[\d\s]{2,6})/i,
  },
  scoreText: (fullText) =>
    scoreTextAgainstSignature(fullText, {
      requiredMarkers: ['Westpac Banking Corporation', 'Account Transactions'],
      optionalMarkers: ['Date', 'Details', 'Amount', 'Balance'],
    }),
};

export const AU_PDF_ADAPTERS: PdfBankAdapter[] = [AU_CBA_PDF_V1, AU_ANZ_PDF_V1, AU_NAB_PDF_V1, AU_WESTPAC_PDF_V1];
