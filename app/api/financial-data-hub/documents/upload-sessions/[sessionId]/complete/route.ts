import { requireCountryConfirmedUser as requireUser, bad, ok } from '@/lib/api';
import { isFdhDocumentUploadEnabled } from '@/lib/financial-data-hub/constants/featureFlags';
import { FDH_MAX_FILE_SIZE_BYTES } from '@/lib/financial-data-hub/domain/fileValidation';
import { completeUpload, FdhUploadLifecycleError } from '@/lib/financial-data-hub/services/uploadLifecycle';

// The largest size FDH-3 accepts for ANY allowed type — a hard, cheap,
// pre-session-lookup bound so an oversized request body is never read fully
// into memory before anything else has been checked (spec section 19/95).
const HARD_MAX_BYTES = Math.max(...Object.values(FDH_MAX_FILE_SIZE_BYTES));

// POST /api/financial-data-hub/documents/upload-sessions/{sessionId}/complete
// completeUpload() (spec section 27). The request body IS the file — this is
// the one server-mediated hop that streams bytes into private storage;
// see FDH3_STORAGE_SECURITY.md for why no direct-to-storage browser upload
// is used instead.
export async function POST(req: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  if (!isFdhDocumentUploadEnabled()) {
    return bad('Document uploads are not currently enabled in this environment.', 403);
  }

  const contentLength = Number(req.headers.get('content-length') ?? '0');
  if (!contentLength || contentLength <= 0) return bad('File upload incomplete.', 422);
  if (contentLength > HARD_MAX_BYTES) return bad('File too large.', 413);

  const arrayBuffer = await req.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  if (bytes.byteLength === 0) return bad('File upload incomplete.', 422);

  try {
    const document = await completeUpload(user.id, sessionId, bytes);
    return ok({
      document_id: document.id,
      processing_status: document.processing_status,
      error_code: document.error_code,
    });
  } catch (e) {
    if (e instanceof FdhUploadLifecycleError) {
      const status = e.code === 'not_found' ? 404 : e.code === 'upload_incomplete' ? 422 : 400;
      return bad(e.message, status);
    }
    return bad('Could not complete this upload.', 500);
  }
}
