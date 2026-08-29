import { requireCountryConfirmedUser as requireUser, bad, ok } from '@/lib/api';
import { listDocuments } from '@/lib/financial-data-hub/services/uploadLifecycle';

// GET /api/financial-data-hub/documents — spec section 27/74. Lists the
// authenticated user's own documents with a user-facing status label. Never
// gated by the upload feature flag — a user must always be able to see
// documents they already have, even while new uploads are disabled.
export async function GET() {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  try {
    const documents = await listDocuments(user.id);
    return ok(documents);
  } catch (e) {
    return bad(e instanceof Error ? e.message : 'could not list documents', 500);
  }
}
