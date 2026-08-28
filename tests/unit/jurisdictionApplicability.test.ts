import { describe, it, expect } from 'vitest';
import { isItemAvailableForCountry, isKnownCountry, getUserHomeCountry } from '@/lib/services/jurisdiction';

type Row = Record<string, unknown>;

// Narrow fake — getUserHomeCountry only ever issues one query shape:
// .from('user_profiles').select('country_of_residence').eq('user_id', ...).maybeSingle()
function fakeClientWithProfile(row: Row | null) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: row, error: null }),
        }),
      }),
    }),
  } as unknown as Parameters<typeof getUserHomeCountry>[1];
}

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

describe('isKnownCountry (exported G0-JA-1 Wave 1 — shared fail-closed vocabulary check for JA-D1/JA-D2)', () => {
  it('accepts AU and IN', () => {
    expect(isKnownCountry('AU')).toBe(true);
    expect(isKnownCountry('IN')).toBe(true);
  });
  it('rejects a forged/unsupported value, null, undefined and non-strings', () => {
    expect(isKnownCountry('ZZ')).toBe(false);
    expect(isKnownCountry(null)).toBe(false);
    expect(isKnownCountry(undefined)).toBe(false);
    expect(isKnownCountry(42)).toBe(false);
  });
});

describe('getUserHomeCountry (canonical resolver — reused directly by JA-D1/JA-D2 fixes)', () => {
  it('resolves a confirmed AU profile to \'AU\'', async () => {
    const client = fakeClientWithProfile({ country_of_residence: 'AU' });
    expect(await getUserHomeCountry('user-1', client)).toBe('AU');
  });
  it('resolves a confirmed IN profile to \'IN\'', async () => {
    const client = fakeClientWithProfile({ country_of_residence: 'IN' });
    expect(await getUserHomeCountry('user-1', client)).toBe('IN');
  });
  it('fails closed to null for a NULL country_of_residence — never AU', async () => {
    const client = fakeClientWithProfile({ country_of_residence: null });
    expect(await getUserHomeCountry('user-1', client)).toBeNull();
  });
  it('fails closed to null for a forged/unsupported country value — never a crash, never AU', async () => {
    const client = fakeClientWithProfile({ country_of_residence: 'ZZ' });
    expect(await getUserHomeCountry('user-1', client)).toBeNull();
  });
  it('fails closed to null when the profile row does not exist at all', async () => {
    const client = fakeClientWithProfile(null);
    expect(await getUserHomeCountry('user-1', client)).toBeNull();
  });
});
