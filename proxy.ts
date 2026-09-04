import { type NextRequest, NextResponse } from 'next/server';
import { createServerClient, type SetAllCookies } from '@supabase/ssr';
import { loadCountryRegistrySnapshot } from '@/lib/services/countryGate';
import { isG4CapabilityLayerEnabled } from '@/lib/services/appCapabilityFlag';

export async function proxy(request: NextRequest) {
  const response = NextResponse.next();
  const setAll: SetAllCookies = (list) =>
    list.forEach(({ name, value }) => response.cookies.set(name, value));
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll,
      },
    }
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;
  const isOnboardingRoute = pathname.startsWith('/onboarding');
  // Mandatory Country Confirmation (2026-08-29) — 'confirm-country' added so
  // this existing mechanism covers the new compulsory screen: an
  // unauthenticated visitor is redirected to /login same as any other app
  // route, and a not-yet-onboarded user is redirected to /onboarding first
  // (country reconfirmation is a post-onboarding concept — see
  // app/(app)/layout.tsx's own gate).
  //
  // Terminal certification (2026-08-31): this list was previously missing six
  // real route prefixes (financial-data-hub, financial-twin, forecast,
  // investment-intelligence, profile, recommendations). That was recorded
  // earlier as a pre-existing, unrelated defect and left undisturbed — but it
  // was then REPRODUCED LIVE as a genuine country-gate hole, so it is fixed
  // here rather than carried:
  //
  //   app/(app)/layout.tsx only redirects an unconfirmed user to
  //   /confirm-country when onboarding_completed is true, precisely BECAUSE
  //   it assumes this proxy already confines every not-yet-onboarded user to
  //   /onboarding. For the six prefixes missing from this list that assumption
  //   was false, so an authenticated user with onboarding_completed = false
  //   and NO confirmed country rendered the full AppShell chrome and the
  //   module page at /financial-data-hub, /forecast, /investment-intelligence,
  //   /profile, /recommendations and /financial-twin — protected application
  //   areas, which Product Owner decision 1.2 requires to be unreachable
  //   before confirmation. (No financial data was exposed: the API layer
  //   returned COUNTRY_CONFIRMATION_REQUIRED for every read and write, and the
  //   database backstop blocked writes independently — this was the UI-surface
  //   layer of the defence failing, not the data layer.)
  //
  // Completing the list is the minimal fail-closed fix and matches this
  // regex's own documented intent (it is meant to name every app route).
  // tests/unit/countryGateAccessMatrix.test.ts (MC-17) now asserts every
  // directory under app/(app)/ is matched here, so a future module cannot
  // reintroduce the gap silently. 'twin', 'coach' and 'settings' are retained
  // as-is: they are pre-existing entries unrelated to this fix.
  const isAppRoute = pathname.match(
    /^\/(dashboard|onboarding|confirm-country|global-setup|income|expenses|assets|liabilities|investments|investment-intelligence|retirement|insurance|score|dna|resilience|goals|twin|financial-twin|financial-data-hub|forecast|profile|recommendations|reports|coach|settings|admin|ai-insights)/
  );

  // ---------------------------------------------------------------------
  // G3 section 10 — the interim pre-G4 boundary, at the routing layer
  // ---------------------------------------------------------------------
  // G4's application-wide capability layer does not exist yet, so every
  // module under app/(app)/ still assumes an AU/IN domestic user. A
  // GENERIC-experience user (GB/US/SG/AE) may therefore reach only the
  // surfaces G3 has actually reasoned about, and is redirected to
  // /global-setup everywhere else.
  //
  // This is an ALLOWLIST, and the list names what is PERMITTED. A module
  // added tomorrow is blocked for generic users by default and must be
  // deliberately added here (or, properly, released by G4) to become
  // reachable — the fail-closed direction. "Do not assume that every
  // existing module is universal."
  //
  // Defence in depth, not the only defence. Independently:
  //   * every one of the ~241 country-gated API routes refuses generic users
  //     via countryConfirmationBlockResponse()'s allowGenericExperience
  //     default of false (lib/services/countryGate.ts), so a page that
  //     somehow rendered would have no data to render; and
  //   * the database refuses generic users outright on all ~85 financial
  //     tables, because countries.is_supported remains true for AU/IN only
  //     and MCC's is_country_confirmed() joins it (migrations 0104/0127).
  // A bypass of this middleware alone therefore exposes nothing.
  // G4 (dispatch section 8): "remove the /global-setup redirect only for the
  // exact enabled destinations". lib/services/appCapability.ts's manifest is
  // the single source of truth for WHICH six modules are newly certified
  // universal (Income, Expenses, Insurance, Scores, DNA, Resilience) — this
  // regex is deliberately not a second, independent judgement about which
  // modules are safe; it only widens the ALREADY-G3-APPROVED allowlist to
  // match, and only while the flag is on. Flag off => byte-identical regex to
  // the pre-G4 middleware (dispatch section 9).
  const G4_NEWLY_ENABLED_ROUTE_PREFIXES = 'income|expenses|insurance|score|dna|resilience';
  const isGenericAllowedRoute = isG4CapabilityLayerEnabled()
    ? new RegExp(`^\\/(global-setup|profile|confirm-country|onboarding|${G4_NEWLY_ENABLED_ROUTE_PREFIXES})`).test(pathname)
    : /^\/(global-setup|profile|confirm-country|onboarding)/.test(pathname);
  // The headless PDF renderer (lib/services/reportPdfRenderer.ts) hits the
  // report print view with no session at all, authorizing instead via a
  // short-lived, single-use render_token query param — this proxy only
  // waives the blanket session redirect for that one exact route shape;
  // the token itself is verified against report_exports inside
  // app/(app)/reports/[id]/print/page.tsx (getReportByRenderToken), not here.
  const isTokenAuthorizedPrintRoute = /^\/reports\/[^/]+\/print$/.test(pathname) && request.nextUrl.searchParams.has('token');

  if (isAppRoute && !user && !isTokenAuthorizedPrintRoute) {
    return NextResponse.redirect(new URL('/login', request.url));
  }

  if (isAppRoute && user) {
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('onboarding_completed, country_of_residence, country_confirmed_at')
      .eq('user_id', user.id)
      .single();

    if (!profile?.onboarding_completed && !isOnboardingRoute) {
      return NextResponse.redirect(new URL('/onboarding', request.url));
    }
    if (profile?.onboarding_completed && isOnboardingRoute) {
      return NextResponse.redirect(new URL('/dashboard', request.url));
    }

    // G3: generic-experience containment. Only evaluated for a user who has
    // actually CONFIRMED a country — an unconfirmed user is app/(app)/
    // layout.tsx's problem (it redirects them to /confirm-country), and
    // pre-empting that here would produce the wrong destination.
    //
    // The experience level is read from the live registry, never inferred
    // from the country code, the reporting currency, the landing cookie or
    // the request's IP. If the registry cannot be read, `experienceLevel` is
    // null and this branch does nothing — the request then meets the API and
    // database gates, both of which fail closed on their own.
    if (profile?.country_confirmed_at && profile.country_of_residence && !isGenericAllowedRoute) {
      const registry = await loadCountryRegistrySnapshot(supabase);
      const entry = registry?.get(String(profile.country_of_residence).trim().toUpperCase());
      if (entry?.experienceLevel === 'GENERIC') {
        return NextResponse.redirect(new URL('/global-setup', request.url));
      }
    }
  }

  return response;
}

export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] };
