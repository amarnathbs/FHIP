import { createClient } from '@/lib/supabase/server';
import { requireUser, ok, bad } from '@/lib/api';
import { goalMilestoneSchema } from '@/lib/validation/goalMilestone';

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string; milestoneId: string }> }) {
  const { milestoneId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const body = await req.json();
  const parsed = goalMilestoneSchema.partial().safeParse(body);
  if (!parsed.success) return bad(parsed.error.message, 422);
  const supabase = await createClient();
  const patch: Record<string, unknown> = { ...parsed.data };
  if (body.status === 'achieved') {
    patch.status = 'achieved';
    patch.achieved_at = new Date().toISOString();
  } else if (body.status) {
    patch.status = body.status;
  }
  const { data, error } = await supabase
    .from('goal_milestones')
    .update(patch)
    .eq('id', milestoneId)
    .eq('user_id', user.id)
    .select()
    .single();
  return error ? bad(error.message) : ok(data);
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string; milestoneId: string }> }) {
  const { milestoneId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const supabase = await createClient();
  const { error } = await supabase.from('goal_milestones').delete().eq('id', milestoneId).eq('user_id', user.id);
  return error ? bad(error.message) : ok({ deleted: true });
}
