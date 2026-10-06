/**
 * Every household has an implicit "self" member — the signed-up user
 * themselves — and a user should never have to take an extra onboarding step
 * just to make that record exist before their own uploaded data can be
 * attributed to them. `lib/investment-import-bridge/auAccountResolution.ts`'s
 * `resolveAuAccountOwnerMember` already established this lazy-create-on-
 * first-need pattern for AU investment accounts; this is that same logic,
 * extracted so every module that needs a `household_members` row for "the
 * user themselves" shares one implementation rather than drifting into two.
 *
 * WHY LAZY, NOT AT SIGNUP. `households`/`household_members` both sit behind
 * `trg_enforce_country_confirmed` (migration 0105), which is bypassed for
 * `service_role` connections but not for a brand-new `auth.users` row being
 * created by GoTrue before any country has ever been confirmed — inserting
 * here from the `on_auth_user_created` trigger would make every new signup
 * fail closed. Calling this from an already-service-role, already-
 * authenticated pipeline (AU or Investment Intelligence resolution, both
 * well after signup) sidesteps that entirely, the same way the AU path
 * already does safely in production.
 *
 * WHY THIS DOES NOT WEAKEN K.4 (Investment Intelligence's owner-name
 * matching, `ownerMatching.ts`). This only guarantees a "self" candidate
 * EXISTS; it never assigns a document to it. Whether an extracted holder
 * name actually matches this member's name is still decided entirely by
 * `matchStatementOwner`'s exact, deterministic comparison — a document
 * printing someone else's name still correctly falls to `mismatch`, not an
 * auto-assignment, even after this member is created.
 */

import { createAdminClient } from '@/lib/supabase/admin';
import { isDuplicateSelfMemberError } from './selfMemberUnique';

export async function ensureSelfHouseholdMember(userId: string): Promise<{ memberId: string | null; error: string | null }> {
  const admin = createAdminClient();
  const { data: existing } = await admin
    .from('household_members')
    .select('id')
    .eq('user_id', userId)
    .eq('relationship', 'self')
    .eq('is_active', true)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (existing) return { memberId: existing.id as string, error: null };

  const { data: profile } = await admin.from('user_profiles').select('full_name').eq('user_id', userId).maybeSingle();
  const fullName = ((profile?.full_name as string | null) ?? '').trim() || 'Me';
  const { data: created, error } = await admin
    .from('household_members')
    .insert({ user_id: userId, full_name: fullName, relationship: 'self' })
    .select('id')
    .single();
  if (isDuplicateSelfMemberError(error)) {
    // Migration 0276: a caller racing us won. That is not an error: re-read and return the row that exists.
    const { data: winner } = await admin
      .from('household_members')
      .select('id')
      .eq('user_id', userId)
      .eq('relationship', 'self')
      .eq('is_active', true)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    return winner ? { memberId: winner.id as string, error: null } : { memberId: null, error: 'Could not record you as a household member.' };
  }
  if (error || !created) return { memberId: null, error: error?.message ?? 'Could not record you as a household member.' };
  // Databases without 0276 have no unique index: settle on the oldest row instead.
  return { memberId: await settleOnOldestSelf(userId, created.id as string), error: null };
}

/**
 * Concurrency guard (DEV browser finding, 07-10-2026): "look for a self member, else insert one" lets two callers that start together
 * each insert one (two rows 67 ms apart were seen, and the owner selector then listed the user twice). After inserting, the call
 * re-reads the user's active self members: the OLDEST one (earliest created_at, then id) is the one that stays. If this call's own
 * row is not the oldest it removes ONLY that row (it was created a moment ago and nothing can reference it yet) and returns the
 * oldest id. A second look after a short pause catches an older row that was not yet visible to the first look.
 * A unique index on (user_id) for active self members would close this completely; that is a schema change and is left to the PO.
 */
async function settleOnOldestSelf(userId: string, ownId: string): Promise<string> {
  const admin = createAdminClient();
  for (let pass = 0; pass < 2; pass++) {
    const { data } = await admin.from('household_members').select('id, created_at').eq('user_id', userId).eq('relationship', 'self').eq('is_active', true);
    const sorted = [...((data ?? []) as Array<{ id: string; created_at: string }>)].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
    const oldest = sorted[0]?.id;
    if (oldest && oldest !== ownId) {
      await admin.from('household_members').delete().eq('id', ownId).eq('user_id', userId);
      return oldest;
    }
    if (pass === 0) await new Promise((r) => setTimeout(r, 150));
  }
  return ownId;
}
