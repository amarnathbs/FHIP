/**
 * R7 — Bank CSV Engine: canonical transaction normalisation (spec sections
 * 24-30, 39-41).
 *
 * ONE code path for both an auto-detected adapter and a user-confirmed
 * generic mapping — both are reduced to the same `RowFormat` shape before
 * reaching `normalizeRow()`, so the two paths can never silently disagree
 * (the same discipline `lib/utils/csv.ts`'s own header comment documents for
 * its two callers).
 */

import type { FdhCsvAmountConvention, FdhCreditDebit, FdhTransactionTypeHint } from '../constants/enums';
import { parseDateWithFormat, type SupportedDateFormat } from './dateFormats';
import { parseAmountField, roundToMoneyScale } from './amount';
import type { FdhCsvColumnMapping } from '../domain/types';
import type { BankCsvAdapter } from './adapters/types';

export interface RowFormat {
  columnRoles: {
    transactionDate: string;
    postedDate?: string;
    valueDate?: string;
    description: string;
    amount?: string;
    debit?: string;
    credit?: string;
    drCrIndicator?: string;
    balance?: string;
    reference?: string;
  };
  amountConvention: FdhCsvAmountConvention;
  dateFormat: SupportedDateFormat;
}

export function adapterToRowFormat(adapter: BankCsvAdapter): RowFormat {
  return { columnRoles: adapter.columnRoles, amountConvention: adapter.amountConvention, dateFormat: adapter.dateFormat };
}

export function mappingToRowFormat(mapping: FdhCsvColumnMapping, amountConvention: FdhCsvAmountConvention, dateFormat: SupportedDateFormat): RowFormat {
  return {
    columnRoles: {
      transactionDate: mapping.transaction_date,
      postedDate: mapping.posting_date ?? undefined,
      valueDate: mapping.value_date ?? undefined,
      description: mapping.description,
      amount: mapping.amount ?? undefined,
      debit: mapping.debit ?? undefined,
      credit: mapping.credit ?? undefined,
      drCrIndicator: mapping.dr_cr_indicator ?? undefined,
      balance: mapping.balance ?? undefined,
      reference: mapping.reference ?? undefined,
    },
    amountConvention,
    dateFormat,
  };
}

export type NormalizationFailureReason =
  | 'missing_transaction_date'
  | 'invalid_transaction_date'
  | 'missing_amount'
  | 'invalid_amount'
  | 'zero_amount'
  | 'ambiguous_direction'
  | 'column_not_found';

export interface NormalizedTransactionCandidate {
  sourceRowNumber: number;
  transactionDate: string;
  postedDate: string | null;
  valueDate: string | null;
  descriptionRaw: string;
  descriptionClean: string;
  referenceRaw: string | null;
  amountOriginal: number;
  creditDebit: FdhCreditDebit;
  balanceAfter: number | null;
  transactionTypeHint: FdhTransactionTypeHint;
}

export type NormalizationResult =
  | { ok: true; transaction: NormalizedTransactionCandidate }
  | { ok: false; reason: NormalizationFailureReason; sourceRowNumber: number };

function columnIndex(header: readonly string[], name: string | undefined): number {
  if (!name) return -1;
  const target = name.trim().toLowerCase();
  return header.findIndex((h) => h.trim().toLowerCase() === target);
}

function cell(header: readonly string[], row: readonly string[], name: string | undefined): string | null {
  const idx = columnIndex(header, name);
  if (idx === -1) return null;
  return row[idx] ?? '';
}

/**
 * Normalises Unicode (NFKC), trims, and collapses internal whitespace runs
 * to a single space (spec 29). Never destroys a reference number — no digit
 * or punctuation character is stripped, only whitespace is collapsed.
 */
export function normalizeDescription(raw: string): string {
  return raw.normalize('NFKC').trim().replace(/\s+/g, ' ');
}

/** Deterministic structural type hints (spec 40) — bounded, explainable
 * substring rules over the NORMALISED description. Never a final category,
 * never AI-derived (spec 41). Order matters: first match wins. */
function inferTypeHint(descriptionClean: string, creditDebit: FdhCreditDebit): FdhTransactionTypeHint {
  const d = descriptionClean.toLowerCase();
  if (/\batm\b|\bcash withdrawal\b/.test(d)) return 'atm_candidate';
  if (/\binterest\b|\bint\.?\s*credit\b/.test(d)) return 'interest_candidate';
  if (/\bfee\b|\bcharge\b|\bsurcharge\b/.test(d)) return 'fee_candidate';
  if (/\bsalary\b|\bpayroll\b|\bwages\b/.test(d) && creditDebit === 'credit') return 'salary_candidate';
  if (/\bdirect debit\b|\bdd\b\s|\bautopay\b/.test(d)) return 'direct_debit_candidate';
  if (/\b(mutual fund|sip|folio|broker|zerodha|groww|nse|bse|vanguard|super contribution|nps)\b/.test(d)) {
    return 'investment_transfer_candidate';
  }
  if (/\btransfer\b|\bpayid\b|\bimps\b|\bneft\b|\brtgs\b|\bupi\b|\bosko\b/.test(d)) return 'transfer_candidate';
  if (/\bcard purchase\b|\bpos\b|\bvisa\b|\bmastercard\b/.test(d)) return 'card_payment_candidate';
  return creditDebit === 'credit' ? 'credit' : 'debit';
}

/**
 * Normalises one raw CSV row into a canonical transaction candidate, or
 * reports exactly why it could not be normalised. `rowFormat` has already
 * been proven (by a certified adapter's detection or a user-confirmed
 * mapping) — this function performs NO format inference of its own.
 */
export function normalizeRow(
  header: readonly string[],
  row: readonly string[],
  sourceRowNumber: number,
  rowFormat: RowFormat,
): NormalizationResult {
  const fail = (reason: NormalizationFailureReason): NormalizationResult => ({ ok: false, reason, sourceRowNumber });

  const dateRaw = cell(header, row, rowFormat.columnRoles.transactionDate);
  if (dateRaw === null) return fail('column_not_found');
  if (!dateRaw.trim()) return fail('missing_transaction_date');
  const dateParsed = parseDateWithFormat(dateRaw, rowFormat.dateFormat);
  if (!dateParsed.ok || !dateParsed.iso) return fail('invalid_transaction_date');

  let postedDate: string | null = null;
  if (rowFormat.columnRoles.postedDate) {
    const raw = cell(header, row, rowFormat.columnRoles.postedDate);
    if (raw?.trim()) {
      const parsed = parseDateWithFormat(raw, rowFormat.dateFormat);
      postedDate = parsed.ok ? parsed.iso : null;
    }
  }
  let valueDate: string | null = null;
  if (rowFormat.columnRoles.valueDate) {
    const raw = cell(header, row, rowFormat.columnRoles.valueDate);
    if (raw?.trim()) {
      const parsed = parseDateWithFormat(raw, rowFormat.dateFormat);
      valueDate = parsed.ok ? parsed.iso : null;
    }
  }

  const descriptionRaw = cell(header, row, rowFormat.columnRoles.description) ?? '';
  const descriptionClean = normalizeDescription(descriptionRaw);
  const referenceRaw = rowFormat.columnRoles.reference ? cell(header, row, rowFormat.columnRoles.reference) : null;

  let magnitude: number;
  let creditDebit: FdhCreditDebit;

  // AMOUNT CANONICALISATION (spec 25) — one convention, three source shapes.
  if (rowFormat.amountConvention === 'single_signed') {
    const raw = cell(header, row, rowFormat.columnRoles.amount);
    if (raw === null) return fail('column_not_found');
    if (!raw.trim()) return fail('missing_amount');
    const parsed = parseAmountField(raw);
    if (!parsed.ok || parsed.magnitude === null) return fail('invalid_amount');
    if (parsed.magnitude === 0) return fail('zero_amount');
    magnitude = parsed.magnitude;
    creditDebit = parsed.isNegative ? 'debit' : 'credit';
  } else if (rowFormat.amountConvention === 'debit_credit_columns') {
    const debitRaw = cell(header, row, rowFormat.columnRoles.debit);
    const creditRaw = cell(header, row, rowFormat.columnRoles.credit);
    const debitHasContent = Boolean(debitRaw?.trim());
    const creditHasContent = Boolean(creditRaw?.trim());
    const debitParsed = debitHasContent ? parseAmountField(debitRaw as string) : null;
    const creditParsed = creditHasContent ? parseAmountField(creditRaw as string) : null;

    // A column with content that fails to parse as a number is a distinct,
    // more specific diagnosis than "no amount was supplied at all" — never
    // collapse the two into the same generic reason (spec 59: a clear,
    // specific error beats a vague one).
    if (debitHasContent && !debitParsed?.ok) return fail('invalid_amount');
    if (creditHasContent && !creditParsed?.ok) return fail('invalid_amount');

    const hasDebit = (debitParsed?.magnitude ?? 0) > 0;
    const hasCredit = (creditParsed?.magnitude ?? 0) > 0;
    if (hasDebit && hasCredit) return fail('ambiguous_direction');
    if (!debitHasContent && !creditHasContent) return fail('missing_amount');
    if (!hasDebit && !hasCredit) return fail('zero_amount');
    if (hasDebit) {
      magnitude = debitParsed!.magnitude!;
      creditDebit = 'debit';
    } else {
      magnitude = creditParsed!.magnitude!;
      creditDebit = 'credit';
    }
  } else {
    // dr_cr_indicator
    const amountRaw = cell(header, row, rowFormat.columnRoles.amount);
    const indicatorRaw = cell(header, row, rowFormat.columnRoles.drCrIndicator);
    if (amountRaw === null || indicatorRaw === null) return fail('column_not_found');
    if (!amountRaw.trim()) return fail('missing_amount');
    const parsed = parseAmountField(amountRaw);
    if (!parsed.ok || parsed.magnitude === null) return fail('invalid_amount');
    if (parsed.magnitude === 0) return fail('zero_amount');
    const indicator = indicatorRaw.trim().toUpperCase();
    if (indicator === 'DR' || indicator === 'D' || indicator === 'DEBIT') creditDebit = 'debit';
    else if (indicator === 'CR' || indicator === 'C' || indicator === 'CREDIT') creditDebit = 'credit';
    else return fail('ambiguous_direction');
    magnitude = parsed.magnitude;
  }

  let balanceAfter: number | null = null;
  if (rowFormat.columnRoles.balance) {
    const raw = cell(header, row, rowFormat.columnRoles.balance);
    if (raw?.trim()) {
      const parsed = parseAmountField(raw);
      if (parsed.ok && parsed.magnitude !== null) {
        balanceAfter = parsed.isNegative ? -parsed.magnitude : parsed.magnitude;
      }
    }
  }

  return {
    ok: true,
    transaction: {
      sourceRowNumber,
      transactionDate: dateParsed.iso,
      postedDate,
      valueDate,
      descriptionRaw,
      descriptionClean,
      referenceRaw: referenceRaw?.trim() ? referenceRaw.trim() : null,
      amountOriginal: roundToMoneyScale(magnitude),
      creditDebit,
      balanceAfter: balanceAfter !== null ? roundToMoneyScale(balanceAfter) : null,
      transactionTypeHint: inferTypeHint(descriptionClean, creditDebit),
    },
  };
}
