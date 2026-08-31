import { requireCountryConfirmedUser as requireUser, bad, ok } from '@/lib/api';
import { isFdhDocumentUploadEnabled } from '@/lib/financial-data-hub/constants/featureFlags';
import { FDH_MAX_FILE_SIZE_BYTES } from '@/lib/financial-data-hub/domain/fileValidation';
import { uploadBankPdf } from '@/lib/financial-data-hub/services/bankPdfUploadService';
import { FdhUploadLifecycleError } from '@/lib/financial-data-hub/services/uploadLifecycle';
import { bankCsvUploadMetadataSchema } from '@/lib/financial-data-hub/validation/bankCsv';

const HARD_MAX_BYTES = FDH_MAX_FILE_SIZE_BYTES['application/pdf'];

// POST /api/financial-data-hub/bank-pdf/upload?country_code=AU&currency_code=AUD[&institution_id=...]
// spec sections 8, 19, 26. The request body IS the PDF bytes (same
// server-mediated pattern as bank-csv/upload and FDH-3's
// upload-sessions/complete — metadata travels as query parameters since the
// body is fully occupied by the file). Reuses `bankCsvUploadMetadataSchema`
// unchanged — the metadata contract (institution/country/currency/masked
// identifier/period) has nothing CSV-specific about it.
export async function POST(req: Request) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  if (!isFdhDocumentUploadEnabled()) {
    return bad('Bank PDF uploads are not currently enabled in this environment.', 403);
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
    const { document, accountResolution } = await uploadBankPdf(user.id, parsed.data, bytes);
    return ok({
      document_id: document.id,
      processing_status: document.processing_status,
      error_code: document.error_code,
      // Never leaks whether the SUPPLIED password was right/wrong here —
      // this is the upload step, no password has been submitted yet. The
      // browser is only told a password will be needed (spec 84: no
      // sensitive internals in a user-facing response).
      password_required: document.error_code === 'password_required',
      account_resolution: accountResolution,
      financial_account_id: document.financial_account_id,
    });
  } catch (e) {
    if (e instanceof FdhUploadLifecycleError) {
      const status = e.code === 'not_found' ? 404 : e.code === 'rate_limited' ? 429 : e.code === 'upload_incomplete' ? 422 : 400;
      return bad(e.message, status);
    }
    return bad('We could not read this PDF upload. Please try again.', 500);
  }
}
