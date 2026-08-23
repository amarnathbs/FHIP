import { createClient } from '@/lib/supabase/server';
import { requireUser, ok, bad } from '@/lib/api';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const supabase = await createClient();
  const { data, error } = await supabase.from('ii_review_items').select('*').eq('id', id).eq('user_id', user.id).maybeSingle();
  if (error) return bad(error.message);
  if (!data) return bad('Review item not found', 404);
  return ok(data);
}
