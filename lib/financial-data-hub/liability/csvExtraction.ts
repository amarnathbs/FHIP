/**
 * FDH-10 — Credit Cards & Loans Intelligence: generic CSV statement
 * extraction (spec sections 13-18).
 *
 * SCOPE (honestly disclosed — see FDH10_REUSE_AND_GAP_AUDIT.md §6). This is a
 * single GENERIC, explicitly-column-mapped CSV adapter for credit-card/loan
 * activity lines — the AU/India per-institution PDF adapters R7
 * (`bank-csv/adapters/auAdapters.ts`/`inAdapters.ts`) and FDH-5 built for bank
 * statements are NOT replicated here for card/loan statements; that is a
 * separate, later effort. What this module reuses in full: FDH's own safe CSV
 * intake (`parseCsvSafe`), amount parsing (`parseAmountField`) and date-format
 * inference (`dateFormats.ts`) — no new CSV parser, no new amount grammar, no
 * new date grammar is introduced.
 *
 * OCR BOUNDARY (spec section 18). A scanned/image-only statement has no CSV
 * form at all; this module only ever receives text already known to be
 * tabular. `LiabilityExtractionFailureKind.ocr_required` exists in
 * `./types.ts` for the caller (the future document pipeline) to report when a
 * PDF turns out to be image-only, which this module cannot itself detect.
 */

import { decodeCsvBytes, detectDelimiter, findHeaderRowIndex, parseCsvSafe, CsvIntakeError } from '../bank-csv/csv';
import { parseAmountField } from '../bank-csv/amount';
import { inferDateFormat, parseDateWithFormat } from '../bank-csv/dateFormats';
import { CSV_HEADER_SCAN_DEPTH } from '../bank-csv/constants';
import {
  LIABILITY_ACTIVITY_TYPES,
  type LiabilityActivityType,
  type LiabilityExtractionResult,
  type LiabilityFacilityType,
  type LiabilityStatementActivity,
  type LiabilityStatementCountry,
  type LiabilityStatementType,
} from './types';

export interface LiabilityCsvColumnMap {
  date: string;
  description: string;
  amount: string;
  activityType: string;
  merchant?: string;
  principalComponent?: string;
  interestComponent?: string;
  feeComponent?: string;
  /** India GST column (spec section 30, evidence-only — see
   * `LiabilityStatementActivity.gstAmountRaw`'s own header). Carried through
   * verbatim, never parsed as an amount and never included in any
   * activity-type total. */
  gstAmount?: string;
  /** Institution-specific vocabulary -> the closed `LiabilityActivityType`
   * set (spec section 28's `normalize` contract step). Matched
   * case-insensitively against the RAW cell value BEFORE the closed-vocab
   * check below — e.g. a real issuer's own "Interest Charged" or "Cash
   * Advance" column value maps onto this module's canonical 'INTEREST' /
   * 'CASH_ADVANCE'. A value present in neither this map nor the canonical
   * vocabulary itself is still surfaced as `row_N_unrecognised_activity_type`
   * (spec section 18: never guessed, never silently dropped). */
  activityTypeAliases?: Record<string, LiabilityActivityType>;
}

export interface LiabilityCsvExtractionInput {
  bytes: Uint8Array;
  columnMap: LiabilityCsvColumnMap;
  statementType: LiabilityStatementType;
  country: LiabilityStatementCountry;
  currencyCode: string;
  facilityType: LiabilityFacilityType;
  institutionName?: string;
  maskedIdentifier?: string;
  statementPeriodStart?: string;
  statementPeriodEnd?: string;
  statementDate?: string;
  dueDate?: string;
  openingBalance?: number;
  closingBalance?: number;
  creditLimit?: number;
  minimumPayment?: number;
  interestRate?: number;
}

const PARSER_NAME = 'fdh10_generic_liability_csv';
const PARSER_VERSION = '1.0.0';

function isKnownActivityType(v: string): v is LiabilityActivityType {
  return (LIABILITY_ACTIVITY_TYPES as readonly string[]).includes(v.toUpperCase());
}

/**
 * Extract statement activities from a generic, explicitly column-mapped CSV.
 *
 * Every row's `activityType` column value must be one of the closed
 * `LIABILITY_ACTIVITY_TYPES` vocabulary (case-insensitive) — a row with an
 * unrecognised value is neither guessed nor silently dropped; it is surfaced
 * as a warning and excluded, so a caller can see exactly what was not
 * understood rather than trusting a completeness figure that quietly omitted
 * rows (spec section 18: "do not silently return incomplete financial
 * values").
 */
export function extractLiabilityStatementFromCsv(input: LiabilityCsvExtractionInput): LiabilityExtractionResult {
  const { text } = decodeCsvBytes(input.bytes);
  const lines = text.split(/\r\n|\n/);

  const delimiter = detectDelimiter(lines.slice(0, CSV_HEADER_SCAN_DEPTH));
  if (!delimiter) {
    return { ok: false, kind: 'layout_unsupported', error: 'Could not detect the CSV delimiter.' };
  }
  const headerRowIndex = findHeaderRowIndex(lines, delimiter, CSV_HEADER_SCAN_DEPTH);
  if (headerRowIndex === null) {
    return { ok: false, kind: 'layout_unsupported', error: 'Could not find a header row in this CSV.' };
  }

  let parsed;
  try {
    parsed = parseCsvSafe(text, delimiter, headerRowIndex);
  } catch (err) {
    if (err instanceof CsvIntakeError) {
      return { ok: false, kind: 'layout_unsupported', error: err.message };
    }
    return { ok: false, kind: 'unknown_error', error: err instanceof Error ? err.message : 'CSV could not be parsed' };
  }

  const { header, rows } = parsed;
  const colIndex = (name: string): number => header.findIndex((h) => h.trim().toLowerCase() === name.trim().toLowerCase());

  const dateIdx = colIndex(input.columnMap.date);
  const descIdx = colIndex(input.columnMap.description);
  const amountIdx = colIndex(input.columnMap.amount);
  const typeIdx = colIndex(input.columnMap.activityType);
  const merchantIdx = input.columnMap.merchant ? colIndex(input.columnMap.merchant) : -1;
  const principalIdx = input.columnMap.principalComponent ? colIndex(input.columnMap.principalComponent) : -1;
  const interestIdx = input.columnMap.interestComponent ? colIndex(input.columnMap.interestComponent) : -1;
  const feeIdx = input.columnMap.feeComponent ? colIndex(input.columnMap.feeComponent) : -1;
  const gstIdx = input.columnMap.gstAmount ? colIndex(input.columnMap.gstAmount) : -1;

  if (dateIdx === -1 || descIdx === -1 || amountIdx === -1 || typeIdx === -1) {
    return { ok: false, kind: 'layout_unsupported', error: 'One or more mapped columns were not found in the CSV header.' };
  }

  const dateSamples = rows.slice(0, 20).map((r) => r[dateIdx]).filter(Boolean);
  const dateFormat = inferDateFormat(dateSamples);
  if (!dateFormat) {
    return { ok: false, kind: 'layout_unsupported', error: 'Could not determine the date format used in this CSV.' };
  }

  const activities: LiabilityStatementActivity[] = [];
  const warnings: string[] = [];

  const aliasLookup = new Map<string, LiabilityActivityType>();
  for (const [alias, canonical] of Object.entries(input.columnMap.activityTypeAliases ?? {})) {
    aliasLookup.set(alias.trim().toLowerCase(), canonical);
  }

  rows.forEach((row, i) => {
    const rawType = (row[typeIdx] ?? '').trim();
    if (!rawType) return; // a blank row — not evidence of anything
    const aliased = aliasLookup.get(rawType.toLowerCase());
    if (!aliased && !isKnownActivityType(rawType)) {
      warnings.push(`row_${i + 1}_unrecognised_activity_type_${rawType}`);
      return;
    }
    const activityType = aliased ?? (rawType.toUpperCase() as LiabilityActivityType);

    const dateResult = parseDateWithFormat(row[dateIdx] ?? '', dateFormat.format);
    if (!dateResult.ok || !dateResult.iso) {
      warnings.push(`row_${i + 1}_unparseable_date`);
      return;
    }

    const amountResult = parseAmountField(row[amountIdx] ?? '');
    if (!amountResult.ok || amountResult.magnitude === null) {
      warnings.push(`row_${i + 1}_unparseable_amount`);
      return;
    }

    const activity: LiabilityStatementActivity = {
      activityType,
      activityDate: dateResult.iso,
      amount: amountResult.magnitude,
      descriptionRaw: row[descIdx] ?? undefined,
      merchantRaw: merchantIdx >= 0 ? row[merchantIdx] || undefined : undefined,
      sourceRowNumber: i + 1,
    };
    if (principalIdx >= 0 && row[principalIdx]) {
      const r = parseAmountField(row[principalIdx]);
      if (r.ok && r.magnitude !== null) activity.principalComponent = r.magnitude;
    }
    if (interestIdx >= 0 && row[interestIdx]) {
      const r = parseAmountField(row[interestIdx]);
      if (r.ok && r.magnitude !== null) activity.interestComponent = r.magnitude;
    }
    if (feeIdx >= 0 && row[feeIdx]) {
      const r = parseAmountField(row[feeIdx]);
      if (r.ok && r.magnitude !== null) activity.feeComponent = r.magnitude;
    }
    // Evidence only — deliberately NOT run through parseAmountField and
    // deliberately NOT added to any total anywhere in this module (spec
    // section 30). A malformed GST cell is still preserved verbatim rather
    // than dropped, because "we could not parse this" is itself information
    // worth keeping for a value nothing downstream ever computes with.
    if (gstIdx >= 0 && row[gstIdx]) {
      activity.gstAmountRaw = row[gstIdx];
    }
    activities.push(activity);
  });

  return {
    ok: true,
    extraction: {
      statementType: input.statementType,
      country: input.country,
      currencyCode: input.currencyCode,
      facilityType: input.facilityType,
      institutionName: input.institutionName,
      maskedIdentifier: input.maskedIdentifier,
      statementPeriodStart: input.statementPeriodStart,
      statementPeriodEnd: input.statementPeriodEnd,
      statementDate: input.statementDate,
      dueDate: input.dueDate,
      openingBalance: input.openingBalance,
      closingBalance: input.closingBalance,
      creditLimit: input.creditLimit,
      minimumPayment: input.minimumPayment,
      interestRate: input.interestRate,
      activities,
      parserName: PARSER_NAME,
      parserVersion: PARSER_VERSION,
      extractionConfidence: warnings.length === 0 ? 0.95 : 0.7,
      warnings,
    },
  };
}
