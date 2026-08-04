import { createClient } from '@/lib/supabase/server';
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
  const supabase = await createClient();
  const { error } = await supabase.from('report_exports').delete().eq('id', exportId).eq('requested_by_user_id', user.id);
  return error ? bad(error.message) : ok({ deleted: true });
}
