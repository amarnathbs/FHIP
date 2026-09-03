// GET /api/user/country/state — the ONE endpoint the compulsory
// confirmation screen (app/(onboarding)/confirm-country) uses to know what
// to render. Deliberately uses requireUser() (auth-only, NOT
// requireCountryConfirmedUser()) — spec section 1.2 explicitly requires
// "any narrowly required endpoint used to save and validate the country
// selection" to remain reachable for a user who has not yet confirmed a
// country; gating this endpoint on country confirmation would make it
// impossible to ever confirm in the first place.
//
// G3: this endpoint now also tells the confirmation screen (a) which
// countries the LIVE REGISTRY currently permits registration for, and (b)
// what each one's experience level is, so the FULL/GENERIC disclosure the
// user reads is generated from the same registry the server will validate
// against. The client is never the source of either fact — it only renders
// what this route computed.
import { requireUser, ok } from '@/lib/api';
import {
  assertCountryConfirmedForUser,
  COUNTRY_GATE_ERROR_CODE,
  REGISTRATION_COUNTRY_OPTIONS,
  loadCountryRegistrySnapshot,
  isRegistrationPermitted,
} from '@/lib/services/countryGate';
import { buildCoverageDisclosure, COUNTRY_LABELS } from '@/lib/services/countryDisclosure';
import { createClient } from '@/lib/supabase/server';

export async function GET() {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const supabase = await createClient();
  const gate = await assertCountryConfirmedForUser(supabase, user.id);
  const registry = await loadCountryRegistrySnapshot(supabase);

  // Registry-derived, in the registry's own terms. A country whose row is
  // inactive, outside its effective window, unselectable, or whose
  // REGISTRATION capability is off simply does not appear — the UI has no
  // list of its own to fall back on, so it cannot offer a country the server
  // would then reject.
  const selectableCountries = REGISTRATION_COUNTRY_OPTIONS.filter((o) =>
    isRegistrationPermitted(registry?.get(o.value))
  ).map((o) => {
    const experienceLevel = registry!.get(o.value)!.experienceLevel;
    return {
      value: o.value,
      label: o.label,
      experienceLevel,
      disclosure: buildCoverageDisclosure(experienceLevel, COUNTRY_LABELS[o.value]),
    };
  });

  return ok({
    state: gate.state,
    code: gate.state === 'CONFIRMED' ? null : COUNTRY_GATE_ERROR_CODE[gate.state],
    countryOfResidence: gate.countryOfResidence,
    countryConfirmedAt: gate.countryConfirmedAt,
    countrySource: gate.countrySource,
    onboardingCompleted: gate.onboardingCompleted,
    experienceLevel: gate.experienceLevel,
    // `registryUnavailable` is surfaced rather than hidden behind an empty
    // list: "no countries are currently offered" and "we could not read the
    // registry" are different truths, and the UI must not present the second
    // as the first (spec section 16: "Loading, error and retry states are
    // truthful").
    registryUnavailable: registry === null,
    supportedCountries: selectableCountries,
  });
}
