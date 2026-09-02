// G2 — Landing-Page Localisation: the canonical presentation-country
// resolver for the PUBLIC, PRE-AUTHENTICATION landing experience (spec
// section 4), updated per the Product Owner's AU/IN/Global clarification.
//
// This is a THIN, ADDITIVE companion to the G1 canonical resolver
// (lib/services/jurisdiction.ts's resolveCountryContext()) — it does NOT
// duplicate the countries registry, does NOT duplicate capability data, and
// does NOT become a second authority for residence/primary/billing country.
//
// THE CORE PO REQUIREMENT THIS FILE ENFORCES: the public landing page has
// exactly THREE top-level presentation buckets — 'AU', 'IN', 'GLOBAL'.
// 'GLOBAL' is an EXPERIENCE CATEGORY, not an ISO country. It is a first
// -class, always-selectable option, not merely what happens when nothing
// else matches (that "nothing resolved yet" state is `null` —
// presentationCountry stays null and the selector shows no preselection,
// per the PO's detection-mapping table row 4 — distinct from a visitor who
// HAS an active Global presentation, e.g. because they were detected in the
// UK or explicitly chose Global).
//
// STRUCTURAL ENFORCEMENT that 'GLOBAL' can never become an authoritative
// country value: LandingPresentationCountry ('AU' | 'IN' | 'GLOBAL') is a
// TYPE-LEVEL DISJOINT union from lib/services/jurisdiction.ts's CountryCode
// ('AU' | 'IN') — there is no implicit conversion between them.
// toAuthoritativeCountryCodeOrNull() below is the only bridge, and it maps
// GLOBAL to `null`, never to a country code. Independently, the G1 schema
// itself already makes this physically impossible even if some future code
// forgot to use that bridge: user_profiles.country_of_residence,
// user_profiles.primary_country, user_profiles.billing_country, and
// cross_border_relationships.country_code are all `char(2)` columns with a
// foreign key to `countries(country_code)` (migrations 0001/0104/0122 —
// see tests/unit/g2GlobalNotACountry.test.ts, which reads those migration
// files directly and proves it) — 'GLOBAL' (6 characters) cannot fit a
// char(2) column, and no `countries` row named 'GLOBAL' is ever seeded, so
// even a hypothetical bypass of every application-layer guard would still
// be rejected by the database itself.
//
// `isAuthoritative` is hard-coded `false` on every possible result: nothing
// this module returns may ever be passed to a confirmation/billing RPC, an
// eligibility check, or a profile write. That is enforced by construction —
// this module has no write path into user_profiles/billing_country/
// country_of_residence at all.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { CountryCode } from '@/lib/services/jurisdiction';

export type LandingCountrySource =
  | 'AUTHENTICATED_PRIMARY'
  | 'ANONYMOUS_SELECTION'
  | 'DETECTED_REQUEST'
  | 'PLATFORM_DEFAULT'
  | 'GENERIC_FALLBACK';

export type LandingExperienceLevel = 'FULL' | 'GENERIC';
export type LandingPricingRegion = 'AU' | 'IN' | 'GLOBAL' | 'UNAVAILABLE';

/**
 * The exactly-three landing presentation buckets (PO clarification,
 * 2026-09-02). 'GLOBAL' is deliberately NOT a member of CountryCode
 * (lib/services/jurisdiction.ts) — see module header.
 */
export type LandingPresentationCountry = 'AU' | 'IN' | 'GLOBAL';

export const LANDING_PRESENTATION_COUNTRIES: readonly LandingPresentationCountry[] = ['AU', 'IN', 'GLOBAL'];

export function isLandingPresentationCountry(value: unknown): value is LandingPresentationCountry {
  return typeof value === 'string' && (LANDING_PRESENTATION_COUNTRIES as readonly string[]).includes(value);
}

/**
 * The one permitted bridge from a landing presentation bucket to an
 * authoritative G1 CountryCode. GLOBAL and `null` both map to `null` — there
 * is no code path by which 'GLOBAL' can become a CountryCode through this
 * function. G2 never actually calls this (it has no write path into any
 * authoritative field at all — see module header), but it exists so any
 * *future* code that ever needs to bridge a resolved landing bucket toward
 * an authoritative concept is structurally prevented from leaking 'GLOBAL'
 * through, rather than relying on every future call site remembering to
 * special-case it.
 */
export function toAuthoritativeCountryCodeOrNull(
  bucket: LandingPresentationCountry | null
): CountryCode | null {
  if (bucket === 'AU' || bucket === 'IN') return bucket;
  return null;
}

export interface LandingCountryContext {
  presentationCountry: LandingPresentationCountry | null;
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
const LANDING_COOKIE_VERSION = 2; // v2: country is now restricted to the 3-value LandingPresentationCountry set (was any registry-member ISO code).

interface LandingCountryCookiePayload {
  v: number;
  country: string;
  source: 'MANUAL';
  setAt: string;
}

/**
 * A snapshot of the parts of the G1 `countries` registry this resolver
 * composes: each registry country's declared `experience_level`. Built by
 * loadLandingCountryRegistrySnapshot() from the live table (world-readable,
 * RLS policy "read countries" using (true) — supabase/migrations/
 * 0001_foundation.sql) — never a second, hardcoded copy of the registry's
 * data.
 *
 * NOTE on why this is now only used for a best-effort experience-level
 * cross-check, not for validating selections/detections: with the
 * presentation model reduced to exactly three fixed buckets (AU/IN/GLOBAL —
 * PO clarification), validating an anonymous selection or a *bucket* no
 * longer needs a live registry call at all (LANDING_PRESENTATION_COUNTRIES
 * is a fixed, closed set). The registry is still consulted to confirm AU/IN
 * are presently `experience_level = 'FULL'` (matching the registry's own
 * declared authority for that fact) and degrades gracefully to the
 * hardcoded AU/IN-are-FULL default (true for every AU/IN row since
 * migration 0122 and unlikely to ever change) if the DB is unreachable —
 * this removes the earlier hard dependency the anonymous/detected paths had
 * on a live database connection.
 */
export interface LandingCountryRegistrySnapshot {
  experienceByCountry: ReadonlyMap<string, LandingExperienceLevel>;
}

export async function loadLandingCountryRegistrySnapshot(
  supabase: SupabaseClient
): Promise<LandingCountryRegistrySnapshot> {
  // Fails closed, never throws: a transient DB/network problem must degrade
  // gracefully (see interface doc above), never crash the public marketing
  // landing page or 500 it.
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

// ISO 3166-1 "user-assigned"/reserved codes, plus the specific pseudo
// -codes real geolocation providers (MaxMind and others) emit for
// anonymizers, satellite providers, and "unknown" — none of these is a real
// country, so a detection value equal to one of these must be treated as
// unresolved/malformed (spec section 6, PO detection table row 4), never as
// "a valid non-AU/IN country" (row 3). This list is intentionally NOT a
// second country registry — it is the opposite: a small, fixed denylist of
// values that are known NOT to be real countries, used only to decide
// whether a syntactically 2-letter code should bucket to GLOBAL (row 3) or
// to "unresolved" (row 4).
const RESERVED_OR_PSEUDO_COUNTRY_CODES: ReadonlySet<string> = new Set([
  'A1', 'A2', 'O1', 'T1', // common geolocation-provider pseudo codes (anonymizer/satellite/other)
  'AA', 'QM', 'QN', 'QO', 'QP', 'QQ', 'QR', 'QS', 'QT', 'QU', 'QV', 'QW', 'QX', 'QY', 'QZ', // ISO 3166-1 user-assigned range
  'XA', 'XB', 'XC', 'XD', 'XE', 'XF', 'XG', 'XH', 'XI', 'XJ', 'XK', 'XL', 'XM', 'XN', 'XO', 'XP', 'XQ', 'XR', 'XS', 'XT', 'XU', 'XV', 'XW', 'XX', 'XY', 'XZ', // ISO 3166-1 user-assigned range
  'ZZ', // ISO 3166-1 "unknown or unspecified country"
  'EU', 'AP', // regional pseudo-codes, not countries
]);

/** Is `code` a syntactically real-looking ISO-3166-1-alpha-2 country code (not a reserved/pseudo value)? Used only for detection bucketing — see RESERVED_OR_PSEUDO_COUNTRY_CODES doc above. */
export function isPlausibleCountryCode(code: string): boolean {
  return /^[A-Z]{2}$/.test(code) && !RESERVED_OR_PSEUDO_COUNTRY_CODES.has(code);
}

/**
 * Buckets a raw, already-normalized 2-letter code into one of the three
 * landing presentation buckets, or `null` if it cannot be resolved at all
 * (spec/PO detection-mapping table):
 *   - 'AU' -> 'AU'
 *   - 'IN' -> 'IN'
 *   - any other plausible ISO-shaped code (GB, US, SG, AE, DE, FR, ...) -> 'GLOBAL'
 *   - malformed / reserved / pseudo (or the input itself is null) -> null
 * This is the ONLY place a raw ISO code is translated into a presentation
 * bucket — the anonymous-selection cookie never needs this (it stores one
 * of the three bucket values directly, since the selector itself only ever
 * offers AU/IN/Global), and the authenticated tier only needs the AU/IN
 * special cases (a G1-confirmed primaryCountry is already guaranteed to be
 * a real, registry-validated code).
 */
export function bucketCountryCodeForLanding(code: string | null): LandingPresentationCountry | null {
  if (!code) return null;
  if (code === 'AU') return 'AU';
  if (code === 'IN') return 'IN';
  return isPlausibleCountryCode(code) ? 'GLOBAL' : null;
}

/**
 * Encodes a validated presentation bucket as an opaque cookie value.
 * Deliberately NOT signed/encrypted: the cookie carries no authority (see
 * module header) and its only integrity-relevant property — membership in
 * the fixed 3-value LANDING_PRESENTATION_COUNTRIES set — is re-validated
 * fresh on every read via parseLandingCountryCookie(), so a tampered value
 * can at worst resolve to a *different valid* bucket (still
 * non-authoritative) or fail to parse and be ignored — never an authority
 * escalation, and structurally never anything outside {AU, IN, GLOBAL}.
 */
export function serializeLandingCountryCookie(country: LandingPresentationCountry): string {
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
 * JSON, wrong version, wrong shape, or a country outside the fixed
 * {AU, IN, GLOBAL} set resolves to `null` — "ignore it and resolve safely"
 * (spec section 5/8, G2-11/G2-12). No database call is needed for this
 * validation any more (see LandingCountryRegistrySnapshot doc above).
 */
export function parseLandingCountryCookie(raw: string | null | undefined): LandingPresentationCountry | null {
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
  return isLandingPresentationCountry(p.country) ? p.country : null;
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
    /** The G1 canonical primaryCountry (already resolved by lib/services/jurisdiction.ts's resolveCountryContext) — never re-derived here. A real ISO code (already DB/FK-validated by G1), never 'GLOBAL'. */
    primaryCountry: string | null;
    billingConfirmed: boolean;
  };
  /** Already validated via parseLandingCountryCookie — one of {AU, IN, GLOBAL}, or null if missing/malformed/unsupported. */
  anonymousSelection: LandingPresentationCountry | null;
  /**
   * The RAW, already-normalized (but not yet bucketed) detected country code
   * — e.g. 'GB', 'DE', 'AU' — or null if missing/malformed. This function
   * performs the AU/IN/GLOBAL bucketing itself via bucketCountryCodeForLanding()
   * so the detection-mapping table (spec/PO section 3) lives in exactly one
   * place.
   */
  detectedCountryRaw: string | null;
  /** Optional, PO-approved platform default bucket. See G2 report — the PO's own detection table row 4 ("Missing/unsupported/malformed -> Neutral selector, no preselected country") has now formally closed the need for this to ever be configured; the tier remains implemented for architectural completeness, not because a gap remains. */
  platformDefaultCountry: LandingPresentationCountry | null;
  registry: LandingCountryRegistrySnapshot;
}

function experienceLevelForBucket(
  bucket: LandingPresentationCountry | null,
  registry: LandingCountryRegistrySnapshot
): LandingExperienceLevel {
  if (bucket !== 'AU' && bucket !== 'IN') return 'GENERIC';
  // Best-effort cross-check against the live registry (see interface doc);
  // degrades to the hardcoded "AU/IN are FULL" fact if the registry
  // snapshot is empty (DB unreachable) — AU/IN have been FULL since
  // migration 0122 and this hardcoded fallback merely reflects the same
  // permanent fact lib/services/jurisdiction.ts's CountryCode type already
  // encodes structurally, not a second, drifting declaration of it.
  return registry.experienceByCountry.get(bucket) ?? 'FULL';
}

function pricingRegionForBucket(bucket: LandingPresentationCountry | null): LandingPricingRegion {
  if (bucket === 'AU' || bucket === 'IN') return bucket;
  if (bucket === 'GLOBAL') return 'GLOBAL';
  return 'UNAVAILABLE';
}

/**
 * The pure five-tier precedence function (spec section 5, PO clarification
 * section 3). Every input is already validated/normalized by its own
 * dedicated helper above — this function only ever combines already-safe
 * values, which is what makes it fully unit-testable without any
 * Supabase/cookie/header plumbing.
 */
export function computeLandingCountryContext(
  input: ComputeLandingCountryContextInput
): LandingCountryContext {
  const { authenticated, anonymousSelection, detectedCountryRaw, platformDefaultCountry, registry } = input;

  // Tier 1 — confirmed authenticated primary-country context always wins,
  // over any anonymous cookie, detected geography, or travel/VPN location.
  // The authenticated primaryCountry is a real G1/FK-validated ISO code
  // (never 'GLOBAL' — G1 has no concept of it), bucketed here for
  // PRESENTATION only; the real code is still what G1 uses for billing/
  // capability decisions elsewhere, untouched by this bucketing.
  if (authenticated.isAuthenticated && authenticated.primaryCountry) {
    const bucket = bucketCountryCodeForLanding(authenticated.primaryCountry) ?? 'GLOBAL';
    return {
      presentationCountry: bucket,
      source: 'AUTHENTICATED_PRIMARY',
      experienceLevel: experienceLevelForBucket(bucket, registry),
      isAuthoritative: false,
      billingConfirmed: authenticated.billingConfirmed,
      pricingRegion: pricingRegionForBucket(bucket),
    };
  }

  // Tier 2 — a valid anonymous manual selection overrides automatic
  // detection (spec section 5). Anonymous selection never carries billing
  // confirmation. Already one of {AU, IN, GLOBAL} by construction
  // (parseLandingCountryCookie only ever returns that set or null).
  if (anonymousSelection) {
    return {
      presentationCountry: anonymousSelection,
      source: 'ANONYMOUS_SELECTION',
      experienceLevel: experienceLevelForBucket(anonymousSelection, registry),
      isAuthoritative: false,
      billingConfirmed: false,
      pricingRegion: pricingRegionForBucket(anonymousSelection),
    };
  }

  // Tier 3 — trusted server-side request-country detection, initialising
  // presentation only. PO detection-mapping table: AU -> AU, IN -> IN,
  // GB/US/SG/AE/another valid non-AU/IN country -> GLOBAL,
  // missing/unsupported/malformed -> unresolved (falls through below).
  const detectedBucket = bucketCountryCodeForLanding(detectedCountryRaw);
  if (detectedBucket) {
    return {
      presentationCountry: detectedBucket,
      source: 'DETECTED_REQUEST',
      experienceLevel: experienceLevelForBucket(detectedBucket, registry),
      isAuthoritative: false,
      billingConfirmed: false,
      pricingRegion: pricingRegionForBucket(detectedBucket),
    };
  }

  // Tier 4 — approved platform presentation default, if the Product Owner
  // has ever configured one. The PO's own detection-mapping table row 4
  // ("Missing/unsupported/malformed -> Neutral selector, no preselected
  // country") is itself the approved behaviour for "no signal" — so this
  // tier is intentionally never exercised in practice today, not because a
  // decision is still pending (see G2 report, gap G2-R2 now CLOSED). Left
  // implemented, not deleted, purely for architectural completeness should
  // a future PO decision ever want a non-null default.
  if (platformDefaultCountry) {
    return {
      presentationCountry: platformDefaultCountry,
      source: 'PLATFORM_DEFAULT',
      experienceLevel: experienceLevelForBucket(platformDefaultCountry, registry),
      isAuthoritative: false,
      billingConfirmed: false,
      pricingRegion: pricingRegionForBucket(platformDefaultCountry),
    };
  }

  // Tier 5 — generic fail-safe fallback: neutral selector, NO preselected
  // country (PO detection table row 4). Distinct from an active 'GLOBAL'
  // presentation — this visitor has not chosen or been mapped to anything
  // yet.
  return {
    presentationCountry: null,
    source: 'GENERIC_FALLBACK',
    experienceLevel: 'GENERIC',
    isAuthoritative: false,
    billingConfirmed: false,
    pricingRegion: 'UNAVAILABLE',
  };
}
