import { createClient } from '@/lib/supabase/server';
import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';
import { z } from 'zod';
import { checkFundingAllocation, resolveAllocatedAmount, assertOwnsGoal } from '@/lib/services/goalFundingAllocation';

// Education/Children Investment -> Goal Linkage, spec s.24/26/57: the
// Investment-side entry point into the SAME canonical goal_funding_sources
// relationship the Goals page's funding-sources routes already write to
// (spec s.27: "one canonical relationship, not two independent links").
// This route never introduces a second table or a second allocation model
// — it is a thin, investment-scoped view over exactly the same rows.

const linkBodySchema = z.object({
  goal_id: z.string().uuid(),
  allocation_percentage: z.number().min(0).max(100).optional(),
  allocated_amount: z.number().min(0).optional(),
});

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const supabase = await createClient();

  const { data: investment } = await supabase.from('investments').select('id').eq('id', id).eq('user_id', user.id).maybeSingle();
  if (!investment) return bad('Investment not found or not owned by the current user', 404);

  const { data, error } = await supabase
    .from('goal_funding_sources')
    .select('id, goal_id, allocated_amount, allocation_percentage, user_goals!inner(goal_name, target_amount, currency_code)')
    .eq('user_id', user.id)
    .eq('linked_investment_id', id)
    .eq('is_active', true);
  if (error) return bad(error.message);

  const links = (data ?? []).map((row) => {
    const goal = Array.isArray(row.user_goals) ? row.user_goals[0] : row.user_goals;
    return {
      id: row.id as string,
      goal_id: row.goal_id as string,
      allocated_amount: row.allocated_amount as number,
      allocation_percentage: row.allocation_percentage as number | null,
      goal_name: (goal as { goal_name: string } | null)?.goal_name ?? 'Goal',
      goal_target_amount: (goal as { target_amount: number } | null)?.target_amount ?? 0,
      goal_currency_code: (goal as { currency_code: string } | null)?.currency_code ?? 'AUD',
    };
  });
  return ok(links);
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const parsed = linkBodySchema.safeParse(await req.json());
  if (!parsed.success) return bad(parsed.error.message, 422);

  const supabase = await createClient();
  const { data: investment } = await supabase.from('investments').select('id, currency_code').eq('id', id).eq('user_id', user.id).maybeSingle();
  if (!investment) return bad('Investment not found or not owned by the current user', 404);

  const goalOwnershipError = await assertOwnsGoal(user.id, parsed.data.goal_id);
  if (goalOwnershipError) return bad(goalOwnershipError, 404);

  const check = await checkFundingAllocation(user.id, {
    linkedInvestmentId: id,
    allocationPercentage: parsed.data.allocation_percentage ?? null,
  });
  if (!check.ok) return bad(check.error!, 409);

  const allocatedAmount = await resolveAllocatedAmount(user.id, {
    sourceType: 'investment',
    linkedInvestmentId: id,
    allocationPercentage: parsed.data.allocation_percentage,
    allocatedAmount: parsed.data.allocated_amount ?? 0,
  });

  const { data, error } = await supabase
    .from('goal_funding_sources')
    .insert({
      goal_id: parsed.data.goal_id,
      user_id: user.id,
      source_type: 'investment',
      linked_investment_id: id,
      allocated_amount: allocatedAmount,
      allocation_percentage: parsed.data.allocation_percentage ?? null,
      currency_code: investment.currency_code as string,
      is_active: true,
    })
    .select('id, goal_id, allocated_amount, allocation_percentage')
    .single();
  return error ? bad(error.message) : ok(data);
}
