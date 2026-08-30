/**
 * FDH-12 — retirement statement format detection (spec sections 84-86).
 *
 * Mirrors FDH-11's and R7's deterministic pipeline exactly:
 *   encoding -> delimiter -> header location -> column signature ->
 *   adapter candidates -> confidence scoring ->
 *   DETECTED / AMBIGUOUS / MANUAL_MAPPING_REQUIRED / INVALID.
 *
 * NEVER RELIES ON THE FILENAME (spec section 86). The detector is given bytes
 * and nothing else; there is no parameter through which a filename could
 * reach it.
 */

import {
  CsvIntakeError,
  decodeCsvBytes,
  detectDelimiter,
  findHeaderRowIndex,
  parseCsvSafe,
} from '../bank-csv/csv';
import type { CsvParseResult, DetectedEncoding } from '../bank-csv/csv';
import {
  CSV_HEADER_SCAN_DEPTH,
  DETECTION_CONFIDENCE_GAP,
  DETECTION_MIN_CONFIDENCE,
} from '../bank-csv/constants';
import { RETIREMENT_CSV_ADAPTER_REGISTRY } from './adapters/registry';
import type { RetirementCsvAdapter } from './adapters/types';

export type RetirementDetectionStatus =
  | 'detected'
  | 'ambiguous'
  | 'manual_mapping_required'
  | 'invalid';

export interface RetirementDetectionResult {
  status: RetirementDetectionStatus;
  encoding: DetectedEncoding | null;
  delimiter: string | null;
  headerRowIndex: number | null;
  header: string[] | null;
  parsed: CsvParseResult | null;
  adapter: RetirementCsvAdapter | null;
  confidence: number | null;
  candidates: { adapterId: string; score: number }[];
  reason?: string;
}

function invalidResult(reason: string): RetirementDetectionResult {
  return {
    status: 'invalid',
    encoding: null, delimiter: null, headerRowIndex: null, header: null,
    parsed: null, adapter: null, confidence: null, candidates: [], reason,
  };
}

export function detectRetirementCsvFormat(bytes: Uint8Array): RetirementDetectionResult {
  const { text, encoding } = decodeCsvBytes(bytes);
  // Splitting on /\r\n|\n/ handles CRLF and LF identically (spec section 144).
  const lines = text.split(/\r\n|\n/);

  const delimiter = detectDelimiter(lines.slice(0, CSV_HEADER_SCAN_DEPTH));
  if (!delimiter) return invalidResult('delimiter_not_detected');

  // Tolerates leading blank rows and preamble lines before the real header
  // (spec section 144) — the scan looks CSV_HEADER_SCAN_DEPTH rows deep rather
  // than assuming row 0.
  const headerRowIndex = findHeaderRowIndex(lines, delimiter, CSV_HEADER_SCAN_DEPTH);
  if (headerRowIndex === null) return invalidResult('header_not_found');

  let parsed: CsvParseResult;
  try {
    parsed = parseCsvSafe(text, delimiter, headerRowIndex);
  } catch (e) {
    if (e instanceof CsvIntakeError) return invalidResult(e.code);
    throw e;
  }

  const candidates = RETIREMENT_CSV_ADAPTER_REGISTRY
    .map((adapter) => ({ adapterId: adapter.id, score: adapter.scoreHeader(parsed.header) }))
    .sort((a, b) => b.score - a.score);

  const top = candidates[0];
  const second = candidates[1];

  // GENERIC PARSER SAFETY (spec section 85): below the confidence floor the
  // answer is MANUAL_MAPPING_REQUIRED. It is never "extract anyway and hope",
  // and it is never a zero-filled success.
  if (!top || top.score < DETECTION_MIN_CONFIDENCE) {
    return {
      status: 'manual_mapping_required',
      encoding, delimiter, headerRowIndex, header: parsed.header, parsed,
      adapter: null, confidence: top?.score ?? 0, candidates,
    };
  }
  // Two layouts scoring within the gap is genuine ambiguity. Picking the first
  // would be the arbitrary selection spec section 18 forbids in the analogous
  // account-matching case; the same discipline applies to format choice.
  if (second && top.score - second.score < DETECTION_CONFIDENCE_GAP) {
    return {
      status: 'ambiguous',
      encoding, delimiter, headerRowIndex, header: parsed.header, parsed,
      adapter: null, confidence: top.score, candidates,
    };
  }

  const adapter = RETIREMENT_CSV_ADAPTER_REGISTRY.find((a) => a.id === top.adapterId) ?? null;
  return {
    status: 'detected',
    encoding, delimiter, headerRowIndex, header: parsed.header, parsed,
    adapter, confidence: top.score, candidates,
  };
}
