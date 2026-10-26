import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';
import { createClient } from '@/lib/supabase/server';
import { resolveEntityScope } from '@/lib/services/entityCashFlowData';

// What changed on this entity: how it was recorded (itemised or net value only) and every change to its lines, income and expenses.
// Read only, owner only (row level security), an entity of another household answers 404.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const supabase = await createClient();
  if (!(await resolveEntityScope('business', id, user.id, supabase))) return bad('Not found', 404);
  const [modes, changes] = await Promise.all([
    supabase.from('entity_figure_mode_log').select('id, action, from_mode, to_mode, net_before, net_after, variance, created_at').eq('entity_id', id).eq('user_id', user.id).order('created_at', { ascending: false }),
    supabase.from('entity_change_log').select('id, table_name, row_id, action, created_at').eq('entity_id', id).eq('user_id', user.id).order('created_at', { ascending: false }).limit(200),
  ]);
  if (modes.error) return bad(modes.error.message);
  if (changes.error) return bad(changes.error.message);
  return ok({ modes: modes.data ?? [], changes: changes.data ?? [] });
}
