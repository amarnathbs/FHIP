import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';
import { applyAiExtractionReview } from '@/lib/services/investment-intelligence/aiExtractionReviewApply';

// Investment Intelligence — AI-fallback document extraction: EXPLICIT
// accept (2026-09-17 PO addendum). This is the ONLY route in the entire
// generalized AI-fallback mechanism that writes a single canonical
// ii_transactions/ii_holding_snapshots row from AI-extracted data — and
// only ever after this exact user action. applyAiExtractionReview()
// re-verifies review ownership and pending status itself; this route does
// not trust anything about the review beyond its id.
export async function POST(request: Request, { params }: { params: Promise<{ reviewId: string }> }) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const { reviewId } = await params;

  const result = await applyAiExtractionReview(user.id, reviewId);
  if (!result.ok) {
    // 2026-09-25: a replayed or concurrent accept is a conflict (409), the
    // same answer every FDH confirm route gives; nothing was written.
    const status = result.code === 'already_decided' ? 409 : result.code === 'not_found' ? 404 : 400;
    return bad(result.error ?? 'Could not accept this AI extraction review.', status);
  }
  return ok(result.summary);
}
