import { createClient } from '@/lib/supabase/server';
import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';
import { computeGoalsPagePayload } from '@/lib/services/goalsData';

// R9 spec section 74/53: GET /investment-intelligence/goals/:id — single
// goal detail with linked investments and related review items.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const supabase = await createClient();

  const { payload } = await computeGoalsPagePayload(user.id, supabase);
  const goal = payload.goals.find((g) => g.id === id);
  if (!goal) return bad('Goal not found or not owned by the current user', 404);

  const { data: reviewItems, error } = await supabase.from('ii_review_items').select('*').eq('user_id', user.id).in('status', ['open', 'acknowledged']);
  if (error) return bad(error.message);
  const relatedReviewItems = (reviewItems ?? []).filter((item) => (item.evidence as Record<string, unknown> | null)?.goalId === id);

  return ok({
    goal: {
      id: goal.id,
      goalName: goal.goalName,
      goalCategory: goal.goalCategory,
      targetAmount: goal.targetAmount,
      targetDate: goal.targetDate,
      currencyCode: goal.currencyCode,
      status: goal.status,
      currentAmount: goal.currentAmount,
      forecasts: goal.forecasts,
      fundingSources: goal.fundingSources,
      modelVersion: payload.modelVersion,
    },
    relatedReviewItems,
  });
}
