import { createClient } from '@/lib/supabase/server';
import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';
import { checkInsSchema } from '@/lib/validation/checkIns';

export async function GET() {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const supabase = await createClient();
  const { data, error } = await supabase.from('health_check_ins').select('*').eq('user_id', user.id).maybeSingle();
  return error ? bad(error.message) : ok(data);
}

export async function PUT(req: Request) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const parsed = checkInsSchema.safeParse(await req.json());
  if (!parsed.success) return bad(parsed.error.message, 422);
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('health_check_ins')
    .upsert(
      { ...parsed.data, user_id: user.id, updated_at: new Date().toISOString() },
      { onConflict: 'user_id' }
    )
    .select()
    .single();
  return error ? bad(error.message) : ok(data);
}
