// G4 — Application-Wide Capability Layer: the single server-authoritative
// capability resolver.
//
// This is the ONE place that turns a user's resolved country context (G1's
// resolveCountryContext(), lib/services/jurisdiction.ts) into a per-module
// ENABLED / EXISTING_RECORD_ONLY / UNAVAILABLE decision. It reuses the G1
// registry data verbatim (country_capabilities, via resolveCountryContext())
// and never introduces a second capability store or a second definition of
// "known country" / "experience level" — see jurisdiction.ts and
// countryGate.ts for those.
//
// Deliberately does NOT replace the pre-existing route-level gates
// (requireCountryConfirmedUser / requireCountryConfirmedUserAllowingGeneric,
// lib/api.ts) wholesale — those remain the fail-closed default for every
// route that has not been individually migrated onto this resolver (see this
// module's own manifest comment below for exactly which routes have). This
// keeps ~200+ pre-existing gated routes byte-identical while giving newly
// migrated routes and the authenticated navigation a governed, testable,
// three-state model instead of a single allow/deny boolean.
//
// Behind the G4 feature flag (lib/services/appCapabilityFlag.ts): while OFF,
// requireModuleCapability() falls back to EXACTLY the pre-existing
// requireCountryConfirmedUser() behaviour (GENERIC refused, FULL admitted
// unconditionally) for every module, so turning the flag off restores exact
// G3 containment with no data changes either way (dispatch section 9).
import type { SupabaseClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';
import { bad } from '@/lib/api';
import {
  resolveCountryContext,
  type ResolvedCountryContext,
} from '@/lib/services/jurisdiction';
import { countryConfirmationBlockResponse } from '@/lib/services/countryGate';
import { isG4CapabilityLayerEnabled } from '@/lib/services/appCapabilityFlag';

// The exact G1 registry vocabulary (migration 0122) — re-exported as a type
// here rather than redefined, so this file and jurisdiction.ts/countryGate.ts
// can never silently drift onto two different capability-key lists.
export const CAPABILITY_KEYS = [
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

export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];

export type CapabilityDecision = 'ENABLED' | 'EXISTING_RECORD_ONLY' | 'UNAVAILABLE';

// A specific, non-sensitive reason enum (dispatch section 2: "a specific
// reason enum") — never leaks a raw DB error, never distinguishes
// "capability off" from "country unresolved" in a way that would let a
// client fingerprint the registry beyond what it can already read itself
// (country_capabilities is world-readable, migration 0122).
export type CapabilityUnavailableReason =
  | 'UNAUTHENTICATED'
  | 'COUNTRY_NOT_CONFIRMED'
  | 'NO_PRIMARY_COUNTRY'
  | 'EXPERIENCE_UNAVAILABLE'
  | 'CAPABILITY_NOT_ENABLED'
  | 'MANIFEST_ENTRY_MISSING'
  | 'METHOD_NOT_PERMITTED_FOR_EXISTING_RECORD_ONLY'
  | 'NONE';

// The complete application-inventory module list (dispatch section 5). Every
// authenticated page/API surface must map onto exactly one of these — the
// route-manifest completeness test (tests/unit/appCapabilityManifest.test.ts)
// asserts that mapping is total.
export const MODULE_KEYS = [
  'DASHBOARD',
  'INCOME',
  'EXPENSES',
  'ASSETS',
  'LIABILITIES',
  'INVESTMENTS',
  'INSURANCE',
  'GOALS',
  'SCORES',
  'DNA',
  'RESILIENCE',
  'FINANCIAL_TWIN',
  'FORECASTING',
  'RECOMMENDATIONS',
  'REPORTS',
  'RESOURCES',
  'FINANCIAL_DATA_HUB',
  'RETIREMENT',
  'SMSF',
  'INVESTMENT_INTELLIGENCE',
  'CROSS_BORDER',
  'PROFILE',
  'SUBSCRIPTION_PRICING',
  'AI_INSIGHTS',
  'ADMIN',
] as const;

export type ModuleKey = (typeof MODULE_KEYS)[number];

export interface ModuleCapabilityRule {
  key: ModuleKey;
  label: string;
  /** The single G1 capability this module's ENABLED decision is keyed on.
   * Never a broader capability standing in for a narrower one (dispatch
   * section 4) — e.g. Retirement/SMSF key on DOMESTIC_RETIREMENT, not on
   * UNIVERSAL_MODULES, even though UNIVERSAL_MODULES is also true for AU/IN. */
  requiredCapability: CapabilityKey;
  /** Existing-record preservation (dispatch section 2/7): when true, a user
   * who already has active rows for this module keeps read access even when
   * the capability is not currently enabled for their present primary
   * country (e.g. after a primary-country change away from AU/IN). Modules
   * with no meaningful "existing record" (Dashboard, Profile, Resources) set
   * this false. */
  supportsExistingRecordPreservation: boolean;
  /** Documentation only — which G0-JA-1/G3/G4 classification note this
   * module's treatment. Not read by any resolver logic. */
  note: string;
}

// =============================================================================
// THE MANIFEST — dispatch section 8: "require an explicit capability-mapping
// entry for every opt-in (a missing manifest entry means unavailable)".
//
// Every entry below was classified from direct read-site evidence (grep +
// read across app/(app)/**, app/api/**, lib/services/**, lib/grid/configs.ts,
// lib/validation/**) during this G4 pass, not assumed. See this task's own
// closure report for the full per-module evidence trail. A module is only
// ever marked with a capability narrower than UNIVERSAL_MODULES when a real,
// cited domestic assumption was found (a hardcoded 'AU'/'IN' branch, a
// literal ['AU','IN'] country_code enum, a currency-derived-country default,
// AU/IN-only labels or a missing per-item jurisdiction gate on a
// catalogue-linked table) — "renders for a GENERIC user" alone was never
// treated as evidence of universality (dispatch section 5).
// =============================================================================
export const APP_CAPABILITY_MANIFEST: Record<ModuleKey, ModuleCapabilityRule> = {
  // -- Confirmed genuinely universal (G4 evidence pass) --------------------
  INCOME: {
    key: 'INCOME',
    label: 'Income',
    requiredCapability: 'UNIVERSAL_MODULES',
    supportsExistingRecordPreservation: true,
    note: 'No country_code/currency_code field on income_sources or its grid config. Two AU-only catalogue items (age_pension, family_tax_benefit) are already independently gated per-row by assertItemCreationAllowedForUser(), which fails closed for a GENERIC (null-country) caller — this module-level ENABLED decision does not bypass that existing per-item gate.',
  },
  EXPENSES: {
    key: 'EXPENSES',
    label: 'Expenses',
    requiredCapability: 'UNIVERSAL_MODULES',
    supportsExistingRecordPreservation: true,
    note: 'No country_code/currency_code field anywhere in expenseGridConfig, validation, or its API routes. No catalogue-item jurisdiction gate exists or is needed (no AU/IN-restricted expense item found).',
  },
  INSURANCE: {
    key: 'INSURANCE',
    label: 'Insurance',
    requiredCapability: 'UNIVERSAL_MODULES',
    supportsExistingRecordPreservation: true,
    note: 'No country_code/currency_code field anywhere in insuranceGridConfig, lib/validation/insurance.ts, or its API routes. No AU/IN literal found in page, config or routes.',
  },
  PROFILE: {
    key: 'PROFILE',
    label: 'Profile & account management',
    requiredCapability: 'UNIVERSAL_MODULES',
    supportsExistingRecordPreservation: false,
    note: 'Already universal by design (G3): app/api/user/profile/route.ts uses plain requireUser(), no country gate at all. Reporting-currency choice and cross-border declarations are the sanctioned G3 generic surfaces.',
  },
  CROSS_BORDER: {
    key: 'CROSS_BORDER',
    label: 'Cross-border relationship declarations',
    requiredCapability: 'CROSS_BORDER_RELATIONSHIPS',
    supportsExistingRecordPreservation: true,
    note: 'G3-sanctioned generic surface (requireCountryConfirmedUserAllowingGeneric). A declaration only, never a calculation (dispatch section 4: CROSS_BORDER_RELATIONSHIPS permits declarations, not calculations) -- lib/api.ts header comment.',
  },

  // -- Confirmed NOT universal (real domestic assumption found) — stay
  // AU/IN-only pending G5 module-classification work ----------------------
  DASHBOARD: {
    key: 'DASHBOARD',
    label: 'Dashboard',
    requiredCapability: 'DOMESTIC_CALCULATIONS',
    supportsExistingRecordPreservation: true,
    note: 'NOT universal: lib/services/dashboardData.ts hardcodes preferred_currency to (\'AUD\'|\'INR\') with an AUD fallback default, and getFxRateAudInr() bakes in a literal AU/IN FX-rate assumption (fallback 56) used in the summary hot path. Kept UNAVAILABLE for GENERIC pending G5.',
  },
  ASSETS: {
    key: 'ASSETS',
    label: 'Assets',
    requiredCapability: 'DOMESTIC_CALCULATIONS',
    supportsExistingRecordPreservation: true,
    note: 'NOT universal: country_code field hardcoded to lib/constants.ts COUNTRY_OPTIONS (AU/IN only), lib/validation/asset.ts enums country_code/currency_code to (\'AU\'|\'IN\')/(\'AUD\'|\'INR\'), and unlike Income/Liabilities, POST has NO assertItemCreationAllowedForUser call at all -- a real gap, not safe to open to GENERIC. Assigned to G5.',
  },
  LIABILITIES: {
    key: 'LIABILITIES',
    label: 'Liabilities',
    requiredCapability: 'DOMESTIC_CALCULATIONS',
    supportsExistingRecordPreservation: true,
    note: 'NOT universal: country_code/currency_code fields hardcoded to AU/IN vocabulary in lib/validation/liability.ts and its grid config, and FinancialDataGrid.tsx\'s shared currency-mismatch copy literally branches "row.country_code === \'IN\' ? India\'s : Australia\'s" (treats any non-IN value, including a hypothetical generic-country row, as Australia\'s). Assigned to G5.',
  },
  GOALS: {
    key: 'GOALS',
    label: 'Goals',
    requiredCapability: 'DOMESTIC_CALCULATIONS',
    supportsExistingRecordPreservation: true,
    note: 'NOT universal: currency type/default hardcoded to (\'AUD\'|\'INR\') with an AUD fallback in three places (goals page, buildGoalForecastInputs, computeGoalsPagePayload), and lib/validation/goal.ts hardcodes country_code to [\'AU\',\'IN\']. Assigned to G5.',
  },
  INVESTMENTS: {
    key: 'INVESTMENTS',
    label: 'Investments',
    requiredCapability: 'DOMESTIC_CALCULATIONS',
    supportsExistingRecordPreservation: true,
    note: 'NOT universal: the single most explicit AU/IN split found in the app -- a dedicated AU-only broker-statement import panel/copy, and a hardcoded IN-only routing decision to /investment-intelligence. Assigned to G5.',
  },
  RETIREMENT: {
    key: 'RETIREMENT',
    label: 'Retirement',
    requiredCapability: 'DOMESTIC_RETIREMENT',
    supportsExistingRecordPreservation: true,
    note: 'NOT universal: lib/services/retirementMemberData.ts:62 resolves countryCode via `profile?.country_of_residence === \'IN\' ? \'IN\' : \'AU\'` -- a "not IN becomes AU" fallback, a named G5-deferred defect this task must NOT fix but must keep unreachable by GENERIC users. requireCountryConfirmedUser() already refuses GENERIC before this function is ever called; this manifest entry keeps that true under the new resolver too.',
  },
  SMSF: {
    key: 'SMSF',
    label: 'SMSF',
    requiredCapability: 'DOMESTIC_RETIREMENT',
    supportsExistingRecordPreservation: true,
    note: 'AU-only by design and by DB trigger (trg_retirement_accounts_smsf_au_gate, migration 0084) -- confirmed still present. Country_capabilities has DOMESTIC_RETIREMENT=true only for AU (IN is false -- no certified India retirement-product engine per migration 0122\'s own comment), so this manifest entry is also correctly UNAVAILABLE for IN under a strict capability read; IN\'s existing (non-SMSF) retirement-member tracking is unaffected since it is served by the RETIREMENT module entry above, not this one.',
  },
  INVESTMENT_INTELLIGENCE: {
    key: 'INVESTMENT_INTELLIGENCE',
    label: 'Investment Intelligence (India)',
    requiredCapability: 'COUNTRY_SPECIFIC_CATALOGUE_ITEMS',
    supportsExistingRecordPreservation: true,
    note: 'India-only by design across R1-R6 (CAS parsing, FIFO/grandfathering CGT engine) -- not evaluated for AU or GENERIC applicability at all; out of scope for any change here.',
  },
  FORECASTING: {
    key: 'FORECASTING',
    label: 'Forecasting',
    requiredCapability: 'DOMESTIC_CALCULATIONS',
    supportsExistingRecordPreservation: true,
    note: 'Consumes Dashboard/Assets/Goals/Retirement data plus forecast_global_assumptions keyed by country_code (AU/IN) and DEFAULT_FX_RATE_AUD_INR (lib/forecast/crossBorderCalculator.ts) -- inherits the same non-universal assumptions as the modules it forecasts. Kept UNAVAILABLE for GENERIC pending G5.',
  },
  SCORES: {
    key: 'SCORES',
    label: 'Scores (Health Score)',
    requiredCapability: 'UNIVERSAL_MODULES',
    supportsExistingRecordPreservation: true,
    note: 'G4 evidence pass: lib/services/healthScoreData.ts, lib/engines/healthScore.ts and lib/engines/healthScoreEligibility.ts contain zero AU/IN/country/currency/retirement_age literals of their own -- BUT healthScoreData.ts:64 calls dashboardData.ts\'s loadDashboard(), which DOES carry the AUD-default/FX-rate-56 assumption (see the DASHBOARD entry below). This is provably inert for a GENERIC user specifically: the ~85-table MCC/G1 backstop (countries.is_supported false for every GENERIC country) makes it structurally impossible for a GENERIC user to hold ANY income/expense/asset/liability/investment/retirement row, so loadDashboard() always aggregates zero real rows for them regardless of the currency it assumes, and the FX-56 fallback is only reached when a foreign-currency row exists to convert -- which cannot happen. The score therefore renders an honest zero/no-data state for a GENERIC user, never a fabricated or misconverted figure. This reasoning does NOT extend to DASHBOARD itself, whose page also surfaces the raw currency/FX figures directly (not just a derived score), so Dashboard stays UNAVAILABLE.',
  },
  DNA: {
    key: 'DNA',
    label: 'Financial DNA',
    requiredCapability: 'UNIVERSAL_MODULES',
    supportsExistingRecordPreservation: true,
    note: 'G4 evidence pass: lib/services/financialDnaData.ts and lib/engines/financialDna.ts contain no country/currency hardcodes of their own, but financialDnaData.ts:83 calls dashboardData.ts\'s loadDashboard() the same way healthScoreData.ts does -- see the SCORES entry above for why this is provably inert (zero real rows possible) for a GENERIC user rather than a live defect.',
  },
  RESILIENCE: {
    key: 'RESILIENCE',
    label: 'Financial Resilience',
    requiredCapability: 'UNIVERSAL_MODULES',
    supportsExistingRecordPreservation: true,
    note: 'G4 evidence pass: the historical currency-derived-country defect (G0-JA-1 Wave 1) is CONFIRMED FIXED -- lib/engines/resilienceStress.ts\'s applyCurrencyShock() no longer guesses AU/IN from currency; it resolves homeCountry via the canonical getUserHomeCountry() (jurisdiction.ts) with no `?? \'AU\'` fallback, and explicitly skips the home/foreign split (fails closed) rather than fabricating one for an unresolved country. resilienceData.ts:68 also calls dashboardData.ts\'s loadDashboard() -- see the SCORES entry above for why that is provably inert (zero real rows possible) for a GENERIC user.',
  },
  FINANCIAL_TWIN: {
    key: 'FINANCIAL_TWIN',
    label: 'Financial Twin / Benchmark',
    requiredCapability: 'DOMESTIC_CALCULATIONS',
    supportsExistingRecordPreservation: true,
    note: 'Cohort-matching/benchmark engine historically AU-fallback-affected (G0-JA-1 Wave 1); not independently re-certified as country-neutral in this pass. Kept UNAVAILABLE for GENERIC pending G5.',
  },
  RECOMMENDATIONS: {
    key: 'RECOMMENDATIONS',
    label: 'Recommendations',
    requiredCapability: 'DOMESTIC_CALCULATIONS',
    supportsExistingRecordPreservation: true,
    note: 'Recommendation content library is pillar/band-triggered off the same underlying financial data; not independently re-certified as country-neutral in this pass. Kept UNAVAILABLE for GENERIC pending G5.',
  },
  REPORTS: {
    key: 'REPORTS',
    label: 'Reports',
    requiredCapability: 'LOCALISED_REPORTS',
    supportsExistingRecordPreservation: true,
    note: 'LOCALISED_REPORTS is true for AU/IN only (migration 0122) -- reports carry AU/IN-specific sections per that migration\'s own comment. Kept UNAVAILABLE for GENERIC.',
  },
  RESOURCES: {
    key: 'RESOURCES',
    label: 'Resources',
    requiredCapability: 'LOCALISED_RESOURCES',
    supportsExistingRecordPreservation: false,
    note: 'LOCALISED_RESOURCES is true for AU/IN only (migration 0122); the PUBLIC Resources site (app/(marketing)/resources/**) is unauthenticated and out of this authenticated-app scope regardless -- this entry covers only any authenticated in-app Resources surface, and G7 (Report/Resources localisation) is explicitly out of scope for G4.',
  },
  FINANCIAL_DATA_HUB: {
    key: 'FINANCIAL_DATA_HUB',
    label: 'Financial Data Hub',
    requiredCapability: 'COUNTRY_SPECIFIC_CATALOGUE_ITEMS',
    supportsExistingRecordPreservation: true,
    note: 'NOT universal: app/api/financial-data-hub/investment-statement/[documentId]/account-match/route.ts:47 hardcodes countryCode: \'AU\' -- a named G5-deferred defect this task must NOT fix but must keep unreachable by GENERIC users via this manifest entry (requireCountryConfirmedUser already refuses GENERIC before this route is ever reached).',
  },
  SUBSCRIPTION_PRICING: {
    key: 'SUBSCRIPTION_PRICING',
    label: 'Subscription / pricing',
    requiredCapability: 'APPROVED_PRICING',
    supportsExistingRecordPreservation: false,
    note: 'APPROVED_PRICING/APPROVED_BILLING are false for every country including AU/IN (migration 0122 -- "no certified AU/IN billing or FX-expansion claim"). No live billing/checkout surface currently exists in the repo behind this manifest entry; kept UNAVAILABLE for every country until a billing surface is actually built and certified.',
  },
  AI_INSIGHTS: {
    key: 'AI_INSIGHTS',
    label: 'AI Coach / Insights',
    requiredCapability: 'DOMESTIC_CALCULATIONS',
    supportsExistingRecordPreservation: false,
    note: 'Module 11\'s standard-question/insight library is triggered off the same underlying financial data as Dashboard/Scores/Recommendations; not independently re-certified as country-neutral in this pass. Kept UNAVAILABLE for GENERIC pending G5. G4 EVIDENCE-PASS FINDING (disclosed, NOT fixed here -- out of this task\'s authorised scope): 4 of its 5 API routes (standard-questions, standard-questions/[code]/resolve, contextual-explanations, contextual-explanations/resolve) resolve auth via lib/ai/household/resolveHouseholdContext.ts, which imports the PLAIN requireUser() (auth-only, no country-confirmation check) rather than requireCountryConfirmedUser() -- an authenticated-but-country-UNCONFIRMED user can reach them today. This predates G4 and is a Mandatory-Country-Confirmation completeness gap, not a G4 regression; flagged for separate remediation.',
  },
  ADMIN: {
    key: 'ADMIN',
    label: 'Admin',
    requiredCapability: 'DOMESTIC_CALCULATIONS',
    supportsExistingRecordPreservation: false,
    note: 'Not a country-experience surface at all -- admin access is governed entirely by lib/services/adminAuth.ts\'s requireAdmin()/role model, independent of country. This manifest entry exists only so the route-manifest completeness test has a home for app/(app)/admin/**; it is never used to grant or deny admin access, and a non-admin GENERIC (or AU/IN) user is refused by requireAdmin() regardless of this entry\'s value.',
  },
};

export interface ModuleCapabilityResult {
  decision: CapabilityDecision;
  reason: CapabilityUnavailableReason;
}

/**
 * Pure decision function — never touches the network itself. Given an
 * already-resolved country context (from resolveCountryContext()) and
 * whether the caller already has active existing rows for this module,
 * returns the three-state decision.
 *
 * Fail-closed rules, in order:
 *   1. No manifest entry for this module -> UNAVAILABLE (dispatch section 8:
 *      "a missing manifest entry means unavailable").
 *   2. No resolvable primary country, or the registry marks the primary
 *      country's experience UNAVAILABLE -> UNAVAILABLE (or
 *      EXISTING_RECORD_ONLY if the module supports preservation AND the
 *      caller already has rows).
 *   3. The module's required capability is not enabled for the resolved
 *      primary country -> same two-way split as above.
 *   4. Otherwise ENABLED.
 */
export function resolveModuleCapability(
  moduleKey: ModuleKey,
  context: ResolvedCountryContext,
  options: { hasExistingRecords?: boolean } = {}
): ModuleCapabilityResult {
  const rule = APP_CAPABILITY_MANIFEST[moduleKey];
  if (!rule) return { decision: 'UNAVAILABLE', reason: 'MANIFEST_ENTRY_MISSING' };

  const hasExisting = options.hasExistingRecords === true && rule.supportsExistingRecordPreservation;

  if (!context.primaryCountry) {
    return hasExisting
      ? { decision: 'EXISTING_RECORD_ONLY', reason: 'NO_PRIMARY_COUNTRY' }
      : { decision: 'UNAVAILABLE', reason: 'NO_PRIMARY_COUNTRY' };
  }

  if (context.experienceLevel === 'UNAVAILABLE') {
    return hasExisting
      ? { decision: 'EXISTING_RECORD_ONLY', reason: 'EXPERIENCE_UNAVAILABLE' }
      : { decision: 'UNAVAILABLE', reason: 'EXPERIENCE_UNAVAILABLE' };
  }

  const enabled = context.capabilities[rule.requiredCapability] === true;
  if (enabled) return { decision: 'ENABLED', reason: 'NONE' };

  return hasExisting
    ? { decision: 'EXISTING_RECORD_ONLY', reason: 'CAPABILITY_NOT_ENABLED' }
    : { decision: 'UNAVAILABLE', reason: 'CAPABILITY_NOT_ENABLED' };
}

/** Stable, non-sensitive 403 per decision — never a raw DB error. Both
 * blocking decisions (UNAVAILABLE, and EXISTING_RECORD_ONLY on an unsafe
 * method) use the same status; only the reason code differs. */
function capabilityBlockResponse(reason: CapabilityUnavailableReason): Response {
  return bad(reason, 403, reason);
}

// HTTP methods that read rather than mutate — the only ones an
// EXISTING_RECORD_ONLY decision permits (dispatch section 2: "never delete,
// rewrite... or silently reclassify a historical record" -- an
// EXISTING_RECORD_ONLY caller may look at their history but may not create,
// edit, or delete anything through this gate).
const SAFE_READ_METHODS = new Set(['GET', 'HEAD']);

/**
 * The G4 route-level guard. Mirrors the existing requireCountryConfirmedUser()
 * / requireCountryConfirmedUserAllowingGeneric() call shape from lib/api.ts
 * (`{ user, unauthenticated }`) so a migrated route's call site changes
 * minimally.
 *
 * While the G4 feature flag is OFF, this delegates to EXACTLY the legacy
 * requireCountryConfirmedUser() behaviour for every module (GENERIC refused,
 * FULL admitted unconditionally) -- dispatch section 9's "flag-off restores
 * exact G3 containment behavior".
 */
export async function requireModuleCapability(
  moduleKey: ModuleKey,
  request: Request,
  options: { hasExistingRecords?: (supabase: SupabaseClient, userId: string) => Promise<boolean> } = {}
): Promise<{ user: { id: string } | null; blocked: Response | null; decision: CapabilityDecision | null }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { user: null, blocked: bad('unauthenticated', 401), decision: null };

  if (!isG4CapabilityLayerEnabled()) {
    const block = await countryConfirmationBlockResponse(supabase, user.id);
    if (block) return { user: null, blocked: block, decision: null };
    return { user, blocked: null, decision: 'ENABLED' };
  }

  const gateBlock = await countryConfirmationBlockResponse(supabase, user.id, { allowGenericExperience: true });
  if (gateBlock) return { user: null, blocked: gateBlock, decision: null };

  const context = await resolveCountryContext(user.id, supabase);
  const hasExistingRecords = options.hasExistingRecords ? await options.hasExistingRecords(supabase, user.id) : false;
  const result = resolveModuleCapability(moduleKey, context, { hasExistingRecords });

  if (result.decision === 'UNAVAILABLE') {
    return { user: null, blocked: capabilityBlockResponse(result.reason), decision: result.decision };
  }
  if (result.decision === 'EXISTING_RECORD_ONLY' && !SAFE_READ_METHODS.has(request.method)) {
    return {
      user: null,
      blocked: capabilityBlockResponse('METHOD_NOT_PERMITTED_FOR_EXISTING_RECORD_ONLY'),
      decision: result.decision,
    };
  }

  return { user, blocked: null, decision: result.decision };
}
