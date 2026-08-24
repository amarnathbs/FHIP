/**
 * FDH-5 — Bank PDF Statement Engine: statement-level metadata extraction
 * (spec sections 36-37).
 *
 * Extracts opening/closing balance, masked account identifier and statement
 * period ONLY where the source explicitly states them (spec 36: "do not
 * infer that the first transaction's running balance is necessarily the
 * bank's official opening balance") — every field here is either a real,
 * explicitly-matched value or `null`; nothing is guessed or derived from the
 * transaction rows.
 */

import { normaliseMaskedIdentifier } from '../bank-csv/accountIdentity';
import { parseAmountField, roundToMoneyScale } from '../bank-csv/amount';
import { parseDateWithFormat, type SupportedDateFormat } from '../bank-csv/dateFormats';
import type { PdfBankAdapter } from './adapters/types';

export interface PdfStatementMetadata {
  declaredOpeningBalance: number | null;
  declaredClosingBalance: number | null;
  maskedAccountIdentifier: string | null;
  statementPeriodStart: string | null;
  statementPeriodEnd: string | null;
}

function matchBalance(fullText: string, pattern: RegExp | undefined): number | null {
  if (!pattern) return null;
  const m = fullText.match(pattern);
  if (!m || !m[1]) return null;
  const parsed = parseAmountField(m[1]);
  if (!parsed.ok || parsed.magnitude === null) return null;
  return roundToMoneyScale(parsed.isNegative ? -parsed.magnitude : parsed.magnitude);
}

function matchDate(fullText: string, pattern: RegExp | undefined, dateFormat: SupportedDateFormat): string | null {
  if (!pattern) return null;
  const m = fullText.match(pattern);
  if (!m || !m[1]) return null;
  const parsed = parseDateWithFormat(m[1], dateFormat);
  return parsed.ok ? parsed.iso : null;
}

export function extractPdfStatementMetadata(fullText: string, adapter: PdfBankAdapter): PdfStatementMetadata {
  const p = adapter.metadataPatterns;
  let maskedAccountIdentifier: string | null = null;
  if (p.maskedAccountIdentifier) {
    const m = fullText.match(p.maskedAccountIdentifier);
    if (m && m[1]) {
      // Reuses the EXACT same masking discipline the CSV path applies to a
      // user-declared masked identifier (spec 37: "apply existing
      // masked/fingerprinted account controls") — never a full account
      // number, no matter what the adapter's own regex happened to capture.
      const normalised = normaliseMaskedIdentifier(m[1]);
      maskedAccountIdentifier = normalised && !/\d{7,}/.test(normalised) ? normalised : null;
    }
  }

  return {
    declaredOpeningBalance: matchBalance(fullText, p.openingBalance),
    declaredClosingBalance: matchBalance(fullText, p.closingBalance),
    maskedAccountIdentifier,
    statementPeriodStart: matchDate(fullText, p.statementPeriodStart, adapter.dateFormat),
    statementPeriodEnd: matchDate(fullText, p.statementPeriodEnd, adapter.dateFormat),
  };
}
