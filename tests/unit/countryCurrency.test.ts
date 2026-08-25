import { describe, it, expect } from 'vitest';
import { deriveCountryCurrencyPatch } from '@/lib/grid/countryCurrency';

// App Review spec §11 (Currency and Country — Critical Financial Defect).
// Real, live-verified defect: a new Asset/Liability/Investment/Retirement
// row's currency_code always started at the household's own
// preferred_currency (usually AUD) regardless of the Country picked
// (components/grid/FinancialDataGrid.tsx's rowFromMaster), and nothing ever
// re-synced it when Country was later changed — so an asset saved with
// Country=India kept currency_code 'AUD' unless the user separately,
// manually remembered to also change the Currency dropdown. Confirmed by
// reading lib/grid/configs.ts's assetGridConfig/liabilityGridConfig/
// investmentGridConfig/retirementGridConfig (all four have a country_code
// field; Income/Expenses/Insurance do not) and FinancialDataGrid.tsx's
// original rowFromMaster/handleFieldChange (no country->currency sync
// existed at all before this fix).
describe('deriveCountryCurrencyPatch (App Review spec §11)', () => {
  it('Case A: Australia selected on a fresh row -> currency defaults to AUD', () => {
    const patch = deriveCountryCurrencyPatch({ field: 'country_code', value: 'AU', currencyTouched: false });
    expect(patch.currency_code).toBe('AUD');
  });

  it('Case B: India selected -> currency defaults to INR, never silently stays/becomes AUD', () => {
    const patch = deriveCountryCurrencyPatch({ field: 'country_code', value: 'IN', currencyTouched: false });
    expect(patch.currency_code).toBe('INR');
    expect(patch.currency_code).not.toBe('AUD');
  });

  it('Case C: India selected, then currency manually overridden to AUD -> the override survives a later unrelated edit', () => {
    // Step 1: country change (untouched) sets the intelligent default.
    const step1 = deriveCountryCurrencyPatch({ field: 'country_code', value: 'IN', currencyTouched: false });
    expect(step1.currency_code).toBe('INR');
    expect(step1.currencyTouched).toBeUndefined();

    // Step 2: user directly overrides currency to AUD -> marks the row touched.
    const step2 = deriveCountryCurrencyPatch({ field: 'currency_code', value: 'AUD', currencyTouched: false });
    expect(step2.currencyTouched).toBe(true);

    // Step 3: country is changed again (now currencyTouched = true from step 2)
    // -> must NOT silently flip currency back to INR; the override survives.
    const step3 = deriveCountryCurrencyPatch({ field: 'country_code', value: 'IN', currencyTouched: true });
    expect(step3.currency_code).toBeUndefined(); // no auto-overwrite once touched
  });

  it('changing an unrelated field never touches currency_code or currencyTouched', () => {
    const patch = deriveCountryCurrencyPatch({ field: 'notes', value: 'hello', currencyTouched: false });
    expect(patch.currency_code).toBeUndefined();
    expect(patch.currencyTouched).toBeUndefined();
  });

  it('an already-saved row (currencyTouched=false on load) still gets the intelligent default the next time Country is actively changed', () => {
    // Loaded rows start currencyTouched=false (never silently touched on
    // load — only once the user actively changes Country in this session).
    const patch = deriveCountryCurrencyPatch({ field: 'country_code', value: 'IN', currencyTouched: false });
    expect(patch.currency_code).toBe('INR');
  });
});
