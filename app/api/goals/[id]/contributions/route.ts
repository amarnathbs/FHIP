import { createClient } from '@/lib/supabase/server';
import { requireUser, ok, bad } from '@/lib/api';
import { goalContributionSchema } from '@/lib/validation/goalContribution';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('goal_contributions')
    .select('*')
    .eq('goal_id', id)
    .eq('user_id', user.id)
    .order('contribution_date', { ascending: false });
  return error ? bad(error.message) : ok(data);
}

// Contributions are an append-only log; a confirmed (non-planned) entry also
// moves the goal's current_amount, which is the single source of truth the
// forecast engine reads (funding sources are informational/double-counting
// checks only, not summed on top of this).
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const parsed = goalContributionSchema.safeParse(await req.json());
  if (!parsed.success) return bad(parsed.error.message, 422);

  const supabase = await createClient();
  const { data: goal, error: goalError } = await supabase
    .from('user_goals')
    .select('current_amount')
    .eq('id', id)
    .eq('user_id', user.id)
    .single();
  if (goalError || !goal) return bad(goalError?.message ?? 'Goal not found', 404);

  const { data, error } = await supabase
    .from('goal_contributions')
    .insert({ ...parsed.data, goal_id: id, user_id: user.id })
    .select()
    .single();
  if (error) return bad(error.message);

  if (parsed.data.contribution_status === 'confirmed') {
    const signedAmount = parsed.data.contribution_type === 'withdrawal' ? -Math.abs(parsed.data.amount) : Math.abs(parsed.data.amount);
    const newCurrentAmount = Math.max(0, Number(goal.current_amount ?? 0) + signedAmount);
    await supabase.from('user_goals').update({ current_amount: newCurrentAmount }).eq('id', id).eq('user_id', user.id);
  }

  return ok(data);
}
