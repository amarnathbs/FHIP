import { requireCountryConfirmedUser as requireUser, bad, ok } from '@/lib/api';
import { statementUploadsRepository } from '@/lib/financial-data-hub/repositories';
import { deriveUploadSubstate, deriveDocumentStatusLabel } from '@/lib/financial-data-hub/domain/uploadSubstate';

// GET /api/financial-data-hub/bank-csv/{documentId}/status — spec 54, 57 step 6.
export async function GET(_req: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const { data: document } = await statementUploadsRepository.getForUser(user.id, documentId);
  if (!document) return bad('document not found', 404);

  return ok({
    document_id: document.id,
    processing_status: document.processing_status,
    status_label: deriveDocumentStatusLabel(document.processing_status),
    substate: deriveUploadSubstate({ sessionStatus: null, processingStatus: document.processing_status, errorCode: document.error_code }),
    detection_status: document.detection_status,
    certification_status: document.certification_status,
    reconciliation_status: document.reconciliation_status,
    declared_row_count: document.declared_row_count,
    parsed_row_count: document.parsed_row_count,
    certified_row_count: document.certified_row_count,
    duplicate_row_count: document.duplicate_row_count,
    financial_account_id: document.financial_account_id,
    error_code: document.error_code,
  });
}
