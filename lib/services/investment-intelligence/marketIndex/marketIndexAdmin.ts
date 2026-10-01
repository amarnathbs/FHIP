// Capability guard for the Market Index Data admin surface (historical Nifty 50
// / BSE Sensex upload, daily-feed status).
//
// ADMIN ARCHITECTURE STANDARD SECTION 2. A separately-NAMED capability backed by
// its own column, admin_users.can_upload_market_index_data (migration 0232),
// read fresh on every call. It is deliberately NOT implied by being an admin,
// by can_view_reference_data_quality (PC6) or by can_view_lookthrough_data_quality
// (PC7): different surface, different grant. Even the PC6 surface that shows
// ingest health does not confer the right to WRITE index data.
//
// SECTION 4 — all four layers, each enforced independently:
//   1. database  : is_market_index_data_admin() + commit_market_index_upload()'s
//                  own auth.uid() check + RLS on ii_market_index_batches (0232)
//   2. API       : requireMarketIndexAdmin()          (this file; 401/403)
//   3. page      : requireMarketIndexAdminPage()      (this file; redirect)
//   4. navigation: lib/admin/adminNav.ts `marketIndexDataUpload`
// Denial is an explicit 401/403 — never a 200 with an empty list.
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { bad } from '@/lib/api';
import { countryConfirmationBlockResponse } from '@/lib/services/countryGate';
import type { User } from '@supabase/supabase-js';

export const MARKET_INDEX_ADMIN_CAPABILITY = 'can_upload_market_index_data' as const;

/** API-layer guard. Returns a Response to send, or null when authorised. */
export async function requireMarketIndexAdmin(): Promise<{ user: User | null; forbidden: Response | null }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { user: null, forbidden: bad('unauthenticated', 401) };

  const { data: adminRow, error } = await supabase.from('admin_users').select(MARKET_INDEX_ADMIN_CAPABILITY).eq('user_id', user.id).maybeSingle();
  // Fail closed (Standard section 13): a read error or a missing column
  // (migration 0232 not applied) is a denial, never a grant.
  if (error || !adminRow || (adminRow as unknown as Record<string, unknown>)[MARKET_INDEX_ADMIN_CAPABILITY] !== true) {
    return { user: null, forbidden: bad('Market index data admin access required', 403) };
  }

  const countryBlock = await countryConfirmationBlockResponse(supabase, user.id);
  if (countryBlock) return { user: null, forbidden: countryBlock };

  return { user, forbidden: null };
}

/** Page-layer guard (section 4 layer 3): a disallowed direct navigation is redirected. */
export async function requireMarketIndexAdminPage(): Promise<User> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: adminRow, error } = await supabase.from('admin_users').select(MARKET_INDEX_ADMIN_CAPABILITY).eq('user_id', user.id).maybeSingle();
  if (error || !adminRow || (adminRow as unknown as Record<string, unknown>)[MARKET_INDEX_ADMIN_CAPABILITY] !== true) redirect('/dashboard');

  return user;
}
