import { requireUser, bad, ok } from '@/lib/api';
import { reviewTransactionLink, ClassificationReviewError } from '@/lib/financial-data-hub/services/classificationReviewService';
import { fdhTransactionLinkReviewSchema } from '@/lib/financial-data-hub/validation/transactions';

// POST /api/financial-data-hub/transaction-links/{linkId}/review — R8 spec
// sections 32, 61: confirm or reject a proposed transfer/settlement/refund/
// reversal link. The narrow legitimate transition (pending -> confirmed or
// rejected) is enforced at the database (migration 0067) as well as here.
export async function POST(req: Request, { params }: { params: Promise<{ linkId: string }> }) {
  const { linkId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const body = await req.json().catch(() => null);
  const parsed = fdhTransactionLinkReviewSchema.safeParse(body);
  if (!parsed.success) return bad(parsed.error.issues[0]?.message ?? 'Invalid request', 422);

  try {
    const link = await reviewTransactionLink(user.id, linkId, parsed.data);
    return ok({ link_id: link.id, status: link.status, user_confirmed: link.user_confirmed });
  } catch (e) {
    if (e instanceof ClassificationReviewError) {
      return bad(e.message, e.code === 'not_found' ? 404 : 409);
    }
    return bad('We could not save this review decision.', 500);
  }
}
