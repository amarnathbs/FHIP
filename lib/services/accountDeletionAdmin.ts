import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { bad } from '@/lib/api';
import { countryConfirmationBlockResponse } from '@/lib/services/countryGate';
import type { User } from '@supabase/supabase-js';

// LR-9 WP-08 — a separately-named, separately-tested capability (Admin
// Architecture Standard §2), deliberately NOT an alias of requireAdmin().
// requireAdmin() only proves "this user has SOME admin access" (a coarse
// flag the Standard explicitly prohibits as the sole basis for a NEW
// capability) — this additionally requires
// admin_users.can_manage_account_deletions = true (migration 0132),
// checked via a fresh read, not cached, on every call.
export async function requireAccountDeletionAdmin(): Promise<{ user: User | null; forbidden: Response | null }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { user: null, forbidden: bad('unauthenticated', 401) };

  const { data: adminRow } = await supabase
    .from('admin_users')
    .select('can_manage_account_deletions')
    .eq('user_id', user.id)
    .maybeSingle();
  if (!adminRow?.can_manage_account_deletions) {
    return { user: null, forbidden: bad('Account-deletion admin access required', 403) };
  }

  // Same country-confirmation gate every other admin route applies
  // (adminAuth.ts's requireAdmin() — see its own header comment) — no
  // exemption for this capability either.
  const countryBlock = await countryConfirmationBlockResponse(supabase, user.id);
  if (countryBlock) return { user: null, forbidden: countryBlock };

  return { user, forbidden: null };
}

// Admin Architecture Standard §4 layer 3 ("Route/page layer — a disallowed
// direct navigation is redirected or rejected, not silently rendered
// empty") — the page-layer counterpart to requireAccountDeletionAdmin()
// above, matching lib/resources/admin/access.ts's requireResourceAdminAccess()
// own redirect-based precedent rather than returning a Response a server
// component can't use directly.
export async function requireAccountDeletionAdminPage(): Promise<User> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: adminRow } = await supabase
    .from('admin_users')
    .select('can_manage_account_deletions')
    .eq('user_id', user.id)
    .maybeSingle();
  if (!adminRow?.can_manage_account_deletions) redirect('/dashboard');

  return user;
}
