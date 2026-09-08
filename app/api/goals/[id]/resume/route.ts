import { createClient } from '@/lib/supabase/server';
import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';

const RESUMABLE_STATUSES = new Set(['paused', 'on_hold']);

// LR-7 WP-05/WP-08 (NEG-07 "resume duplicates contributions") — state-
// transition guard, previously absent: this route would flip ANY goal back
// to 'active' regardless of its current status. Resume only makes sense
// from a paused/on-hold goal; an archived/achieved/cancelled goal must not
// be silently resurrected by this route. Resume never touches
// current_amount or the contribution ledger, so even a permitted call can
// never duplicate a contribution — only the status/paused_at fields move.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const supabase = await createClient();

  const { data: existing, error: findError } = await supabase.from('user_goals').select('status').eq('id', id).eq('user_id', user.id).maybeSingle();
  if (findError) return bad(findError.message);
  if (!existing) return bad('Goal not found', 404);
  if (!RESUMABLE_STATUSES.has(existing.status)) {
    return bad(`Only a paused goal can be resumed (this goal is currently "${existing.status}").`, 409);
  }

  const { data, error } = await supabase
    .from('user_goals')
    .update({ status: 'active', paused_at: null, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('user_id', user.id)
    .select()
    .single();
  return error ? bad(error.message) : ok(data);
}
