import { createClient } from '@/lib/supabase/server';
import { bad } from '@/lib/api';
import type { User } from '@supabase/supabase-js';

// Exceptional override of the Premium grant limits (hardening 0264, item 3) — the capability guard.
//
// ADMIN ARCHITECTURE STANDARD §2/§3. A separately NAMED capability backed by its own column,
// admin_users.can_override_entitlement_limits, read fresh on every call. It is NOT implied by Super Admin,
// by admin_users membership, by can_manage_premium_entitlements or by can_manage_promo_codes. The override
// is only ever used TOGETHER with can_manage_premium_entitlements (the ordinary guard runs first in the
// route), so this guard checks that the same row also holds the override flag. The database function
// admin_manage_premium_entitlement re-checks both (is_premium_entitlement_admin() and
// is_entitlement_override_admin()), so a caller who reaches the RPC directly is still refused (§4 layer 1).

export const ENTITLEMENT_OVERRIDE_CAPABILITY = 'can_override_entitlement_limits' as const;

/** API-layer guard for an override request. Fails closed on a read error, including a missing column. */
export async function requireEntitlementOverrideAdmin(): Promise<{ user: User | null; forbidden: Response | null }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { user: null, forbidden: bad('unauthenticated', 401) };
  const { data: adminRow, error } = await supabase
    .from('admin_users')
    .select(`can_manage_premium_entitlements, ${ENTITLEMENT_OVERRIDE_CAPABILITY}`)
    .eq('user_id', user.id)
    .maybeSingle();
  const row = adminRow as Record<string, unknown> | null;
  if (error || row?.can_manage_premium_entitlements !== true || row?.[ENTITLEMENT_OVERRIDE_CAPABILITY] !== true) {
    return { user: null, forbidden: bad('Overriding the grant limits needs a separate capability that your account does not hold.', 403, 'ENTITLEMENT_OVERRIDE_NOT_ALLOWED') };
  }
  return { user, forbidden: null };
}
