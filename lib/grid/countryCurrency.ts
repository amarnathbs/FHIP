import { COUNTRY_CURRENCY_DEFAULT } from '@/lib/constants';

// App Review spec §11 (Currency and Country — Critical Financial Defect).
// Pure, unit-testable core of components/grid/FinancialDataGrid.tsx's
// handleFieldChange currency-sync behaviour — kept separate from the React
// component so the rule itself (not just its wiring) has direct test
// coverage without a component-testing setup this repo doesn't otherwise use.
//
// Rule: changing Country auto-fills the intelligent default currency for
// that country (AU -> AUD, IN -> INR), but only while the user hasn't
// manually picked a currency for this row in this session
// (currencyTouched === false). Directly changing Currency always marks the
// row touched, so a later Country change never silently overwrites an
// explicit override (Case C: "India, currency manually overridden to AUD —
// override survives").
export interface CountryCurrencyChangeInput {
  field: string;
  value: unknown;
  currencyTouched: boolean;
}

export interface CountryCurrencyPatch {
  currency_code?: 'AUD' | 'INR';
  currencyTouched?: boolean;
}

export function deriveCountryCurrencyPatch(input: CountryCurrencyChangeInput): CountryCurrencyPatch {
  const patch: CountryCurrencyPatch = {};
  if (input.field === 'country_code' && !input.currencyTouched) {
    const smart = COUNTRY_CURRENCY_DEFAULT[input.value as 'AU' | 'IN'];
    if (smart) patch.currency_code = smart;
  }
  if (input.field === 'currency_code') {
    patch.currencyTouched = true;
  }
  return patch;
}
