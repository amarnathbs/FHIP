import { createClient } from '@/lib/supabase/server';
import { requireUser, ok, bad } from '@/lib/api';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const body = await req.json().catch(() => ({}));
  const supabase = await createClient();
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
