/**
 * FDH-5 — Bank PDF Statement Engine: the pure processing pipeline (spec
 * sections 6, 13-46, 55, 91). Classification -> adapter detection -> row
 * reconstruction -> per-row normalisation -> fingerprinting -> dedup ->
 * reconciliation -> certification decision, entirely in memory, entirely
 * deterministic, with NO database access — the direct PDF analogue of
 * `bank-csv/orchestrator.ts`'s `runBankCsvPipeline`.
 *
 * REUSE, NOT REIMPLEMENTATION (spec 2-3, 57, 60). `computeSourceRowHash`,
 * `computeEconomicFingerprint`, `decideDedup`, `addToDedupIndex`,
 * `reconcileBalances`, `computeDateCoverage` and `decideCertification` are
 * ALL imported from `bank-csv/*` UNCHANGED — this file adds zero new dedup,
 * reconciliation or certification-decision logic. A CSV-sourced transaction
 * and a PDF-sourced transaction describing the same economic event run
 * through the IDENTICAL fingerprint/dedup/reconciliation code, which is what
 * makes cross-format duplicate detection (spec 57-59) correct by
 * construction rather than by a second implementation happening to agree
 * with the first.
 */

import type { FdhCreditDebit, FdhTransactionDedupStatus, FdhTransactionTypeHint } from '../constants/enums';
import { classifyPdf } from './classification';
import { detectPdfBankAdapter, type PdfDetectionResult } from './detection';
import { flattenPdfLines, reconstructRows } from './rowReconstruction';
import { normalizePdfRow } from './normalize';
import { extractPdfStatementMetadata, type PdfStatementMetadata } from './metadata';
import { computeEconomicFingerprint, computeSourceRowHash, ECONOMIC_FINGERPRINT_VERSION } from '../bank-csv/fingerprint';
import { decideDedup, addToDedupIndex, type DedupIndex } from '../bank-csv/dedup';
import { reconcileBalances, computeDateCoverage } from '../bank-csv/reconciliation';
import type { BalanceReconciliationResult, DateCoverageResult } from '../bank-csv/reconciliation';
import { decideCertification } from '../bank-csv/orchestrator';
import type { CertificationDecision } from '../bank-csv/orchestrator';
import { getPdfAdapterById } from './adapters/registry';
import type { PdfBankAdapter } from './adapters/types';
import { FDH5_PARSER_VERSION, PDF_MAX_TRANSACTION_ROWS, PDF_MIN_EXTRACTION_CONFIDENCE } from './constants';

export interface AcceptedPdfTransactionPlan {
  sourceRowNumber: number;
  sourcePage: number;
  transactionDate: string;
  descriptionRaw: string;
  descriptionClean: string;
  amountOriginal: number;
  creditDebit: FdhCreditDebit;
  balanceAfter: number | null;
  transactionTypeHint: FdhTransactionTypeHint;
  sourceRowHash: string;
  economicFingerprint: string;
  dedupStatus: FdhTransactionDedupStatus;
  matchedTransactionId: string | null;
  matchMethod: 'exact_hash' | 'fuzzy_amount_date' | 'statement_overlap' | 'user_reported' | null;
  dedupConfidence: number;
  extractionConfidence: number;
}

export interface RejectedPdfRowPlan {
  sourceRowNumber: number;
  reason: string;
}

export type PdfPipelineStatus =
  | 'ok'
  | 'encrypted'
  | 'password_invalid'
  | 'corrupt'
  | 'image_only'
  | 'page_limit_exceeded'
  | 'unsupported_layout'
  | 'ambiguous_layout'
  | 'extraction_low_confidence';

export interface PdfPipelineResult {
  status: PdfPipelineStatus;
  adapter: PdfBankAdapter | null;
  detection: PdfDetectionResult | null;
  pageCount: number | null;
  statementMetadata: PdfStatementMetadata | null;
  accepted: AcceptedPdfTransactionPlan[];
  rejected: RejectedPdfRowPlan[];
  unparseableBlockCount: number;
  reconciliation: BalanceReconciliationResult | null;
  dateCoverage: DateCoverageResult | null;
  newTransactionRowCount: number;
  duplicateConfirmedRowCount: number;
  statementExtractionConfidence: number | null;
  parserVersion: string;
  economicFingerprintVersion: string;
}

function emptyResult(status: PdfPipelineStatus, detection: PdfDetectionResult | null = null): PdfPipelineResult {
  return {
    status,
    adapter: null,
    detection,
    pageCount: null,
    statementMetadata: null,
    accepted: [],
    rejected: [],
    unparseableBlockCount: 0,
    reconciliation: null,
    dateCoverage: null,
    newTransactionRowCount: 0,
    duplicateConfirmedRowCount: 0,
    statementExtractionConfidence: null,
    parserVersion: FDH5_PARSER_VERSION,
    economicFingerprintVersion: ECONOMIC_FINGERPRINT_VERSION,
  };
}

export interface RunPdfPipelineInput {
  bytes: Uint8Array;
  statementUploadId: string;
  financialAccountId: string;
  currencyCode: string;
  password?: string;
  /** When provided, skips adapter auto-detection and forces this adapter —
   * used only when the caller has already resolved detection in a prior
   * step and is re-running the pipeline deterministically (idempotent
   * reprocessing, spec 89-90). Auto-detection is re-run whenever this is
   * absent. */
  adapterIdOverride?: string;
  dedupIndex: DedupIndex;
  declaredPeriodStart?: string | null;
  declaredPeriodEnd?: string | null;
}

/**
 * Runs the full deterministic PDF pipeline. Performs no I/O beyond reading
 * `bytes` already held in memory — the caller has already downloaded the
 * private storage object before calling this (spec 19: parsing happens
 * server-side only, and this pure module has no way to do otherwise — it
 * takes bytes in, returns a plan out).
 */
export async function runBankPdfPipeline(input: RunPdfPipelineInput): Promise<PdfPipelineResult> {
  const classified = await classifyPdf(input.bytes, input.password);

  if (classified.classification === 'encrypted') {
    return emptyResult(classified.reasonCode === 'wrong_password' ? 'password_invalid' : 'encrypted');
  }
  if (classified.classification === 'corrupt') return emptyResult('corrupt');
  if (classified.classification === 'unsupported') return emptyResult('page_limit_exceeded');
  if (classified.classification === 'image_only') return emptyResult('image_only');
  // 'text_native' or 'mixed_content' fall through to adapter detection —
  // mixed_content proceeds on native text (spec 14) but its statement-level
  // extraction confidence is penalised below via sparsePageIndexes.

  const pages = classified.pages ?? [];
  const fullText = pages.join('\n');

  let adapter: PdfBankAdapter | null = null;
  let detection: PdfDetectionResult | null = null;
  if (input.adapterIdOverride) {
    adapter = getPdfAdapterById(input.adapterIdOverride);
  } else {
    detection = detectPdfBankAdapter(fullText);
    if (detection.status === 'ambiguous') return emptyResult('ambiguous_layout', detection);
    if (detection.status === 'unsupported_layout' || !detection.adapter) return emptyResult('unsupported_layout', detection);
    adapter = detection.adapter;
  }
  if (!adapter) return emptyResult('unsupported_layout', detection);

  const statementMetadata = extractPdfStatementMetadata(fullText, adapter);

  const lines = flattenPdfLines(pages, adapter);
  const { rows, unparseableBlocks } = reconstructRows(lines, adapter);

  if (rows.length > PDF_MAX_TRANSACTION_ROWS) {
    return emptyResult('page_limit_exceeded', detection);
  }

  const accepted: AcceptedPdfTransactionPlan[] = [];
  const rejected: RejectedPdfRowPlan[] = [];
  let confidenceSum = 0;

  for (const row of rows) {
    const result = normalizePdfRow(row, adapter.dateFormat, adapter.amountConvention);
    if (!result.ok) {
      rejected.push({ sourceRowNumber: row.rowIndex, reason: result.reason });
      continue;
    }
    const t = result.transaction;
    const sourceRowHash = computeSourceRowHash(input.statementUploadId, row.rowIndex, [
      row.dateRaw,
      row.descriptionRaw,
      row.amountRaw,
      row.balanceRaw ?? '',
    ]);
    const economicFingerprint = computeEconomicFingerprint({
      financialAccountId: input.financialAccountId,
      currencyCode: input.currencyCode,
      transaction: t,
    });
    const hasStrongEvidence = t.balanceAfter !== null;
    const decision = decideDedup({ economicFingerprint, hasStrongEvidence }, input.dedupIndex);

    accepted.push({
      sourceRowNumber: row.rowIndex,
      sourcePage: row.pageNumber,
      transactionDate: t.transactionDate,
      descriptionRaw: t.descriptionRaw,
      descriptionClean: t.descriptionClean,
      amountOriginal: t.amountOriginal,
      creditDebit: t.creditDebit,
      balanceAfter: t.balanceAfter,
      transactionTypeHint: t.transactionTypeHint,
      sourceRowHash,
      economicFingerprint,
      dedupStatus: decision.status,
      matchedTransactionId: decision.matchedTransactionId,
      matchMethod: decision.matchMethod,
      dedupConfidence: decision.confidence,
      extractionConfidence: result.extractionConfidence,
    });
    confidenceSum += result.extractionConfidence;

    addToDedupIndex(input.dedupIndex, economicFingerprint, {
      transactionId: `pending-row-${row.rowIndex}`,
      hasStrongEvidence,
    });
  }

  const nonDuplicateAccepted = accepted.filter((a) => a.dedupStatus !== 'duplicate_confirmed');
  const duplicateConfirmed = accepted.filter((a) => a.dedupStatus === 'duplicate_confirmed');

  const reconciliation = reconcileBalances(
    nonDuplicateAccepted.map((a) => ({
      sourceRowNumber: a.sourceRowNumber,
      amountOriginal: a.amountOriginal,
      creditDebit: a.creditDebit,
      balanceAfter: a.balanceAfter,
    })),
    input.currencyCode,
  );
  const dateCoverage = computeDateCoverage(
    nonDuplicateAccepted.map((a) => a.transactionDate),
    input.declaredPeriodStart ?? statementMetadata.statementPeriodStart ?? null,
    input.declaredPeriodEnd ?? statementMetadata.statementPeriodEnd ?? null,
  );

  // Statement-level extraction confidence (spec 44, distinct from any one
  // row's own confidence): mean row confidence, further penalised by any
  // block whose numeric tail could never be located at all (spec 7: an
  // unparseable block is never silently dropped from this signal) and by a
  // MIXED_CONTENT document's sparse pages.
  const rowConfidence = rows.length > 0 ? confidenceSum / rows.length : 1;
  const unparseablePenalty = rows.length > 0 ? unparseableBlocks.length / (rows.length + unparseableBlocks.length) : 0;
  const mixedContentPenalty = classified.sparsePageIndexes.length > 0 ? 0.15 : 0;
  const statementExtractionConfidence = Math.max(0, rowConfidence - unparseablePenalty - mixedContentPenalty);

  if (statementExtractionConfidence < PDF_MIN_EXTRACTION_CONFIDENCE && rows.length > 0) {
    return {
      ...emptyResult('extraction_low_confidence', detection),
      adapter,
      pageCount: classified.pageCount,
      statementMetadata,
      unparseableBlockCount: unparseableBlocks.length,
      statementExtractionConfidence,
    };
  }

  return {
    status: 'ok',
    adapter,
    detection,
    pageCount: classified.pageCount,
    statementMetadata,
    accepted,
    rejected,
    unparseableBlockCount: unparseableBlocks.length,
    reconciliation,
    dateCoverage,
    newTransactionRowCount: nonDuplicateAccepted.length,
    duplicateConfirmedRowCount: duplicateConfirmed.length,
    statementExtractionConfidence,
    parserVersion: FDH5_PARSER_VERSION,
    economicFingerprintVersion: ECONOMIC_FINGERPRINT_VERSION,
  };
}

// ---------------------------------------------------------------------------
// Certification decision (spec 55, 91) — REUSES `decideCertification` from
// `bank-csv/orchestrator.ts` byte-for-byte; only the PDF-shaped detection
// status is mapped onto the CSV-shaped input value it expects.
// ---------------------------------------------------------------------------

export function decidePdfCertification(input: {
  pipelineStatus: PdfPipelineStatus;
  declaredRowCount: number;
  parsedRowCount: number;
  rejectedRowCount: number;
  duplicateCandidateCount: number;
  accountAmbiguous: boolean;
  reconciliationStatus: BalanceReconciliationResult['status'] | null;
}): CertificationDecision {
  const detectionStatus =
    input.pipelineStatus === 'ambiguous_layout'
      ? 'ambiguous'
      : input.pipelineStatus === 'unsupported_layout' ||
          input.pipelineStatus === 'encrypted' ||
          input.pipelineStatus === 'password_invalid' ||
          input.pipelineStatus === 'corrupt' ||
          input.pipelineStatus === 'image_only' ||
          input.pipelineStatus === 'page_limit_exceeded' ||
          input.pipelineStatus === 'extraction_low_confidence'
        ? 'unsupported'
        : 'detected';

  return decideCertification({
    detectionStatus,
    declaredRowCount: input.declaredRowCount,
    parsedRowCount: input.parsedRowCount,
    rejectedRowCount: input.rejectedRowCount,
    duplicateCandidateCount: input.duplicateCandidateCount,
    accountAmbiguous: input.accountAmbiguous,
    reconciliationStatus: input.reconciliationStatus,
  });
}
