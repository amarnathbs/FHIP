import { requireUser, bad, ok } from '@/lib/api';
import { confirmBankCsvMapping, BankCsvProcessingError } from '@/lib/financial-data-hub/services/bankCsvProcessingService';
import { bankCsvMappingConfirmSchema } from '@/lib/financial-data-hub/validation/bankCsv';

// POST /api/financial-data-hub/bank-csv/{documentId}/map — spec 22-23, 54, 57 step 3.
export async function POST(req: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const body = await req.json().catch(() => null);
  const parsed = bankCsvMappingConfirmSchema.safeParse(body);
  if (!parsed.success) return bad(parsed.error.issues[0]?.message ?? 'Invalid mapping', 422);

  try {
    const document = await confirmBankCsvMapping(user.id, documentId, parsed.data);
    return ok({
      document_id: document.id,
      detection_status: document.detection_status,
      mapping_template_id: document.mapping_template_id,
    });
  } catch (e) {
    if (e instanceof BankCsvProcessingError) {
      const status = e.code === 'not_found' ? 404 : 400;
      return bad(
        e.code === 'invalid_state'
          ? 'This document does not currently need a manual column mapping.'
          : e.message,
        status,
      );
    }
    return bad('We could not save this column mapping.', 500);
  }
}
