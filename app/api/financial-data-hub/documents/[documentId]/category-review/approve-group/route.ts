import { requireCountryConfirmedUser as requireUser, bad, ok } from '@/lib/api';
import { approveCategoryGroup } from '@/lib/financial-data-hub/services/categoryReviewService';
import { categoryReviewErrorResponse } from '@/lib/financial-data-hub/services/categoryReviewHttp';
import { fdhApproveCategoryGroupSchema } from '@/lib/financial-data-hub/validation/transactions';

// POST /api/financial-data-hub/documents/{documentId}/category-review/approve-group
// Approves exactly the still-pending transactions of one category group,
// through FDH-7's existing per-transaction approval (RPC pre-check + DB
// trigger). A second call for the same group is a no-op
// (outcome 'already_approved'). If every line in the group is blocked the
// response is 409 with the per-line reasons.
export async function POST(req: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const body = await req.json().catch(() => null);
  const parsed = fdhApproveCategoryGroupSchema.safeParse(body);
  if (!parsed.success) return bad('Choose a category group to approve.', 422);

  try {
    const result = await approveCategoryGroup(user.id, documentId, parsed.data.group_key);
    if (result.outcome === 'blocked') {
      return Response.json(
        { error: 'None of these transactions could be approved yet. Refresh the page to see which ones need a decision.', details: result },
        { status: 409 },
      );
    }
    return ok(result);
  } catch (e) {
    return categoryReviewErrorResponse(e, 'We could not approve this category.');
  }
}
