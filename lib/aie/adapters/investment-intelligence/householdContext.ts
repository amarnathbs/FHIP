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
import { getUserHomeCountry } from '@/lib/services/jurisdiction';

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
