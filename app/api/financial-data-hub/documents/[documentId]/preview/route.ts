import { requireCountryConfirmedUser as requireUser, bad } from '@/lib/api';
import { FdhUploadLifecycleError, requestDocumentPreview } from '@/lib/financial-data-hub/services/uploadLifecycle';

// GET — requestDocumentPreview() (spec section 25/58). Redirects (302) to a
// short-lived signed Storage URL, exactly matching the existing
// report-exports download precedent — never returns the URL as JSON to keep
// it out of any client-side logging path, and never issued once the
// document has been purged (spec section 111: "purged URL unavailable").
export async function GET(_req: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  try {
    const url = await requestDocumentPreview(user.id, documentId);
    return Response.redirect(url, 302);
  } catch (e) {
    if (e instanceof FdhUploadLifecycleError) {
      const status = e.code === 'not_found' ? 404 : e.code === 'already_purged' ? 410 : 400;
      return bad(e.message, status);
    }
    return bad('Could not generate a preview link.', 500);
  }
}
