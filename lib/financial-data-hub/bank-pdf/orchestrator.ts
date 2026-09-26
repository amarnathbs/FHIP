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
// Imported for `runBankPdfPipelineFromReadRows` below — the SAME description
// cleaning and type-hint inference the CSV and PDF native paths already use,
// so an AI-read row is derived exactly like a natively-parsed one.
import { normalizeDescription, inferTypeHint } from '../bank-csv/normalize';
import { extractPdfStatementMetadata, type PdfStatementMetadata } from './metadata';
import { computeEconomicFingerprint, computeSourceRowHash, ECONOMIC_FINGERPRINT_VERSION } from '../bank-csv/fingerprint';
import { decideDedup, addToDedupIndex, type DedupIndex } from '../bank-csv/dedup';
import { reconcileBalances, computeDateCoverage } from '../bank-csv/reconciliation';
import { sumMoney } from '../domain/money';
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
  | 'extraction_low_confidence'
  | 'extraction_timeout';

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
  /**
   * The native-extracted page text, IN MEMORY ONLY, populated ONLY for the
   * failure statuses an AI fallback is eligible for
   * (`unsupported_layout`, `ambiguous_layout`, `extraction_low_confidence`)
   * and `null` in every other case, including success.
   *
   * ADDED 2026-09-23 for the AI-fallback path, and the narrowness is the
   * whole point. The caller needs the text to MASK it and offer it to the AI
   * gateway, and it previously died as a local inside this function
   * (`classifyPdf`'s `pages` are consumed at the top and never returned) —
   * `classification.ts` states the invariant plainly: extracted text is
   * "ephemeral, in-memory only, never persisted (spec 21, 75)". That
   * invariant is NOT relaxed here. This field is never written to a database
   * column, never logged, and never included in an API response; it exists so
   * the service can hand it to `maskText` without re-parsing the PDF — which
   * was the only alternative, and would have meant re-admitting the decrypted
   * `password` below the line the service's own header promises it is never
   * used again.
   *
   * It is deliberately NOT populated on success (nothing needs it) or on
   * `encrypted`/`corrupt`/`image_only`/`page_limit_exceeded` (there is no
   * usable text, which is precisely why those statuses are not AI-eligible).
   */
  extractedText: string | null;
}

function emptyResult(status: PdfPipelineStatus, detection: PdfDetectionResult | null = null, extractedText: string | null = null): PdfPipelineResult {
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
    extractedText,
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

  // WP-08 (UPL-01): the read ran out of time -- retryable, not a verdict.
  if (classified.reasonCode === 'timeout') return emptyResult('extraction_timeout');
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
    // `fullText` is carried out on these two statuses ONLY so the AI-fallback
    // path can mask it — see `PdfPipelineResult.extractedText`'s header.
    if (detection.status === 'ambiguous') return emptyResult('ambiguous_layout', detection, fullText);
    if (detection.status === 'unsupported_layout' || !detection.adapter) return emptyResult('unsupported_layout', detection, fullText);
    adapter = detection.adapter;
  }
  if (!adapter) return emptyResult('unsupported_layout', detection, fullText);

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
      ...emptyResult('extraction_low_confidence', detection, fullText),
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
    // Never carried on success — nothing downstream needs it, and the
    // narrowest possible lifetime for extracted document text is the point.
    extractedText: null,
  };
}

// ---------------------------------------------------------------------------
// AI-FALLBACK RE-ENTRY (2026-09-23) — the SAME deterministic downstream, run
// over rows an AI read off a layout the deterministic parser could not
// segment.
//
// WHY THIS LIVES HERE, NEXT TO `runBankPdfPipeline`, AND NOT IN THE ADAPTER.
// Everything below the "read the rows off the page" step — fingerprinting,
// duplicate decisions, balance rollforward, date coverage, statement
// confidence — must be byte-identical between a natively-parsed statement and
// an AI-read one, or an AI-sourced import could reach the database having
// passed different checks. Putting this function in the AI adapter would have
// meant either importing all seven deterministic helpers into
// `lib/aie/` (duplicating this file's own careful REUSE-NOT-REIMPLEMENTATION
// property one directory over) or, far worse, reimplementing them. It lives
// here so that it CANNOT drift: it calls the same functions, in the same
// order, from the same module as the native path immediately above it.
//
// WHAT IT DELIBERATELY DOES NOT DO. It performs no I/O, makes no AI call,
// knows nothing about masking or feature flags, and writes nothing. It is as
// pure as its native sibling. It also does not set `status: 'ok'` blindly —
// see the confidence note below.
// ---------------------------------------------------------------------------

/** One transaction line as READ off the page, before any derivation. The AI
 * adapter maps its schema onto this; nothing else in this module knows the AI
 * exists. */
export interface ReadBankStatementRow {
  sourceRowNumber: number;
  transactionDate: string;
  descriptionRaw: string;
  /** Positive magnitude. Direction is `creditDebit`, never a sign. */
  amountOriginal: number;
  creditDebit: FdhCreditDebit;
  balanceAfter: number | null;
}

export interface RunPdfPipelineFromReadRowsInput {
  statementUploadId: string;
  financialAccountId: string;
  currencyCode: string;
  dedupIndex: DedupIndex;
  rows: readonly ReadBankStatementRow[];
  statementMetadata: PdfStatementMetadata;
  pageCount: number | null;
  declaredPeriodStart?: string | null;
  declaredPeriodEnd?: string | null;
  /** Stamped onto the result so a reviewer (and every downstream consumer)
   * can tell an AI-read statement from a natively-parsed one. */
  parserVersion: string;
}

/**
 * Runs the deterministic downstream over already-read rows.
 *
 * `extractionConfidence` on each row is recorded as 0, and the
 * statement-level `statementExtractionConfidence` likewise. That is NOT a
 * claim that the reading is worthless — it is this codebase's established
 * P4/REC-04 position that no confidence channel is ever trusted to gate
 * anything, applied consistently: the payslip adapter records the same 0. The
 * signal that actually decides whether this import is trustworthy is the
 * balance rollforward computed below, which is arithmetic over the rows
 * themselves rather than an opinion about them.
 */
/**
 * 2026-09-25 (other-PDF AI proof): the STATEMENT-LEVEL rollforward, for a
 * read statement that prints no running balance per line (a letter, a
 * summary, many credit-union layouts). `reconcileBalances` needs per-row
 * balances and otherwise answers `not_available`, which let such a statement
 * through with NO arithmetic check at all -- a missing or doubled line was
 * invisible. When the statement itself declares an opening AND a closing
 * balance, this checks opening + credits - debits = closing, exactly (zero
 * tolerance, the same money arithmetic), and records the declared closing as
 * the reported figure so a mismatch is kept as a variance, never balanced
 * away. Returns null (leaving `not_available`) when either balance is absent.
 */
export function reconcileDeclaredOpeningToClosing(
  rows: readonly { amountOriginal: number; creditDebit: FdhCreditDebit }[],
  metadata: PdfStatementMetadata,
  currencyCode: string,
): ReturnType<typeof reconcileBalances> | null {
  const opening = metadata.declaredOpeningBalance;
  const closing = metadata.declaredClosingBalance;
  if (opening === null || opening === undefined || closing === null || closing === undefined) return null;
  const credits = rows.filter((r) => r.creditDebit === 'credit').map((r) => r.amountOriginal);
  const debits = rows.filter((r) => r.creditDebit === 'debit').map((r) => r.amountOriginal);
  const extractedCredits = credits.length ? sumMoney(credits, currencyCode) : 0;
  const extractedDebits = debits.length ? sumMoney(debits, currencyCode) : 0;
  const expectedClosingBalance = sumMoney([opening, extractedCredits, -extractedDebits], currencyCode);
  const variance = sumMoney([expectedClosingBalance, -closing], currencyCode);
  return {
    status: variance === 0 ? 'reconciled' : 'failed',
    method: 'balance_rollforward',
    openingBalance: opening,
    extractedCredits,
    extractedDebits,
    expectedClosingBalance,
    reportedClosingBalance: closing,
    variance,
    varianceTolerance: 0,
    firstBreakRowNumber: null,
  };
}

export function runBankPdfPipelineFromReadRows(input: RunPdfPipelineFromReadRowsInput): PdfPipelineResult {
  const accepted: AcceptedPdfTransactionPlan[] = [];

  for (const row of input.rows) {
    const descriptionClean = normalizeDescription(row.descriptionRaw);
    const transactionTypeHint = inferTypeHint(descriptionClean, row.creditDebit);
    const transaction = {
      sourceRowNumber: row.sourceRowNumber,
      transactionDate: row.transactionDate,
      postedDate: null,
      valueDate: null,
      descriptionRaw: row.descriptionRaw,
      descriptionClean,
      referenceRaw: null,
      amountOriginal: row.amountOriginal,
      creditDebit: row.creditDebit,
      balanceAfter: row.balanceAfter,
      transactionTypeHint,
    };

    const sourceRowHash = computeSourceRowHash(input.statementUploadId, row.sourceRowNumber, [
      row.transactionDate,
      row.descriptionRaw,
      String(row.amountOriginal),
      row.balanceAfter === null ? '' : String(row.balanceAfter),
    ]);
    const economicFingerprint = computeEconomicFingerprint({
      financialAccountId: input.financialAccountId,
      currencyCode: input.currencyCode,
      transaction,
    });
    const hasStrongEvidence = row.balanceAfter !== null;
    const decision = decideDedup({ economicFingerprint, hasStrongEvidence }, input.dedupIndex);

    accepted.push({
      sourceRowNumber: row.sourceRowNumber,
      // An AI reading is not page-anchored: the model is given the whole
      // document's flattened text and is not asked which page a line came
      // from (a fact it could only guess). Recorded as page 1 rather than
      // inventing a page number per row.
      sourcePage: 1,
      transactionDate: row.transactionDate,
      descriptionRaw: row.descriptionRaw,
      descriptionClean,
      amountOriginal: row.amountOriginal,
      creditDebit: row.creditDebit,
      balanceAfter: row.balanceAfter,
      transactionTypeHint,
      sourceRowHash,
      economicFingerprint,
      dedupStatus: decision.status,
      matchedTransactionId: decision.matchedTransactionId,
      matchMethod: decision.matchMethod,
      dedupConfidence: decision.confidence,
      extractionConfidence: 0,
    });

    addToDedupIndex(input.dedupIndex, economicFingerprint, {
      transactionId: `pending-row-${row.sourceRowNumber}`,
      hasStrongEvidence,
    });
  }

  const nonDuplicateAccepted = accepted.filter((a) => a.dedupStatus !== 'duplicate_confirmed');
  const duplicateConfirmed = accepted.filter((a) => a.dedupStatus === 'duplicate_confirmed');

  const rowLevel = reconcileBalances(
    nonDuplicateAccepted.map((a) => ({
      sourceRowNumber: a.sourceRowNumber,
      amountOriginal: a.amountOriginal,
      creditDebit: a.creditDebit,
      balanceAfter: a.balanceAfter,
    })),
    input.currencyCode,
  );
  // Row-level evidence decides only when EVERY line carries a balance. With
  // none or only some (a read letter; a statement printing a balance per page;
  // or a single figure that coincides with a printed one -- seen live), the
  // printed opening and closing balances decide instead, when both exist.
  const rowLevelConclusive = rowLevel.status === 'reconciled' || rowLevel.status === 'failed';
  const reconciliation = !rowLevelConclusive && nonDuplicateAccepted.length > 0
    ? reconcileDeclaredOpeningToClosing(nonDuplicateAccepted, input.statementMetadata, input.currencyCode) ?? rowLevel
    : rowLevel;
  const dateCoverage = computeDateCoverage(
    nonDuplicateAccepted.map((a) => a.transactionDate),
    input.declaredPeriodStart ?? input.statementMetadata.statementPeriodStart ?? null,
    input.declaredPeriodEnd ?? input.statementMetadata.statementPeriodEnd ?? null,
  );

  return {
    status: 'ok',
    adapter: null,
    detection: null,
    pageCount: input.pageCount,
    statementMetadata: input.statementMetadata,
    accepted,
    rejected: [],
    unparseableBlockCount: 0,
    reconciliation,
    dateCoverage,
    newTransactionRowCount: nonDuplicateAccepted.length,
    duplicateConfirmedRowCount: duplicateConfirmed.length,
    statementExtractionConfidence: 0,
    parserVersion: input.parserVersion,
    economicFingerprintVersion: ECONOMIC_FINGERPRINT_VERSION,
    extractedText: null,
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
