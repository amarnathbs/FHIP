import { createClient } from '@/lib/supabase/server';
import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';
import { goalMilestoneSchema } from '@/lib/validation/goalMilestone';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('goal_milestones')
    .select('*')
    .eq('goal_id', id)
    .eq('user_id', user.id)
    .order('display_order');
  return error ? bad(error.message) : ok(data);
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const parsed = goalMilestoneSchema.safeParse(await req.json());
  if (!parsed.success) return bad(parsed.error.message, 422);
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('goal_milestones')
    .insert({ ...parsed.data, goal_id: id, user_id: user.id })
    .select()
    .single();
  return error ? bad(error.message) : ok(data);
}
