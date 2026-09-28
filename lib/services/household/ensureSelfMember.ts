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
  if (error || !created) return { memberId: null, error: error?.message ?? 'Could not record you as a household member.' };
  return { memberId: created.id as string, error: null };
}
