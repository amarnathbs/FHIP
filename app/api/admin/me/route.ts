import { createClient } from '@/lib/supabase/server';
import { ok } from '@/lib/api';

// Lets the nav know whether to show the Admin link (and, since the R1.2
// Resources shell, the Resources nav group too), without exposing any admin
// data itself — a logged-out, non-admin, non-Resources-role caller just gets
// both flags false, never a 403 (the actual admin/Resources routes still
// enforce their own server-side checks — this is UX-only gating per spec
// §90: "Navigation hiding is only UX", RLS remains the real boundary).
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return ok({ isAdmin: false, hasResourcesAccess: false });

  const [{ data: adminRow }, { data: resourceRoleRows }] = await Promise.all([
    supabase.from('admin_users').select('user_id').eq('user_id', user.id).maybeSingle(),
    supabase.from('resource_user_roles').select('role').eq('user_id', user.id).eq('is_active', true).limit(1),
  ]);
  const isAdmin = Boolean(adminRow);
  return ok({ isAdmin, hasResourcesAccess: isAdmin || (resourceRoleRows ?? []).length > 0 });
}
