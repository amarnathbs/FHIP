import { requireUser, bad, ok } from '@/lib/api';
import {
  FdhUploadLifecycleError,
  getDocumentStatus,
  userDeleteDocument,
} from '@/lib/financial-data-hub/services/uploadLifecycle';

// GET — getDocumentStatus() (spec section 27/74).
export async function GET(_req: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  try {
    const result = await getDocumentStatus(user.id, documentId);
    return ok(result);
  } catch (e) {
    if (e instanceof FdhUploadLifecycleError && e.code === 'not_found') return bad('Document not found', 404);
    return bad('Could not load document status.', 500);
  }
}

// DELETE — deleteDocument() (spec section 27/47). Never gated by the upload
// feature flag — deletion must remain available even while new uploads are
// disabled.
export async function DELETE(_req: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  try {
    await userDeleteDocument(user.id, documentId);
    return ok({ deleted: true });
  } catch (e) {
    if (e instanceof FdhUploadLifecycleError) {
      const status = e.code === 'not_found' ? 404 : e.code === 'already_purged' ? 409 : 400;
      return bad(e.message, status);
    }
    return bad('Could not delete this document.', 500);
  }
}
