import { requireUser, bad, ok } from '@/lib/api';
import { reviewRecurringSeries, ClassificationReviewError } from '@/lib/financial-data-hub/services/classificationReviewService';
import { fdhRecurringSeriesReviewSchema } from '@/lib/financial-data-hub/validation/transactions';

// POST /api/financial-data-hub/recurring-transactions/{recurringId}/review
// — R8 spec sections 53, 61: confirm, pause, resume or end a detected
// recurring series. The database (migration 0067) independently enforces
// which transitions are legitimate for the authenticated role.
export async function POST(req: Request, { params }: { params: Promise<{ recurringId: string }> }) {
  const { recurringId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const body = await req.json().catch(() => null);
  const parsed = fdhRecurringSeriesReviewSchema.safeParse(body);
  if (!parsed.success) return bad(parsed.error.issues[0]?.message ?? 'Invalid request', 422);

  try {
    const series = await reviewRecurringSeries(user.id, recurringId, parsed.data);
    return ok({ recurring_id: series.id, status: series.status, user_confirmed: series.user_confirmed });
  } catch (e) {
    if (e instanceof ClassificationReviewError) {
      return bad(e.message, e.code === 'not_found' ? 404 : 409);
    }
    return bad('We could not save this review decision.', 500);
  }
}
