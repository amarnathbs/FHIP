import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';
import { createClient } from '@/lib/supabase/server';

// "Mode history": every change of how this fund is recorded, newest first. Append-only; the owner can read it (row level security).
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('entity_figure_mode_log')
    .select('id, action, from_mode, to_mode, net_before, net_after, variance, created_at, undoes_log_id')
    .eq('entity_kind', 'smsf')
    .eq('entity_id', id)
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(50);
  return error ? bad(error.message) : ok(data);
}
