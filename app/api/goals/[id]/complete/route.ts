import { createClient } from '@/lib/supabase/server';
import { requireUser, ok, bad } from '@/lib/api';

// Achievement is always a user-confirmed action — a goal is never
// auto-marked achieved just because a linked balance temporarily exceeds
// the target (Rule 9).
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const body = await req.json().catch(() => ({}));
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('user_goals')
    .update({
      status: body?.partial ? 'partially_achieved' : 'achieved',
      achieved_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('user_id', user.id)
    .select()
    .single();
  return error ? bad(error.message) : ok(data);
}
