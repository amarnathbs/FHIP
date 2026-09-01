// G2 — Landing-Page Localisation: the canonical presentation-country
// resolver for the PUBLIC, PRE-AUTHENTICATION landing experience (spec
// section 4).
//
// This is a THIN, ADDITIVE companion to the G1 canonical resolver
// (lib/services/jurisdiction.ts's resolveCountryContext()) — it does NOT
// duplicate the countries registry, does NOT duplicate capability data, and
// does NOT become a second authority for residence/primary/billing country.
// It composes:
//   - the caller's own G1 ResolvedCountryContext (authenticated tier only),
//   - a world-readable snapshot of the `countries` registry (selectable +
//     active rows only — same table G1 owns, read here, never written),
//   - a validated anonymous-selection cookie value,
//   - a validated detected-request-country value,
// and applies the exact five-tier precedence spec section 5 requires.
//
// `isAuthoritative` is hard-coded `false` on every possible result: nothing
// this module returns may ever be passed to a confirmation/billing RPC, an
// eligibility check, or a profile write. That is enforced by construction —
// this module has no write path into user_profiles/billing_country/
// country_of_residence at all.
import type { SupabaseClient } from '@supabase/supabase-js';

export type LandingCountrySource =
  | 'AUTHENTICATED_PRIMARY'
  | 'ANONYMOUS_SELECTION'
  | 'DETECTED_REQUEST'
  | 'PLATFORM_DEFAULT'
  | 'GENERIC_FALLBACK';

export type LandingExperienceLevel = 'FULL' | 'GENERIC';
export type LandingPricingRegion = 'AU' | 'IN' | 'GENERIC' | 'UNAVAILABLE';

export interface LandingCountryContext {
  presentationCountry: string | null;
  source: LandingCountrySource;
  experienceLevel: LandingExperienceLevel;
  /** Always false. This is a presentation-layer result only — see module header. */
  isAuthoritative: false;
  billingConfirmed: boolean;
  pricingRegion: LandingPricingRegion;
}

/** The cookie name the anonymous-selection API route (app/api/landing/country/route.ts) reads/writes. */
export const LANDING_COUNTRY_COOKIE_NAME = 'fhip_landing_country';

/** Cookie payload version — bump if the shape changes; a mismatched version is treated as invalid, not migrated. */
const LANDING_COOKIE_VERSION = 1;

interface LandingCountryCookiePayload {
  v: number;
  country: string;
  source: 'MANUAL';
  setAt: string;
}

/**
 * A snapshot of the parts of the G1 `countries` registry this resolver is
 * allowed to read: which codes are currently `selectable && active`, and
 * each one's `experience_level`. Built by loadLandingCountryRegistrySnapshot()
 * from the live table (world-readable, RLS policy "read countries" using
 * (true) — see supabase/migrations/0001_foundation.sql) — never a second,
 * hardcoded copy of the registry's data.
 */
export interface LandingCountryRegistrySnapshot {
  experienceByCountry: ReadonlyMap<string, LandingExperienceLevel>;
}

export async function loadLandingCountryRegistrySnapshot(
  supabase: SupabaseClient
): Promise<LandingCountryRegistrySnapshot> {
  // Fails closed, never throws: a transient DB/network problem must degrade
  // the public marketing landing page to the safe generic-fallback tier
  // (spec section 5's own "unsupported/malformed/absent detection must fail
  // safely" principle applied to the registry lookup itself), never crash
  // it or 500 it. An empty snapshot makes every isKnownLandingCountry() call
  // return false, which is exactly the fail-closed behaviour this module
  // already uses for a malformed cookie/header.
  try {
    const { data, error } = await supabase
      .from('countries')
      .select('country_code, experience_level')
      .eq('selectable', true)
      .eq('active', true);
    if (error) return { experienceByCountry: new Map() };

    const experienceByCountry = new Map<string, LandingExperienceLevel>();
    for (const row of data ?? []) {
      const level = row.experience_level === 'FULL' ? 'FULL' : 'GENERIC';
      if (typeof row.country_code === 'string') experienceByCountry.set(row.country_code, level);
    }
    return { experienceByCountry };
  } catch {
    return { experienceByCountry: new Map() };
  }
}

/** Normalizes a raw, untrusted country-code-shaped string. Anything that isn't exactly 2 letters is rejected outright (fails closed). */
export function normalizeLandingCountryCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(trimmed)) return null;
  return trimmed;
}

/** Is `code` one of the currently selectable+active G1 registry countries? Malformed/unknown/pseudo codes ('XX', 'A1', 'EU', 'T1', ...) are never members. */
export function isKnownLandingCountry(
  code: string | null,
  registry: LandingCountryRegistrySnapshot
): code is string {
  return !!code && registry.experienceByCountry.has(code);
}

/**
 * Encodes a validated country code as an opaque cookie value. Deliberately
 * NOT signed/encrypted: the cookie carries no authority (see module header)
 * and its only integrity-relevant property — registry membership — is
 * re-validated fresh on every read via parseLandingCountryCookie(), so a
 * tampered value can at worst resolve to a *different valid* presentation
 * country (still non-authoritative) or fail to parse and be ignored — never
 * an authority escalation.
 */
export function serializeLandingCountryCookie(country: string): string {
  const payload: LandingCountryCookiePayload = {
    v: LANDING_COOKIE_VERSION,
    country,
    source: 'MANUAL',
    setAt: new Date().toISOString(),
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/**
 * Decodes+validates a raw cookie value. Any malformed base64, malformed
 * JSON, wrong version, wrong shape, or a country not currently
 * selectable+active in the live registry resolves to `null` — "ignore it
 * and resolve safely" (spec section 5, G2-11/G2-12).
 */
export function parseLandingCountryCookie(
  raw: string | null | undefined,
  registry: LandingCountryRegistrySnapshot
): string | null {
  if (!raw) return null;
  let payload: unknown;
  try {
    const json = Buffer.from(raw, 'base64url').toString('utf8');
    payload = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (p.v !== LANDING_COOKIE_VERSION) return null;
  if (p.source !== 'MANUAL') return null;
  const code = normalizeLandingCountryCode(p.country);
  if (!code || !isKnownLandingCountry(code, registry)) return null;
  return code;
}

/**
 * The canonical header this resolver reads for trusted server-side
 * request-country detection. AWS Amplify Hosting serves through CloudFront,
 * and CloudFront's standard viewer-country header is
 * `CloudFront-Viewer-Country` — but that header is only populated when the
 * distribution has viewer-country injection explicitly enabled, which this
 * task has NO evidence, and no console access to confirm, is turned on for
 * this app's Amplify distribution (see G2 report section D — documented
 * infrastructure blocker, not fabricated detection proof). Reading it here
 * is safe regardless: if the header is never actually injected in
 * production, `detectedCountry` simply always resolves to null and the
 * chain safely falls through to the platform-default/generic-fallback
 * tiers — it can never fail unsafe.
 */
export const LANDING_DETECTED_COUNTRY_HEADER = 'cloudfront-viewer-country';

/**
 * Deterministic override for local/DEV/automated tests ONLY (spec section
 * 6's "how do automated tests inject deterministic signals"). Gated by an
 * explicit env var that must never be set in production — even though a
 * forged value here could never gain authority (this whole module is
 * presentation-only), gating it keeps a stray client-sent test header from
 * ever influencing even the *presentation* shown to a real visitor.
 */
export const LANDING_TEST_DETECTED_COUNTRY_HEADER = 'x-fhip-g2-test-detected-country';

export function isTestDetectionHeaderAllowed(): boolean {
  return process.env.G2_ALLOW_TEST_DETECTION_HEADER === 'true';
}

/**
 * Resolves the raw detected-country header value from a Headers-like
 * object, honouring the test-only override when explicitly enabled. Never
 * reads/exposes the caller's raw IP address (spec section 6: "never expose
 * raw IPs", "never store visitor IPs for G2") — no IP header is read by
 * this function at all.
 */
export function readRawDetectedCountry(headers: {
  get(name: string): string | null;
}): string | null {
  if (isTestDetectionHeaderAllowed()) {
    const testValue = headers.get(LANDING_TEST_DETECTED_COUNTRY_HEADER);
    if (testValue) return testValue;
  }
  return headers.get(LANDING_DETECTED_COUNTRY_HEADER);
}

export interface ComputeLandingCountryContextInput {
  authenticated: {
    isAuthenticated: boolean;
    /** The G1 canonical primaryCountry (already resolved by lib/services/jurisdiction.ts's resolveCountryContext) — never re-derived here. */
    primaryCountry: string | null;
    billingConfirmed: boolean;
  };
  /** Already validated via parseLandingCountryCookie — null if missing/malformed/unsupported. */
  anonymousSelection: string | null;
  /** Already validated via normalizeLandingCountryCode + isKnownLandingCountry — null if missing/malformed/unsupported/forged-unresolvable. */
  detectedCountry: string | null;
  /** Optional, PO-approved platform default (see G2 report — none is currently approved, so this is always null in production today, but the tier is real, not skipped). */
  platformDefaultCountry: string | null;
  registry: LandingCountryRegistrySnapshot;
}

function experienceLevelFor(
  code: string | null,
  registry: LandingCountryRegistrySnapshot
): LandingExperienceLevel {
  if (!code) return 'GENERIC';
  return registry.experienceByCountry.get(code) ?? 'GENERIC';
}

function pricingRegionFor(code: string | null): LandingPricingRegion {
  if (code === 'AU' || code === 'IN') return code;
  if (code) return 'GENERIC';
  return 'UNAVAILABLE';
}

/**
 * The pure five-tier precedence function (spec section 5). Every input is
 * already validated/normalized by its own dedicated helper above — this
 * function only ever combines already-safe values, which is what makes it
 * fully unit-testable without any Supabase/cookie/header plumbing.
 */
export function computeLandingCountryContext(
  input: ComputeLandingCountryContextInput
): LandingCountryContext {
  const { authenticated, anonymousSelection, detectedCountry, platformDefaultCountry, registry } = input;

  // Tier 1 — confirmed authenticated primary-country context always wins,
  // over any anonymous cookie, detected geography, or travel/VPN location.
  if (authenticated.isAuthenticated && authenticated.primaryCountry) {
    return {
      presentationCountry: authenticated.primaryCountry,
      source: 'AUTHENTICATED_PRIMARY',
      experienceLevel: experienceLevelFor(authenticated.primaryCountry, registry),
      isAuthoritative: false,
      billingConfirmed: authenticated.billingConfirmed,
      pricingRegion: pricingRegionFor(authenticated.primaryCountry),
    };
  }

  // Tier 2 — a valid anonymous manual selection overrides automatic
  // detection (spec section 5). Anonymous selection never carries billing
  // confirmation.
  if (anonymousSelection) {
    return {
      presentationCountry: anonymousSelection,
      source: 'ANONYMOUS_SELECTION',
      experienceLevel: experienceLevelFor(anonymousSelection, registry),
      isAuthoritative: false,
      billingConfirmed: false,
      pricingRegion: pricingRegionFor(anonymousSelection),
    };
  }

  // Tier 3 — trusted server-side request-country detection, initialising
  // presentation only.
  if (detectedCountry) {
    return {
      presentationCountry: detectedCountry,
      source: 'DETECTED_REQUEST',
      experienceLevel: experienceLevelFor(detectedCountry, registry),
      isAuthoritative: false,
      billingConfirmed: false,
      pricingRegion: pricingRegionFor(detectedCountry),
    };
  }

  // Tier 4 — approved platform presentation default, if the Product Owner
  // has ever configured one. None is currently recorded/approved (see G2
  // report) so this tier is always skipped today; it is not removed,
  // because a future PO decision should only require setting the env var,
  // not writing new code.
  if (platformDefaultCountry && isKnownLandingCountry(platformDefaultCountry, registry)) {
    return {
      presentationCountry: platformDefaultCountry,
      source: 'PLATFORM_DEFAULT',
      experienceLevel: experienceLevelFor(platformDefaultCountry, registry),
      isAuthoritative: false,
      billingConfirmed: false,
      pricingRegion: pricingRegionFor(platformDefaultCountry),
    };
  }

  // Tier 5 — generic fail-safe fallback / neutral selector prompt.
  return {
    presentationCountry: null,
    source: 'GENERIC_FALLBACK',
    experienceLevel: 'GENERIC',
    isAuthoritative: false,
    billingConfirmed: false,
    pricingRegion: 'UNAVAILABLE',
  };
}
