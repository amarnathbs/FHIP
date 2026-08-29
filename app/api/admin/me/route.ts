import { createClient } from '@/lib/supabase/server';
import { ok } from '@/lib/api';

// Lets the nav know whether to show the Admin link (and, since the R1.2
// Resources shell, the Resources nav group too), without exposing any admin
// data itself — a logged-out, non-admin, non-Resources-role caller just gets
// both flags false, never a 403 (the actual admin/Resources routes still
// enforce their own server-side checks — this is UX-only gating per spec
// §90: "Navigation hiding is only UX", RLS remains the real boundary).
//
// Mandatory Country Confirmation, round-2 closure (MCC-2): deliberately the
// ONE admin API route NOT wired to countryConfirmationBlockResponse. Its own
// documented contract is "never a 403" — it always returns a safe boolean
// pair, even for a logged-out caller — and blocking it would both violate
// that contract and be moot in practice: a country-unconfirmed user is
// already redirected away from every app/(app)/** page (including the ones
// that would call this) by app/(app)/layout.tsx before this endpoint could
// ever be reached from the real UI. Every route this endpoint's flags are
// used to decide whether to *link to* is itself independently gated (the 54
// other admin routes, closed this round; the admin pages, closed in round
// 1) — so a forged/unconfirmed caller of this specific endpoint learns
// nothing exploitable, only whether admin_users/resource_user_roles rows
// exist for their own id, which they could already read directly under RLS.
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
