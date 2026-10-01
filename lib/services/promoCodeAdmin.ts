import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { bad } from '@/lib/api';
import { countryConfirmationBlockResponse } from '@/lib/services/countryGate';
import type { User } from '@supabase/supabase-js';

// Promo codes — the capability guard for creating, listing and disabling promo
// codes and reading their audit trail.
//
// ADMIN ARCHITECTURE STANDARD §2/§3. A separately NAMED capability backed by its
// own column, admin_users.can_manage_promo_codes (migration 0237), read fresh on
// every call. It is NOT requireAdmin(), NOT implied by Super Admin, and NOT the
// same capability as can_manage_premium_entitlements: deciding which codes exist
// is a different duty from granting an individual user Premium, so holding one
// must never confer the other (each has its own test).
//
// §4: this module is layers 2 (API) and 3 (page). Layer 1 is the database: every
// promo function re-checks is_promo_code_admin() on auth.uid(), and the promo
// tables' RLS only admits promo-code admins. Layer 4 is lib/admin/adminNav.ts.

export const PROMO_CODE_ADMIN_CAPABILITY = 'can_manage_promo_codes' as const;

export async function requirePromoCodeAdmin(): Promise<{ user: User | null; forbidden: Response | null }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { user: null, forbidden: bad('unauthenticated', 401) };

  const { data: adminRow, error } = await supabase
    .from('admin_users')
    .select(PROMO_CODE_ADMIN_CAPABILITY)
    .eq('user_id', user.id)
    .maybeSingle();
  // §13 fail closed: a read error (including a missing column before the migration) is a denial.
  if (error || !adminRow?.[PROMO_CODE_ADMIN_CAPABILITY]) {
    return { user: null, forbidden: bad('Promo code admin access required', 403) };
  }

  const countryBlock = await countryConfirmationBlockResponse(supabase, user.id);
  if (countryBlock) return { user: null, forbidden: countryBlock };

  return { user, forbidden: null };
}

export async function requirePromoCodeAdminPage(): Promise<User> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: adminRow, error } = await supabase
    .from('admin_users')
    .select(PROMO_CODE_ADMIN_CAPABILITY)
    .eq('user_id', user.id)
    .maybeSingle();
  if (error || !adminRow?.[PROMO_CODE_ADMIN_CAPABILITY]) redirect('/dashboard');

  return user;
}
