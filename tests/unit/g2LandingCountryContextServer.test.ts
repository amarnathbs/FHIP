import { describe, it, expect } from 'vitest';
import { resolveLandingCountryContextForRequest } from '@/lib/services/landingCountryContextServer';

// Fake Supabase client covering both calls
// resolveLandingCountryContextForRequest issues: the G2 registry snapshot
// (`countries`) and, for an authenticated request, G1's own
// resolveCountryContext() reads (`user_profiles`, `countries`,
// `country_capabilities`, `cross_border_relationships`). Mirrors the
// fixture style already established in tests/unit/g1CountryFoundation.test.ts.
function fakeClient(profile: Record<string, unknown> | null) {
  return {
    from(table: string) {
      if (table === 'user_profiles') {
        return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: profile, error: null }) }) }) };
      }
      if (table === 'countries') {
        // Used twice with different call shapes: G2's own registry
        // snapshot (select().eq().eq()) and G1's per-country lookup
        // (select().eq().maybeSingle()). Both are satisfied by chaining
        // through the same terminal shape.
        const terminal = {
          eq: () => terminal,
          maybeSingle: () => Promise.resolve({ data: { experience_level: 'GENERIC', default_locale: null }, error: null }),
          then: (resolve: (v: { data: unknown[]; error: null }) => void) => resolve({ data: [], error: null }),
        };
        return { select: () => terminal };
      }
      if (table === 'country_capabilities') {
        return { select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }) };
      }
      if (table === 'cross_border_relationships') {
        return { select: () => ({ eq: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }) }) };
      }
      throw new Error(`unexpected table in test fake: ${table}`);
    },
    auth: { getUser: () => Promise.resolve({ data: { user: null }, error: null }) },
  } as unknown as Parameters<typeof resolveLandingCountryContextForRequest>[0]['supabase'];
}

function headersFixture(map: Record<string, string> = {}) {
  return { get: (name: string) => map[name.toLowerCase()] ?? null };
}

describe('G2 server orchestration — currency never influences presentation (PO clarification section 5)', () => {
  it('AUD preferred_currency does not imply AU: an IN-primary user with AUD preference still presents as IN', async () => {
    const ctx = await resolveLandingCountryContextForRequest({
      supabase: fakeClient({
        country_of_residence: 'IN',
        country_confirmed_at: '2026-01-01T00:00:00Z',
        primary_country: 'IN',
        primary_country_source: 'USER_CONFIRMED',
        preferred_currency: 'AUD', // deliberately mismatched currency
        billing_country: null,
        billing_country_confirmed_at: null,
      }),
      userId: 'user-in-aud',
      cookieValue: null,
      headers: headersFixture(),
    });
    expect(ctx.presentationCountry).toBe('IN');
  });

  it('INR preferred_currency does not imply IN: an AU-primary user with INR preference still presents as AU', async () => {
    const ctx = await resolveLandingCountryContextForRequest({
      supabase: fakeClient({
        country_of_residence: 'AU',
        country_confirmed_at: '2026-01-01T00:00:00Z',
        primary_country: 'AU',
        primary_country_source: 'USER_CONFIRMED',
        preferred_currency: 'INR', // deliberately mismatched currency
        billing_country: null,
        billing_country_confirmed_at: null,
      }),
      userId: 'user-au-inr',
      cookieValue: null,
      headers: headersFixture(),
    });
    expect(ctx.presentationCountry).toBe('AU');
  });

  it('a Global (GB) user with an AUD preference remains Global', async () => {
    const ctx = await resolveLandingCountryContextForRequest({
      supabase: fakeClient({
        country_of_residence: 'GB',
        country_confirmed_at: null,
        primary_country: 'GB',
        primary_country_source: 'USER_CONFIRMED',
        preferred_currency: 'AUD',
        billing_country: null,
        billing_country_confirmed_at: null,
      }),
      userId: 'user-gb-aud',
      cookieValue: null,
      headers: headersFixture(),
    });
    expect(ctx.presentationCountry).toBe('GLOBAL');
  });

  it('a Global (GB) user with an INR preference remains Global', async () => {
    const ctx = await resolveLandingCountryContextForRequest({
      supabase: fakeClient({
        country_of_residence: 'GB',
        country_confirmed_at: null,
        primary_country: 'GB',
        primary_country_source: 'USER_CONFIRMED',
        preferred_currency: 'INR',
        billing_country: null,
        billing_country_confirmed_at: null,
      }),
      userId: 'user-gb-inr',
      cookieValue: null,
      headers: headersFixture(),
    });
    expect(ctx.presentationCountry).toBe('GLOBAL');
  });

  it('anonymous visitor, no auth at all: presentation resolves from cookie/detection only, no DB profile touched', async () => {
    const ctx = await resolveLandingCountryContextForRequest({
      supabase: fakeClient(null),
      userId: null,
      cookieValue: null,
      headers: headersFixture({ 'cloudfront-viewer-country': 'AU' }),
    });
    expect(ctx.presentationCountry).toBe('AU');
    expect(ctx.source).toBe('DETECTED_REQUEST');
  });
});
