import { requireUser, ok, bad } from '@/lib/api';
import { computeGoalsPagePayload } from '@/lib/services/goalsData';

// Education/Children Investment -> Goal Linkage, spec s.24/57/59: a
// lightweight, read-only goal picker for "Link to Goal" controls (the
// Investments page's GoalLinkControl). Deliberately uses
// computeGoalsPagePayload directly rather than GET /api/goals (which wraps
// loadGoalsPage — persists a new goal_forecasts row and upserts a
// goal_snapshots row on every call, appropriate for the main Goals page's
// own load but wasteful to call every time a picker opens elsewhere).
// Returns only goals the caller owns (computeGoalsPagePayload is already
// scoped to auth.uid()) and 'active' status only (spec s.59: "active
// Goals, user-owned Goals only").
export async function GET() {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  try {
    const { payload } = await computeGoalsPagePayload(user.id);
    const goals = payload.goals
      .filter((g) => g.status === 'active')
      .map((g) => ({ id: g.id, goalName: g.goalName, targetAmount: g.targetAmount, currencyCode: g.currencyCode }));
    return ok(goals);
  } catch (e) {
    return bad(e instanceof Error ? e.message : 'Could not load goals');
  }
}
