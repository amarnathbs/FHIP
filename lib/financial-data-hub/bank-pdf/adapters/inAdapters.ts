/**
 * FDH-5 — India priority-bank PDF adapters (spec sections 50, 52-56).
 *
 * Same evidence-standard discipline as `auAdapters.ts` — synthetic
 * structural fixtures from documented conventions, no real customer
 * statement. India statements are additionally the PARTICULAR SCRUTINY AREA
 * for password-protected handling (spec 50: "India support must
 * specifically consider encrypted/password-protected statements") — that
 * handling lives in `bank-pdf/password.ts` and the processing service
 * (applies identically regardless of which adapter below eventually
 * matches; a password-protected PDF's content is not visible to ANY
 * adapter's `scoreText()` until a correct password has been supplied and
 * discarded, per `textExtraction.ts`).
 */

import type { PdfBankAdapter } from './types';
import { scoreTextAgainstSignature } from './types';

export const IN_SBI_PDF_V1: PdfBankAdapter = {
  id: 'in_sbi_pdf_v1',
  institutionCode: 'sbi',
  country: 'IN',
  version: '1.0.0',
  certificationState: 'certified',
  displayName: 'State Bank of India — PDF statement (V1)',
  certifiedExtractionMethods: ['native_text'],
  signature: {
    requiredMarkers: ['State Bank of India', 'Account Statement'],
    optionalMarkers: ['Txn Date', 'Description', 'Debit', 'Credit', 'Balance'],
  },
  amountConvention: 'dr_cr_indicator',
  dateFormat: 'DD Mon YYYY',
  // "10 Aug 2026  UPI/mmid/vpa/NEFT TRANSFER   1,250.00 DR   45,678.90"
  dateLineRegex: /^(\d{1,2}\s+[A-Za-z]{3,4}\s+\d{4})\s*(.*)$/,
  headerFooterPatterns: [/^Txn Date\s+Description\s+Debit\s+Credit\s+Balance$/i, /^Page \d+ of \d+$/i, /^State Bank of India$/i],
  metadataPatterns: {
    openingBalance: /Opening Balance[:\s]+(?:Rs\.?|₹)?\s*([\d,]+\.\d{2})/i,
    closingBalance: /Closing Balance[:\s]+(?:Rs\.?|₹)?\s*([\d,]+\.\d{2})/i,
    maskedAccountIdentifier: /Account No[:\s]+(X{2,}\d{2,4})/i,
  },
  scoreText: (fullText) =>
    scoreTextAgainstSignature(fullText, {
      requiredMarkers: ['State Bank of India', 'Account Statement'],
      optionalMarkers: ['Txn Date', 'Description', 'Debit', 'Credit', 'Balance'],
    }),
};

export const IN_HDFC_PDF_V1: PdfBankAdapter = {
  id: 'in_hdfc_pdf_v1',
  institutionCode: 'hdfc_bank',
  country: 'IN',
  version: '1.0.0',
  certificationState: 'certified',
  displayName: 'HDFC Bank — PDF statement (V1)',
  certifiedExtractionMethods: ['native_text'],
  signature: {
    requiredMarkers: ['HDFC Bank', 'Statement of Account'],
    optionalMarkers: ['Date', 'Narration', 'Withdrawal Amt', 'Deposit Amt', 'Closing Balance'],
  },
  amountConvention: 'single_signed',
  dateFormat: 'DD/MM/YYYY',
  // "10/08/2026  IMPS-P2A-TRANSFER-JOHN DOE   -2500.00   67,890.12"
  dateLineRegex: /^(\d{1,2}\/\d{1,2}\/\d{4})\s*(.*)$/,
  headerFooterPatterns: [/^Date\s+Narration\s+/i, /^Page \d+ of \d+$/i, /^HDFC BANK LIMITED/i],
  metadataPatterns: {
    openingBalance: /Opening Balance[:\s]+(?:Rs\.?|₹)?\s*([\d,]+\.\d{2})/i,
    closingBalance: /Closing Balance[:\s]+(?:Rs\.?|₹)?\s*([\d,]+\.\d{2})/i,
    maskedAccountIdentifier: /Account No[:\s]+(X{2,}\d{2,4})/i,
  },
  scoreText: (fullText) =>
    scoreTextAgainstSignature(fullText, {
      requiredMarkers: ['HDFC Bank', 'Statement of Account'],
      optionalMarkers: ['Date', 'Narration', 'Withdrawal Amt', 'Deposit Amt', 'Closing Balance'],
    }),
};

export const IN_ICICI_PDF_V1: PdfBankAdapter = {
  id: 'in_icici_pdf_v1',
  institutionCode: 'icici_bank',
  country: 'IN',
  version: '1.0.0',
  certificationState: 'certified',
  displayName: 'ICICI Bank — PDF statement (V1)',
  certifiedExtractionMethods: ['native_text'],
  signature: {
    requiredMarkers: ['ICICI Bank', 'Account Statement'],
    optionalMarkers: ['Date', 'Transaction Remarks', 'Withdrawal', 'Deposit', 'Balance'],
  },
  amountConvention: 'dr_cr_indicator',
  dateFormat: 'DD-Mon-YYYY',
  // "10-Aug-2026  NEFT DR-ICIC0000123-JOHN DOE   5,000.00 DR   1,23,456.78"
  dateLineRegex: /^(\d{1,2}-[A-Za-z]{3,4}-\d{4})\s*(.*)$/,
  headerFooterPatterns: [/^Date\s+Transaction Remarks\s+/i, /^Page \d+ of \d+$/i, /^ICICI Bank Limited/i],
  metadataPatterns: {
    openingBalance: /Opening Balance[:\s]+(?:Rs\.?|₹)?\s*([\d,]+\.\d{2})/i,
    closingBalance: /Closing Balance[:\s]+(?:Rs\.?|₹)?\s*([\d,]+\.\d{2})/i,
    maskedAccountIdentifier: /Account Number[:\s]+(X{2,}\d{2,4})/i,
  },
  scoreText: (fullText) =>
    scoreTextAgainstSignature(fullText, {
      requiredMarkers: ['ICICI Bank', 'Account Statement'],
      optionalMarkers: ['Date', 'Transaction Remarks', 'Withdrawal', 'Deposit', 'Balance'],
    }),
};

export const IN_AXIS_PDF_V1: PdfBankAdapter = {
  id: 'in_axis_pdf_v1',
  institutionCode: 'axis_bank',
  country: 'IN',
  version: '1.0.0',
  certificationState: 'certified',
  displayName: 'Axis Bank — PDF statement (V1)',
  certifiedExtractionMethods: ['native_text'],
  signature: {
    requiredMarkers: ['Axis Bank', 'Statement of Account'],
    optionalMarkers: ['Tran Date', 'Particulars', 'Debit', 'Credit', 'Balance'],
  },
  amountConvention: 'single_signed',
  dateFormat: 'DD/MM/YYYY',
  // "10/08/2026  ATM WDL AXIS BANK MUMBAI   -1000.00   34,567.89"
  dateLineRegex: /^(\d{1,2}\/\d{1,2}\/\d{4})\s*(.*)$/,
  headerFooterPatterns: [/^Tran Date\s+Particulars\s+/i, /^Page \d+ of \d+$/i, /^Axis Bank Limited/i],
  metadataPatterns: {
    openingBalance: /Opening Balance[:\s]+(?:Rs\.?|₹)?\s*([\d,]+\.\d{2})/i,
    closingBalance: /Closing Balance[:\s]+(?:Rs\.?|₹)?\s*([\d,]+\.\d{2})/i,
    maskedAccountIdentifier: /Account No[:\s]+(X{2,}\d{2,4})/i,
  },
  scoreText: (fullText) =>
    scoreTextAgainstSignature(fullText, {
      requiredMarkers: ['Axis Bank', 'Statement of Account'],
      optionalMarkers: ['Tran Date', 'Particulars', 'Debit', 'Credit', 'Balance'],
    }),
};

export const IN_PDF_ADAPTERS: PdfBankAdapter[] = [IN_SBI_PDF_V1, IN_HDFC_PDF_V1, IN_ICICI_PDF_V1, IN_AXIS_PDF_V1];
