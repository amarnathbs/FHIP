// G2 — Landing-Page Localisation: the anonymous country-selection mutation
// endpoint (spec sections 7-8). This is the ONLY place that writes the
// fhip_landing_country cookie.
//
// CSRF/origin protection: this repository has no dedicated CSRF-token
// system to reuse (confirmed during G2 baseline discovery — no existing API
// route implements one; mutation routes rely on authenticated-session
// SameSite cookies). Since this endpoint is deliberately reachable by a
// signed-out visitor (it has no session to anchor to), it instead validates
// the request's own Origin header against the app's own canonical origin —
// the same-origin check a browser-sent Origin header lets a server perform
// directly, and a cross-site page cannot forge a false one (browsers set
// Origin themselves). A missing Origin header (some legitimate same-site
// requests, older browsers) is tolerated but never required to prove
// anything beyond what it already is: this endpoint can only ever set a
// NON-authoritative presentation preference (spec section 10) — worst case
// of a successful forged call is a wrong marketing-copy country shown to
// the attacker's own victim, never a billing/eligibility change.
import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getFhipApplicationUrl } from '@/lib/seo/entity';
import {
  LANDING_COUNTRY_COOKIE_NAME,
  loadLandingCountryRegistrySnapshot,
  normalizeLandingCountryCode,
  isKnownLandingCountry,
  serializeLandingCountryCookie,
} from '@/lib/services/landingCountryContext';

const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 180; // 180 days

function isOriginAllowed(request: NextRequest): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return true; // no Origin header at all -- not a cross-site browser POST
  try {
    const allowed = new URL(getFhipApplicationUrl());
    const got = new URL(origin);
    return got.origin === allowed.origin;
  } catch {
    return false;
  }
}

function cookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
  };
}

export async function POST(request: NextRequest) {
  if (!isOriginAllowed(request)) {
    return NextResponse.json({ error: 'ORIGIN_NOT_ALLOWED' }, { status: 403 });
  }

  const body = await request.json().catch(() => null);
  const code = normalizeLandingCountryCode(
    body && typeof body === 'object' ? (body as Record<string, unknown>).country : null
  );

  const supabase = await createClient();
  const registry = await loadLandingCountryRegistrySnapshot(supabase);

  if (!code || !isKnownLandingCountry(code, registry)) {
    return NextResponse.json({ error: 'UNSUPPORTED_COUNTRY' }, { status: 400 });
  }

  const response = NextResponse.json({ country: code });
  response.cookies.set(LANDING_COUNTRY_COOKIE_NAME, serializeLandingCountryCookie(code), {
    ...cookieOptions(),
    maxAge: COOKIE_MAX_AGE_SECONDS,
  });
  return response;
}

/** Clears the anonymous selection (spec section 8: "provide a safe way to replace/clear the preference"). */
export async function DELETE(request: NextRequest) {
  if (!isOriginAllowed(request)) {
    return NextResponse.json({ error: 'ORIGIN_NOT_ALLOWED' }, { status: 403 });
  }

  const response = NextResponse.json({ cleared: true });
  response.cookies.set(LANDING_COUNTRY_COOKIE_NAME, '', { ...cookieOptions(), maxAge: 0 });
  return response;
}
