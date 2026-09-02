import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { createClient } from '@/lib/supabase/server';
import {
  assertCountryConfirmedForUser,
  loadCountryRegistrySnapshot,
  isRegistrationPermitted,
  REGISTRATION_COUNTRY_OPTIONS,
} from '@/lib/services/countryGate';
import { buildCoverageDisclosure, COUNTRY_LABELS } from '@/lib/services/countryDisclosure';
import {
  LANDING_COUNTRY_COOKIE_NAME,
  parseLandingCountryCookie,
} from '@/lib/services/landingCountryContext';
import { ConfirmCountryForm } from './ConfirmCountryForm';

// Mandatory Country Confirmation — the compulsory screen itself. Lives under
// the (onboarding) route group deliberately (same reasoning as
// app/(onboarding)/onboarding: a distraction-free flow with no AppShell
// chrome), NOT under app/(app) — putting it there would mean app/(app)/
// layout.tsx's own redirect-to-here would apply to this page too, an
// infinite redirect loop (spec 5.4: "avoid redirect loops").
//
// Server-rendered classification (never client-guessed) decides what to
// show: a user who is already CONFIRMED is bounced straight to /dashboard
// (defends against someone bookmarking this URL or using browser back after
// confirming); PROFILE_INCOMPLETE/DB_ERROR fall back to /onboarding, since
// this page has nothing meaningful to update without a profile row.
//
// =============================================================================
// G3 — the landing handoff (spec section 6.2)
// =============================================================================
// The G2 landing cookie is httpOnly, so the client CANNOT read it. That is
// why the handoff is resolved here, on the server, and passed down as an
// inert `landingBucket` prop rather than being read by the form.
//
// What the bucket is allowed to do is exactly one thing: decide which option
// the selector starts on. It never confirms anything, never narrows the
// registry, and never reaches the confirm API (which has no cookie access at
// all). Per the spec's own table:
//
//   AU      -> preselect AU              IN      -> preselect IN
//   GLOBAL  -> preselect nothing;        missing -> preselect nothing;
//              show the four actual                 show all six
//              generic countries
//
// A FORGED cookie therefore changes a dropdown's initial value and nothing
// else. It cannot make an unavailable country available (the option list is
// built from the live registry below), and it cannot skip confirmation (the
// user must still choose and submit, and the server re-validates).
export default async function ConfirmCountryPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const gate = await assertCountryConfirmedForUser(supabase, user.id);

  if (gate.state === 'CONFIRMED') {
    redirect(gate.experienceLevel === 'GENERIC' ? '/global-setup' : '/dashboard');
  }
  if (gate.state === 'PROFILE_INCOMPLETE' || gate.state === 'DB_ERROR') redirect('/onboarding');

  const registry = await loadCountryRegistrySnapshot(supabase);

  // The option list is REGISTRY-DERIVED, not a hardcoded list. A country the
  // registry has deactivated, put outside its effective window, made
  // unselectable, or whose REGISTRATION capability is off simply is not
  // offered — so the UI can never present a choice the server would reject.
  const options = REGISTRATION_COUNTRY_OPTIONS.filter((o) =>
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

  const cookieStore = await cookies();
  const landing = parseLandingCountryCookie(cookieStore.get(LANDING_COUNTRY_COOKIE_NAME)?.value ?? null);

  return (
    <ConfirmCountryForm
      initialState={gate.state}
      currentCountry={gate.countryOfResidence}
      options={options}
      landingBucket={landing}
      registryUnavailable={registry === null}
    />
  );
}
