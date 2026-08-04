import { createClient } from '@/lib/supabase/server';
import { householdSchema } from '@/lib/validation/household';
import { ok, bad } from '@/lib/api';

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return bad('unauthenticated', 401);

  const { data, error } = await supabase.from('households').select('*').eq('user_id', user.id).maybeSingle();
  return error ? bad(error.message) : ok(data);
}

export async function PUT(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return bad('unauthenticated', 401);

  const parsed = householdSchema.partial().safeParse(await req.json());
  if (!parsed.success) return bad(parsed.error.message, 422);

  const { data: existing } = await supabase.from('households').select('id').eq('user_id', user.id).maybeSingle();

  const query = existing
    ? supabase
        .from('households')
        .update({ ...parsed.data, updated_at: new Date().toISOString() })
        .eq('id', existing.id)
    : supabase.from('households').insert({ ...parsed.data, user_id: user.id });

  const { data, error } = await query.select().single();
  return error ? bad(error.message) : ok(data);
}
