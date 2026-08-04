import { requireUser, ok, bad } from '@/lib/api';
import { buildGoalForecastInputs } from '@/lib/services/goalsData';
import { computeAllScenarios } from '@/lib/engines/goalForecast';

// Live recalculation for goal-detail display — always computed fresh, never
// persisted (persistence only happens via the immutable goal_forecasts log
// written by loadGoalsPage on the main GET /api/goals route).
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const inputs = await buildGoalForecastInputs(user.id, id);
  if (!inputs) return bad('Goal not found', 404);
  const forecasts = computeAllScenarios(inputs.goalRecord, inputs.extras, inputs.config);
  return ok(forecasts);
}

// What-if goal simulator: apply overrides on top of the goal's real data and
// return the resulting forecast — a simulated result only, never persisted
// unless the user changes their actual goal (mirrors lib/engines/whatIf.ts).
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const body = await req.json().catch(() => ({}));

  const inputs = await buildGoalForecastInputs(user.id, id);
  if (!inputs) return bad('Goal not found', 404);

  const before = computeAllScenarios(inputs.goalRecord, inputs.extras, inputs.config);

  const overriddenGoal = {
    ...inputs.goalRecord,
    targetAmount: typeof body.target_amount === 'number' ? body.target_amount : inputs.goalRecord.targetAmount,
    targetDate: typeof body.target_date === 'string' ? body.target_date : inputs.goalRecord.targetDate,
    currentAmount: typeof body.current_amount === 'number' ? body.current_amount : inputs.goalRecord.currentAmount,
    plannedContributionAmount:
      typeof body.monthly_contribution === 'number' ? body.monthly_contribution : inputs.goalRecord.plannedContributionAmount,
    annualContributionGrowthPct:
      typeof body.annual_contribution_growth_pct === 'number'
        ? body.annual_contribution_growth_pct / 100
        : inputs.goalRecord.annualContributionGrowthPct,
    inflationAdjusted: typeof body.inflation_adjusted === 'boolean' ? body.inflation_adjusted : inputs.goalRecord.inflationAdjusted,
  };
  const after = computeAllScenarios(overriddenGoal, inputs.extras, inputs.config);

  return ok({ before, after });
}
