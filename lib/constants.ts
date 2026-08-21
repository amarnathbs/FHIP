import type { SupportedCurrency } from '@/lib/engines/fx';

export const COUNTRY_OPTIONS: { value: 'AU' | 'IN'; label: string }[] = [
  { value: 'AU', label: 'Australia' },
  { value: 'IN', label: 'India' },
];

export type CountryCode = 'AU' | 'IN';

// Deterministic country -> expected-currency mapping. This app supports
// exactly two countries and two currencies (see lib/engines/fx.ts), so this
// is a straight 1:1 lookup, not a general FX/locale table. Used both to
// auto-set a grid row's currency when its country changes, and to
// cross-validate country_code/currency_code server-side (see
// lib/validation/currencyCountry.ts) — the two fields must never be able to
// drift apart silently again.
export const COUNTRY_TO_CURRENCY: Record<CountryCode, SupportedCurrency> = {
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
