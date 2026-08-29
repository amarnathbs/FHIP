import { createClient } from '@/lib/supabase/server';
import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';

// Reversal, not deletion: contribution history is never overwritten. A
// reversal is a new opposite-signed row referencing the original, and the
// goal's current_amount is adjusted back by the same amount.
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string; contributionId: string }> }) {
  const { id, contributionId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const supabase = await createClient();

  const { data: original, error: fetchError } = await supabase
    .from('goal_contributions')
    .select('*')
    .eq('id', contributionId)
    .eq('goal_id', id)
    .eq('user_id', user.id)
    .single();
  if (fetchError || !original) return bad(fetchError?.message ?? 'Contribution not found', 404);
  if (original.contribution_status === 'reversed') return bad('Contribution already reversed', 409);

  const { data: goal, error: goalError } = await supabase
    .from('user_goals')
    .select('current_amount')
    .eq('id', id)
    .eq('user_id', user.id)
    .single();
  if (goalError || !goal) return bad(goalError?.message ?? 'Goal not found', 404);

  const { data: reversal, error: reversalError } = await supabase
    .from('goal_contributions')
    .insert({
      goal_id: id,
      user_id: user.id,
      contribution_date: new Date().toISOString().slice(0, 10),
      amount: -original.amount,
      currency_code: original.currency_code,
      contribution_type: 'adjustment',
      contribution_status: 'confirmed',
      reversal_of_id: original.id,
      notes: `Reversal of contribution ${original.id}`,
    })
    .select()
    .single();
  if (reversalError) return bad(reversalError.message);

  await supabase.from('goal_contributions').update({ contribution_status: 'reversed' }).eq('id', original.id);

  if (original.contribution_status === 'confirmed') {
    const originalSigned = original.contribution_type === 'withdrawal' ? -Math.abs(original.amount) : Math.abs(original.amount);
    const newCurrentAmount = Math.max(0, Number(goal.current_amount ?? 0) - originalSigned);
    await supabase.from('user_goals').update({ current_amount: newCurrentAmount }).eq('id', id).eq('user_id', user.id);
  }

  return ok(reversal);
}
