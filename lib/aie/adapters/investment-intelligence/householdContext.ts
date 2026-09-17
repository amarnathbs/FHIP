/**
 * M3 (Phase 4) — resolving the owner's jurisdiction for an Investment
 * Intelligence dispatch, and the reason it is not read off the document.
 *
 * `countryCode` matters twice in this pipeline: it is an input to instrument
 * resolution (`resolveScheme` compares a scheme's country of domicile), and
 * it is what the adapter's canonical-conflict rule derives an expected
 * currency from (`countryCode === 'IN' ? 'INR' : 'AUD'`, reused verbatim
 * from `documentProcessing.ts` rather than re-derived differently).
 *
 * WHY THIS IS NOT INFERRED FROM THE STATEMENT. A CAMS statement is an Indian
 * document, so "detect IN from the parser that claimed it" looks obvious and
 * would work for every fixture. It is still wrong: global invariant D.4
 * forbids the AI inventing a currency or FX, and the same discipline has to
 * apply to deterministic inference, or the rule is about the mechanism
 * rather than the risk. A user resident in AU can legitimately hold an
 * Indian folio, and deriving jurisdiction from the document's origin would
 * silently mislabel that holding's currency and country — a cross-border
 * error that would surface much later, in net-worth aggregation, far from
 * its cause.
 *
 * So jurisdiction comes from the AUTHENTICATED PROFILE, via the same
 * `getUserHomeCountry` every other jurisdiction-sensitive surface uses, and
 * it FAILS CLOSED: that function deliberately does not default to 'AU', and
 * neither does this one. An unresolved home country raises rather than
 * guessing, and the route turns that into a refusal the user can act on
 * (complete onboarding) instead of an import that is quietly wrong.
 */

import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getUserHomeCountry } from '@/lib/services/jurisdiction';
import type { Pc5HouseholdMemberForMatching } from './ownerMatching';

export class UnresolvedHouseholdCountryError extends Error {
  constructor() {
    super('The signed-in user has no resolved home country, so an investment document cannot be attributed to a jurisdiction.');
    this.name = 'UnresolvedHouseholdCountryError';
  }
}

export async function resolveHouseholdCountryForUser(userId: string): Promise<string> {
  const supabase = await createClient();
  const country = await getUserHomeCountry(userId, supabase);
  if (!country) throw new UnresolvedHouseholdCountryError();
  return country;
}

/**
 * PC5 (M4) — K.4. The household members an extracted holder name is
 * compared against.
 *
 * TENANT SCOPING IS IN THE QUERY, not in the caller: `.eq('user_id',
 * userId)` is the same discipline every other loader in this adapter
 * applies (`context.ts`'s header states it explicitly). Using the
 * service-role client rather than the request's RLS client matches how the
 * rest of the AIE pipeline reads — the pipeline runs work on the user's
 * behalf across several awaits and must not depend on a request cookie
 * still being in scope — and the explicit filter is what actually enforces
 * isolation either way.
 *
 * INACTIVE MEMBERS ARE LOADED, NOT FILTERED OUT HERE. `matchStatementOwner`
 * does its own `isActive` filtering, and it needs to be the one place that
 * decides: an inactive member is excluded from MATCHING (you should not be
 * able to file a new statement against someone marked inactive) but their
 * existence still matters for telling "this name is unknown to this
 * household" apart from "this name belongs to a member you deactivated" —
 * a distinction a caller can only draw if it can see them.
 */
export async function loadHouseholdMembersForMatching(userId: string): Promise<Pc5HouseholdMemberForMatching[]> {
  const admin = createAdminClient();
  const { data } = await admin
    .from('household_members')
    .select('id, full_name, relationship, is_active')
    .eq('user_id', userId)
    .order('created_at', { ascending: true });
  return (data ?? []).map((r) => ({
    id: r.id as string,
    fullName: (r.full_name as string) ?? '',
    relationship: (r.relationship as string) ?? 'other',
    isActive: r.is_active !== false,
  }));
}

/**
 * The owner evidence for a whole parsed document, collapsed to one record.
 *
 * WHY ONE RECORD AND NOT ONE PER ACCOUNT BLOCK. A CAMS consolidated
 * statement is issued to ONE investor and prints the same holder across
 * every folio block; a per-block comparison would raise N identical
 * mismatch items for one problem, which is exactly the divergent counting
 * K.3 forbids and K.16 would then have to hide again. So the evidence is
 * collapsed by taking the first block that actually names a holder, and
 * unioning the joint-holder names across blocks. If a future statement
 * format genuinely carries different holders per block, this collapses to
 * the first — which is a KNOWN limitation recorded here rather than a
 * silent one, and it fails in the safe direction: a differing later block
 * still cannot be published without its own account resolution.
 */
export function collapseOwnerEvidence(
  accounts: readonly { holderName: string | null; jointHolders: string[]; holdingModeRaw: string | null }[],
): { holderName: string | null; jointHolders: string[]; holdingModeRaw: string | null } {
  const named = accounts.find((a) => (a.holderName ?? '').trim().length > 0);
  const jointHolders = [...new Set(accounts.flatMap((a) => a.jointHolders).filter((j) => j.trim().length > 0))];
  return {
    holderName: named?.holderName ?? null,
    jointHolders,
    holdingModeRaw: named?.holdingModeRaw ?? accounts.find((a) => a.holdingModeRaw)?.holdingModeRaw ?? null,
  };
}
