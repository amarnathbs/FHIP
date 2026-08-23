import { requireUser, bad, ok } from '@/lib/api';
import { isFdhDocumentUploadEnabled } from '@/lib/financial-data-hub/constants/featureFlags';
import { FDH_MAX_FILE_SIZE_BYTES } from '@/lib/financial-data-hub/domain/fileValidation';
import { uploadBankCsv } from '@/lib/financial-data-hub/services/bankCsvUploadService';
import { FdhUploadLifecycleError } from '@/lib/financial-data-hub/services/uploadLifecycle';
import { bankCsvUploadMetadataSchema } from '@/lib/financial-data-hub/validation/bankCsv';

const HARD_MAX_BYTES = FDH_MAX_FILE_SIZE_BYTES['text/csv'];

// POST /api/financial-data-hub/bank-csv/upload?country_code=AU&currency_code=AUD[&institution_id=...]
// spec section 54/57 step 1. The request body IS the CSV bytes (same
// server-mediated pattern as FDH-3's upload-sessions/complete); metadata
// travels as query parameters since the body is fully occupied by the file.
export async function POST(req: Request) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  if (!isFdhDocumentUploadEnabled()) {
    return bad('Bank CSV uploads are not currently enabled in this environment.', 403);
  }

  const url = new URL(req.url);
  const metadataInput = {
    original_filename_sanitised: url.searchParams.get('filename') || undefined,
    institution_id: url.searchParams.get('institution_id') || undefined,
    country_code: url.searchParams.get('country_code') || undefined,
    currency_code: url.searchParams.get('currency_code') || undefined,
    declared_masked_identifier: url.searchParams.get('masked_identifier') || undefined,
    statement_period_start: url.searchParams.get('statement_period_start') || undefined,
    statement_period_end: url.searchParams.get('statement_period_end') || undefined,
  };
  const parsed = bankCsvUploadMetadataSchema.safeParse(metadataInput);
  if (!parsed.success) return bad(parsed.error.issues[0]?.message ?? 'Invalid request', 422);

  const contentLength = Number(req.headers.get('content-length') ?? '0');
  if (!contentLength || contentLength <= 0) return bad('File upload incomplete.', 422);
  if (contentLength > HARD_MAX_BYTES) return bad('File too large.', 413);

  const arrayBuffer = await req.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  if (bytes.byteLength === 0) return bad('File upload incomplete.', 422);

  try {
    const { document, accountResolution } = await uploadBankCsv(user.id, parsed.data, bytes);
    return ok({
      document_id: document.id,
      processing_status: document.processing_status,
      error_code: document.error_code,
      account_resolution: accountResolution,
      financial_account_id: document.financial_account_id,
    });
  } catch (e) {
    if (e instanceof FdhUploadLifecycleError) {
      const status = e.code === 'not_found' ? 404 : e.code === 'rate_limited' ? 429 : e.code === 'upload_incomplete' ? 422 : 400;
      return bad(e.message, status);
    }
    return bad('We could not read this CSV upload. Please try again.', 500);
  }
}
