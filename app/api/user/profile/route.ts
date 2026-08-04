import { createClient } from '@/lib/supabase/server';
import { profileSchema } from '@/lib/validation/profile';
import { ok, bad } from '@/lib/api';

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return bad('unauthenticated', 401);

  const { data, error } = await supabase.from('user_profiles').select('*').eq('user_id', user.id).single();
  return error ? bad(error.message) : ok(data);
}

export async function PUT(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return bad('unauthenticated', 401);

  const parsed = profileSchema.partial().safeParse(await req.json());
  if (!parsed.success) return bad(parsed.error.message, 422);

  const { data, error } = await supabase
    .from('user_profiles')
    .update({ ...parsed.data, updated_at: new Date().toISOString() })
    .eq('user_id', user.id)
    .select()
    .single();
  return error ? bad(error.message) : ok(data);
}
