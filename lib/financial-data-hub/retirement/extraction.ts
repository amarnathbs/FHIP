/**
 * FDH-12 — reading a detected retirement statement CSV into evidence
 * (spec sections 84-85, 143-145).
 *
 * ============================================================================
 * FAILING SAFE IS THE POINT OF THIS FILE
 * ============================================================================
 *
 * spec 143: "Include malformed date/amount/currency/balance/contribution. Rows
 * must fail safely. Do not convert malformed fields to zero."
 * spec 145: "Unrecognised statement: MANUAL_MAPPING_REQUIRED. Not successful
 * import with zeros."
 * spec 94:  "Never render $0 retirement balance when real state is loading /
 * query failure / parser failure / unsupported statement / OCR required."
 *
 * Concretely, in this module:
 *   * a row whose AMOUNT will not parse is SKIPPED and counted as a warning.
 *     It never becomes an activity of 0.00.
 *   * a row whose DATE will not parse keeps a null date. It is still an
 *     activity (the amount is real evidence) but it can never be fingerprinted
 *     or matched, which is the honest consequence.
 *   * a statement where NO row parsed returns a FAILURE, not an empty success.
 *     An empty success would render as $0 in the UI, which spec 94 forbids.
 *   * `openingBalance`/`closingBalance` are `undefined` when the statement did
 *     not show them — never '0'.
 */

import { parseDateWithFormat, inferDateFormat } from '../bank-csv/dateFormats';
import type { SupportedDateFormat } from '../bank-csv/dateFormats';
import { classifyRetirementActivity, looksSummaryTotal, looksYearToDate } from './activityClassification';
import { ZERO, tryParseMoneyToMinorUnits, minorUnitsToDecimalString } from './money';
import type { RetirementCsvAdapter } from './adapters/types';
import type { RetirementDetectionResult } from './detection';
import type {
  RetirementActivityEvidence,
  RetirementExtractionResult,
  RetirementJurisdiction,
  RetirementPositionEvidence,
  RetirementStatementExtraction,
} from './types';

export const FDH12_PARSER_VERSION = '1.0.0';

/** Column-index lookup for a header, case/whitespace-insensitive. Returns -1
 * when the column is absent, which is a legitimate state for an optional
 * column (spec section 144). */
function columnIndex(header: readonly string[], name: string | undefined): number {
  if (!name) return -1;
  const wanted = name.trim().toLowerCase().replace(/\s+/g, ' ');
  return header.findIndex((h) => h.trim().toLowerCase().replace(/\s+/g, ' ') === wanted);
}

function cell(row: readonly string[], index: number): string {
  if (index < 0 || index >= row.length) return '';
  return (row[index] ?? '').trim();
}

/** Rows that are entirely blank, or a trailing "generated on ..." footer, are
 * skipped rather than treated as malformed (spec section 144). */
function isBlankRow(row: readonly string[]): boolean {
  return row.every((c) => (c ?? '').trim() === '');
}

/**
 * Read an OPTIONAL date cell, returning `undefined` for absent, empty or
 * unreadable values.
 *
 * `undefined` and not a fabricated date: an unreadable period boundary means
 * we do not know the period, and inventing one would silently shift a
 * contribution into the wrong pay period (spec sections 50, 143).
 */
function parseOptionalDate(
  row: readonly string[],
  index: number,
  dateFormat: { format: SupportedDateFormat } | null,
): string | undefined {
  if (index < 0 || !dateFormat) return undefined;
  const raw = cell(row, index);
  if (raw === '') return undefined;
  const parsed = parseDateWithFormat(raw, dateFormat.format);
  return parsed.ok ? (parsed.iso ?? undefined) : undefined;
}

/**
 * `Item`-keyed summary lines a member statement uses, mapped to the extraction
 * field they populate. Matched case-insensitively by substring on the folded
 * label, most specific first — the same first-match-wins discipline as
 * `activityClassification.ts`, and for the same auditability reason.
 */
const SUMMARY_ITEM_RULES: readonly { terms: readonly string[]; field: keyof RetirementStatementExtraction }[] = [
  { terms: ['opening balance', 'balance at start', 'balance brought forward'], field: 'openingBalance' },
  { terms: ['closing balance', 'balance at end', 'balance carried forward', 'total benefit', 'account balance'], field: 'closingBalance' },
  { terms: ['employer contribution', 'superannuation guarantee', 'sg contribution', 'employer share'], field: 'employerContributions' },
  { terms: ['salary sacrifice'], field: 'salarySacrifice' },
  { terms: ['government co-contribution', 'co-contribution', 'government contribution'], field: 'governmentContributions' },
  { terms: ['personal contribution', 'member contribution', 'employee share', 'after-tax contribution'], field: 'personalContributions' },
  { terms: ['rollover in', 'rollovers in', 'transfer in'], field: 'rolloversIn' },
  { terms: ['rollover out', 'rollovers out', 'transfer out'], field: 'rolloversOut' },
  { terms: ['pension payment', 'income stream payment'], field: 'pensionPayments' },
  { terms: ['withdrawal', 'lump sum', 'benefit payment'], field: 'withdrawals' },
  { terms: ['insurance premium', 'insurance cost'], field: 'insurancePremiums' },
  { terms: ['contributions tax', 'earnings tax', 'tax'], field: 'tax' },
  { terms: ['investment earnings', 'net earnings', 'investment return', 'interest'], field: 'investmentEarnings' },
  { terms: ['fee', 'administration cost', 'indirect cost'], field: 'fees' },
];

function matchSummaryItem(label: string): keyof RetirementStatementExtraction | null {
  const folded = label.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!folded) return null;
  for (const rule of SUMMARY_ITEM_RULES) {
    if (rule.terms.some((t) => folded.includes(t))) return rule.field;
  }
  return null;
}

/**
 * Extract evidence from a detected retirement CSV.
 *
 * @param detection  the result of `detectRetirementCsvFormat`. MUST be
 *                   `status: 'detected'` — any other status is the caller's
 *                   signal to record MANUAL_MAPPING_REQUIRED and stop, and
 *                   this function refuses to proceed on one.
 */
export function extractRetirementStatement(
  detection: RetirementDetectionResult,
  opts: {
    currencyCode: string;
    jurisdiction: RetirementJurisdiction;
    fundName?: string | null;
    maskedAccountIdentifier?: string | null;
    statementStartDate?: string | null;
    statementEndDate?: string | null;
    statementDate?: string | null;
  },
): RetirementExtractionResult {
  if (detection.status === 'manual_mapping_required') {
    return { ok: false, kind: 'manual_mapping_required', error: 'This statement layout is not one we can read automatically yet.' };
  }
  if (detection.status === 'ambiguous') {
    return { ok: false, kind: 'ambiguous_format', error: 'This file matched more than one statement layout equally well.' };
  }
  if (detection.status !== 'detected' || !detection.adapter || !detection.parsed) {
    return { ok: false, kind: 'layout_unsupported', error: detection.reason ?? 'This file could not be read as a retirement statement.' };
  }

  const adapter: RetirementCsvAdapter = detection.adapter;
  const { header, rows } = detection.parsed;
  const warnings: string[] = [];

  const base: RetirementStatementExtraction = {
    statementType: adapter.statementType,
    jurisdiction: opts.jurisdiction,
    accountType: adapter.accountType,
    fundName: opts.fundName ?? undefined,
    maskedAccountIdentifier: opts.maskedAccountIdentifier ?? undefined,
    currencyCode: opts.currencyCode,
    statementDate: opts.statementDate ?? undefined,
    statementStartDate: opts.statementStartDate ?? undefined,
    statementEndDate: opts.statementEndDate ?? undefined,
    activities: [],
    positions: [],
    parserName: adapter.id,
    parserVersion: FDH12_PARSER_VERSION,
    extractionConfidence: 0,
    warnings,
  };

  if (adapter.csvKind === 'summary') return extractSummary(base, adapter, header, rows, warnings);
  if (adapter.csvKind === 'holdings') return extractHoldings(base, adapter, header, rows, warnings);
  return extractTransactions(base, adapter, header, rows, warnings, opts.jurisdiction);
}

// ---------------------------------------------------------------------------
// Transaction layout
// ---------------------------------------------------------------------------

function extractTransactions(
  base: RetirementStatementExtraction,
  adapter: RetirementCsvAdapter,
  header: readonly string[],
  rows: readonly string[][],
  warnings: string[],
  jurisdiction: RetirementJurisdiction,
): RetirementExtractionResult {
  const iDate = columnIndex(header, adapter.columnRoles.activityDate);
  const iDesc = columnIndex(header, adapter.columnRoles.description);
  const iAmount = columnIndex(header, adapter.columnRoles.amount);
  const iType = columnIndex(header, adapter.columnRoles.activityType);
  const iEmployer = columnIndex(header, adapter.columnRoles.employer);
  const iPeriodStart = columnIndex(header, adapter.columnRoles.periodStart);
  const iPeriodEnd = columnIndex(header, adapter.columnRoles.periodEnd);

  if (iDesc < 0 || iAmount < 0) {
    return { ok: false, kind: 'layout_unsupported', error: 'This statement is missing the description or amount column.' };
  }

  // Infer the date format ONCE from a sample of the file rather than per row,
  // so 03/04 cannot be read as March in one row and April in another.
  const dateSamples = rows.slice(0, 40).map((r) => cell(r, iDate)).filter((s) => s !== '');
  const dateFormat = dateSamples.length > 0 ? inferDateFormat(dateSamples) : null;
  if (dateSamples.length > 0 && !dateFormat) warnings.push('date_format_not_inferable');

  const activities: RetirementActivityEvidence[] = [];
  let unparseableAmounts = 0;
  let unparseableDates = 0;
  let unknownTypes = 0;

  rows.forEach((row, i) => {
    if (isBlankRow(row)) return;

    const description = cell(row, iDesc);
    const rawAmount = cell(row, iAmount);
    if (description === '' && rawAmount === '') return; // trailing footer padding

    // AMOUNT: a row we cannot read is SKIPPED, never zeroed (spec 143).
    const minorUnits = tryParseMoneyToMinorUnits(rawAmount);
    if (minorUnits === null) {
      unparseableAmounts += 1;
      return;
    }

    // DATE: unparseable leaves the date null. The activity survives, but
    // cannot be fingerprinted or matched — the honest consequence.
    let activityDate: string | undefined;
    const rawDate = cell(row, iDate);
    if (rawDate !== '' && dateFormat) {
      // `DateParseResult` is `{ ok: boolean; iso: string | null }` rather than
      // a discriminated union, so `ok` does not narrow `iso`. Coalescing is
      // the honest read: no ISO value means no date, whatever `ok` says.
      const parsed = parseDateWithFormat(rawDate, dateFormat.format);
      activityDate = parsed.ok ? (parsed.iso ?? undefined) : undefined;
      if (activityDate === undefined) unparseableDates += 1;
    } else if (rawDate !== '') {
      unparseableDates += 1;
    }

    // TYPE: an explicit Type column, when present, is stronger evidence than
    // the description. Both go through the same classifier, so the vocabulary
    // is identical either way.
    const typeSource = iType >= 0 && cell(row, iType) !== '' ? cell(row, iType) : description;
    const activityType = classifyRetirementActivity(typeSource, jurisdiction);
    if (activityType === 'UNKNOWN') unknownTypes += 1;

    const periodStart = parseOptionalDate(row, iPeriodStart, dateFormat);
    const periodEnd = parseOptionalDate(row, iPeriodEnd, dateFormat);

    activities.push({
      activityType,
      // Stored as a POSITIVE MAGNITUDE. Direction lives in the activity type
      // (see RETIREMENT_ACTIVITY_DIRECTION); a statement printing "-100.00"
      // for a fee and one printing "100.00" produce the same evidence.
      amount: minorUnitsToDecimalString(minorUnits < ZERO ? -minorUnits : minorUnits),
      currencyCode: base.currencyCode,
      activityDate,
      effectivePeriodStart: periodStart ?? undefined,
      effectivePeriodEnd: periodEnd ?? undefined,
      descriptionRaw: description || undefined,
      employerNameRaw: iEmployer >= 0 ? (cell(row, iEmployer) || undefined) : undefined,
      isSummaryTotal: looksSummaryTotal(description),
      isYearToDate: looksYearToDate(description),
      sourceRowNumber: i + 1,
    });
  });

  if (unparseableAmounts > 0) warnings.push(`unreadable_amount_rows_skipped:${unparseableAmounts}`);
  if (unparseableDates > 0) warnings.push(`unreadable_date_rows:${unparseableDates}`);
  if (unknownTypes > 0) warnings.push(`unclassified_activity_rows:${unknownTypes}`);

  // NO ROWS PARSED IS A FAILURE, NOT AN EMPTY SUCCESS (spec 94, 145).
  if (activities.length === 0) {
    return {
      ok: false,
      kind: 'layout_unsupported',
      error: 'No readable retirement activity was found in this file.',
    };
  }

  // Confidence reflects what actually happened, not a fixed optimism.
  const cleanRatio = activities.length / (activities.length + unparseableAmounts);
  const classifiedRatio = (activities.length - unknownTypes) / activities.length;
  const confidence = Math.max(0, Math.min(1, 0.5 + 0.25 * cleanRatio + 0.25 * classifiedRatio));

  return {
    ok: true,
    extraction: { ...base, activities, extractionConfidence: Number(confidence.toFixed(4)), warnings },
  };
}

// ---------------------------------------------------------------------------
// Summary layout
// ---------------------------------------------------------------------------

function extractSummary(
  base: RetirementStatementExtraction,
  adapter: RetirementCsvAdapter,
  header: readonly string[],
  rows: readonly string[][],
  warnings: string[],
): RetirementExtractionResult {
  const iItem = columnIndex(header, adapter.columnRoles.item);
  const iAmount = columnIndex(header, adapter.columnRoles.amount);
  const iPeriod = columnIndex(header, adapter.columnRoles.period);
  if (iItem < 0 || iAmount < 0) {
    return { ok: false, kind: 'layout_unsupported', error: 'This summary statement is missing the item or amount column.' };
  }

  const out: RetirementStatementExtraction = { ...base };
  let populated = 0;
  let unparseable = 0;

  for (const row of rows) {
    if (isBlankRow(row)) continue;
    const label = cell(row, iItem);
    const rawAmount = cell(row, iAmount);
    if (label === '' && rawAmount === '') continue;

    const field = matchSummaryItem(label);
    if (!field) continue;

    const minorUnits = tryParseMoneyToMinorUnits(rawAmount);
    if (minorUnits === null) { unparseable += 1; continue; }

    const magnitude = minorUnits < ZERO ? -minorUnits : minorUnits;
    // Balances keep their sign; movement totals are magnitudes, because their
    // direction is implied by which field they land in.
    const isBalance = field === 'openingBalance' || field === 'closingBalance';
    // YTD lines populate the ytd_* fields, never the period ones (spec
    // 114-116). The `Period` column is the stronger, stated evidence; the
    // label text is the fallback for files that leave it blank.
    const periodCell = iPeriod >= 0 ? cell(row, iPeriod) : '';
    const isYtd = periodCell !== '' ? looksYearToDate(periodCell) : looksYearToDate(label);
    if (isYtd) {
      if (field === 'employerContributions') { out.ytdEmployerContributions = minorUnitsToDecimalString(magnitude); populated += 1; }
      else if (field === 'personalContributions') { out.ytdPersonalContributions = minorUnitsToDecimalString(magnitude); populated += 1; }
      continue;
    }
    (out as unknown as Record<string, string>)[field] =
      minorUnitsToDecimalString(isBalance ? minorUnits : magnitude);
    populated += 1;
  }

  if (unparseable > 0) warnings.push(`unreadable_summary_rows_skipped:${unparseable}`);

  if (populated === 0) {
    return { ok: false, kind: 'layout_unsupported', error: 'No readable retirement figures were found in this file.' };
  }

  const confidence = Math.max(0, Math.min(1, 0.6 + 0.4 * (populated / (populated + unparseable))));
  return { ok: true, extraction: { ...out, extractionConfidence: Number(confidence.toFixed(4)), warnings } };
}

// ---------------------------------------------------------------------------
// Holdings layout — EVIDENCE ONLY (migration 0112 PART D)
// ---------------------------------------------------------------------------

function extractHoldings(
  base: RetirementStatementExtraction,
  adapter: RetirementCsvAdapter,
  header: readonly string[],
  rows: readonly string[][],
  warnings: string[],
): RetirementExtractionResult {
  const iOption = columnIndex(header, adapter.columnRoles.optionName);
  const iValue = columnIndex(header, adapter.columnRoles.marketValue);
  const iAssetClass = columnIndex(header, adapter.columnRoles.assetClass);
  const iUnits = columnIndex(header, adapter.columnRoles.units);
  const iUnitPrice = columnIndex(header, adapter.columnRoles.unitPrice);
  const iValuationDate = columnIndex(header, adapter.columnRoles.valuationDate);

  if (iOption < 0 || iValue < 0) {
    return { ok: false, kind: 'layout_unsupported', error: 'This holdings file is missing the option or market value column.' };
  }

  const dateSamples = rows.slice(0, 40).map((r) => cell(r, iValuationDate)).filter((s) => s !== '');
  const dateFormat = dateSamples.length > 0 ? inferDateFormat(dateSamples) : null;

  const positions: RetirementPositionEvidence[] = [];
  let unparseable = 0;

  rows.forEach((row, i) => {
    if (isBlankRow(row)) return;
    const name = cell(row, iOption);
    const rawValue = cell(row, iValue);
    if (name === '' && rawValue === '') return;

    const minorUnits = tryParseMoneyToMinorUnits(rawValue);
    if (minorUnits === null) { unparseable += 1; return; }

    const valuationDate = parseOptionalDate(row, iValuationDate, dateFormat);

    positions.push({
      optionNameRaw: name || 'Unnamed investment option',
      assetClassRaw: iAssetClass >= 0 ? (cell(row, iAssetClass) || undefined) : undefined,
      units: iUnits >= 0 && cell(row, iUnits) !== '' ? cell(row, iUnits) : undefined,
      unitPrice: iUnitPrice >= 0 && cell(row, iUnitPrice) !== '' ? cell(row, iUnitPrice) : undefined,
      marketValue: minorUnitsToDecimalString(minorUnits < ZERO ? -minorUnits : minorUnits),
      currencyCode: base.currencyCode,
      valuationDate,
      sourceRowNumber: i + 1,
    });
  });

  if (unparseable > 0) warnings.push(`unreadable_holding_rows_skipped:${unparseable}`);
  if (positions.length === 0) {
    return { ok: false, kind: 'layout_unsupported', error: 'No readable investment options were found in this file.' };
  }

  const confidence = Math.max(0, Math.min(1, 0.6 + 0.4 * (positions.length / (positions.length + unparseable))));
  return { ok: true, extraction: { ...base, positions, extractionConfidence: Number(confidence.toFixed(4)), warnings } };
}
