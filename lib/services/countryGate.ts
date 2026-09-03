// Mandatory Country Confirmation — canonical country-gate classification.
//
// Product Owner decision (2026-08-29): every authenticated FHIP user must
// explicitly confirm their country of residence before accessing or using
// the application. This module is the SINGLE source of truth for what
// "confirmed" means — reused by:
//   - app/(app)/layout.tsx (primary UI enforcement, structurally covers
//     every page in that route group, including admin)
//   - lib/api.ts's requireUser() (API-layer enforcement — see that file's
//     header comment for why the pre-existing shared guard was extended in
//     place rather than requiring 188 call sites to change)
//   - app/api/user/country/confirm and .../state (the confirmation flow
//     itself)
//
// Deliberately never infers country from currency, IP, browser locale,
// language, timezone, existing holdings or household data (spec section
// 1.1) — the ONLY inputs are user_profiles.country_of_residence and
// .country_confirmed_at. Deliberately never defaults an unresolved/invalid/
// unsupported value to AU or IN (contrast with the unmerged, unauthorised
// 2fa2090 hotfix, which this task explicitly supersedes/rejects for exactly
// that behaviour).
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  AUTHORITATIVE_COUNTRY_CODES,
  type CountryCode,
  type ExperienceLevel,
} from '@/lib/services/jurisdiction';

// G3 — Registration and Existing-User Alignment.
//
// Registration eligibility is now the SIX-country authoritative vocabulary,
// not the two-country record vocabulary this file previously borrowed from
// lib/constants.ts's COUNTRY_OPTIONS. Those two lists had silently been the
// same list; G3 makes them genuinely different concepts, so this file no
// longer derives from COUNTRY_OPTIONS at all.
//
// IMPORTANT: membership of this list is necessary but NOT sufficient for
// registration. The registry (`countries` + `country_capabilities`) is the
// authority per G3 spec section 6.3, and is consulted live by
// assertCountryConfirmedForUser() below. This constant only bounds the
// vocabulary the application will even consider -- so that a syntactically
// valid but unoffered code ('NZ', 'FR') is rejected as UNSUPPORTED without a
// database round trip, and so that no arbitrary two-letter string can reach
// the registry lookup at all (G3 section 5.1: "Do not accept arbitrary
// two-letter codes merely because they are syntactically valid").
export const SUPPORTED_COUNTRY_CODES: readonly CountryCode[] = AUTHORITATIVE_COUNTRY_CODES;

/** The registration selector's options, in the order the UI presents them. */
export const REGISTRATION_COUNTRY_OPTIONS: { value: CountryCode; label: string }[] = [
  { value: 'AU', label: 'Australia' },
  { value: 'IN', label: 'India' },
  { value: 'GB', label: 'United Kingdom' },
  { value: 'US', label: 'United States' },
  { value: 'SG', label: 'Singapore' },
  { value: 'AE', label: 'United Arab Emirates' },
];

export type CountrySource = 'USER_CONFIRMED' | 'ADMIN_CORRECTED';

// The 7 states section 5.2/5.5 requires to be held distinct — never
// flattened into a generic success/failure boolean. G3 adds two more, for
// the same reason the original seven exist: each is a genuinely different
// situation with a different truthful message, and collapsing them would
// either mislead the user or fail open.
//
//   COUNTRY_REGISTRATION_NOT_PERMITTED — the code is in this app's
//     vocabulary, but the live registry does not currently permit
//     registration for it (row inactive, outside its effective window, not
//     selectable, or REGISTRATION capability disabled). Distinct from
//     COUNTRY_UNSUPPORTED, which means "not in the vocabulary at all".
//
//   GENERIC_EXPERIENCE_RESTRICTED — the user has a perfectly valid, fully
//     confirmed GENERIC residence (GB/US/SG/AE). Their country is not the
//     problem; the requested surface is. This is G3's interim pre-G4
//     boundary (spec section 10) and it is NOT a confirmation failure —
//     sending such a user back to /confirm-country would be both untrue and
//     an infinite loop, which is why shouldRedirectToConfirmCountry()
//     explicitly excludes it below.
export type CountryGateState =
  | 'PROFILE_INCOMPLETE'
  | 'COUNTRY_MISSING'
  | 'COUNTRY_UNCONFIRMED'
  | 'COUNTRY_UNSUPPORTED'
  | 'COUNTRY_INVALID'
  | 'COUNTRY_REGISTRATION_NOT_PERMITTED'
  | 'GENERIC_EXPERIENCE_RESTRICTED'
  | 'CONFIRMED'
  | 'DB_ERROR';

export interface CountryGateResult {
  state: CountryGateState;
  countryOfResidence: string | null;
  countryConfirmedAt: string | null;
  countrySource: CountrySource | null;
  onboardingCompleted: boolean;
  /**
   * G3: the experience level the SERVER derived from the registry for this
   * user's confirmed country — never a client-supplied value, and never
   * inferred from currency, locale or IP. `null` when no country is
   * confirmed, or when the registry could not be read (in which case the
   * state is DB_ERROR and everything fails closed anyway).
   */
  experienceLevel: ExperienceLevel | null;
}

// Well-formed shape check only — deliberately NOT a full ISO-3166 list.
// Repository evidence (supabase/seed.sql, lib/constants.ts,
// lib/validation/profile.ts) shows FHIP has only ever seeded/validated
// exactly two countries (AU, IN); there is no existing catalogue of
// "recognised but not yet supported" codes to check against. A two-letter
// alphabetic code that isn't one of the supported ones is therefore
// classified UNSUPPORTED (a real, if currently unpopulated by any actual
// user, state — e.g. a plausible ISO code like 'NZ' or 'US'); anything that
// isn't even shaped like a country code (empty, numeric, too long, symbols)
// is classified INVALID. This distinction is documented explicitly in the
// closure report (section D) as a scope decision made from direct repo
// evidence, not an assumption.
const COUNTRY_CODE_SHAPE = /^[A-Za-z]{2}$/;

export type CountryValueShape = 'MISSING' | 'INVALID' | 'UNSUPPORTED' | 'SUPPORTED';

export function classifyCountryValue(raw: string | null | undefined): CountryValueShape {
  if (raw == null) return 'MISSING';
  const trimmed = raw.trim();
  if (trimmed === '') return 'MISSING';
  if (!COUNTRY_CODE_SHAPE.test(trimmed)) return 'INVALID';
  const upper = trimmed.toUpperCase();
  return (SUPPORTED_COUNTRY_CODES as readonly string[]).includes(upper) ? 'SUPPORTED' : 'UNSUPPORTED';
}

interface ProfileCountryRow {
  country_of_residence: string | null;
  country_confirmed_at: string | null;
  country_source: string | null;
  onboarding_completed: boolean | null;
}

// =============================================================================
// G3 — the live registry snapshot (spec section 6.3: "Server authority")
// =============================================================================
// The server must "verify it exists and is active", "verify registration is
// permitted" and "derive experience level from the registry" — never trust a
// client-supplied experience level or capability flag. That means a real read
// of `countries` + `country_capabilities`, not a hardcoded second copy of the
// registry's data in TypeScript.
//
// Both tables are world-readable (RLS `using (true)`, migrations 0001/0122),
// tiny (six rows / 78 rows), and change only by migration. This gate runs on
// every one of the ~241 country-gated API routes and on every app page
// render, so the snapshot is memoised in-process behind a short TTL rather
// than re-queried per request. The trade-off is explicit and bounded: a
// registry change made by migration takes up to REGISTRY_TTL_MS to be
// honoured by an already-running instance. That is acceptable because
// registry changes are deploy-time events, and because the DATABASE-level
// backstops (migrations 0104/0127) are not cached at all — they re-evaluate
// the registry on every single write, so a stale cache can never let a write
// through that the database would reject.
export interface CountryRegistryEntry {
  countryCode: string;
  experienceLevel: ExperienceLevel;
  registrationEnabled: boolean;
  active: boolean;
  selectable: boolean;
  effectiveFrom: string | null;
  effectiveTo: string | null;
}

export type CountryRegistrySnapshot = ReadonlyMap<string, CountryRegistryEntry>;

const REGISTRY_TTL_MS = 60_000;

let registryCache: { snapshot: CountryRegistrySnapshot; loadedAt: number } | null = null;

/** Test seam — clears the memoised registry so a test can vary it. */
export function __resetCountryRegistryCacheForTests(): void {
  registryCache = null;
}

/**
 * Reads the registry. Returns `null` on ANY read failure — deliberately not
 * an empty snapshot, because an empty snapshot is indistinguishable from
 * "no country is registerable", and callers must be able to tell an
 * operational failure (DB_ERROR, 500) apart from a legitimate denial (403).
 */
export async function loadCountryRegistrySnapshot(
  supabase: SupabaseClient
): Promise<CountryRegistrySnapshot | null> {
  const cached = registryCache;
  if (cached && Date.now() - cached.loadedAt < REGISTRY_TTL_MS) return cached.snapshot;

  const [{ data: countryRows, error: countryError }, { data: capRows, error: capError }] = await Promise.all([
    supabase.from('countries').select('country_code, experience_level, selectable, active, effective_from, effective_to'),
    supabase.from('country_capabilities').select('country_code, capability, enabled').eq('capability', 'REGISTRATION'),
  ]);

  if (countryError || capError || !countryRows) return null;

  const registrationEnabled = new Set(
    (capRows ?? []).filter((r) => r.enabled === true).map((r) => String(r.country_code).trim().toUpperCase())
  );

  const snapshot = new Map<string, CountryRegistryEntry>();
  for (const row of countryRows) {
    const code = String(row.country_code ?? '').trim().toUpperCase();
    if (!code) continue;
    const level = row.experience_level;
    snapshot.set(code, {
      countryCode: code,
      experienceLevel: level === 'FULL' || level === 'GENERIC' ? level : 'UNAVAILABLE',
      registrationEnabled: registrationEnabled.has(code),
      active: row.active !== false,
      selectable: row.selectable === true,
      effectiveFrom: row.effective_from ?? null,
      effectiveTo: row.effective_to ?? null,
    });
  }

  registryCache = { snapshot, loadedAt: Date.now() };
  return snapshot;
}

/**
 * G3 spec section 6.3, as one pure predicate: may a user register with (and
 * therefore confirm) this country right now?
 *
 * Registry-derived only. Note in particular what is NOT consulted:
 * `is_supported` (that is the stricter FINANCIAL-eligibility flag, which
 * stays AU/IN-only and backs the ~85-table MCC backstop), the user's
 * currency, their landing-page cookie, their locale, or their IP.
 */
export function isRegistrationPermitted(
  entry: CountryRegistryEntry | undefined,
  now: Date = new Date()
): boolean {
  if (!entry) return false;
  if (!entry.active || !entry.selectable || !entry.registrationEnabled) return false;
  if (entry.effectiveFrom && new Date(entry.effectiveFrom) > now) return false;
  if (entry.effectiveTo && new Date(entry.effectiveTo) <= now) return false;
  return true;
}

// The one canonical classification function. Never throws for a normal
// "not confirmed yet" outcome — only DB_ERROR represents an operational
// failure distinct from every legitimate user-facing state (spec 5.5: "Do
// not flatten these into a false success or AU/IN default").
export async function assertCountryConfirmedForUser(
  supabase: SupabaseClient,
  userId: string
): Promise<CountryGateResult> {
  const { data: profile, error } = await supabase
    .from('user_profiles')
    .select('country_of_residence, country_confirmed_at, country_source, onboarding_completed')
    .eq('user_id', userId)
    .maybeSingle<ProfileCountryRow>();

  const empty = {
    countryOfResidence: null,
    countryConfirmedAt: null,
    countrySource: null,
    onboardingCompleted: false,
    experienceLevel: null,
  };

  if (error) {
    return { state: 'DB_ERROR', ...empty };
  }
  if (!profile) {
    // Should be structurally rare — 0002_module1.sql's handle_new_user
    // trigger creates this row synchronously at signup — but a defensive,
    // distinct state per spec 5.5 rather than silently treating it as
    // COUNTRY_MISSING (a missing profile is a different failure mode from a
    // present profile with no country yet).
    return { state: 'PROFILE_INCOMPLETE', ...empty };
  }

  const base = {
    countryOfResidence: profile.country_of_residence,
    countryConfirmedAt: profile.country_confirmed_at,
    countrySource: (profile.country_source as CountrySource | null) ?? null,
    onboardingCompleted: profile.onboarding_completed === true,
    experienceLevel: null,
  };

  const shape = classifyCountryValue(profile.country_of_residence);
  if (shape === 'MISSING') return { state: 'COUNTRY_MISSING', ...base };
  if (shape === 'INVALID') return { state: 'COUNTRY_INVALID', ...base };
  if (shape === 'UNSUPPORTED') return { state: 'COUNTRY_UNSUPPORTED', ...base };

  // shape === 'SUPPORTED' — the value itself is fine; confirmation is a
  // separate, explicit fact that a well-formed/legacy value must never
  // substitute for (spec 5.1 — pre-filled AU in the existing onboarding
  // wizard is exactly the case this guards against).
  if (!profile.country_confirmed_at) return { state: 'COUNTRY_UNCONFIRMED', ...base };

  // ---------------------------------------------------------------------
  // G3 — server-derived registry authority (spec section 6.3)
  // ---------------------------------------------------------------------
  // Everything above is unchanged pre-G3 behaviour. What follows only ever
  // NARROWS the outcome: a state that was already blocking stays blocking,
  // and the sole previously-passing case (a confirmed AU/IN user) can only
  // reach CONFIRMED, because AU and IN are FULL in the registry. No existing
  // AU/IN user's classification changes.
  const country = profile.country_of_residence!.trim().toUpperCase();
  const registry = await loadCountryRegistrySnapshot(supabase);
  if (!registry) {
    // Registry unreadable. Fails CLOSED, and as an OPERATIONAL failure
    // rather than a user-facing denial — the same discipline as the DB_ERROR
    // path above, and for the same MCC-12 reason: an unresolved gate must
    // never be treated as a pass.
    return { state: 'DB_ERROR', ...base };
  }

  const entry = registry.get(country);
  if (!isRegistrationPermitted(entry)) {
    return { state: 'COUNTRY_REGISTRATION_NOT_PERMITTED', ...base, experienceLevel: entry?.experienceLevel ?? null };
  }

  return { state: 'CONFIRMED', ...base, experienceLevel: entry!.experienceLevel };
}

/**
 * G3 spec section 10 — the interim pre-G4 boundary, as one shared decision.
 *
 * G4's application-wide capability layer does not exist yet, so the app still
 * exposes AU/IN domestic modules indiscriminately to anyone who gets past the
 * country gate. A GENERIC-experience user must therefore be admitted to the
 * genuinely universal surfaces (their profile, their currency choice, their
 * cross-border declarations, account management) and held out of everything
 * else until G4 certifies it.
 *
 * This function does NOT enumerate what is blocked. It enumerates what is
 * ALLOWED, and everything absent from that list is blocked — the fail-closed
 * direction. "Do not assume that every existing module is universal" (spec
 * section 10) is honoured by construction: a module added tomorrow is blocked
 * for generic users until someone deliberately adds it here.
 */
export function isGenericExperienceRestricted(gate: CountryGateResult, allowGeneric: boolean): boolean {
  return gate.state === 'CONFIRMED' && gate.experienceLevel === 'GENERIC' && !allowGeneric;
}

/**
 * G3 section 6.2 — the landing handoff, as one pure function.
 *
 * Decides which option the confirmation selector STARTS on. It does not
 * confirm anything, does not narrow the offered list, and its result is
 * always a value the user must still operate a control and submit to act on.
 *
 * Extracted here rather than left inline in ConfirmCountryForm.tsx precisely
 * so scenario G3-14 (a forged AU landing cookie against a user whose account
 * says IN) is directly testable, instead of only observable by driving a
 * browser.
 *
 * Precedence, highest authority first:
 *   1. A country already ON THE ACCOUNT that is genuinely offered. This is
 *      the user's own recorded value and outranks any cookie.
 *   2. The G2 landing bucket, but only when it names a real country. 'GLOBAL'
 *      is not a country and preselects NOTHING — a Global visitor must
 *      actively state where they live.
 *   3. Nothing.
 */
export function resolveConfirmCountryPreselect(params: {
  currentCountry: string | null;
  landingBucket: 'AU' | 'IN' | 'GLOBAL' | null;
  offeredCountries: readonly string[];
}): string {
  const { currentCountry, landingBucket, offeredCountries } = params;
  if (currentCountry && offeredCountries.includes(currentCountry)) return currentCountry;
  if ((landingBucket === 'AU' || landingBucket === 'IN') && offeredCountries.includes(landingBucket)) {
    return landingBucket;
  }
  return '';
}

export function isBlockingState(state: CountryGateState): boolean {
  return state !== 'CONFIRMED';
}

// MCC-12 fix (round-4 closure, 2026-08-29 live-DEV certification). Extracted
// as its own pure, directly unit-testable function rather than left inline in
// app/(app)/layout.tsx, because the bug it fixes was exactly that inline
// condition failing open.
//
// The original layout condition was:
//   if (gate.state !== 'CONFIRMED' && gate.onboardingCompleted) redirect(...)
// Both DB_ERROR and PROFILE_INCOMPLETE construct their result from the same
// `empty` shape above, which hardcodes `onboardingCompleted: false`. That
// made the condition evaluate to `false` for those two states no matter what
// — a transient database/read error, or a structurally-rare missing profile
// row, silently fell through to <AppShell>{children}</AppShell> (real
// financial data) instead of being blocked. This was found live on DEV when
// the migration lagged the code (see closure report Issue Register, MCC-12):
// the classifier's own DB_ERROR path was reachable simply by the profile
// query failing, with no attacker action required.
//
// Neither DB_ERROR nor PROFILE_INCOMPLETE can be positively classified as
// CONFIRMED, so both must fail CLOSED regardless of the onboarding flag —
// unlike a legitimate mid-onboarding user (who proxy.ts already confines to
// /onboarding, so this only matters as defense in depth), an operational
// failure to read the profile is never evidence that showing the onboarding
// wizard instead of the country gate is safe.
export function shouldRedirectToConfirmCountry(gate: CountryGateResult): boolean {
  if (gate.state === 'DB_ERROR' || gate.state === 'PROFILE_INCOMPLETE') return true;
  // G3: GENERIC_EXPERIENCE_RESTRICTED is never produced by
  // assertCountryConfirmedForUser() (which reports the honest CONFIRMED
  // state and lets the caller decide), but if a caller ever constructs one,
  // it must NOT come here — the user's country is confirmed and correct;
  // sending them to /confirm-country would be untrue and would loop.
  if (gate.state === 'GENERIC_EXPERIENCE_RESTRICTED') return false;
  return gate.state !== 'CONFIRMED' && gate.onboardingCompleted;
}

// Stable, UI-handleable error codes (spec 5.5) — kept separate from the
// internal CountryGateState names so route responses never leak internal
// state names by accident if this module's states are ever renamed.
export const COUNTRY_GATE_ERROR_CODE: Record<Exclude<CountryGateState, 'CONFIRMED'>, string> = {
  PROFILE_INCOMPLETE: 'PROFILE_INCOMPLETE',
  COUNTRY_MISSING: 'COUNTRY_CONFIRMATION_REQUIRED',
  COUNTRY_UNCONFIRMED: 'COUNTRY_CONFIRMATION_REQUIRED',
  COUNTRY_UNSUPPORTED: 'COUNTRY_UNSUPPORTED',
  COUNTRY_INVALID: 'COUNTRY_INVALID',
  COUNTRY_REGISTRATION_NOT_PERMITTED: 'COUNTRY_REGISTRATION_NOT_PERMITTED',
  GENERIC_EXPERIENCE_RESTRICTED: 'GENERIC_EXPERIENCE_RESTRICTED',
  DB_ERROR: 'OPERATIONAL_ERROR',
};

export const COUNTRY_GATE_HTTP_STATUS: Record<Exclude<CountryGateState, 'CONFIRMED'>, number> = {
  PROFILE_INCOMPLETE: 403,
  COUNTRY_MISSING: 403,
  COUNTRY_UNCONFIRMED: 403,
  COUNTRY_UNSUPPORTED: 403,
  COUNTRY_INVALID: 422,
  COUNTRY_REGISTRATION_NOT_PERMITTED: 403,
  GENERIC_EXPERIENCE_RESTRICTED: 403,
  DB_ERROR: 500,
};

// Round 2 closure (MCC-2/MCC-7): the ONE shared helper every server-side
// entry point uses to turn a classification into "should this request be
// blocked, and with what response" — added so `lib/api.ts`'s
// `requireCountryConfirmedUser()`, `lib/services/adminAuth.ts`'s
// `requireAdmin()`, the 39 Resources admin routes (which have no shared
// auth wrapper at all — each does its own inline `getUser()` check, per
// docs/admin/FHIP_Admin_Module_Discovery_Report_2026-08-29.md's own finding)
// and `app/api/household/route.ts` all resolve "blocked or not" identically,
// rather than five slightly-different reimplementations of the same
// onboarding-exemption + state-to-response mapping. Deliberately does NOT
// import `bad()` from `lib/api.ts` (which itself imports from this module)
// to avoid a circular import — the one-line JSON error shape is duplicated
// here instead of shared, which is a smaller risk than a circular module
// dependency between the two files every other guard relies on.
function countryGateErrorResponse(state: Exclude<CountryGateState, 'CONFIRMED'>): Response {
  return Response.json({ error: COUNTRY_GATE_ERROR_CODE[state] }, { status: COUNTRY_GATE_HTTP_STATUS[state] });
}

// Mandatory Country Confirmation, round-3 closure (Gap 1) — this API-layer
// guard used to carry the IDENTICAL unscoped defect the database trigger
// had: `if (!gate.onboardingCompleted) return null;` exempted EVERY route
// that called this helper (all 241 of them) whenever onboarding_completed
// was false, not just the one legitimate case. Fixed the same way as the DB
// trigger: the exemption is now OFF by default, and must be explicitly
// opted into by the one caller that genuinely needs it —
// app/api/household/route.ts, via `{ allowDuringOnboarding: true }`. Since
// this round also moved the onboarding wizard's optional first-goal write
// out of onboarding entirely (see ConfirmCountryForm.tsx), household is now
// the ONLY route in the entire 241-route gated surface that needs this flag
// at all — every other caller (including goals/route.ts, which used to be
// exempted here too) now requires a genuinely confirmed country regardless
// of onboarding_completed.
// G3 (spec section 10) adds a SECOND, independently opt-in exemption:
// `allowGenericExperience`. Its default is `false`, which means all ~241
// routes gated by requireCountryConfirmedUser() begin refusing
// GENERIC-experience (GB/US/SG/AE) users the moment generic registration
// opens, with no per-route change and no possibility of a route being
// forgotten. Only the handful of genuinely universal endpoints a generic
// user MUST reach — their own profile, their AUD/INR reporting-currency
// choice, their cross-border declarations, the country-confirmation flow
// itself — opt in explicitly.
//
// The direction of the default is the whole point. An allowlist that must be
// added to in order to expose a surface cannot accidentally expose one; a
// blocklist that must be added to in order to protect a surface can, and
// G4 (which will replace this) has not yet certified a single module.
export async function countryConfirmationBlockResponse(
  supabase: SupabaseClient,
  userId: string,
  options: { allowDuringOnboarding?: boolean; allowGenericExperience?: boolean } = {}
): Promise<Response | null> {
  const gate = await assertCountryConfirmedForUser(supabase, userId);
  if (options.allowDuringOnboarding && !gate.onboardingCompleted && gate.state !== 'DB_ERROR' && gate.state !== 'PROFILE_INCOMPLETE') {
    return null;
  }
  if (gate.state !== 'CONFIRMED') return countryGateErrorResponse(gate.state);
  if (isGenericExperienceRestricted(gate, options.allowGenericExperience === true)) {
    return countryGateErrorResponse('GENERIC_EXPERIENCE_RESTRICTED');
  }
  return null;
}
