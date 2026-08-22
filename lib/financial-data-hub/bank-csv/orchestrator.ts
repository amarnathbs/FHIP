/**
 * R7 — Bank CSV Engine: the pure processing pipeline (spec sections 18-46,
 * 55). Detection -> per-row normalisation -> fingerprinting -> dedup ->
 * reconciliation -> certification decision, entirely in memory, entirely
 * deterministic, with NO database access. This is what the independent
 * certification harness (`tests/unit/r7*.test.ts`, the Python oracle) drives
 * directly; the DB-touching service layer
 * (`services/bankCsvProcessingService.ts`) is a thin wrapper that fetches
 * the inputs this module needs and persists the plan it returns.
 */

import type { FdhCreditDebit, FdhCsvCertificationStatus, FdhTransactionDedupStatus, FdhTransactionTypeHint } from '../constants/enums';
import { detectBankCsvFormat } from './detection';
import type { DetectionResult } from './detection';
import { adapterToRowFormat, normalizeRow, type NormalizationFailureReason, type RowFormat } from './normalize';
import { computeEconomicFingerprint, computeSourceRowHash, ECONOMIC_FINGERPRINT_VERSION } from './fingerprint';
import { decideDedup, addToDedupIndex, type DedupIndex } from './dedup';
import { reconcileBalances, computeDateCoverage } from './reconciliation';
import type { BalanceReconciliationResult, DateCoverageResult } from './reconciliation';
import { R7_PARSER_VERSION } from './constants';

export interface AcceptedTransactionPlan {
  sourceRowNumber: number;
  transactionDate: string;
  postedDate: string | null;
  valueDate: string | null;
  descriptionRaw: string;
  descriptionClean: string;
  referenceRaw: string | null;
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
}

export interface RejectedRowPlan {
  sourceRowNumber: number;
  reason: NormalizationFailureReason;
}

export interface PipelineResult {
  detection: DetectionResult;
  declaredRowCount: number;
  parsedRowCount: number;
  accepted: AcceptedTransactionPlan[];
  rejected: RejectedRowPlan[];
  reconciliation: BalanceReconciliationResult | null;
  dateCoverage: DateCoverageResult | null;
  /** Rows accepted as genuinely NEW canonical transactions (unique or a
   * duplicate CANDIDATE still requiring review) — i.e. everything except
   * auto-confirmed duplicates, which correctly do not increase the
   * transaction count (spec 32's "0 duplicate economic transactions"). */
  newTransactionRowCount: number;
  duplicateConfirmedRowCount: number;
  parserVersion: string;
  economicFingerprintVersion: string;
}

export interface RunPipelineInput {
  bytes: Uint8Array;
  statementUploadId: string;
  financialAccountId: string;
  currencyCode: string;
  /** Present when the format was auto-detected; absent when driven by a
   * user-confirmed generic mapping (rowFormatOverride is then required). */
  rowFormatOverride?: RowFormat;
  /** Pre-loaded fingerprint index covering both prior-persisted transactions
   * for this account and (as rows are accepted) this run's own rows — see
   * `dedup.ts`'s header comment for why one index serves both purposes. */
  dedupIndex: DedupIndex;
  declaredPeriodStart?: string | null;
  declaredPeriodEnd?: string | null;
}

/**
 * Runs the full deterministic pipeline. Returns a `PipelineResult` whose
 * `accepted` array is exactly what the service layer should persist as
 * `fdh_transactions` rows — this function performs no I/O and can be run
 * any number of times on the same bytes with the same result (the basis of
 * the module's retry-safety and idempotency guarantees, spec 37/56).
 */
export function runBankCsvPipeline(input: RunPipelineInput): PipelineResult {
  const detection = detectBankCsvFormat(input.bytes);

  const rowFormat: RowFormat | null = input.rowFormatOverride ?? (detection.adapter ? adapterToRowFormat(detection.adapter) : null);

  if (!rowFormat || !detection.parsed) {
    return {
      detection,
      declaredRowCount: detection.parsed?.declaredRowCount ?? 0,
      parsedRowCount: 0,
      accepted: [],
      rejected: [],
      reconciliation: null,
      dateCoverage: null,
      newTransactionRowCount: 0,
      duplicateConfirmedRowCount: 0,
      parserVersion: R7_PARSER_VERSION,
      economicFingerprintVersion: ECONOMIC_FINGERPRINT_VERSION,
    };
  }

  const { header, rows, declaredRowCount } = detection.parsed;
  const accepted: AcceptedTransactionPlan[] = [];
  const rejected: RejectedRowPlan[] = [];

  rows.forEach((row, idx) => {
    const sourceRowNumber = idx + 1;
    const result = normalizeRow(header, row, sourceRowNumber, rowFormat);
    if (!result.ok) {
      rejected.push({ sourceRowNumber, reason: result.reason });
      return;
    }
    const t = result.transaction;
    const sourceRowHash = computeSourceRowHash(input.statementUploadId, sourceRowNumber, row);
    const economicFingerprint = computeEconomicFingerprint({
      financialAccountId: input.financialAccountId,
      currencyCode: input.currencyCode,
      transaction: t,
    });
    const hasStrongEvidence = Boolean(t.referenceRaw) || t.balanceAfter !== null;
    const decision = decideDedup({ economicFingerprint, hasStrongEvidence }, input.dedupIndex);

    accepted.push({
      sourceRowNumber,
      transactionDate: t.transactionDate,
      postedDate: t.postedDate,
      valueDate: t.valueDate,
      descriptionRaw: t.descriptionRaw,
      descriptionClean: t.descriptionClean,
      referenceRaw: t.referenceRaw,
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
    });

    // Feed this row into the index immediately, so a LATER row in the same
    // file that matches THIS one is caught too (within-file duplicates,
    // spec 68), before any DB write has happened.
    addToDedupIndex(input.dedupIndex, economicFingerprint, {
      transactionId: `pending-row-${sourceRowNumber}`,
      hasStrongEvidence,
    });
  });

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
    input.declaredPeriodStart ?? null,
    input.declaredPeriodEnd ?? null,
  );

  return {
    detection,
    declaredRowCount,
    parsedRowCount: accepted.length,
    accepted,
    rejected,
    reconciliation,
    dateCoverage,
    newTransactionRowCount: nonDuplicateAccepted.length,
    duplicateConfirmedRowCount: duplicateConfirmed.length,
    parserVersion: R7_PARSER_VERSION,
    economicFingerprintVersion: ECONOMIC_FINGERPRINT_VERSION,
  };
}

// ---------------------------------------------------------------------------
// Certification decision (spec section 45-46, 91)
// ---------------------------------------------------------------------------

export interface CertificationDecisionInput {
  detectionStatus: DetectionResult['status'];
  declaredRowCount: number;
  parsedRowCount: number;
  rejectedRowCount: number;
  duplicateCandidateCount: number;
  accountAmbiguous: boolean;
  reconciliationStatus: BalanceReconciliationResult['status'] | null;
}

export interface CertificationDecision {
  certificationStatus: FdhCsvCertificationStatus;
  reasonCodes: string[];
}

/**
 * The single place the four-state certification outcome is decided (spec
 * 45). PARTIAL is returned whenever ANY row failed to parse or the parse
 * declared fewer/more rows than were actually processed — a half-import is
 * NEVER silently certified (spec 46, 91).
 */
export function decideCertification(input: CertificationDecisionInput): CertificationDecision {
  const reasonCodes: string[] = [];

  if (input.detectionStatus === 'invalid' || input.detectionStatus === 'unsupported') {
    return { certificationStatus: 'rejected', reasonCodes: ['format_unsupported_or_invalid'] };
  }
  if (input.detectionStatus === 'ambiguous' || input.detectionStatus === 'manual_mapping_required') {
    return { certificationStatus: 'review_required', reasonCodes: [input.detectionStatus] };
  }

  if (input.parsedRowCount !== input.declaredRowCount) {
    reasonCodes.push('declared_vs_parsed_row_count_mismatch');
  }
  if (input.rejectedRowCount > 0) {
    reasonCodes.push('rows_failed_normalisation');
  }
  if (reasonCodes.length > 0) {
    return { certificationStatus: 'partial', reasonCodes };
  }

  if (input.accountAmbiguous) {
    return { certificationStatus: 'review_required', reasonCodes: ['account_identity_ambiguous'] };
  }
  if (input.duplicateCandidateCount > 0) {
    return { certificationStatus: 'review_required', reasonCodes: ['duplicate_candidates_pending_review'] };
  }
  if (input.reconciliationStatus === 'failed') {
    return { certificationStatus: 'review_required', reasonCodes: ['reconciliation_failed'] };
  }

  return { certificationStatus: 'certified', reasonCodes: [] };
}
