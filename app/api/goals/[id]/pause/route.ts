import { createClient } from '@/lib/supabase/server';
import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';

// LR-7 WP-05/WP-08 — state-transition guard, previously absent: this route
// would flip ANY goal to 'paused' regardless of its current status (an
// already-archived or already-achieved goal included). Pause is only a
// meaningful action on a goal that is currently active.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const body = await req.json().catch(() => ({}));
  const supabase = await createClient();

  const { data: existing, error: findError } = await supabase.from('user_goals').select('status').eq('id', id).eq('user_id', user.id).maybeSingle();
  if (findError) return bad(findError.message);
  if (!existing) return bad('Goal not found', 404);
  if (existing.status !== 'active') {
    return bad(`Only an active goal can be paused (this goal is currently "${existing.status}").`, 409);
  }

  const { data, error } = await supabase
    .from('user_goals')
    .update({
      status: 'paused',
      paused_at: new Date().toISOString(),
      reason_for_status_change: body?.reason ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('user_id', user.id)
    .select()
    .single();
  return error ? bad(error.message) : ok(data);
}
