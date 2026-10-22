import { requireCountryConfirmedUser as requireUser, bad, ok } from '@/lib/api';
import { processBankCsvDocument, BankCsvProcessingError } from '@/lib/financial-data-hub/services/bankCsvProcessingService';
import { refuseUnlessImportRunMayStart } from '@/lib/entitlements/financialDataImport';
import { fdhDocumentRunPosition } from '@/lib/financial-data-hub/services/importRunPosition';

// POST /api/financial-data-hub/bank-csv/{documentId}/process — spec 32-46,
// 54, 55-56, 57 step 5. Idempotent/retry-safe — see the service module's
// header comment.
// WP-08 (UPL-01): a bounded request.
export const maxDuration = 60;

export async function POST(_req: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  // Premium Upload Entitlement (14-10-2026): starting NEW extraction work (a retry / re-parse) is Premium; the first run of a
  // document admitted while Premium and the idempotent in-flight lifecycle still complete after a downgrade.
  const importDenied = await refuseUnlessImportRunMayStart(user.id, 'fdh.bank_csv.process', () => fdhDocumentRunPosition(user.id, documentId));
  if (importDenied) return importDenied;

  try {
    const result = await processBankCsvDocument(user.id, documentId);
    return ok({
      // 2026-09-25: for a byte-identical re-upload, the ORIGINAL upload the
      // result belongs to (its import summary, or its AI draft to confirm).
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
    });
  } catch (e) {
    if (e instanceof BankCsvProcessingError) {
      // F15: another run of this same statement is still going; not an error, and not to be started twice.
      if (e.code === 'in_progress') return bad(e.message, 409, 'statement_in_progress');
      const status = e.code === 'not_found' ? 404 : 400;
      const message =
        e.code === 'mapping_required'
          ? 'We could read this CSV, but could not determine which column contains the transaction amount. Please confirm a column mapping first.'
          : e.code === 'account_unresolved'
            ? 'We could not tell which account this statement belongs to. Please resolve the account before processing.'
            : e.code === 'invalid_state'
              ? 'This document is not currently ready to be processed.'
              : e.message;
      return bad(message, status);
    }
    // F15: this used to answer with a fixed sentence and log nothing, so the failing stage was invisible. The class and message (never the
    // file, never an amount) go to the server log; the user still gets the plain sentence plus a stable code.
    console.error('[bank-csv/process] unexpected failure', { documentIdPrefix: documentId.slice(0, 8), name: e instanceof Error ? e.name : typeof e, message: e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300) });
    return bad('We could not process this bank statement.', 500, 'process_failed');
  }
}
