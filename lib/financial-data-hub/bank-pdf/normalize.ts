/**
 * FDH-5 — Bank PDF Statement Engine: canonical transaction normalisation
 * (spec sections 38-41).
 *
 * REUSE, NOT REIMPLEMENTATION. Every actual parsing/rounding primitive here
 * is imported UNCHANGED from `bank-csv/*`: `parseDateWithFormat`,
 * `parseAmountField`, `roundToMoneyScale`, `normalizeDescription`,
 * `inferTypeHint`. This module's own job is narrow: turn a
 * `ReconstructedRow` (PDF-specific shape) into the exact same
 * `NormalizedTransactionCandidate` shape `bank-csv/normalize.ts` produces,
 * so every downstream consumer (fingerprinting, dedup, reconciliation,
 * persistence, R8) is IDENTICAL code regardless of source format (spec 2,
 * 38, 57, 60, 63 — "one financial truth pipeline").
 */

import type { FdhCsvAmountConvention, FdhCreditDebit } from '../constants/enums';
import { parseDateWithFormat, type SupportedDateFormat } from '../bank-csv/dateFormats';
import { parseAmountField, roundToMoneyScale } from '../bank-csv/amount';
import { normalizeDescription, inferTypeHint, type NormalizedTransactionCandidate } from '../bank-csv/normalize';
import type { ReconstructedRow } from './rowReconstruction';

export type PdfNormalizationFailureReason =
  | 'invalid_transaction_date'
  | 'invalid_amount'
  | 'zero_amount'
  | 'ambiguous_direction'
  | 'missing_balance';

export interface PdfNormalizationResult {
  ok: true;
  transaction: NormalizedTransactionCandidate;
  /** Statement-level extraction confidence contribution for THIS row (spec
   * 44-45) — independent of `classification_confidence`. 1.0 for a row
   * whose numeric tail was found on the same line as its date; a fixed,
   * documented penalty when it had to be located on a continuation line
   * (rarer layout, slightly less certain the numbers truly belong to this
   * row rather than a mis-split neighbour). */
  extractionConfidence: number;
}
export type PdfNormalizationOutcome = PdfNormalizationResult | { ok: false; reason: PdfNormalizationFailureReason; rowIndex: number };

const CONTINUATION_LINE_CONFIDENCE_PENALTY = 0.1;

export function normalizePdfRow(
  row: ReconstructedRow,
  dateFormat: SupportedDateFormat,
  amountConvention: FdhCsvAmountConvention,
): PdfNormalizationOutcome {
  const fail = (reason: PdfNormalizationFailureReason): PdfNormalizationOutcome => ({ ok: false, reason, rowIndex: row.rowIndex });

  const dateParsed = parseDateWithFormat(row.dateRaw, dateFormat);
  if (!dateParsed.ok || !dateParsed.iso) return fail('invalid_transaction_date');

  const amountParsed = parseAmountField(row.amountRaw);
  if (!amountParsed.ok || amountParsed.magnitude === null) return fail('invalid_amount');
  if (amountParsed.magnitude === 0) return fail('zero_amount');

  let creditDebit: FdhCreditDebit;
  if (amountConvention === 'dr_cr_indicator') {
    if (row.directionMarkerRaw === 'DR') creditDebit = 'debit';
    else if (row.directionMarkerRaw === 'CR') creditDebit = 'credit';
    else return fail('ambiguous_direction');
  } else {
    // single_signed: the row's own sign (leading '-' or parenthesised) IS
    // the direction, exactly as `bank-csv/normalize.ts`'s own
    // single_signed branch decides it.
    creditDebit = amountParsed.isNegative ? 'debit' : 'credit';
  }

  let balanceAfter: number | null = null;
  if (row.balanceRaw) {
    const balanceParsed = parseAmountField(row.balanceRaw);
    if (balanceParsed.ok && balanceParsed.magnitude !== null) {
      balanceAfter = balanceParsed.isNegative ? -balanceParsed.magnitude : balanceParsed.magnitude;
    }
  }

  const descriptionClean = normalizeDescription(row.descriptionRaw);

  const transaction: NormalizedTransactionCandidate = {
    sourceRowNumber: row.rowIndex,
    transactionDate: dateParsed.iso,
    postedDate: null,
    valueDate: null,
    descriptionRaw: row.descriptionRaw,
    descriptionClean,
    referenceRaw: null,
    amountOriginal: roundToMoneyScale(amountParsed.magnitude),
    creditDebit,
    balanceAfter: balanceAfter !== null ? roundToMoneyScale(balanceAfter) : null,
    transactionTypeHint: inferTypeHint(descriptionClean, creditDebit),
  };

  const extractionConfidence = row.numbersOnContinuationLine ? Math.max(0, 1 - CONTINUATION_LINE_CONFIDENCE_PENALTY) : 1;

  return { ok: true, transaction, extractionConfidence };
}
