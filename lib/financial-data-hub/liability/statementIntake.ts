/**
 * FDH-10 — Credit Cards & Loans Intelligence: statement detection + intake
 * (spec section 28's `detectStatement`/`identifyInstitution`/
 * `identifyFacility` steps).
 *
 * DETERMINISTIC PIPELINE, same shape as R7's `detectBankCsvFormat`: decode ->
 * delimiter -> header row -> score every registered adapter for the
 * DECLARED statement type (credit_card vs loan is asked of the user up front
 * — spec section 2's "Credit Card Statement / Loan Statement selector" — so
 * detection only has to disambiguate WITHIN that type, never between a card
 * and a loan format) -> best-match / ambiguous / unsupported. Never guesses
 * past a low- or tied-confidence result (spec section 18).
 */

import { decodeCsvBytes, detectDelimiter, findHeaderRowIndex, parseCsvSafe, CsvIntakeError } from '../bank-csv/csv';
import { CSV_HEADER_SCAN_DEPTH, DETECTION_CONFIDENCE_GAP, DETECTION_MIN_CONFIDENCE } from '../bank-csv/constants';
import { LIABILITY_CSV_ADAPTER_REGISTRY } from './adapters/registry';
import type { LiabilityCsvAdapter } from './adapters/types';
import { extractLiabilityStatementFromCsv, type LiabilityCsvExtractionInput } from './csvExtraction';
import type {
  LiabilityExtractionResult,
  LiabilityStatementCountry,
  LiabilityStatementType,
} from './types';

export interface LiabilityDetectionCandidate {
  adapterId: string;
  score: number;
}

export type LiabilityDetectionStatus = 'detected' | 'ambiguous' | 'manual_mapping_required' | 'invalid';

export interface LiabilityDetectionResult {
  status: LiabilityDetectionStatus;
  adapter: LiabilityCsvAdapter | null;
  confidence: number | null;
  candidates: LiabilityDetectionCandidate[];
  reason?: string;
}

/**
 * Detect which registered adapter (if any) matches this CSV's header, scoped
 * to the user-declared statement type and country (spec section 2 asks the
 * user for both up front, so detection is never guessing the type itself —
 * only which institution's shape it is).
 */
export function detectLiabilityCsvAdapter(
  bytes: Uint8Array,
  statementType: LiabilityStatementType,
  country: LiabilityStatementCountry,
): LiabilityDetectionResult {
  let text: string;
  try {
    ({ text } = decodeCsvBytes(bytes));
  } catch {
    return { status: 'invalid', adapter: null, confidence: null, candidates: [], reason: 'could_not_decode_bytes' };
  }
  const lines = text.split(/\r\n|\n/);
  const delimiter = detectDelimiter(lines.slice(0, CSV_HEADER_SCAN_DEPTH));
  if (!delimiter) return { status: 'invalid', adapter: null, confidence: null, candidates: [], reason: 'delimiter_not_detected' };

  const headerRowIndex = findHeaderRowIndex(lines, delimiter, CSV_HEADER_SCAN_DEPTH);
  if (headerRowIndex === null) return { status: 'invalid', adapter: null, confidence: null, candidates: [], reason: 'header_not_found' };

  let header: string[];
  try {
    header = parseCsvSafe(text, delimiter, headerRowIndex).header;
  } catch (e) {
    return { status: 'invalid', adapter: null, confidence: null, candidates: [], reason: e instanceof CsvIntakeError ? e.code : 'parse_failed' };
  }

  const pool = LIABILITY_CSV_ADAPTER_REGISTRY.filter((a) => a.statementType === statementType && a.country === country);
  const candidates: LiabilityDetectionCandidate[] = pool
    .map((a) => ({ adapterId: a.id, score: a.scoreHeader(header) }))
    .sort((a, b) => b.score - a.score);

  const best = candidates[0];
  const second = candidates[1];

  if (!best || best.score < DETECTION_MIN_CONFIDENCE) {
    return { status: 'manual_mapping_required', adapter: null, confidence: best?.score ?? 0, candidates };
  }
  if (second && second.score >= DETECTION_MIN_CONFIDENCE && best.score - second.score < DETECTION_CONFIDENCE_GAP) {
    return { status: 'ambiguous', adapter: null, confidence: best.score, candidates, reason: `${best.adapterId} vs ${second.adapterId}` };
  }

  const adapter = pool.find((a) => a.id === best.adapterId)!;
  return { status: 'detected', adapter, confidence: best.score, candidates };
}

export interface LiabilityStatementIntakeInput {
  bytes: Uint8Array;
  statementType: LiabilityStatementType;
  country: LiabilityStatementCountry;
  currencyCode: string;
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

/**
 * The full intake pipeline: detect the adapter, then run the generic
 * column-mapped CSV extractor with that adapter's own column map. Returns a
 * detection-failure result (mapped onto the closed `LiabilityExtractionResult`
 * failure vocabulary) rather than throwing, exactly like every other FDH
 * extraction entry point.
 */
export function extractLiabilityStatement(input: LiabilityStatementIntakeInput): LiabilityExtractionResult {
  const detection = detectLiabilityCsvAdapter(input.bytes, input.statementType, input.country);
  if (detection.status === 'manual_mapping_required') {
    return { ok: false, kind: 'manual_mapping_required', error: 'We could not recognise the layout of this statement.' };
  }
  if (detection.status === 'ambiguous') {
    return { ok: false, kind: 'ambiguous_format', error: 'This statement matches more than one known layout — please check the file.' };
  }
  if (detection.status === 'invalid' || !detection.adapter) {
    return { ok: false, kind: 'layout_unsupported', error: 'This file could not be read as a statement export.' };
  }

  const adapter = detection.adapter;
  const csvInput: LiabilityCsvExtractionInput = {
    bytes: input.bytes,
    columnMap: adapter.columnMap,
    statementType: adapter.statementType,
    country: adapter.country,
    currencyCode: input.currencyCode,
    facilityType: adapter.facilityType,
    institutionName: input.institutionName ?? adapter.fixedMetadata?.institutionName,
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
  };
  return extractLiabilityStatementFromCsv(csvInput);
}
