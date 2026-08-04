import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { bad } from '@/lib/api';
import type { User } from '@supabase/supabase-js';

// Admin routes use the service-role client for writes (bypassing RLS on the
// reference tables), but only after confirming the caller is a real admin —
// admin_users itself is RLS-scoped so a user can only ever read their OWN
// flag, never grant it to themselves (spec section 20/26: no benchmark
// governance action without a real, auditable admin).
export async function requireAdmin(): Promise<{ user: User | null; forbidden: Response | null }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { user: null, forbidden: bad('unauthenticated', 401) };

  const { data: adminRow } = await supabase.from('admin_users').select('user_id').eq('user_id', user.id).maybeSingle();
  if (!adminRow) return { user: null, forbidden: bad('Admin access required', 403) };
  return { user, forbidden: null };
}

export function adminClient() {
  return createAdminClient();
}
