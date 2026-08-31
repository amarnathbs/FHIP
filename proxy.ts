import { type NextRequest, NextResponse } from 'next/server';
import { createServerClient, type SetAllCookies } from '@supabase/ssr';

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
    /^\/(dashboard|onboarding|confirm-country|income|expenses|assets|liabilities|investments|investment-intelligence|retirement|insurance|score|dna|resilience|goals|twin|financial-twin|financial-data-hub|forecast|profile|recommendations|reports|coach|settings|admin)/
  );
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
      .select('onboarding_completed')
      .eq('user_id', user.id)
      .single();

    if (!profile?.onboarding_completed && !isOnboardingRoute) {
      return NextResponse.redirect(new URL('/onboarding', request.url));
    }
    if (profile?.onboarding_completed && isOnboardingRoute) {
      return NextResponse.redirect(new URL('/dashboard', request.url));
    }
  }

  return response;
}

export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] };
