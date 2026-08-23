// Investment Intelligence R2 — the parser registry (spec section 8) and
// the source-detection + full-document-parse orchestration that is common
// to EVERY provider adapter (never re-implemented per-parser).

import { camsParser } from './camsParser';
import { kfintechParser } from './kfintechParser';
import type { InvestmentDocumentParser, ParsedDocumentOutput, ParsedWarning, SourceDetectionResult } from './types';

export const PARSER_REGISTRY: InvestmentDocumentParser[] = [camsParser, kfintechParser];

export const SOURCE_DETECTION_CONFIDENCE_THRESHOLD = 0.5;

export interface DetectSourceResult {
  parser: InvestmentDocumentParser | null;
  detection: SourceDetectionResult;
  /** Every registered parser's own detection result, for audit/debug — never used to silently pick a low-confidence match. */
  allCandidates: { parserCode: string; detection: SourceDetectionResult }[];
}

/**
 * Detect which registered parser can handle this already-extracted
 * document text, using document EVIDENCE only (spec section 12 — never
 * the filename). If no registered parser reaches the confidence
 * threshold, `parser` is null and the caller must treat the document as
 * unsupported/reconciliation_required, never guess.
 */
export function detectSource(text: string): DetectSourceResult {
  const allCandidates = PARSER_REGISTRY.map((p) => ({ parserCode: p.parserCode, detection: p.canHandle(text) }));
  const best = allCandidates.reduce<{ parserCode: string; detection: SourceDetectionResult } | null>((acc, cur) => {
    if (!acc || cur.detection.confidence > acc.detection.confidence) return cur;
    return acc;
  }, null);

  if (!best || best.detection.confidence < SOURCE_DETECTION_CONFIDENCE_THRESHOLD) {
    return {
      parser: null,
      detection: best?.detection ?? { sourceKey: null, confidence: 0, documentTypeDetected: null, formatVersionDetected: null, evidenceMatched: [] },
      allCandidates,
    };
  }
  const parser = PARSER_REGISTRY.find((p) => p.parserCode === best.parserCode) ?? null;
  return { parser, detection: best.detection, allCandidates };
}

/**
 * Deterministic overall parser-confidence formula (spec section 28 — "if
 * an aggregate confidence score is introduced, document its deterministic
 * formula"), documented verbatim in
 * docs/investment-intelligence/R2_DATA_QUALITY_AND_CERTIFICATION.md:
 *
 *   score = 1
 *         - 0.15 * (count of ERROR-severity warnings)
 *         - 0.05 * (count of WARNING-severity warnings)
 *   score *= 0.7 + 0.3 * (average transaction classification confidence)   [only if >=1 transaction was parsed]
 *   score = clamp(score, 0, 1)
 *
 * Rationale: any parse error materially reduces trust (steep 0.15
 * penalty); a soft warning (e.g. one unclassified but immaterial line)
 * reduces trust more gently (0.05); a document whose transactions mostly
 * failed CLASSIFICATION (not extraction) can lose at most 30% of score —
 * classification failures still produce a real, auditable canonical
 * transaction (type=UNCLASSIFIED), so they are read failures, not data
 * loss.
 */
export function computeParserConfidence(warnings: ParsedWarning[], transactionClassificationConfidences: number[]): number {
  const errorCount = warnings.filter((w) => w.severity === 'error').length;
  const warnCount = warnings.filter((w) => w.severity === 'warning').length;
  let score = 1 - errorCount * 0.15 - warnCount * 0.05;
  if (transactionClassificationConfidences.length > 0) {
    const avg = transactionClassificationConfidences.reduce((s, c) => s + c, 0) / transactionClassificationConfidences.length;
    score *= 0.7 + 0.3 * avg;
  }
  return Math.max(0, Math.min(1, score));
}

export interface ParseExtractedDocumentResult {
  detection: DetectSourceResult;
  parsed: ParsedDocumentOutput | null;
}

/**
 * The full, DB-FREE pipeline entry point: given already-extracted document
 * text, detect the source and run the matched parser end-to-end. This is
 * what every golden-fixture test calls directly (no Supabase, no
 * filesystem beyond reading the fixture) — the DB-touching orchestration
 * (account/instrument resolution, persistence, reconciliation writes)
 * lives in documentProcessing.ts and is a THIN layer on top of this.
 */
export function parseExtractedDocument(text: string): ParseExtractedDocumentResult {
  const detection = detectSource(text);
  if (!detection.parser) return { detection, parsed: null };
  return { detection, parsed: parseDocumentWithParser(detection.parser, text) };
}

/** Run one parser's full pipeline (metadata + accounts + transactions + holdings + validate) and assemble the ParsedDocumentOutput contract every downstream R2 stage consumes. */
export function parseDocumentWithParser(parser: InvestmentDocumentParser, text: string): ParsedDocumentOutput {
  const metadata = parser.extractMetadata(text);
  const accounts = parser.parseAccounts(text);
  const { transactions, warnings: txnWarnings } = parser.parseTransactions(text, accounts);
  const { holdings, warnings: holdingWarnings } = parser.parseHoldings(text, accounts);
  const warnings = [...txnWarnings, ...holdingWarnings];
  const errors = warnings.filter((w) => w.severity === 'error');
  const parserConfidence = computeParserConfidence(
    warnings,
    transactions.map((t) => t.classificationConfidence)
  );

  const output: ParsedDocumentOutput = {
    parserCode: parser.parserCode,
    parserVersion: parser.parserVersion,
    metadata,
    accounts,
    transactions,
    holdings,
    warnings,
    errors,
    parserConfidence,
  };
  return output;
}
