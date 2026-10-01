import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { bad } from '@/lib/api';
import { countryConfirmationBlockResponse } from '@/lib/services/countryGate';
import type { User } from '@supabase/supabase-js';

// Admin Premium grant (migration 0231) — the capability guard for managing
// admin-allocated Premium.
//
// ADMIN ARCHITECTURE STANDARD §2. This is a separately-NAMED capability backed
// by its own column, admin_users.can_manage_premium_entitlements, checked by a
// fresh read on every call. It is deliberately NOT requireAdmin() (any admin),
// NOT implied by Super Admin (§3), and NOT an alias of any other capability
// (account-deletion, reference-data, look-through): money-affecting entitlement
// changes are a different duty from each of those.
//
// §4 — navigation is not authorisation. This module is layers 2 and 3 (API and
// page). Layer 1 is the database: every RPC behind these routes re-checks
// is_premium_entitlement_admin() on auth.uid() itself, so a caller who somehow
// reached an RPC directly (the database-bypass case) is still refused. Layer 4
// is lib/admin/adminNav.ts.

export const PREMIUM_ENTITLEMENT_ADMIN_CAPABILITY = 'can_manage_premium_entitlements' as const;

/** API-layer guard. Returns a Response to send, or null `forbidden` when authorised. */
export async function requirePremiumEntitlementAdmin(): Promise<{ user: User | null; forbidden: Response | null }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { user: null, forbidden: bad('unauthenticated', 401) };

  const { data: adminRow, error } = await supabase
    .from('admin_users')
    .select(PREMIUM_ENTITLEMENT_ADMIN_CAPABILITY)
    .eq('user_id', user.id)
    .maybeSingle();
  // §13 fail closed: a read error (including a missing column because the
  // migration is not applied yet) is a denial, never a grant.
  if (error || !adminRow?.[PREMIUM_ENTITLEMENT_ADMIN_CAPABILITY]) {
    return { user: null, forbidden: bad('Premium entitlement admin access required', 403) };
  }

  const countryBlock = await countryConfirmationBlockResponse(supabase, user.id);
  if (countryBlock) return { user: null, forbidden: countryBlock };

  return { user, forbidden: null };
}

/** Page-layer guard (§4 layer 3): a disallowed direct navigation is redirected, never rendered empty. */
export async function requirePremiumEntitlementAdminPage(): Promise<User> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: adminRow, error } = await supabase
    .from('admin_users')
    .select(PREMIUM_ENTITLEMENT_ADMIN_CAPABILITY)
    .eq('user_id', user.id)
    .maybeSingle();
  if (error || !adminRow?.[PREMIUM_ENTITLEMENT_ADMIN_CAPABILITY]) redirect('/dashboard');

  return user;
}
