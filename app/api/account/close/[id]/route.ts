import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';
import { createClient } from '@/lib/supabase/server';

// LR-9 WP-07 — a user may cancel their OWN request only while it is still
// pending; RLS's own "user cancel own pending deletion request" policy
// (migration 0132) is the real enforcement — this route's .eq('status',
// 'pending') filter is a matching, defense-in-depth check that also lets
// this route return a clear 409 instead of a silent zero-row update.
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const supabase = await createClient();

  const { data, error } = await supabase
    .from('account_deletion_requests')
    .update({ status: 'cancelled', cancelled_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('user_id', user.id)
    .eq('status', 'pending')
    .select()
    .maybeSingle();
  if (error) return bad(error.message);
  if (!data) return bad('This request no longer exists or is not pending — it may already be cancelled or processing.', 409);
  return ok(data);
}
