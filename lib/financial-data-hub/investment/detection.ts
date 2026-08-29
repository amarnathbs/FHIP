/**
 * FDH-11 — Australia investment CSV format detection (spec sections 15-16).
 * Mirrors `lib/financial-data-hub/bank-csv/detection.ts`'s deterministic
 * pipeline: encoding -> delimiter -> header location -> column signature ->
 * adapter candidates -> confidence scoring -> DETECTED / AMBIGUOUS /
 * UNSUPPORTED / MANUAL_MAPPING_REQUIRED / INVALID. Never relies on the
 * filename.
 */

import { decodeCsvBytes, detectDelimiter, findHeaderRowIndex, parseCsvSafe, CsvIntakeError } from '../bank-csv/csv';
import type { CsvParseResult, DetectedEncoding } from '../bank-csv/csv';
import { CSV_HEADER_SCAN_DEPTH, DETECTION_CONFIDENCE_GAP, DETECTION_MIN_CONFIDENCE } from '../bank-csv/constants';
import { AU_INVESTMENT_CSV_ADAPTER_REGISTRY } from './adapters/registry';
import type { AuInvestmentCsvAdapter } from './adapters/types';

export type AuInvestmentDetectionStatus = 'detected' | 'ambiguous' | 'unsupported' | 'manual_mapping_required' | 'invalid';

export interface AuInvestmentDetectionResult {
  status: AuInvestmentDetectionStatus;
  encoding: DetectedEncoding | null;
  delimiter: string | null;
  headerRowIndex: number | null;
  header: string[] | null;
  parsed: CsvParseResult | null;
  adapter: AuInvestmentCsvAdapter | null;
  confidence: number | null;
  candidates: { adapterId: string; score: number }[];
  reason?: string;
}

function invalidResult(reason: string): AuInvestmentDetectionResult {
  return { status: 'invalid', encoding: null, delimiter: null, headerRowIndex: null, header: null, parsed: null, adapter: null, confidence: null, candidates: [], reason };
}

export function detectAuInvestmentCsvFormat(bytes: Uint8Array): AuInvestmentDetectionResult {
  const { text, encoding } = decodeCsvBytes(bytes);
  const lines = text.split(/\r\n|\n/);

  const delimiter = detectDelimiter(lines.slice(0, CSV_HEADER_SCAN_DEPTH));
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

  const candidates = AU_INVESTMENT_CSV_ADAPTER_REGISTRY.map((adapter) => ({
    adapterId: adapter.id,
    score: adapter.scoreHeader(parsed.header),
  })).sort((a, b) => b.score - a.score);

  const top = candidates[0];
  const second = candidates[1];

  if (!top || top.score < DETECTION_MIN_CONFIDENCE) {
    return {
      status: 'manual_mapping_required',
      encoding, delimiter, headerRowIndex, header: parsed.header, parsed, adapter: null, confidence: top?.score ?? 0, candidates,
    };
  }
  if (second && top.score - second.score < DETECTION_CONFIDENCE_GAP) {
    return {
      status: 'ambiguous',
      encoding, delimiter, headerRowIndex, header: parsed.header, parsed, adapter: null, confidence: top.score, candidates,
    };
  }

  const adapter = AU_INVESTMENT_CSV_ADAPTER_REGISTRY.find((a) => a.id === top.adapterId) ?? null;
  return {
    status: 'detected',
    encoding, delimiter, headerRowIndex, header: parsed.header, parsed, adapter, confidence: top.score, candidates,
  };
}
