/**
 * R7 — Bank CSV Engine: format/institution detection pipeline (spec section
 * 18-21).
 *
 * DETERMINISTIC PIPELINE: encoding -> delimiter -> header location ->
 * column signature -> institution adapter candidates -> confidence scoring
 * -> DETECTED / AMBIGUOUS / UNSUPPORTED / MANUAL_MAPPING_REQUIRED / INVALID.
 * Never relies on the filename (spec 18) — nothing in this module reads a
 * filename at all.
 */

import { decodeCsvBytes, detectDelimiter, findHeaderRowIndex, parseCsvSafe, CsvIntakeError } from './csv';
import type { CsvParseResult, DetectedEncoding } from './csv';
import { BANK_CSV_ADAPTER_REGISTRY } from './adapters/registry';
import type { BankCsvAdapter } from './adapters/types';
import { CSV_HEADER_SCAN_DEPTH, DETECTION_CONFIDENCE_GAP, DETECTION_MIN_CONFIDENCE } from './constants';

export type DetectionStatus = 'detected' | 'ambiguous' | 'unsupported' | 'manual_mapping_required' | 'invalid';

export interface AdapterCandidateScore {
  adapterId: string;
  score: number;
}

export interface DetectionEvidence {
  encoding: DetectedEncoding;
  delimiter: string;
  headerRowIndex: number;
  header: string[];
  candidates: AdapterCandidateScore[];
  reason?: string;
}

export interface DetectionResult {
  status: DetectionStatus;
  encoding: DetectedEncoding | null;
  delimiter: string | null;
  headerRowIndex: number | null;
  header: string[] | null;
  parsed: CsvParseResult | null;
  adapter: BankCsvAdapter | null;
  confidence: number | null;
  evidence: DetectionEvidence | { reason: string };
}

function invalidResult(reason: string): DetectionResult {
  return {
    status: 'invalid',
    encoding: null,
    delimiter: null,
    headerRowIndex: null,
    header: null,
    parsed: null,
    adapter: null,
    confidence: null,
    evidence: { reason },
  };
}

/**
 * Runs the full deterministic pipeline over decoded CSV bytes. Never throws
 * for a malformed-but-recoverable input — always resolves to one of the five
 * DetectionStatus values (spec 21). A `CsvIntakeError` from the safety layer
 * (row/column/field-length limits, unterminated quote) resolves to
 * `invalid`, carrying the specific reason for a clear user-facing message
 * (spec 59).
 */
export function detectBankCsvFormat(bytes: Uint8Array): DetectionResult {
  const { text, encoding } = decodeCsvBytes(bytes);
  const lines = text.split(/\r\n|\n/);

  const sampleForDelimiter = lines.slice(0, CSV_HEADER_SCAN_DEPTH);
  const delimiter = detectDelimiter(sampleForDelimiter);
  if (!delimiter) return invalidResult('delimiter_not_detected');

  const headerRowIndex = findHeaderRowIndex(lines, delimiter, CSV_HEADER_SCAN_DEPTH);
  if (headerRowIndex === null) return invalidResult('header_not_found');

  let parsed: CsvParseResult;
  try {
    parsed = parseCsvSafe(text, delimiter, headerRowIndex);
  } catch (e) {
    if (e instanceof CsvIntakeError) return invalidResult(e.code);
    throw e;
  }

  const candidates: AdapterCandidateScore[] = BANK_CSV_ADAPTER_REGISTRY.map((adapter) => ({
    adapterId: adapter.id,
    score: adapter.scoreHeader(parsed.header),
  })).sort((a, b) => b.score - a.score);

  const evidence: DetectionEvidence = { encoding, delimiter, headerRowIndex, header: parsed.header, candidates };

  const best = candidates[0];
  const second = candidates[1];

  if (!best || best.score < DETECTION_MIN_CONFIDENCE) {
    return {
      status: 'manual_mapping_required',
      encoding,
      delimiter,
      headerRowIndex,
      header: parsed.header,
      parsed,
      adapter: null,
      confidence: best?.score ?? 0,
      evidence,
    };
  }

  if (second && second.score >= DETECTION_MIN_CONFIDENCE && best.score - second.score < DETECTION_CONFIDENCE_GAP) {
    return {
      status: 'ambiguous',
      encoding,
      delimiter,
      headerRowIndex,
      header: parsed.header,
      parsed,
      adapter: null,
      confidence: best.score,
      evidence: { ...evidence, reason: `${best.adapterId} vs ${second.adapterId} scored within ${DETECTION_CONFIDENCE_GAP}` },
    };
  }

  const adapter = BANK_CSV_ADAPTER_REGISTRY.find((a) => a.id === best.adapterId)!;
  return {
    status: 'detected',
    encoding,
    delimiter,
    headerRowIndex,
    header: parsed.header,
    parsed,
    adapter,
    confidence: best.score,
    evidence,
  };
}
