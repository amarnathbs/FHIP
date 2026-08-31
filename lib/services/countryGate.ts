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
import { COUNTRY_OPTIONS, type CountryCode } from '@/lib/constants';

export const SUPPORTED_COUNTRY_CODES: readonly CountryCode[] = COUNTRY_OPTIONS.map((o) => o.value);

export type CountrySource = 'USER_CONFIRMED' | 'ADMIN_CORRECTED';

// The 7 states section 5.2/5.5 requires to be held distinct — never
// flattened into a generic success/failure boolean.
export type CountryGateState =
  | 'PROFILE_INCOMPLETE'
  | 'COUNTRY_MISSING'
  | 'COUNTRY_UNCONFIRMED'
  | 'COUNTRY_UNSUPPORTED'
  | 'COUNTRY_INVALID'
  | 'CONFIRMED'
  | 'DB_ERROR';

export interface CountryGateResult {
  state: CountryGateState;
  countryOfResidence: string | null;
  countryConfirmedAt: string | null;
  countrySource: CountrySource | null;
  onboardingCompleted: boolean;
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
  return { state: 'CONFIRMED', ...base };
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
  DB_ERROR: 'OPERATIONAL_ERROR',
};

export const COUNTRY_GATE_HTTP_STATUS: Record<Exclude<CountryGateState, 'CONFIRMED'>, number> = {
  PROFILE_INCOMPLETE: 403,
  COUNTRY_MISSING: 403,
  COUNTRY_UNCONFIRMED: 403,
  COUNTRY_UNSUPPORTED: 403,
  COUNTRY_INVALID: 422,
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
export async function countryConfirmationBlockResponse(
  supabase: SupabaseClient,
  userId: string,
  options: { allowDuringOnboarding?: boolean } = {}
): Promise<Response | null> {
  const gate = await assertCountryConfirmedForUser(supabase, userId);
  if (options.allowDuringOnboarding && !gate.onboardingCompleted && gate.state !== 'DB_ERROR' && gate.state !== 'PROFILE_INCOMPLETE') {
    return null;
  }
  if (gate.state === 'CONFIRMED') return null;
  return countryGateErrorResponse(gate.state);
}
