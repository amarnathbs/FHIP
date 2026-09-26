import { requireCountryConfirmedUser as requireUser, ok } from '@/lib/api';
import { acknowledgeStatementReviewItem } from '@/lib/financial-data-hub/services/categoryReviewService';
import { categoryReviewErrorResponse } from '@/lib/financial-data-hub/services/categoryReviewHttp';

// POST /api/financial-data-hub/documents/{documentId}/review-items/{itemId}/acknowledge
// WP-08 (EXP-G15). The user confirms, after checking their statement, that a
// possibly-incomplete AI reading does list every transaction. Only the
// statement-level checks the domain names as acknowledgeable can be settled
// here (422 for any other); another user's id is 404. Repeating it is a no-op.
export async function POST(_req: Request, { params }: { params: Promise<{ documentId: string; itemId: string }> }) {
  const { documentId, itemId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  try {
    return ok(await acknowledgeStatementReviewItem(user.id, documentId, itemId));
  } catch (e) {
    return categoryReviewErrorResponse(e, 'We could not save your confirmation.');
  }
}
