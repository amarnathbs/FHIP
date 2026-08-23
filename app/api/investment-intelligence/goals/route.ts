import { createClient } from '@/lib/supabase/server';
import { requireUser, ok, bad } from '@/lib/api';
import { computeGoalsPagePayload } from '@/lib/services/goalsData';

// R9 spec section 74/53: GET /investment-intelligence/goals — the Goal
// Review view. Consumes the CANONICAL live Goals forecast
// (computeGoalsPagePayload) rather than recomputing anything (spec section
// 27); adds only the II-side "how many open review items relate to this
// goal" rollup, itself a read of ii_review_items evidence, not a
// recalculation.
export async function GET() {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const supabase = await createClient();

  const { payload } = await computeGoalsPagePayload(user.id, supabase);
  const { data: openItems, error } = await supabase.from('ii_review_items').select('id, evidence').eq('user_id', user.id).eq('review_type', 'goal').in('status', ['open', 'acknowledged']);
  if (error) return bad(error.message);

  const reviewCountByGoal = new Map<string, number>();
  for (const item of openItems ?? []) {
    const goalId = (item.evidence as Record<string, unknown> | null)?.goalId as string | undefined;
    if (!goalId) continue;
    reviewCountByGoal.set(goalId, (reviewCountByGoal.get(goalId) ?? 0) + 1);
  }

  const goals = payload.goals.map((g) => ({
    id: g.id,
    goalName: g.goalName,
    targetAmount: g.targetAmount,
    targetDate: g.targetDate,
    currencyCode: g.currencyCode,
    status: g.status,
    allocatedInvestmentCount: (g.fundingSources ?? []).filter((s) => s.source_type === 'investment').length,
    currentAllocatedValue: g.currentAmount,
    forecastProjectedValue: g.forecasts.base.projectedTargetDateValue,
    forecastTargetValue: g.forecasts.base.targetAmountFuture,
    forecastGap: g.forecasts.base.fundingGapAtTargetDate,
    trackStatus: g.forecasts.base.trackStatus,
    forecastModelVersion: payload.modelVersion,
    openReviewItemCount: reviewCountByGoal.get(g.id) ?? 0,
  }));

  return ok({ goals, modelVersion: payload.modelVersion });
}
