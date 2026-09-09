import { createClient } from '@/lib/supabase/server';
import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';
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
// moves the goal's current_amount, the manual/confirmed-contribution ledger.
//
// LR-7 (2026-09-08): this comment previously claimed current_amount was "the
// single source of truth the forecast engine reads (funding sources are
// informational/double-counting checks only, not summed on top of this)" --
// that was accurate before the Education/Children Investment -> Goal
// Linkage release, and is stale now. Today, a goal's DISPLAYED progress
// (Goal detail/list page via goalsData.ts, and the household forecast via
// forecastData.ts, both as of this phase) is current_amount PLUS the live
// value of any active investment/asset/retirement-linked funding source
// (computeLiveLinkedFundingValue(), goalFundingAllocation.ts) -- genuinely
// additive by design, not a double-counting check. checkFundingAllocation()
// is the actual double-counting guard, and it only prevents the SAME linked
// balance being over-allocated ACROSS goals; it does not (and cannot)
// detect a user manually re-entering, in current_amount, money that is also
// sitting in a linked account -- see the LR-7 phase report for the
// provenance-honesty UI this drives.
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
