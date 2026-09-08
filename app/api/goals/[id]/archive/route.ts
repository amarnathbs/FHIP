import { createClient } from '@/lib/supabase/server';
import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';

// LR-7 WP-05/WP-06 — Archive is the normal, broadly-available lifecycle
// action (spec's own Product Owner lock), so this deliberately does not
// restrict WHICH prior status may be archived — only guards against a
// meaningless double-archive, which would otherwise silently overwrite an
// earlier archived_at timestamp on every repeat call.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const supabase = await createClient();

  const { data: existing, error: findError } = await supabase.from('user_goals').select('status').eq('id', id).eq('user_id', user.id).maybeSingle();
  if (findError) return bad(findError.message);
  if (!existing) return bad('Goal not found', 404);
  if (existing.status === 'archived') return bad('This goal is already archived.', 409);

  const { data, error } = await supabase
    .from('user_goals')
    .update({ status: 'archived', archived_at: new Date().toISOString() })
    .eq('id', id)
    .eq('user_id', user.id)
    .select()
    .single();
  return error ? bad(error.message) : ok(data);
}
