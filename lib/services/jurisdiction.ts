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
// G3 — Registration and Existing-User Alignment (spec section 5.3).
//
// THIS IS THE ONE CANONICAL AUTHORITATIVE COUNTRY REPRESENTATION for the
// whole application. Before G3 it was `'AU' | 'IN'`, which had become a lie:
// the G1 registry (migration 0122) already describes six countries, and G3
// opens registration to all six. A residence country read from
// user_profiles.country_of_residence can now legitimately be any of them.
//
// Deliberately derived from a single `as const` array so the runtime
// vocabulary check (isKnownCountry) and the compile-time union can never
// drift apart -- the exact failure mode that let 'AU' | 'IN' survive past
// G1.
//
// 'GLOBAL' is NOT a member and never will be: it is a G2 landing-page
// PRESENTATION bucket, not a country. lib/services/landingCountryContext.ts
// keeps its own disjoint LandingPresentationCountry type, and
// toAuthoritativeCountryCodeOrNull() there is the only bridge (GLOBAL ->
// null). The database independently makes it impossible -- every
// authoritative country column is char(2) with an FK to `countries`, and
// migration 0127 additionally forbids two-letter catch-all placeholders.
export const AUTHORITATIVE_COUNTRY_CODES = ['AU', 'IN', 'GB', 'US', 'SG', 'AE'] as const;

export type CountryCode = (typeof AUTHORITATIVE_COUNTRY_CODES)[number];

const KNOWN_COUNTRIES: readonly CountryCode[] = AUTHORITATIVE_COUNTRY_CODES;

// -----------------------------------------------------------------------------
// The FULL/GENERIC split, at the type level
// -----------------------------------------------------------------------------
// Widening CountryCode alone would have been actively dangerous: dozens of
// AU/IN domestic engines (tax, retirement, catalogue applicability, income
// bands, statement adapters) accept a "country" and would silently have
// started receiving 'GB'. G3 spec section 5.3 requires the opposite -- that
// missed AU/IN assumptions FAIL COMPILATION.
//
// So the widened CountryCode is paired with a NARROWER named type for the two
// countries that actually have domestic coverage. Every domestic call site
// keeps a FullExperienceCountryCode and must narrow explicitly, at which
// point a generic country resolves to `null` -- i.e. "unresolved" -- which
// every one of those call sites already handles fail-closed.
//
// This is a type-level restatement of the database's own two-tier model
// (migration 0127): countries.is_supported is true for AU/IN only, so the
// ~85-table MCC backstop already rejects generic-country users outright.
export const FULL_EXPERIENCE_COUNTRY_CODES = ['AU', 'IN'] as const;

export type FullExperienceCountryCode = (typeof FULL_EXPERIENCE_COUNTRY_CODES)[number];

export function isFullExperienceCountry(value: unknown): value is FullExperienceCountryCode {
  return typeof value === 'string' && (FULL_EXPERIENCE_COUNTRY_CODES as readonly string[]).includes(value);
}

/**
 * The single sanctioned narrowing from the authoritative six-country
 * vocabulary down to the two countries with domestic coverage. A GENERIC
 * country (GB/US/SG/AE) maps to `null` -- NOT to 'AU', NOT to 'IN'.
 *
 * This is the function that makes G3's mandatory negative controls
 * structurally true rather than conventionally true:
 *   - "Not IN" never becomes AU, and "not AU" never becomes IN, because
 *     neither branch of this function can produce a country it was not
 *     given.
 *   - Generic countries fail closed wherever only AU/IN rules exist,
 *     because `null` is exactly the "unresolved jurisdiction" value every
 *     such call site already refuses to act on.
 */
export function toFullExperienceCountryOrNull(
  country: CountryCode | null | undefined
): FullExperienceCountryCode | null {
  return isFullExperienceCountry(country) ? country : null;
}

// G0-JA-1 Wave 2: the five Product-Owner-approved canonical applicability
// classes (01-canonical-architecture.md S7). Metadata only -- see
// migration 0102's own comment on master_financial_items.applicability_class
// for why this never becomes a second enforcement path. Country stays a
// separate attribute always -- never folded into this value (no
// 'HOME_OR_CROSS_BORDER_COUNTRY(AU)'-style compound is ever stored).
export type ApplicabilityClass =
  | 'GLOBAL'
  | 'HOME_JURISDICTION'
  | 'HOME_OR_CROSS_BORDER_COUNTRY'
  | 'GLOBAL_WITH_JURISDICTION_VARIANT'
  | 'EXISTING_RECORD_ONLY';

// master_financial_items.category -> the table a saved row for that
// category actually lives in. Used only by the existing-record preservation
// check below (never for enforcement) -- kept here, next to the resolver it
// serves, rather than duplicated at each call site.
const CATEGORY_TABLE: Record<string, string> = {
  income: 'income_sources',
  expense: 'expense_items',
  asset: 'assets',
  liability: 'liabilities',
  investment: 'investments',
  retirement: 'retirement_accounts',
  insurance: 'insurance_policies',
};

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
 * G3: the caller's home country ONLY IF it is one of the two countries with
 * domestic coverage (AU/IN); `null` for a GENERIC-experience country
 * (GB/US/SG/AE) exactly as for a genuinely unresolved one.
 *
 * Provided so the ~8 domestic call sites that previously relied on
 * getUserHomeCountry() returning a two-value union express their narrowing
 * once, identically, rather than each inventing its own `=== 'IN' ? 'IN' :
 * 'AU'`-style fallback -- the precise defect class G3's negative controls
 * forbid. Callers that genuinely want all six countries (capability
 * resolution, registry lookups, disclosure) keep using getUserHomeCountry().
 */
export async function getUserFullExperienceHomeCountry(
  userId: string,
  supabase: SupabaseClient
): Promise<FullExperienceCountryCode | null> {
  return toFullExperienceCountryOrNull(await getUserHomeCountry(userId, supabase));
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
}): Promise<
  | { allowed: true }
  | { allowed: false; reason: string; crossBorderContextStatus?: 'not_yet_supported' }
> {
  const { userId, supabase, category, itemKey } = params;
  if (!itemKey) return { allowed: true }; // custom (non-catalogue) rows are never jurisdiction-restricted

  const { data: item } = await supabase
    .from('master_financial_items')
    .select('country_applicability, applicability_class')
    .eq('category', category)
    .eq('item_key', itemKey)
    .maybeSingle();

  // Item not found in the catalogue at all (e.g. a stale/custom key) — not
  // this function's concern; let the normal FK/validation layer handle it.
  if (!item) return { allowed: true };
  if (item.country_applicability == null) return { allowed: true }; // globally applicable, nothing to gate

  // G0-JA-1 Wave 2 — existing-record preservation (spec: new-creation
  // eligibility must be evaluated separately from, and must never block,
  // access to an already-active existing record). The generic grid save
  // flow (lib/services/registry.ts's save()) always POSTs/upserts for any
  // catalogue-linked row — including an ordinary field edit on a row a user
  // already owns — so without this check, a user whose home country changed
  // after they created a now-restricted item would be locked out of editing
  // their own pre-existing record, even though the record itself remains
  // fully valid history. Mirrors the DB-trigger precedent (migration 0084's
  // trg_retirement_accounts_smsf_au_gate), which only gates INSERT or
  // reactivation, never an ordinary update of an already-active row —
  // reactivating an archived row is deliberately NOT treated as
  // "preservation" here either, for the same reason.
  const table = CATEGORY_TABLE[category];
  if (table) {
    const { data: existing } = await supabase
      .from(table)
      .select('id')
      .eq('user_id', userId)
      .eq('master_item_key', itemKey)
      .eq('is_active', true)
      .maybeSingle();
    if (existing) return { allowed: true };
  }

  const country = await getUserHomeCountry(userId, supabase);
  if (isItemAvailableForCountry(item.country_applicability, country)) return { allowed: true };

  // G0-JA-1 Wave 2: HOME_OR_CROSS_BORDER_COUNTRY items are honestly denied
  // with a distinct, truthful status when the only reason the item is out
  // of reach is the (not yet built) cross-border-relationship store — never
  // silently treated the same as a plain HOME_JURISDICTION denial, and
  // never approximated from currency/locale/an existing item/client input.
  // A genuinely unresolved country is still a plain fail-closed denial
  // (there is no "unsupported cross-border path" to name — resolving the
  // country at all is the prerequisite for that path to even be relevant).
  if (country && item.applicability_class === 'HOME_OR_CROSS_BORDER_COUNTRY') {
    return {
      allowed: false,
      reason: `This item is available to users whose home jurisdiction is ${(item.country_applicability ?? []).join(', ')}, or who have an explicitly verified cross-border context for that jurisdiction. Cross-border context verification is not yet available in this release.`,
      crossBorderContextStatus: 'not_yet_supported',
    };
  }

  return {
    allowed: false,
    reason: `This item is only available to users whose home jurisdiction is ${(item.country_applicability ?? []).join(', ')}.`,
  };
}

// =============================================================================
// G1 Country Foundation (migration 0122) — canonical resolver extension.
//
// Everything below reads the G1 schema (countries registry, country_
// capabilities, user_profiles.primary_country/billing_country,
// cross_border_relationships) additively. It never changes the meaning of
// getUserHomeCountry()/isItemAvailableForCountry()/
// assertItemCreationAllowedForUser() above, which remain the sole authority
// for residence-based catalogue applicability. This section adds a second,
// wider typed result (ResolvedCountryContext) for the broader G1 concepts
// (primary country, base currency, locale, billing, cross-border, experience
// level, capabilities, provenance) spec section 18 requires — extending the
// existing canonical service rather than creating a competing one.
// =============================================================================

export type ExperienceLevel = 'FULL' | 'GENERIC' | 'UNAVAILABLE';

// The exact provenance vocabulary spec section 18 names. CONFIRMED_PROFILE
// covers both residence and (explicitly, separately) primary/billing
// confirmation — never conflated with a lower-authority signal.
export type CountryProvenance =
  | 'CONFIRMED_PROFILE'
  | 'EXPLICIT_PRIMARY_SELECTION'
  | 'ANONYMOUS_SELECTION'
  | 'DETECTED_REQUEST'
  | 'PLATFORM_DEFAULT'
  | 'UNRESOLVED';

export interface CrossBorderRelationshipSummary {
  countryCode: string;
  relationshipType: string;
  status: 'ACTIVE' | 'ENDED';
}

export interface ResolvedCountryContext {
  residenceCountry: CountryCode | null;
  residenceConfirmed: boolean;
  primaryCountry: string | null;
  primaryCountryProvenance: CountryProvenance;
  baseCurrency: string | null;
  locale: string | null;
  billingCountry: string | null;
  billingConfirmed: boolean;
  crossBorderCountries: CrossBorderRelationshipSummary[];
  experienceLevel: ExperienceLevel;
  capabilities: Record<string, boolean>;
}

const ALL_CAPABILITY_KEYS = [
  'REGISTRATION',
  'UNIVERSAL_MODULES',
  'DOMESTIC_CALCULATIONS',
  'DOMESTIC_RETIREMENT',
  'DOMESTIC_TAX_OUTPUTS',
  'CROSS_BORDER_RELATIONSHIPS',
  'LOCALISED_RESOURCES',
  'LOCALISED_REPORTS',
  'APPROVED_BILLING',
  'APPROVED_PRICING',
  'FX_CONVERSION',
  'REGULATORY_GUIDANCE',
  'COUNTRY_SPECIFIC_CATALOGUE_ITEMS',
] as const;

function emptyCapabilities(): Record<string, boolean> {
  return Object.fromEntries(ALL_CAPABILITY_KEYS.map((k) => [k, false]));
}

/**
 * The G1 canonical context resolver (spec section 18). Reads ONLY
 * authenticated-user-owned rows (RLS-scoped via the caller's own Supabase
 * client) plus world-readable registry data — never trusts a client-supplied
 * country for anything beyond the ANONYMOUS/DETECTED provenance values,
 * which this function never returns itself (it always resolves the
 * AUTHENTICATED case; anonymous/detected resolution belongs to G2's
 * request-level middleware, not this per-user service). No lower-authority
 * signal (anonymous/detected/default) ever populates a higher-authority
 * field here — this function simply has no anonymous/detected inputs to
 * leak in the first place.
 */
export async function resolveCountryContext(
  userId: string,
  supabase: SupabaseClient
): Promise<ResolvedCountryContext> {
  const { data: profile } = await supabase
    .from('user_profiles')
    .select(
      'country_of_residence, country_confirmed_at, primary_country, primary_country_source, preferred_currency, billing_country, billing_country_confirmed_at'
    )
    .eq('user_id', userId)
    .maybeSingle();

  const residenceCountry = isKnownCountry(profile?.country_of_residence) ? profile!.country_of_residence : null;
  const residenceConfirmed = Boolean(profile?.country_confirmed_at) && residenceCountry !== null;

  // Effective primary country (spec section 6.4: "initially derived from
  // confirmed residence where appropriate"): an explicit stored value always
  // wins; otherwise fall back LIVE to confirmed residence for read purposes
  // — this is what lets a user created after migration 0122's one-time
  // backfill still resolve a sensible primary country without a second
  // write-time hook. An unconfirmed residence never substitutes here (fails
  // to UNRESOLVED, matching every other fail-closed rule in this file).
  const storedPrimary = profile?.primary_country ?? null;
  let primaryCountry: string | null = storedPrimary;
  let primaryCountryProvenance: CountryProvenance = 'UNRESOLVED';
  if (storedPrimary) {
    primaryCountryProvenance =
      profile?.primary_country_source === 'USER_CONFIRMED' ? 'EXPLICIT_PRIMARY_SELECTION' : 'CONFIRMED_PROFILE';
  } else if (residenceConfirmed) {
    primaryCountry = residenceCountry;
    primaryCountryProvenance = 'CONFIRMED_PROFILE';
  }

  const billingCountry = profile?.billing_country ?? null;
  const billingConfirmed = Boolean(profile?.billing_country_confirmed_at) && billingCountry !== null;

  let registryRow: { experience_level?: string | null; default_locale?: string | null } | null = null;
  if (primaryCountry) {
    const { data } = await supabase
      .from('countries')
      .select('experience_level, default_locale')
      .eq('country_code', primaryCountry)
      .maybeSingle();
    registryRow = data;
  }
  const experienceLevel: ExperienceLevel =
    registryRow?.experience_level === 'FULL' || registryRow?.experience_level === 'GENERIC'
      ? registryRow.experience_level
      : 'UNAVAILABLE';

  const capabilities = emptyCapabilities();
  if (primaryCountry) {
    const { data: capRows } = await supabase
      .from('country_capabilities')
      .select('capability, enabled')
      .eq('country_code', primaryCountry);
    for (const row of capRows ?? []) {
      if (row.capability in capabilities) capabilities[row.capability] = Boolean(row.enabled);
    }
  }

  const { data: cbRows } = await supabase
    .from('cross_border_relationships')
    .select('country_code, relationship_type, status')
    .eq('user_id', userId)
    .eq('status', 'ACTIVE');
  const crossBorderCountries: CrossBorderRelationshipSummary[] = (cbRows ?? []).map((r) => ({
    countryCode: r.country_code,
    relationshipType: r.relationship_type,
    status: 'ACTIVE',
  }));

  return {
    residenceCountry,
    residenceConfirmed,
    primaryCountry,
    primaryCountryProvenance,
    baseCurrency: profile?.preferred_currency ?? null,
    locale: registryRow?.default_locale ?? null,
    billingCountry,
    billingConfirmed,
    crossBorderCountries,
    experienceLevel,
    capabilities,
  };
}
