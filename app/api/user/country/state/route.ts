// GET /api/user/country/state — the ONE endpoint the compulsory
// confirmation screen (app/(onboarding)/confirm-country) uses to know what
// to render. Deliberately uses requireUser() (auth-only, NOT
// requireCountryConfirmedUser()) — spec section 1.2 explicitly requires
// "any narrowly required endpoint used to save and validate the country
// selection" to remain reachable for a user who has not yet confirmed a
// country; gating this endpoint on country confirmation would make it
// impossible to ever confirm in the first place.
import { requireUser, ok } from '@/lib/api';
import { assertCountryConfirmedForUser, COUNTRY_GATE_ERROR_CODE } from '@/lib/services/countryGate';
import { COUNTRY_OPTIONS } from '@/lib/constants';
import { createClient } from '@/lib/supabase/server';

export async function GET() {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const supabase = await createClient();
  const gate = await assertCountryConfirmedForUser(supabase, user.id);

  return ok({
    state: gate.state,
    code: gate.state === 'CONFIRMED' ? null : COUNTRY_GATE_ERROR_CODE[gate.state],
    countryOfResidence: gate.countryOfResidence,
    countryConfirmedAt: gate.countryConfirmedAt,
    countrySource: gate.countrySource,
    onboardingCompleted: gate.onboardingCompleted,
    supportedCountries: COUNTRY_OPTIONS,
  });
}
