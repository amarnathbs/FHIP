import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { requireUser, ok, bad } from '@/lib/api';

export async function GET(_req: Request, { params }: { params: Promise<{ exportId: string }> }) {
  const { exportId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const supabase = await createClient();
  const { data, error } = await supabase.from('report_exports').select('*').eq('id', exportId).eq('requested_by_user_id', user.id).single();
  return error || !data ? bad('Export not found', 404) : ok(data);
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ exportId: string }> }) {
  const { exportId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  // II-R10 hardening (migration 0070): report_exports grants the
  // authenticated role SELECT-own only now — confirm ownership on the
  // RLS-scoped read, then delete via the admin client.
  const supabase = await createClient();
  const { data: owned } = await supabase.from('report_exports').select('id').eq('id', exportId).eq('requested_by_user_id', user.id).maybeSingle();
  if (!owned) return bad('Export not found', 404);
  const { error } = await createAdminClient().from('report_exports').delete().eq('id', exportId).eq('requested_by_user_id', user.id);
  return error ? bad(error.message) : ok({ deleted: true });
}
