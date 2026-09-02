import type { SupportedCurrency } from '@/lib/engines/fx';

// Mandatory Country Confirmation, round-3 closure (Gap 1) — the sessionStorage
// key OnboardingWizard.tsx stashes an optional first-goal draft under, and
// ConfirmCountryForm.tsx reads it back from once the user has genuinely
// confirmed their country. Shared here (not duplicated as a magic string in
// both files) so the two stay in sync by construction.
export const PENDING_GOAL_STORAGE_KEY = 'fhip_pending_first_goal';

// G3 (spec section 5.3): this file used to declare its own, second
// `export type CountryCode = 'AU' | 'IN'` alongside the authoritative one in
// lib/services/jurisdiction.ts. Two independently-maintained unions with the
// same name was exactly the "multiple conflicting country unions" G3
// forbids, so the definition is gone -- what remains is a re-export of the
// canonical types, and the two concepts are now named apart:
//
//   CountryCode              (six countries) -- an authoritative RESIDENCE
//                            country. Any of AU/IN/GB/US/SG/AE.
//   FullExperienceCountryCode (two countries) -- a country with actual
//                            domestic coverage, and therefore the only kind
//                            of country a FINANCIAL RECORD may be located
//                            in today. Record-level country expansion is
//                            G6 cross-border scope, explicitly not G3's.
//
// COUNTRY_OPTIONS below is the RECORD-level list (asset/liability/goal grid
// rows, whose currency must be one of the two certified currencies), not the
// registration list. The registration list is
// countryGate.ts's REGISTRATION_COUNTRY_OPTIONS, which is registry-aligned.
import {
  type CountryCode,
  type FullExperienceCountryCode,
  FULL_EXPERIENCE_COUNTRY_CODES,
} from '@/lib/services/jurisdiction';

export type { CountryCode, FullExperienceCountryCode };

export const COUNTRY_OPTIONS: { value: FullExperienceCountryCode; label: string }[] = [
  { value: 'AU', label: 'Australia' },
  { value: 'IN', label: 'India' },
];

export { FULL_EXPERIENCE_COUNTRY_CODES };

// Deterministic country -> expected-currency mapping. This app supports
// exactly two countries and two currencies (see lib/engines/fx.ts), so this
// is a straight 1:1 lookup, not a general FX/locale table. Used both to
// auto-set a grid row's currency when its country changes, and to
// cross-validate country_code/currency_code server-side (see
// lib/validation/currencyCountry.ts) — the two fields must never be able to
// drift apart silently again.
// G3: keyed by FullExperienceCountryCode, NOT CountryCode. There is
// deliberately no GB/US/SG/AE entry: a generic country has no implied
// reporting currency, and G3 spec section 8.3 requires those users to make an
// EXPLICIT AUD/INR choice rather than have one guessed for them. The absence
// of the four keys is what makes "do not guess" a compile-time fact.
export const COUNTRY_TO_CURRENCY: Record<FullExperienceCountryCode, SupportedCurrency> = {
  AU: 'AUD',
  IN: 'INR',
};

export function expectedCurrencyForCountry(
  countryCode: string | null | undefined
): SupportedCurrency | undefined {
  return countryCode === 'AU' || countryCode === 'IN' ? COUNTRY_TO_CURRENCY[countryCode] : undefined;
}

export const OWNER_VALUES = [
  'self',
  'spouse',
  'joint',
  'child',
  'family_trust',
  'company',
  'smsf',
  'other',
] as const;

export type Owner = (typeof OWNER_VALUES)[number];

export const OWNER_OPTIONS: { value: Owner; label: string }[] = [
  { value: 'self', label: 'Self' },
  { value: 'spouse', label: 'Spouse/Partner' },
  { value: 'joint', label: 'Joint' },
  { value: 'child', label: 'Child' },
  { value: 'family_trust', label: 'Family Trust' },
  { value: 'company', label: 'Company' },
  { value: 'smsf', label: 'SMSF' },
  { value: 'other', label: 'Other' },
];
