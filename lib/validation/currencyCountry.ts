// Shared cross-field check used by every validation schema that carries both
// a country_code and a currency_code (asset/liability/investment/retirement
// — income/expense/insurance have no country_code field and are unaffected).
//
// Product decision: a country/currency mismatch is a HARD BLOCK, not a soft
// warning, with one carve-out — a genuine multi-currency/foreign-currency
// holding (e.g. the 'foreign_currency' asset catalogue item, or an AU
// resident deliberately recording an India-denominated holding) needs an
// explicit, affirmatively-set currency_override flag. Silently defaulting
// the currency away from the country is the original bug; this override is
// never itself a silent default (see FinancialDataGrid.tsx for the UI).
import { expectedCurrencyForCountry } from '@/lib/constants';

export interface CurrencyCountryFields {
  currency_code?: string;
  country_code?: string;
  currency_override?: boolean;
}

export function currencyMatchesCountry<T extends CurrencyCountryFields>(data: T): boolean {
  if (data.currency_override) return true;
  const expected = expectedCurrencyForCountry(data.country_code);
  // No country selected, or currency_code absent from this (possibly
  // partial/PATCH) payload — nothing to cross-check.
  if (!expected || !data.currency_code) return true;
  return data.currency_code === expected;
}

export const CURRENCY_COUNTRY_MISMATCH_MESSAGE =
  "Currency doesn't match the selected country. If this holding is genuinely denominated in a different currency, enable the currency override.";

export const currencyCountryRefinement = {
  message: CURRENCY_COUNTRY_MISMATCH_MESSAGE,
  path: ['currency_code'],
};

// Client-side mirrors of the same rule, used by FinancialDataGrid.tsx (and
// exercised directly in tests) so the save button and the server agree
// before a round-trip ever happens.

// Raw mismatch, ignoring the override flag — used to decide whether to show
// the override affordance at all (it must stay visible once the user has
// checked it, or they'd have no way to see/uncheck it again).
export function currencyMismatch(row: CurrencyCountryFields): boolean {
  const expected = expectedCurrencyForCountry(row.country_code);
  return Boolean(expected) && row.currency_code !== expected;
}

// The actual save-blocking condition: a mismatch the user has not
// explicitly overridden.
export function currencyMismatchBlocked(row: CurrencyCountryFields): boolean {
  return currencyMismatch(row) && !row.currency_override;
}
