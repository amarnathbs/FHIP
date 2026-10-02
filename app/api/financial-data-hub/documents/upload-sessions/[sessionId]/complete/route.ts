import { requireCountryConfirmedUser as requireUser, bad, ok } from '@/lib/api';
import { isFdhDocumentUploadEnabled } from '@/lib/financial-data-hub/constants/featureFlags';
import { FDH_MAX_FILE_SIZE_BYTES } from '@/lib/financial-data-hub/domain/fileValidation';
import { completeUpload, FdhUploadLifecycleError } from '@/lib/financial-data-hub/services/uploadLifecycle';
import { createAdminClient } from '@/lib/supabase/admin';
import {
  OWNER_FLOW_FOR_DOCUMENT_TYPE,
  assertNoIdenticalDocumentWithDifferentOwnerKey,
  documentOwnerConflictResponse,
  ownerKeyOfRow,
} from '@/lib/financial-data-hub/services/documentOwnerRequest';

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
    // Owner-before-upload (decision 6): the same bytes under a DIFFERENT owner is refused BEFORE
    // anything is stored, strictly within this user's own documents of the same type. The document
    // row the session created is closed (rejected) so no empty record is left behind.
    const admin = createAdminClient();
    const { data: sess } = await admin.from('fdh_upload_sessions').select('document_id').eq('id', sessionId).eq('user_id', user.id).maybeSingle();
    const sessionDocumentId = (sess as { document_id?: string } | null)?.document_id ?? null;
    if (sessionDocumentId) {
      const { data: docRow } = await admin.from('fdh_statement_uploads').select('*').eq('id', sessionDocumentId).eq('user_id', user.id).maybeSingle();
      const doc = (docRow ?? null) as Record<string, unknown> | null;
      if (doc && OWNER_FLOW_FOR_DOCUMENT_TYPE[doc.document_type as string] && doc.owner_selection_source === 'user_selected') {
        const sameKindTypes = OWNER_FLOW_FOR_DOCUMENT_TYPE[doc.document_type as string] === 'liability' ? ['credit_card_statement', 'loan_statement'] : [doc.document_type as string];
        try {
          await assertNoIdenticalDocumentWithDifferentOwnerKey(user.id, bytes, sameKindTypes, ownerKeyOfRow(doc), sessionDocumentId);
        } catch (conflict) {
          const response = documentOwnerConflictResponse(conflict);
          if (response) {
            await admin.from('fdh_statement_uploads').update({ processing_status: 'rejected' }).eq('id', sessionDocumentId).eq('user_id', user.id).eq('processing_status', 'created');
            return response;
          }
          throw conflict;
        }
      }
    }
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
