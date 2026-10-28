import { requireCountryConfirmedUser as requireUser, bad, ok } from '@/lib/api';
import { BankCsvProcessingError } from '@/lib/financial-data-hub/services/bankCsvProcessingService';
import { resetBankCsvForRemap } from '@/lib/financial-data-hub/services/bankCsvRemap';
import { refuseUnlessImportRunMayStart } from '@/lib/entitlements/financialDataImport';
import { fdhDocumentRunPosition } from '@/lib/financial-data-hub/services/importRunPosition';

// POST /api/financial-data-hub/bank-csv/{documentId}/remap -- take a statement that was read through a column mapping back to the mapping
// step, because the reading was wrong (every amount zero, lines unread, dates in the wrong order). The person then chooses the columns again
// (POST .../map) and the statement is read again from the stored file, without uploading it a second time.
//
// Refused once any line of the statement is approved (an approved line is never touched), while the statement is still being read, and when
// the stored file is gone (checked BEFORE anything is removed). Re-reading is new extraction work, so it carries the same Premium guard as
// the map and process routes.
export async function POST(_req: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const importDenied = await refuseUnlessImportRunMayStart(user.id, 'fdh.bank_csv.remap', () => fdhDocumentRunPosition(user.id, documentId));
  if (importDenied) return importDenied;

  try {
    const document = await resetBankCsvForRemap(user.id, documentId);
    return ok({ document_id: document.id, detection_status: document.detection_status });
  } catch (e) {
    if (e instanceof BankCsvProcessingError) {
      switch (e.code) {
        case 'not_found':
          return bad('document not found', 404);
        case 'file_gone':
          return bad('The stored copy of this file is no longer available, so it cannot be read again. Please upload it again.', 410, 'file_gone');
        case 'already_approved':
          return bad('Some lines of this statement are already approved, so it cannot be read again. Correct those lines in the review page instead.', 409, 'already_approved');
        case 'in_progress':
          return bad('This statement is still being read. Please wait for it to finish.', 409, 'statement_in_progress');
        case 'invalid_state':
          return bad('This statement was recognised automatically, so there is no column mapping to change.', 400);
        default:
          return bad('We could not reopen the column mapping.', 500);
      }
    }
    return bad('We could not reopen the column mapping.', 500);
  }
}
