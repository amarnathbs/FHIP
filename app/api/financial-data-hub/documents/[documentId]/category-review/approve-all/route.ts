import { requireCountryConfirmedUser as requireUser, ok } from '@/lib/api';
import { approveAllOnStatement } from '@/lib/financial-data-hub/services/categoryReviewService';
import { categoryReviewErrorResponse } from '@/lib/financial-data-hub/services/categoryReviewHttp';

// POST /api/financial-data-hub/documents/{documentId}/category-review/approve-all
// Approves everything left on the statement through FDH-7's existing
// statement approval — but only once no line still needs the user's decision
// (409 with a plain reason otherwise). Repeating it is a no-op.
export async function POST(_req: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  try {
    return ok(await approveAllOnStatement(user.id, documentId));
  } catch (e) {
    return categoryReviewErrorResponse(e, 'We could not approve this statement.');
  }
}
