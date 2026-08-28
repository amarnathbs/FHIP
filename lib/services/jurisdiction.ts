import type { SupabaseClient } from '@supabase/supabase-js';

// GEO-1 Applicability Model — reusable helper so no future module hard-codes
// its own `if (country === 'Australia')` check (spec s.13-17). Canonical
// home-jurisdiction field, resolved by direct read-site tracing across the
// whole app (lib/validation/profile.ts, lib/services/twinData.ts,
// lib/services/retirementMemberData.ts, lib/services/recommendationsData.ts,
// lib/services/forecastData.ts, lib/services/reportSnapshotResolver.ts,
// lib/engines/twin/metricDerivation.ts, app/(app)/dashboard/page.tsx):
// user_profiles.country_of_residence. households.primary_country exists but
// is only ever WRITTEN as a one-way copy of country_of_residence at
// onboarding time (app/(onboarding)/onboarding/OnboardingWizard.tsx) and is
// never independently read for any logic branch — it is not a second
// source of truth, so this module deliberately never reads it.
//
// Only AU/IN are seeded/zod-enforced today (lib/validation/profile.ts:
// z.enum(['AU', 'IN'])); this type is written to extend cleanly if that
// ever grows without becoming a breaking change at every call site.
export type CountryCode = 'AU' | 'IN';

const KNOWN_COUNTRIES: readonly CountryCode[] = ['AU', 'IN'];

// Exported (G0-JA-1 Wave 1, JA-D1/JA-D2) so every module resolving a home
// country from a raw/untrusted value (a DB column, a forged request body)
// applies the exact same fail-closed vocabulary check as this file's own
// getUserHomeCountry() — never a second, silently-drifting definition of
// "known country" duplicated elsewhere.
export function isKnownCountry(value: unknown): value is CountryCode {
  return typeof value === 'string' && (KNOWN_COUNTRIES as readonly string[]).includes(value);
}

/**
 * The user's canonical home jurisdiction, or null if it genuinely isn't set
 * yet (e.g. onboarding incomplete) or holds a value this app doesn't
 * recognise. Deliberately does NOT default to 'AU' — several other
 * display-only call sites in the app do (`?? 'AU'`) as a UX convenience for
 * incomplete profiles, but a security-relevant gate must fail closed: an
 * unresolved jurisdiction must never be treated as if it were AU.
 */
export async function getUserHomeCountry(
  userId: string,
  supabase: SupabaseClient
): Promise<CountryCode | null> {
  const { data } = await supabase
    .from('user_profiles')
    .select('country_of_residence')
    .eq('user_id', userId)
    .maybeSingle();
  return isKnownCountry(data?.country_of_residence) ? data.country_of_residence : null;
}

/**
 * GEO-1: does a catalogue item's country_applicability allow creation for a
 * given (possibly unresolved) home country? NULL applicability = globally
 * applicable. A null/unresolved country is only ever allowed against
 * globally-applicable items — never against a jurisdiction-restricted one
 * (fail closed, matches the DB-level trigger's own fail-closed behaviour).
 */
export function isItemAvailableForCountry(
  countryApplicability: readonly string[] | null | undefined,
  country: CountryCode | null
): boolean {
  if (!countryApplicability || countryApplicability.length === 0) return true;
  if (!country) return false;
  return countryApplicability.includes(country);
}

/**
 * Server-side creation gate for any catalogue-linked row (spec s.6-7,
 * s.33). Reads the item's country_applicability directly from
 * master_financial_items and compares against the caller's own resolved
 * home country — never a client-supplied one. This is the app-layer half of
 * defence-in-depth; the DB-level backstop for retirement_accounts/'smsf'
 * specifically is trg_retirement_accounts_smsf_au_gate (migration 0084),
 * which rejects a forged direct PostgREST request even if this check were
 * ever bypassed or a future code path forgot to call it.
 */
export async function assertItemCreationAllowedForUser(params: {
  userId: string;
  supabase: SupabaseClient;
  category: string;
  itemKey: string | null | undefined;
}): Promise<{ allowed: true } | { allowed: false; reason: string }> {
  const { userId, supabase, category, itemKey } = params;
  if (!itemKey) return { allowed: true }; // custom (non-catalogue) rows are never jurisdiction-restricted

  const { data: item } = await supabase
    .from('master_financial_items')
    .select('country_applicability')
    .eq('category', category)
    .eq('item_key', itemKey)
    .maybeSingle();

  // Item not found in the catalogue at all (e.g. a stale/custom key) — not
  // this function's concern; let the normal FK/validation layer handle it.
  if (!item) return { allowed: true };
  if (isItemAvailableForCountry(item.country_applicability, null) && item.country_applicability == null) {
    return { allowed: true };
  }

  const country = await getUserHomeCountry(userId, supabase);
  if (isItemAvailableForCountry(item.country_applicability, country)) return { allowed: true };

  return {
    allowed: false,
    reason: `This item is only available to users whose home jurisdiction is ${(item.country_applicability ?? []).join(', ')}.`,
  };
}
