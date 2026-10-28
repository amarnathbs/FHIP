import { requireCountryConfirmedUser as requireUser, bad, ok } from '@/lib/api';
import { loadBankCsvMappingSample, BankCsvProcessingError } from '@/lib/financial-data-hub/services/bankCsvProcessingService';

// GET /api/financial-data-hub/bank-csv/{documentId}/columns -- the columns of an uploaded CSV whose layout is not recognised, with its first
// rows, so the person can say which column is which (the mapping step; the answer goes to POST .../map).
//
// Read-only and owner-only: the document is read through the signed-in user's id, so another user's document answers 404, exactly as a
// document that does not exist does. It does not start any extraction (nothing is stored, nothing is parsed into transactions), so it
// carries no Premium guard of its own; the map and process routes it leads to do. The same malware admission every import passes
// applies before the stored file is read.
export async function GET(_req: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  try {
    const sample = await loadBankCsvMappingSample(user.id, documentId);
    return ok({ document_id: documentId, header: sample.header, rows: sample.rows, total_rows: sample.totalRows, delimiter: sample.delimiter });
  } catch (e) {
    if (e instanceof BankCsvProcessingError) {
      if (e.code === 'not_found') return bad('document not found', 404);
      if (e.code === 'file_gone') return bad('The stored copy of this file is no longer available. Please upload it again.', 410, 'file_gone');
      return bad(e.code === 'invalid_state' ? 'This statement does not need its columns chosen right now.' : e.message, 400);
    }
    return bad('We could not read the columns of this file.', 500);
  }
}
