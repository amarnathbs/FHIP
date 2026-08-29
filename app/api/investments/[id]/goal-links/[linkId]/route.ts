import { createClient } from '@/lib/supabase/server';
import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';

// Unlink (spec s.28: soft-deactivate, never delete the Investment or the
// Goal; $0 Net Worth movement). Matches the existing Goals-side DELETE
// /api/goals/[id]/funding-sources/[sourceId] route's semantics exactly —
// same table, same is_active=false soft-remove, same user_id scoping.
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string; linkId: string }> }) {
  const { id, linkId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const supabase = await createClient();
  const { error } = await supabase
    .from('goal_funding_sources')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('id', linkId)
    .eq('linked_investment_id', id)
    .eq('user_id', user.id);
  return error ? bad(error.message) : ok({ archived: true });
}
