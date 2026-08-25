import { describe, it, expect } from 'vitest';
import { isItemAvailableForCountry } from '@/lib/services/jurisdiction';

describe('isItemAvailableForCountry (GEO-1 applicability)', () => {
  it('null country_applicability = globally applicable for any resolved country', () => {
    expect(isItemAvailableForCountry(null, 'AU')).toBe(true);
    expect(isItemAvailableForCountry(null, 'IN')).toBe(true);
  });

  it('null country_applicability = globally applicable even when the user\'s country is unresolved', () => {
    expect(isItemAvailableForCountry(null, null)).toBe(true);
  });

  it('AU-restricted item is available to AU, not to IN', () => {
    expect(isItemAvailableForCountry(['AU'], 'AU')).toBe(true);
    expect(isItemAvailableForCountry(['AU'], 'IN')).toBe(false);
  });

  it('fails closed: AU-restricted item is NOT available when the caller\'s country is unresolved', () => {
    // Security-relevant gate must never default an unresolved jurisdiction
    // to "AU" the way display-only fallbacks elsewhere in the app do.
    expect(isItemAvailableForCountry(['AU'], null)).toBe(false);
  });

  it('empty array is treated the same as null (globally applicable)', () => {
    expect(isItemAvailableForCountry([], 'IN')).toBe(true);
  });
});
