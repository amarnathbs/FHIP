// PC6 (M6) — the capability guard for the reference-market-data quality
// surface (N.11).
//
// ADMIN ARCHITECTURE STANDARD §2. A new admin surface may NOT be gated on
// bare requireAdmin(), which only proves "this user has SOME admin access" —
// the Standard explicitly prohibits a coarse flag as the sole basis for a new
// capability. This is a separately-NAMED capability backed by its own column,
// admin_users.can_view_reference_data_quality (migration 0155), checked by a
// fresh read on every call.
//
// Follows the LR-9 precedent in lib/services/accountDeletionAdmin.ts exactly,
// including its API/page split, rather than inventing a second pattern.
//
// §4 — NAVIGATION IS NOT AUTHORISATION. This module is layers 2 and 3 (API and
// page). Layer 1 (database) is migration 0155's is_pc6_reference_data_admin()
// predicate, which backs the RLS policy on every PC6 operational table, so a
// direct PostgREST request from a browser session that skips this code is
// refused by Postgres itself. Layer 4 (navigation) is lib/admin/adminNav.ts.

import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { bad } from '@/lib/api';
import { countryConfirmationBlockResponse } from '@/lib/services/countryGate';
import type { User } from '@supabase/supabase-js';

export const PC6_ADMIN_CAPABILITY = 'can_view_reference_data_quality' as const;

/** API-layer guard. Returns a Response to send, or null when authorised. */
export async function requireReferenceDataAdmin(): Promise<{ user: User | null; forbidden: Response | null }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { user: null, forbidden: bad('unauthenticated', 401) };

  const { data: adminRow } = await supabase
    .from('admin_users')
    .select(PC6_ADMIN_CAPABILITY)
    .eq('user_id', user.id)
    .maybeSingle();
  if (!adminRow?.[PC6_ADMIN_CAPABILITY]) {
    // §4: deny with an explicit 403, never a 200 carrying an empty list — a
    // zero-row response is indistinguishable from "the feed is healthy".
    return { user: null, forbidden: bad('Reference-data admin access required', 403) };
  }

  // The same country-confirmation gate every other admin route applies. No
  // exemption for this capability either.
  const countryBlock = await countryConfirmationBlockResponse(supabase, user.id);
  if (countryBlock) return { user: null, forbidden: countryBlock };

  return { user, forbidden: null };
}

/** Page-layer guard (§4 layer 3): a disallowed direct navigation is redirected. */
export async function requireReferenceDataAdminPage(): Promise<User> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: adminRow } = await supabase
    .from('admin_users')
    .select(PC6_ADMIN_CAPABILITY)
    .eq('user_id', user.id)
    .maybeSingle();
  if (!adminRow?.[PC6_ADMIN_CAPABILITY]) redirect('/dashboard');

  return user;
}
