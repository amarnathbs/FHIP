/**
 * The JSON a bank-statement "process" answer carries, in ONE place.
 *
 * Before WP-G the two process routes built this inline and returned it when the (long) request finished. Now a finished import's
 * summary is stored on the job (`result_summary`) and returned by every later status poll, so the same shape has to be built from
 * a service result by the worker AND by the admission route (which still answers inline for an already-settled statement or an AI
 * draft that is waiting). Pure: no I/O.
 */

import type { ProcessBankCsvResult } from '../services/bankCsvProcessingService';
import type { ProcessBankPdfResult } from '../services/bankPdfProcessingService';

export function csvProcessResponse(result: ProcessBankCsvResult): Record<string, unknown> {
  return {
    // 2026-09-25: for a byte-identical re-upload, the ORIGINAL upload the result belongs to.
    document_id: result.duplicateOfDocumentId ?? result.document.id,
    duplicate_of_document_id: result.duplicateOfDocumentId ?? null,
    duplicate: Boolean(result.duplicateOfDocumentId),
    certification_status: result.certificationStatus,
    processing_status: result.document.processing_status,
    reconciliation_status: result.reconciliationStatus,
    transactions_created: result.transactionsCreated,
    duplicates_skipped: result.duplicatesSkipped,
    duplicate_candidates: result.duplicateCandidates,
    rejected_rows: result.rejectedRows,
    // WP-08 (EXP-G14): why lines could not be read, in words.
    unread_lines: result.unreadLines ?? null,
    declared_row_count: result.document.declared_row_count,
    parsed_row_count: result.document.parsed_row_count,
  };
}

export function pdfProcessResponse(result: ProcessBankPdfResult): Record<string, unknown> {
  return {
    document_id: result.duplicateOfDocumentId ?? result.document.id,
    duplicate_of_document_id: result.duplicateOfDocumentId ?? null,
    duplicate: Boolean(result.duplicateOfDocumentId),
    pipeline_status: result.pipelineStatus,
    certification_status: result.certificationStatus,
    processing_status: result.document.processing_status,
    // A copy never carries its own state (e.g. its password prompt) into the original's result.
    error_code: result.duplicateOfDocumentId ? null : result.document.error_code,
    reconciliation_status: result.reconciliationStatus,
    transactions_created: result.transactionsCreated,
    duplicates_skipped: result.duplicatesSkipped,
    duplicate_candidates: result.duplicateCandidates,
    rejected_rows: result.rejectedRows,
    // WP-08 (EXP-G14/EXP-G15): why lines could not be read, and whether an AI reading may be missing lines.
    unread_lines: result.unreadLines ?? null,
    incomplete_extraction: result.incompleteExtraction ?? false,
    page_count: result.document.page_count,
    declared_row_count: result.document.declared_row_count,
    parsed_row_count: result.document.parsed_row_count,
    // Present (non-null) ONLY when `pipeline_status === 'ai_fallback_available'`: a DRAFT an AI read; nothing is written yet.
    ai_fallback_draft: result.aiFallbackDraft ?? null,
    // 'premium_required' | 'entitlement_unavailable' when the AI reading was not attempted for entitlement reasons.
    ai_fallback_refusal: result.aiFallbackRefusal ?? null,
  };
}
