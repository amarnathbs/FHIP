/**
 * Bank CSV column mapping -- the pure logic behind the "tell us which column is which" step (28-10-2026).
 *
 * When a bank statement CSV's header is not a layout the engine recognises, the person assigns each file column to the system's fields.
 * This module is everything that step needs that is not drawing: suggestions from header words, the rules a complete assignment must
 * satisfy, the live preview of the first rows as the system will read them, and the request body for the existing map route. It is
 * pure (no I/O, no node-only imports) so the screen and the tests run exactly the same code, and so the preview can never disagree with
 * what the import will later do: the preview calls the SAME `normalizeRow` the import calls.
 *
 * Nothing here ever decides silently. A suggestion is only a pre-selection; the screen requires the person to confirm. A date order that
 * the values themselves do not prove is returned as ambiguous, never picked.
 */

import type { FdhCsvAmountConvention } from '../constants/enums';
import type { FdhCsvColumnMapping } from '../domain/types';
import { dateFormatCandidates, parseDateWithFormat, SUPPORTED_DATE_FORMATS, type SupportedDateFormat } from './dateFormats';
import { parseAmountField } from './amount';
import { mappingToRowFormat, normalizeRow, type NormalizationFailureReason } from './normalize';

export type AmountStyle = FdhCsvAmountConvention;

/** One assignment per system field. A value is the file column's heading, or null when the field is not assigned. */
export interface MappingDraft {
  transactionDate: string | null;
  postedDate: string | null;
  description: string | null;
  extraDescription: string | null;
  amount: string | null;
  debit: string | null;
  credit: string | null;
  drCrIndicator: string | null;
  balance: string | null;
  reference: string | null;
}

export type MappingField = keyof MappingDraft;

export const EMPTY_DRAFT: MappingDraft = {
  transactionDate: null,
  postedDate: null,
  description: null,
  extraDescription: null,
  amount: null,
  debit: null,
  credit: null,
  drCrIndicator: null,
  balance: null,
  reference: null,
};

export const AMOUNT_STYLE_LABELS: Record<AmountStyle, string> = {
  debit_credit_columns: 'A Debit column and a Credit column',
  single_signed: 'One Amount column (money out is negative)',
  dr_cr_indicator: 'An Amount column plus a column that says Debit or Credit',
};

export interface FieldDefinition {
  key: MappingField;
  label: string;
  help: string;
}

/** The fields shown for a given amount style, required ones first. */
export function fieldDefinitions(style: AmountStyle): { required: FieldDefinition[]; optional: FieldDefinition[] } {
  const required: FieldDefinition[] = [
    { key: 'transactionDate', label: 'Date', help: 'The day the transaction happened.' },
    { key: 'description', label: 'Description', help: 'Who or what the transaction was with.' },
  ];
  if (style === 'debit_credit_columns') {
    required.push(
      { key: 'debit', label: 'Debit amount (money out)', help: 'The column holding money going out.' },
      { key: 'credit', label: 'Credit amount (money in)', help: 'The column holding money coming in.' },
    );
  } else if (style === 'single_signed') {
    required.push({ key: 'amount', label: 'Amount', help: 'One column with the amount; money out is negative.' });
  } else {
    required.push(
      { key: 'amount', label: 'Amount', help: 'The column holding the amount, without its direction.' },
      { key: 'drCrIndicator', label: 'Debit / Credit marker', help: 'The column that says whether each line is a debit (DR) or a credit (CR).' },
    );
  }
  const optional: FieldDefinition[] = [
    { key: 'balance', label: 'Balance', help: 'The running balance after each line. Used to check the import adds up.' },
    { key: 'reference', label: 'Reference', help: 'A reference or receipt number.' },
    { key: 'extraDescription', label: 'Extra description (long description)', help: 'A longer description kept as extra detail after the description.' },
    { key: 'postedDate', label: 'Other date (posted or processed)', help: 'A second date column, kept as extra detail.' },
  ];
  return { required, optional };
}

function norm(h: string): string {
  return h.trim().toLowerCase().replace(/[^a-z0-9/ ]+/g, ' ').replace(/\s+/g, ' ');
}

function samplesOf(header: readonly string[], rows: readonly (readonly string[])[], column: string): string[] {
  const idx = header.indexOf(column);
  if (idx === -1) return [];
  return rows.map((r) => (r[idx] ?? '').trim()).filter(Boolean);
}

function mostlyAmounts(values: readonly string[]): boolean {
  if (values.length === 0) return false;
  return values.filter((v) => parseAmountField(v).ok).length / values.length >= 0.8;
}

const INDICATOR_VALUES = new Set(['DR', 'CR', 'D', 'C', 'DEBIT', 'CREDIT']);

function mostlyIndicators(values: readonly string[]): boolean {
  if (values.length === 0) return false;
  return values.filter((v) => INDICATOR_VALUES.has(v.trim().toUpperCase())).length / values.length >= 0.8;
}

/** A column that no suggestion has used yet and whose heading matches one of the patterns, earlier patterns winning. */
function firstMatch(header: readonly string[], used: ReadonlySet<string>, patterns: readonly RegExp[], accept: (column: string) => boolean = () => true): string | null {
  for (const p of patterns) {
    for (const column of header) {
      if (!column || used.has(column)) continue;
      if (header.filter((h) => h === column).length > 1) continue; // two columns with one name cannot be told apart
      if (p.test(norm(column)) && accept(column)) return column;
    }
  }
  return null;
}

export interface MappingSuggestion {
  draft: MappingDraft;
  /** null when the headings do not tell (the person chooses). */
  amountStyle: AmountStyle | null;
}

/**
 * Pre-selections from header words. Never final: the screen shows them as suggestions and the person must confirm. A column is never
 * suggested for two fields, and an amount-type field is only suggested for a column whose values look like amounts.
 */
export function suggestMapping(header: readonly string[], rows: readonly (readonly string[])[]): MappingSuggestion {
  const used = new Set<string>();
  const take = (column: string | null): string | null => {
    if (column) used.add(column);
    return column;
  };
  const values = (c: string) => samplesOf(header, rows, c);

  const dateWords = /\bdate\b|\bdt\b|\bdated\b|posted on|booking|transaction on/;
  const transactionDate = take(
    firstMatch(header, used, [/effective date/, /transaction date|trans date|txn date|txn dt|date of transaction|booking date/, /^date$/, /^date\b/, dateWords], (c) => {
      const n = norm(c);
      return !/create|creat|post|process|settle|value|entry|import|expiry|due|birth/.test(n) || /^date$/.test(n) || /posted on/.test(n);
    }) ??
      firstMatch(header, used, [dateWords]) ??
      // Headings that say nothing: a column whose values all read as dates under some supported style.
      firstMatch(header, used, [/.*/], (c) => values(c).length > 0 && dateFormatCandidates(values(c)).groups.length > 0),
  );
  const postedDate = take(firstMatch(header, used, [/post(ing|ed)? date|date posted/, /process(ed|ing)? date|create(d)? date|value date|entry date/]));

  const description = take(
    firstMatch(header, used, [/^description$/, /^(transaction )?(details?|narration|particulars|memo|description)$/, /narration|particulars|details?|description|memo/], (c) => !/long|extended|full|additional|more/.test(norm(c))) ??
      firstMatch(header, used, [/description|details?|narration|particulars|memo/]) ??
      // Headings that say nothing: the unused column whose values are mostly words.
      firstMatch(header, used, [/.*/], (c) => {
        const v = values(c);
        return v.length > 0 && v.filter((x) => /[A-Za-z]{3,}/.test(x) && !INDICATOR_VALUES.has(x.toUpperCase())).length / v.length >= 0.8;
      }),
  );
  const extraDescription = take(firstMatch(header, used, [/long description|extended description|full description|additional (details|description)|more (details|description)/]));

  const numericOnly = (c: string) => mostlyAmounts(values(c));
  const debit = firstMatch(header, used, [/\bdebits?\b(?! card)/, /withdrawals?|money out|paid out|payments? out|\bdr\b/], numericOnly);
  const credit = firstMatch(header, new Set([...used, ...(debit ? [debit] : [])]), [/\bcredits?\b(?! card)/, /deposits?|money in|paid in|payments? in|receipts?\b|\bcr\b/], numericOnly);
  let amountStyle: AmountStyle | null = null;
  let amount: string | null = null;
  let drCrIndicator: string | null = null;
  let finalDebit: string | null = null;
  let finalCredit: string | null = null;
  if (debit && credit) {
    amountStyle = 'debit_credit_columns';
    finalDebit = take(debit);
    finalCredit = take(credit);
  } else {
    const amountColumn = firstMatch(header, used, [/^amount$/, /\bamount\b/, /^value$/, /\bvalue\b/], (c) => !/balance/.test(norm(c)) && numericOnly(c));
    if (amountColumn) {
      amount = take(amountColumn);
      const indicator = firstMatch(header, used, [/dr ?\/? ?cr|debit ?\/? ?credit|\bindicator\b|\bd\/c\b|cr\/dr|\btype\b/], (c) => mostlyIndicators(values(c)));
      if (indicator) {
        drCrIndicator = take(indicator);
        amountStyle = 'dr_cr_indicator';
      } else {
        amountStyle = 'single_signed';
      }
    } else if (debit || credit) {
      // Only one of the two is present (some exports leave one out): still the two-column style, the person sees the other is empty.
      amountStyle = 'debit_credit_columns';
      finalDebit = take(debit);
      finalCredit = take(credit);
    }
  }

  const balance = take(firstMatch(header, used, [/balance/], numericOnly));
  const reference = take(firstMatch(header, used, [/reference|ref no|ref\b|receipt|transaction id|^id$/]) ?? firstMatch(header, used, [/cheque|check no|chq/]));

  return {
    draft: { transactionDate, postedDate, description, extraDescription, amount, debit: finalDebit, credit: finalCredit, drCrIndicator, balance, reference },
    amountStyle,
  };
}

/** The field keys that must hold a column for this amount style. */
export function requiredFields(style: AmountStyle): MappingField[] {
  return fieldDefinitions(style).required.map((f) => f.key);
}

export interface MappingProblem {
  field: MappingField | 'amountStyle' | 'dateFormat' | 'general';
  message: string;
}

/** Fields that count for the style: an amount-style change must not leave a hidden, stale assignment behind. */
export function activeFields(style: AmountStyle): MappingField[] {
  const { required, optional } = fieldDefinitions(style);
  return [...required, ...optional].map((f) => f.key);
}

/** Drops the assignments that do not belong to the chosen amount style (a Credit column chosen, then the style switched to one Amount column). */
export function draftForStyle(draft: MappingDraft, style: AmountStyle): MappingDraft {
  const active = new Set(activeFields(style));
  const next = { ...draft };
  (Object.keys(next) as MappingField[]).forEach((k) => {
    if (!active.has(k)) next[k] = null;
  });
  return next;
}

/**
 * Everything that stops a person continuing, in plain words. Empty = the assignment is complete and consistent. A column given to two
 * fields is a problem unless the person explicitly allowed it; a heading that appears twice in the file cannot be told apart and is
 * refused; a heading not in the file is refused.
 */
export function mappingProblems(
  header: readonly string[],
  draftIn: MappingDraft,
  style: AmountStyle | null,
  dateFormat: SupportedDateFormat | null,
  options: { allowSharedColumns?: boolean } = {},
): MappingProblem[] {
  const problems: MappingProblem[] = [];
  if (!style) {
    problems.push({ field: 'amountStyle', message: 'Choose how this file shows the amount: separate Debit and Credit columns, one Amount column, or an Amount column plus a Debit/Credit marker.' });
    return problems;
  }
  const draft = draftForStyle(draftIn, style);
  const defs = fieldDefinitions(style);
  for (const f of defs.required) {
    if (!draft[f.key]) problems.push({ field: f.key, message: `Choose the column that holds the ${f.label.toLowerCase()}.` });
  }
  const all = [...defs.required, ...defs.optional];
  const seen = new Map<string, string>();
  for (const f of all) {
    const column = draft[f.key];
    if (!column) continue;
    if (!header.includes(column)) {
      problems.push({ field: f.key, message: `The column "${column}" is not in this file.` });
      continue;
    }
    if (header.filter((h) => h === column).length > 1) {
      problems.push({ field: f.key, message: `Two columns in this file are both called "${column}", so they cannot be told apart. Rename one in your file and upload it again.` });
    }
    const other = seen.get(column);
    if (other && !options.allowSharedColumns) {
      problems.push({ field: f.key, message: `"${column}" is already used for ${other}. Choose a different column, or tick "Allow one column to be used for two fields".` });
    }
    if (!other) seen.set(column, f.label);
  }
  if (!dateFormat) {
    problems.push({ field: 'dateFormat', message: 'Choose how this file writes dates.' });
  }
  return problems;
}

/** Whether the dates in the chosen column prove one reading, or the person must say. */
export interface DateFormatAdvice {
  /** The values prove exactly one reading (every supported format that reads them gives the same dates). */
  proven: SupportedDateFormat | null;
  /** Readings that fit every value. More than one group means the same text is a different day under each: ask. */
  groups: SupportedDateFormat[][];
  /** No supported format reads every value. */
  unreadable: boolean;
  /** The first value no supported reading accepts, for the message. */
  firstUnreadable: string | null;
}

export function adviseDateFormat(header: readonly string[], rows: readonly (readonly string[])[], dateColumn: string | null): DateFormatAdvice {
  if (!dateColumn) return { proven: null, groups: [], unreadable: false, firstUnreadable: null };
  const values = samplesOf(header, rows, dateColumn);
  const { groups, proven } = dateFormatCandidates(values);
  if (groups.length > 0) return { proven, groups, unreadable: false, firstUnreadable: null };
  const firstUnreadable = values.find((v) => !SUPPORTED_DATE_FORMATS.some((f) => parseDateWithFormat(v, f).ok)) ?? values[0] ?? null;
  return { proven: null, groups: [], unreadable: values.length > 0, firstUnreadable };
}

/** The request body of `POST /bank-csv/{id}/map`. Every key is present (null when unassigned), as the stored template requires. */
export interface MapRequestBody {
  amount_convention: AmountStyle;
  date_format: SupportedDateFormat;
  delimiter: string;
  column_mapping: Required<{ [K in keyof FdhCsvColumnMapping]: FdhCsvColumnMapping[K] }>;
  save_as_reusable_template: boolean;
  allow_shared_columns: boolean;
}

export function toMapRequest(
  draftIn: MappingDraft,
  style: AmountStyle,
  dateFormat: SupportedDateFormat,
  delimiter: string,
  options: { remember: boolean; allowSharedColumns: boolean },
): MapRequestBody {
  const d = draftForStyle(draftIn, style);
  return {
    amount_convention: style,
    date_format: dateFormat,
    delimiter,
    column_mapping: {
      transaction_date: d.transactionDate as string,
      posting_date: d.postedDate,
      value_date: null,
      description: d.description as string,
      extra_description: d.extraDescription,
      amount: d.amount,
      debit: d.debit,
      credit: d.credit,
      dr_cr_indicator: d.drCrIndicator,
      balance: d.balance,
      reference: d.reference,
      currency: null,
    },
    save_as_reusable_template: options.remember,
    allow_shared_columns: options.allowSharedColumns,
  };
}

export const FAILURE_REASON_TEXT: Record<NormalizationFailureReason, string> = {
  missing_transaction_date: 'the date is empty',
  invalid_transaction_date: 'the date could not be read with the chosen date style',
  missing_amount: 'there is no amount',
  invalid_amount: 'the amount is not a number',
  zero_amount: 'the amount is zero',
  ambiguous_direction: 'it is not clear whether it is money in or out',
  column_not_found: 'a chosen column is not in the file',
  currency_mismatch: 'it is in another currency',
};

export interface PreviewLine {
  rowNumber: number;
  ok: boolean;
  /** ISO date; shown day-first by `formatDayFirst`, never as is. */
  dateIso: string | null;
  description: string;
  direction: 'credit' | 'debit' | null;
  amount: number | null;
  balance: number | null;
  reason: string | null;
}

export interface MappingCheck {
  lines: PreviewLine[];
  /** How many of the rows looked at could be read. */
  readable: number;
  looked: number;
  /** Rejected rows grouped by plain-words reason. */
  rejectedReasons: Array<{ reason: string; count: number }>;
  /** Plain-words warnings about the assignment itself, from what the rows show. */
  warnings: string[];
}

/**
 * Reads the rows with the assignment exactly as the import will (the same `normalizeRow`), for the live preview and for the warnings
 * that catch a wrong assignment before the person continues. `previewCount` rows are returned for display; all `rows` given are counted.
 */
export function checkMapping(
  header: readonly string[],
  rows: readonly (readonly string[])[],
  draftIn: MappingDraft,
  style: AmountStyle,
  dateFormat: SupportedDateFormat,
  previewCount = 8,
): MappingCheck {
  const body = toMapRequest(draftIn, style, dateFormat, ',', { remember: false, allowSharedColumns: true });
  const rowFormat = mappingToRowFormat(body.column_mapping as FdhCsvColumnMapping, style, dateFormat);
  const lines: PreviewLine[] = [];
  const reasons = new Map<string, number>();
  let readable = 0;
  let allZeroOrEmptyAmounts = true;
  rows.forEach((row, idx) => {
    const result = normalizeRow(header, row, idx + 1, rowFormat);
    if (result.ok) {
      readable += 1;
      allZeroOrEmptyAmounts = false;
      if (lines.length < previewCount) {
        const t = result.transaction;
        lines.push({ rowNumber: idx + 1, ok: true, dateIso: t.transactionDate, description: t.descriptionRaw, direction: t.creditDebit, amount: t.amountOriginal, balance: t.balanceAfter, reason: null });
      }
    } else {
      const text = FAILURE_REASON_TEXT[result.reason];
      reasons.set(text, (reasons.get(text) ?? 0) + 1);
      if (lines.length < previewCount) {
        const descIdx = draftIn.description ? header.indexOf(draftIn.description) : -1;
        lines.push({ rowNumber: idx + 1, ok: false, dateIso: null, description: descIdx >= 0 ? (row[descIdx] ?? '') : '', direction: null, amount: null, balance: null, reason: text });
      }
    }
  });
  const looked = rows.length;
  const rejectedReasons = [...reasons.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count);
  const warnings: string[] = [];
  if (looked > 0 && readable === 0) {
    warnings.push(
      `None of the ${looked} rows checked could be read with this assignment${rejectedReasons[0] ? ` (mostly because ${rejectedReasons[0].reason})` : ''}. Change the columns or the date style, and the preview will update.`,
    );
  } else if (looked > 0 && readable < looked) {
    warnings.push(`${looked - readable} of the ${looked} rows checked could not be read${rejectedReasons[0] ? ` (mostly because ${rejectedReasons[0].reason})` : ''}. If that is not what you expect, change the assignment.`);
  }
  if (looked > 0 && allZeroOrEmptyAmounts && !warnings.length) warnings.push('Every amount is empty or zero. Check the amount columns.');
  if (readable > 0) {
    const credits = lines.filter((l) => l.ok && l.direction === 'credit').length;
    const debits = lines.filter((l) => l.ok && l.direction === 'debit').length;
    if (credits > 0 && debits === 0 && lines.filter((l) => l.ok).length >= 5) {
      warnings.push('Every line shown is money coming in. If that is not right, the money-out column may be in the wrong place.');
    } else if (debits > 0 && credits === 0 && lines.filter((l) => l.ok).length >= 5) {
      warnings.push('Every line shown is money going out. If some should be money coming in, check the credit column or the amount style.');
    }
  }
  return { lines, readable, looked, rejectedReasons, warnings };
}

/** dd/mm/yyyy for Australia, dd-mm-yyyy for India. Never ISO, never month first. */
export function formatDayFirst(iso: string | null, country: 'AU' | 'IN'): string {
  if (!iso) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return '';
  return country === 'IN' ? `${m[3]}-${m[2]}-${m[1]}` : `${m[3]}/${m[2]}/${m[1]}`;
}

export function formatMoney(value: number | null, country: 'AU' | 'IN'): string {
  if (value === null) return '';
  return value.toLocaleString(country === 'IN' ? 'en-IN' : 'en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
