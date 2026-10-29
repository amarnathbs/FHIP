import { requireCountryConfirmedUser as requireUser, ok } from '@/lib/api';
import { recheckStatementCategories } from '@/lib/financial-data-hub/services/categoryRecheckService';
import { categoryReviewErrorResponse } from '@/lib/financial-data-hub/services/categoryReviewHttp';

// POST /api/financial-data-hub/documents/{documentId}/category-review/recheck
// "Check the categories again": runs today's classification rules over this statement's lines that are still waiting for approval, so a
// statement imported earlier benefits without being uploaded again. It never approves anything and never changes an approved line, a category
// the person chose, an AI proposal or a user rule. Idempotent: a second press changes nothing.
export async function POST(_req: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  try {
    return ok(await recheckStatementCategories(user.id, documentId));
  } catch (e) {
    return categoryReviewErrorResponse(e, 'We could not check the categories again right now.');
  }
}
