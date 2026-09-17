import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';
import { rejectAiExtractionReview } from '@/lib/services/investment-intelligence/aiExtractionReviewApply';

// Investment Intelligence — AI-fallback document extraction: explicit
// reject (2026-09-17 PO addendum). Never writes a canonical row; reverts
// the source document to the honest original failure status it would have
// shown had AI-fallback never been attempted.
export async function POST(request: Request, { params }: { params: Promise<{ reviewId: string }> }) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const { reviewId } = await params;

  const result = await rejectAiExtractionReview(user.id, reviewId);
  if (!result.ok) return bad(result.error ?? 'Could not reject this AI extraction review.', 400);
  return ok({ rejected: true });
}
