// G2 — server-side orchestration wrapper around computeLandingCountryContext
// (lib/services/landingCountryContext.ts). This is the ONLY place that
// touches cookies()/headers()/Supabase for the landing page — kept separate
// from the pure precedence function so that function stays trivially unit
// -testable, and so this IO wiring is the single place a future change to
// "which header/cookie API we use" has to be made.
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveCountryContext } from '@/lib/services/jurisdiction';
import {
  computeLandingCountryContext,
  loadLandingCountryRegistrySnapshot,
  normalizeLandingCountryCode,
  parseLandingCountryCookie,
  readRawDetectedCountry,
  LANDING_COUNTRY_COOKIE_NAME,
  type LandingCountryContext,
} from '@/lib/services/landingCountryContext';

export interface ResolveLandingCountryContextForRequestParams {
  supabase: SupabaseClient;
  userId: string | null;
  cookieValue: string | null;
  headers: { get(name: string): string | null };
}

/**
 * Resolves the full LandingCountryContext for one request. Reads:
 *   - the G1 canonical resolver (authenticated tier only, and only when a
 *     userId is present — an anonymous visitor never triggers a
 *     user_profiles lookup);
 *   - a best-effort snapshot of the live, world-readable `countries`
 *     registry (used only to cross-check AU/IN's declared experience_level;
 *     since the PO's AU/IN/Global clarification, no cookie/header/selection
 *     validation depends on this any more — see
 *     LandingCountryRegistrySnapshot's own doc comment);
 *   - the validated anonymous-selection cookie (one of {AU, IN, GLOBAL} or null);
 *   - the validated detected-request-country header.
 * No PO-approved platform default is recorded today (see G2 report), so
 * `platformDefaultCountry` is always null here — see
 * computeLandingCountryContext's own tier-4 comment for why the mechanism
 * still exists rather than being deleted.
 */
export async function resolveLandingCountryContextForRequest(
  params: ResolveLandingCountryContextForRequestParams
): Promise<LandingCountryContext> {
  const { supabase, userId, cookieValue, headers } = params;

  const registry = await loadLandingCountryRegistrySnapshot(supabase);

  let authenticated = { isAuthenticated: false, primaryCountry: null as string | null, billingConfirmed: false };
  if (userId) {
    // Same fail-closed principle as loadLandingCountryRegistrySnapshot(): a
    // transient DB error resolving the authenticated G1 context must not
    // crash the landing page. Falling back to isAuthenticated:false here is
    // safe (never unsafe) -- worst case a signed-in visitor sees the
    // anonymous/detected presentation tier for that one request, never an
    // authority escalation, and no MCC/auth gating anywhere else is
    // affected (this module has no bearing on proxy.ts's own gates).
    try {
      const g1Context = await resolveCountryContext(userId, supabase);
      authenticated = {
        isAuthenticated: true,
        primaryCountry: g1Context.primaryCountry,
        billingConfirmed: g1Context.billingConfirmed,
      };
    } catch {
      authenticated = { isAuthenticated: false, primaryCountry: null, billingConfirmed: false };
    }
  }

  const anonymousSelection = parseLandingCountryCookie(cookieValue);

  const rawDetected = readRawDetectedCountry(headers);
  const detectedCountryRaw = normalizeLandingCountryCode(rawDetected);

  return computeLandingCountryContext({
    authenticated,
    anonymousSelection,
    detectedCountryRaw,
    platformDefaultCountry: null,
    registry,
  });
}

export { LANDING_COUNTRY_COOKIE_NAME };
