import { requireCountryConfirmedUser as requireUser, ok } from '@/lib/api';
import { getStatementCategoryReview } from '@/lib/financial-data-hub/services/categoryReviewService';
import { categoryReviewErrorResponse } from '@/lib/financial-data-hub/services/categoryReviewHttp';

// GET /api/financial-data-hub/documents/{documentId}/category-review
// The statement's transactions grouped by category with each group's count
// and total, plus the lines that need the user's own decision listed
// separately. Read-only; scoped to the signed-in user (another user's
// statement id is a 404).
export async function GET(_req: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  try {
    return ok(await getStatementCategoryReview(user.id, documentId));
  } catch (e) {
    return categoryReviewErrorResponse(e, 'We could not load this statement review.');
  }
}
