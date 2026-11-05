import { requireCountryConfirmedUser as requireUser, ok } from '@/lib/api';
import { undoAutoCategorise } from '@/lib/financial-data-hub/services/premiumAutoCategoriseService';
import { categoryReviewErrorResponse } from '@/lib/financial-data-hub/services/categoryReviewHttp';

// POST /api/financial-data-hub/documents/{documentId}/category-review/auto-categorise/undo
// Withdraws every approval on the statement (the lines keep their categories) so the person can change what is wrong and approve again.
// Not behind the feature flag or Premium: anyone who has automatic lines can always take them back. 409 when there is nothing to undo.
export async function POST(_req: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  try {
    return ok(await undoAutoCategorise(user.id, documentId));
  } catch (e) {
    return categoryReviewErrorResponse(e, 'We could not undo this.');
  }
}
