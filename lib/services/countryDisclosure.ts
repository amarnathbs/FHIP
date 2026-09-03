// G3 — FULL versus GENERIC coverage disclosure (spec section 7).
//
// THE SINGLE SOURCE OF THE DISCLOSURE TEXT. The registration UI renders it,
// the confirm API validates the acknowledged version against it, and the
// user_profiles.generic_disclosure_version column stores whichever version
// the user actually agreed to. Keeping the copy here (rather than inline in
// a component) is what makes "record the disclosure version acknowledged"
// meaningful: the stored string can be resolved back to exact wording.
//
// VERSIONING RULE: bump GENERIC_DISCLOSURE_VERSION whenever the SUBSTANCE of
// the generic-coverage statement changes. A previously-stored version string
// is never rewritten or migrated — an old acknowledgement remains a true
// record of what that user was actually shown.
import type { CountryCode, ExperienceLevel } from '@/lib/services/jurisdiction';

export const GENERIC_DISCLOSURE_VERSION = 'g3-generic-coverage-2026-09';

/**
 * The exact wording a GENERIC-country user must explicitly acknowledge.
 *
 * Written to satisfy spec section 7.2's honesty requirements literally: it
 * promises universal functionality only, and it names each category of thing
 * that is NOT available rather than hiding behind "some features may vary".
 */
export const GENERIC_DISCLOSURE_BODY =
  'Global coverage provides jurisdiction-neutral financial-health tools. Local tax, ' +
  'retirement, regulatory and country-specific calculations are not currently available ' +
  'for your country.';

export const GENERIC_DISCLOSURE_POINTS: readonly string[] = [
  'Universal financial-health functionality only.',
  'You choose AUD or INR as your reporting currency. This is a presentation choice, not a statement about where you live.',
  'No local tax calculation.',
  'No local retirement calculation.',
  'No local regulatory guidance.',
  'No locally certified pricing or checkout.',
  'No Australian or Indian domestic functionality is applied to your account.',
  'You may declare cross-border relationships, but no cross-border calculations are performed yet.',
];

export const GENERIC_DISCLOSURE_ACKNOWLEDGEMENT_LABEL =
  'I understand that FHIP does not currently provide local tax, retirement, regulatory or ' +
  'country-specific calculations for my country, and I confirm this is genuinely my country of residence.';

/**
 * What a FULL-experience (AU/IN) user is told.
 *
 * Deliberately does NOT claim comprehensive domestic coverage. Spec section
 * 7.1 is explicit: "Do not state that India retirement products exist if
 * EPF/PPF/NPS remain unimplemented. Do not state that all Australian tax
 * outputs are certified if the registry says otherwise." Both of those are
 * currently true in the registry (IN has DOMESTIC_RETIREMENT = false; NEITHER
 * AU nor IN has APPROVED_BILLING/APPROVED_PRICING, and AU has
 * DOMESTIC_TAX_OUTPUTS = false), so this copy promises only that
 * country-specific functionality exists *where enabled*, and points at the
 * registry as the authority rather than restating it.
 */
export const FULL_DISCLOSURE_BODY =
  'Your country has a full FHIP experience: universal financial-health features plus the ' +
  'country-specific functionality currently enabled for it. Not every domestic calculation ' +
  'exists for every product — only the capabilities actually enabled for your country apply.';

export interface CountryCoverageDisclosure {
  experienceLevel: ExperienceLevel;
  headline: string;
  body: string;
  points: readonly string[];
  /** Only a GENERIC country requires an explicit tick before confirmation. */
  requiresAcknowledgement: boolean;
  /** The version string an acknowledgement will be recorded under, or null. */
  version: string | null;
  acknowledgementLabel: string | null;
}

/**
 * Builds the disclosure for a server-derived experience level.
 *
 * Takes an ExperienceLevel, never a country code and never a client-supplied
 * flag — the caller must already have resolved the level FROM THE REGISTRY.
 * That keeps this module incapable of being the place where a forged
 * experience level sneaks in.
 */
export function buildCoverageDisclosure(
  experienceLevel: ExperienceLevel,
  countryLabel: string
): CountryCoverageDisclosure {
  if (experienceLevel === 'FULL') {
    return {
      experienceLevel,
      headline: `Full experience for ${countryLabel}`,
      body: FULL_DISCLOSURE_BODY,
      points: [
        'Universal financial-health features.',
        'The country-specific functionality currently enabled for your country.',
        'Your reporting currency is a separate choice — you may report in AUD or INR.',
      ],
      requiresAcknowledgement: false,
      version: null,
      acknowledgementLabel: null,
    };
  }

  if (experienceLevel === 'GENERIC') {
    return {
      experienceLevel,
      headline: `Global experience for ${countryLabel}`,
      body: GENERIC_DISCLOSURE_BODY,
      points: GENERIC_DISCLOSURE_POINTS,
      requiresAcknowledgement: true,
      version: GENERIC_DISCLOSURE_VERSION,
      acknowledgementLabel: GENERIC_DISCLOSURE_ACKNOWLEDGEMENT_LABEL,
    };
  }

  // UNAVAILABLE — spec section 5.2's honest unavailable state. Critically,
  // this offers no way forward: there is no acknowledgement to tick, and the
  // copy actively warns against picking a different country to get in.
  return {
    experienceLevel: 'UNAVAILABLE',
    headline: 'Not yet available for your country',
    body:
      "FHIP's authenticated experience is not yet available for your country. You may review " +
      'the public Global information, but do not select another country unless it is genuinely ' +
      'your residence.',
    points: [],
    requiresAcknowledgement: false,
    version: null,
    acknowledgementLabel: null,
  };
}

/**
 * Is this acknowledgement good enough to confirm `country` right now?
 *
 * Used by the confirm API. A FULL country needs no acknowledgement. A GENERIC
 * country needs one whose version string matches the CURRENT version exactly
 * — an acknowledgement of superseded wording is not an acknowledgement of the
 * current wording, and silently accepting it would defeat the point of
 * versioning at all.
 */
export function isDisclosureAcknowledgementValid(params: {
  experienceLevel: ExperienceLevel;
  acknowledgedVersion: string | null | undefined;
}): boolean {
  if (params.experienceLevel === 'FULL') return true;
  if (params.experienceLevel !== 'GENERIC') return false;
  return params.acknowledgedVersion === GENERIC_DISCLOSURE_VERSION;
}

/** Display labels for the six authoritative countries. */
export const COUNTRY_LABELS: Record<CountryCode, string> = {
  AU: 'Australia',
  IN: 'India',
  GB: 'United Kingdom',
  US: 'United States',
  SG: 'Singapore',
  AE: 'United Arab Emirates',
};
