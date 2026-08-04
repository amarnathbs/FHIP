import { createClient } from '@/lib/supabase/server';
import { ok } from '@/lib/api';

// Lets the nav know whether to show the Admin link, without exposing any
// admin data itself — a logged-out or non-admin caller just gets false,
// never a 403 (the actual admin routes still enforce requireAdmin()).
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return ok({ isAdmin: false });

  const { data } = await supabase.from('admin_users').select('user_id').eq('user_id', user.id).maybeSingle();
  return ok({ isAdmin: Boolean(data) });
}
