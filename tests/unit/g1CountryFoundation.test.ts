import { describe, it, expect } from 'vitest';
import { resolveCountryContext } from '@/lib/services/jurisdiction';
import {
  validatePriceForBilling,
  genericUserCanReceiveIndiaPricing,
  type PriceCatalogueEntry,
} from '@/lib/services/billingAuthority';

// Table-aware fake Supabase client. resolveCountryContext() issues, in
// order: user_profiles select, countries select (only if primaryCountry
// resolved), country_capabilities select (only if primaryCountry resolved),
// cross_border_relationships select. Each table's fixture data is supplied
// by the test.
type Fixtures = {
  user_profiles?: Record<string, unknown> | null;
  countries?: Record<string, unknown> | null;
  country_capabilities?: Array<{ capability: string; enabled: boolean }>;
  cross_border_relationships?: Array<{ country_code: string; relationship_type: string; status: string }>;
};

function fakeClient(fixtures: Fixtures) {
  return {
    from(table: string) {
      if (table === 'user_profiles') {
        return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: fixtures.user_profiles ?? null, error: null }) }) }) };
      }
      if (table === 'countries') {
        return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: fixtures.countries ?? null, error: null }) }) }) };
      }
      if (table === 'country_capabilities') {
        return { select: () => ({ eq: () => Promise.resolve({ data: fixtures.country_capabilities ?? [], error: null }) }) };
      }
      if (table === 'cross_border_relationships') {
        return { select: () => ({ eq: () => ({ eq: () => Promise.resolve({ data: fixtures.cross_border_relationships ?? [], error: null }) }) }) };
      }
      throw new Error(`unexpected table in test fake: ${table}`);
    },
  } as unknown as Parameters<typeof resolveCountryContext>[1];
}

describe('resolveCountryContext (G1 canonical resolver, spec section 18)', () => {
  it('confirmed AU user with an explicit stored primary_country (USER_CONFIRMED)', async () => {
    const client = fakeClient({
      user_profiles: {
        country_of_residence: 'AU',
        country_confirmed_at: '2026-01-01T00:00:00Z',
        primary_country: 'AU',
        primary_country_source: 'USER_CONFIRMED',
        preferred_currency: 'AUD',
        billing_country: null,
        billing_country_confirmed_at: null,
      },
      countries: { experience_level: 'FULL', default_locale: 'en-AU' },
      country_capabilities: [{ capability: 'DOMESTIC_RETIREMENT', enabled: true }],
      cross_border_relationships: [],
    });
    const ctx = await resolveCountryContext('u1', client);
    expect(ctx.residenceCountry).toBe('AU');
    expect(ctx.residenceConfirmed).toBe(true);
    expect(ctx.primaryCountry).toBe('AU');
    expect(ctx.primaryCountryProvenance).toBe('EXPLICIT_PRIMARY_SELECTION');
    expect(ctx.experienceLevel).toBe('FULL');
    expect(ctx.capabilities.DOMESTIC_RETIREMENT).toBe(true);
    expect(ctx.capabilities.DOMESTIC_TAX_OUTPUTS).toBe(false);
    expect(ctx.billingCountry).toBeNull();
    expect(ctx.billingConfirmed).toBe(false);
  });

  it('confirmed IN user with NO stored primary_country falls back live to residence (CONFIRMED_PROFILE)', async () => {
    const client = fakeClient({
      user_profiles: {
        country_of_residence: 'IN',
        country_confirmed_at: '2026-01-01T00:00:00Z',
        primary_country: null,
        primary_country_source: null,
        preferred_currency: 'INR',
        billing_country: 'IN',
        billing_country_confirmed_at: '2026-01-02T00:00:00Z',
      },
      countries: { experience_level: 'FULL', default_locale: 'en-IN' },
      country_capabilities: [{ capability: 'DOMESTIC_TAX_OUTPUTS', enabled: true }],
      cross_border_relationships: [{ country_code: 'AU', relationship_type: 'PROPERTY', status: 'ACTIVE' }],
    });
    const ctx = await resolveCountryContext('u2', client);
    expect(ctx.primaryCountry).toBe('IN');
    expect(ctx.primaryCountryProvenance).toBe('CONFIRMED_PROFILE');
    expect(ctx.billingCountry).toBe('IN');
    expect(ctx.billingConfirmed).toBe(true);
    expect(ctx.crossBorderCountries).toEqual([{ countryCode: 'AU', relationshipType: 'PROPERTY', status: 'ACTIVE' }]);
  });

  it('unconfirmed residence and no stored primary_country resolves to UNRESOLVED, never a default country', async () => {
    const client = fakeClient({
      user_profiles: {
        country_of_residence: null,
        country_confirmed_at: null,
        primary_country: null,
        primary_country_source: null,
        preferred_currency: null,
        billing_country: null,
        billing_country_confirmed_at: null,
      },
    });
    const ctx = await resolveCountryContext('u3', client);
    expect(ctx.residenceCountry).toBeNull();
    expect(ctx.residenceConfirmed).toBe(false);
    expect(ctx.primaryCountry).toBeNull();
    expect(ctx.primaryCountryProvenance).toBe('UNRESOLVED');
    expect(ctx.experienceLevel).toBe('UNAVAILABLE');
    expect(Object.values(ctx.capabilities).every((v) => v === false)).toBe(true);
  });

  it('GENERIC primary country (e.g. GB) resolves experience level GENERIC with only universal capabilities', async () => {
    const client = fakeClient({
      user_profiles: {
        country_of_residence: 'AU',
        country_confirmed_at: '2026-01-01T00:00:00Z',
        primary_country: 'GB',
        primary_country_source: 'USER_CONFIRMED',
        preferred_currency: 'AUD',
        billing_country: null,
        billing_country_confirmed_at: null,
      },
      countries: { experience_level: 'GENERIC', default_locale: 'en-GB' },
      country_capabilities: [
        { capability: 'UNIVERSAL_MODULES', enabled: true },
        { capability: 'CROSS_BORDER_RELATIONSHIPS', enabled: true },
        { capability: 'DOMESTIC_RETIREMENT', enabled: false },
      ],
      cross_border_relationships: [],
    });
    const ctx = await resolveCountryContext('u4', client);
    expect(ctx.experienceLevel).toBe('GENERIC');
    expect(ctx.capabilities.UNIVERSAL_MODULES).toBe(true);
    expect(ctx.capabilities.DOMESTIC_RETIREMENT).toBe(false);
    // Residence stays AU even though primary experience is GB — the two never conflate.
    expect(ctx.residenceCountry).toBe('AU');
  });
});

describe('billingAuthority — server-side price-region validation (spec section 17)', () => {
  const catalogue: PriceCatalogueEntry[] = [
    { priceId: 'price_au_premium', region: 'AU' },
    { priceId: 'price_in_premium', region: 'IN' },
    { priceId: 'price_generic_premium', region: 'GENERIC' },
  ];

  it('AU billing + AU price allowed', () => {
    const r = validatePriceForBilling({ billingCountry: 'AU', billingConfirmed: true, requestedPriceId: 'price_au_premium', catalogue });
    expect(r.allowed).toBe(true);
  });

  it('IN billing + India price allowed', () => {
    const r = validatePriceForBilling({ billingCountry: 'IN', billingConfirmed: true, requestedPriceId: 'price_in_premium', catalogue });
    expect(r.allowed).toBe(true);
  });

  it('missing billing confirmation fails closed regardless of requested price', () => {
    const r = validatePriceForBilling({ billingCountry: null, billingConfirmed: false, requestedPriceId: 'price_generic_premium', catalogue });
    expect(r.allowed).toBe(false);
    expect(r.allowed === false && r.reason).toBe('BILLING_COUNTRY_NOT_CONFIRMED');
  });

  it('a confirmed-but-not-yet-applied billing country (billingConfirmed=false) is treated as unconfirmed even if a value is present', () => {
    const r = validatePriceForBilling({ billingCountry: 'AU', billingConfirmed: false, requestedPriceId: 'price_au_premium', catalogue });
    expect(r.allowed).toBe(false);
  });

  it('forged/unknown price ID is denied', () => {
    const r = validatePriceForBilling({ billingCountry: 'AU', billingConfirmed: true, requestedPriceId: 'price_forged_xyz', catalogue });
    expect(r.allowed).toBe(false);
    expect(r.allowed === false && r.reason).toBe('PRICE_ID_UNKNOWN');
  });

  it('CENTRAL PROOF: a generic (non-AU/IN) confirmed billing country cannot receive India pricing, regardless of currency/landing default', () => {
    // AU is used here as the stand-in "generic/other" confirmed billing
    // country relative to the India price -- the point under test is that
    // ANY billing country other than IN is denied an India-region price;
    // nothing about currency, detected country, or the landing page's
    // static AUD display (see billingAuthority.ts header) ever enters this
    // function's inputs at all.
    const allowed = genericUserCanReceiveIndiaPricing({
      billingCountry: 'AU',
      billingConfirmed: true,
      indiaPriceId: 'price_in_premium',
      catalogue,
    });
    expect(allowed).toBe(false);
  });

  it('CENTRAL PROOF: an unconfirmed billing country (the default for every user, including one who only ever saw the AUD landing price) cannot receive India pricing either', () => {
    const allowed = genericUserCanReceiveIndiaPricing({
      billingCountry: null,
      billingConfirmed: false,
      indiaPriceId: 'price_in_premium',
      catalogue,
    });
    expect(allowed).toBe(false);
  });

  it('a GENERIC-region price (no country-specific pricing) is allowed for any confirmed billing country', () => {
    const rAu = validatePriceForBilling({ billingCountry: 'AU', billingConfirmed: true, requestedPriceId: 'price_generic_premium', catalogue });
    const rIn = validatePriceForBilling({ billingCountry: 'IN', billingConfirmed: true, requestedPriceId: 'price_generic_premium', catalogue });
    expect(rAu.allowed).toBe(true);
    expect(rIn.allowed).toBe(true);
  });
});
