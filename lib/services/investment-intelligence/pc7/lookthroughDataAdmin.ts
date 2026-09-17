// PC7 (M7) — the capability guard for the Underlying Fund Holdings quality
// surface (O.9).
//
// ADMIN ARCHITECTURE STANDARD §2. A new admin surface may NOT be gated on a
// bare requireAdmin(). This is a separately-NAMED capability backed by its own
// column, admin_users.can_view_lookthrough_data_quality (migration 0157),
// checked by a fresh read on every call.
//
// WHY NOT REUSE PC6's can_view_reference_data_quality. It is also a named
// capability, so reusing it would satisfy the letter of §2. It is a different
// SURFACE though: PC6's authorises the NAV / benchmark / risk-free feeds,
// PC7's authorises fund-portfolio constituent data. An operator can
// legitimately be trusted with one and not the other, and a capability that
// silently widens to cover a second surface is how capability creep starts.
//
// §4 — NAVIGATION IS NOT AUTHORISATION. This module is layers 2 and 3 (API and
// page). Layer 1 (database) is migration 0157's is_pc7_lookthrough_data_admin()
// predicate. Follows the LR-9 / PC6 precedent exactly rather than inventing a
// third pattern.

import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { bad } from '@/lib/api';
import { countryConfirmationBlockResponse } from '@/lib/services/countryGate';
import type { User } from '@supabase/supabase-js';

export const PC7_ADMIN_CAPABILITY = 'can_view_lookthrough_data_quality' as const;

/** API-layer guard. Returns a Response to send, or null when authorised. */
export async function requireLookthroughDataAdmin(): Promise<{ user: User | null; forbidden: Response | null }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { user: null, forbidden: bad('unauthenticated', 401) };

  const { data: adminRow } = await supabase
    .from('admin_users')
    .select(PC7_ADMIN_CAPABILITY)
    .eq('user_id', user.id)
    .maybeSingle();
  if (!adminRow?.[PC7_ADMIN_CAPABILITY]) {
    // §4: an explicit 403, never a 200 carrying an empty list — a zero-row
    // response is indistinguishable from "the look-through corpus is healthy".
    return { user: null, forbidden: bad('Look-through data admin access required', 403) };
  }

  const countryBlock = await countryConfirmationBlockResponse(supabase, user.id);
  if (countryBlock) return { user: null, forbidden: countryBlock };

  return { user, forbidden: null };
}

/** Page-layer guard (§4 layer 3). */
export async function requireLookthroughDataAdminPage(): Promise<User> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: adminRow } = await supabase
    .from('admin_users')
    .select(PC7_ADMIN_CAPABILITY)
    .eq('user_id', user.id)
    .maybeSingle();
  if (!adminRow?.[PC7_ADMIN_CAPABILITY]) redirect('/dashboard');

  return user;
}
