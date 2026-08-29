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
  // app/(app)/layout.tsx's own gate). This list was found during this task
  // to already be missing several existing route prefixes (financial-data-
  // hub, investment-intelligence, forecast, profile) — a pre-existing,
  // unrelated defect left undisturbed here; only the new prefix this task
  // introduces is added. See the closure report's verification section.
  const isAppRoute = pathname.match(
    /^\/(dashboard|onboarding|confirm-country|income|expenses|assets|liabilities|investments|retirement|insurance|score|dna|resilience|goals|twin|reports|coach|settings|admin)/
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
