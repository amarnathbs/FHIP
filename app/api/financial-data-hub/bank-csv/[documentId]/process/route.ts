import { requireUser, bad, ok } from '@/lib/api';
import { processBankCsvDocument, BankCsvProcessingError } from '@/lib/financial-data-hub/services/bankCsvProcessingService';

// POST /api/financial-data-hub/bank-csv/{documentId}/process — spec 32-46,
// 54, 55-56, 57 step 5. Idempotent/retry-safe — see the service module's
// header comment.
export async function POST(_req: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  try {
    const result = await processBankCsvDocument(user.id, documentId);
    return ok({
      document_id: result.document.id,
      certification_status: result.certificationStatus,
      processing_status: result.document.processing_status,
      reconciliation_status: result.reconciliationStatus,
      transactions_created: result.transactionsCreated,
      duplicates_skipped: result.duplicatesSkipped,
      duplicate_candidates: result.duplicateCandidates,
      rejected_rows: result.rejectedRows,
      declared_row_count: result.document.declared_row_count,
      parsed_row_count: result.document.parsed_row_count,
    });
  } catch (e) {
    if (e instanceof BankCsvProcessingError) {
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
    return bad('We could not process this bank statement.', 500);
  }
}
