import { createClient } from '@/lib/supabase/server';
import { requireUser, ok, bad } from '@/lib/api';
import { iiGoalAllocationSchema } from '@/lib/validation/investment-intelligence';
import { createOrUpdateGoalAllocation } from '@/lib/services/investment-intelligence/goalAllocations';

export async function GET() {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const supabase = await createClient();
  const { data, error } = await supabase.from('ii_goal_allocations').select('*').eq('user_id', user.id).eq('status', 'active');
  return error ? bad(error.message) : ok(data);
}

// Creates an ii_goal_allocations row and, when linkedInvestmentId is
// supplied (the position has already been structurally published — see
// positions/[id]/publish), writes through to goal_funding_sources so the
// existing checkFundingAllocation() 100%-cap logic applies unchanged
// (R0_GOAL_INTEGRATION_CONTRACT.md). goal_id ownership is verified before
// any write, closing the cross-household relational-reference gap
// (DB-009/SEC-009): a user must own both the goal and the position.
export async function POST(req: Request) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const parsed = iiGoalAllocationSchema.safeParse(await req.json());
  if (!parsed.success) return bad(parsed.error.message, 422);

  const supabase = await createClient();
  const { data: goal } = await supabase.from('user_goals').select('id').eq('id', parsed.data.goalId).eq('user_id', user.id).maybeSingle();
  if (!goal) return bad('Goal not found or not owned by the current user', 404);

  const result = await createOrUpdateGoalAllocation(
    user.id,
    {
      goalId: parsed.data.goalId,
      investmentPositionId: parsed.data.investmentPositionId,
      allocationType: parsed.data.allocationType,
      allocationValue: parsed.data.allocationValue,
      source: 'user',
    },
    parsed.data.linkedInvestmentId ?? null
  );
  if (result.error) return bad(result.error, result.capExceeded ? 409 : 500);
  return ok({ allocationId: result.allocationId });
}
