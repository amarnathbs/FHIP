import { createClient } from '@/lib/supabase/server';
import { requireUser, ok, bad } from '@/lib/api';
import { iiGoalAllocationSchema } from '@/lib/validation/investment-intelligence';
import { createOrUpdateGoalAllocation } from '@/lib/services/investment-intelligence/goalAllocations';

// R9 spec section 74's exact path: POST /investment-intelligence/goals/:id/allocations.
// Thin wrapper over the same goalAllocations service the standalone
// /investment-intelligence/goal-allocations route uses — goalId in the
// path must match the body (defence against a mismatched-path forgery
// attempt), and goal ownership is verified before any write, exactly like
// the existing goal-allocations POST route.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const body = await req.json();
  const parsed = iiGoalAllocationSchema.safeParse({ ...body, goalId: id });
  if (!parsed.success) return bad(parsed.error.message, 422);
  if (body.goalId && body.goalId !== id) return bad('goalId in body does not match the goal in the URL path', 422);

  const supabase = await createClient();
  const { data: goal } = await supabase.from('user_goals').select('id').eq('id', id).eq('user_id', user.id).maybeSingle();
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
