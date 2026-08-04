import { createClient } from '@/lib/supabase/server';
import { ok, bad } from '@/lib/api';

export async function POST() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return bad('unauthenticated', 401);

  const { error } = await supabase
    .from('user_profiles')
    .update({ onboarding_completed: true })
    .eq('user_id', user.id);
  return error ? bad(error.message) : ok({ onboarding_completed: true });
}
