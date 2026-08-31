import { requireCountryConfirmedUser as requireUser, bad, ok } from '@/lib/api';
import { detectBankCsvDocument, BankCsvProcessingError } from '@/lib/financial-data-hub/services/bankCsvProcessingService';

// POST /api/financial-data-hub/bank-csv/{documentId}/detect — spec 54, 57 step 2.
export async function POST(_req: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  try {
    const document = await detectBankCsvDocument(user.id, documentId);
    return ok({
      document_id: document.id,
      detection_status: document.detection_status,
      detection_confidence: document.detection_confidence,
      adapter_key: document.adapter_key,
      encoding_detected: document.encoding_detected,
      delimiter_detected: document.delimiter_detected,
      declared_row_count: document.declared_row_count,
    });
  } catch (e) {
    if (e instanceof BankCsvProcessingError) {
      const status = e.code === 'not_found' ? 404 : 400;
      return bad(
        e.code === 'invalid_state'
          ? 'We could not read this CSV, or it is not ready for format detection yet.'
          : e.message,
        status,
      );
    }
    return bad('We could not determine the format of this file.', 500);
  }
}
