import { describe, it, expect, beforeEach, vi } from 'vitest';
import { __resetCountryRegistryCacheForTests } from '@/lib/services/countryGate';
import { __setG4CapabilityLayerFlagForTests } from '@/lib/services/appCapabilityFlag';

// Registry rows: AU/IN FULL, GB/US/SG/AE GENERIC — matches migration 0122/0127.
const COUNTRY_ROWS = [
  { country_code: 'AU', experience_level: 'FULL', selectable: true, active: true, effective_from: '2020-01-01T00:00:00Z', effective_to: null, default_locale: 'en-AU' },
  { country_code: 'IN', experience_level: 'FULL', selectable: true, active: true, effective_from: '2020-01-01T00:00:00Z', effective_to: null, default_locale: 'en-IN' },
  { country_code: 'GB', experience_level: 'GENERIC', selectable: true, active: true, effective_from: '2020-01-01T00:00:00Z', effective_to: null, default_locale: 'en-GB' },
];

const REGISTRATION_CAP_ROWS = COUNTRY_ROWS.map((c) => ({ country_code: c.country_code, capability: 'REGISTRATION', enabled: true }));

// Full country_capabilities rows for the "nav decisions" style resolver
// query (unfiltered by capability) — mirrors migration 0122's seed exactly
// for AU/GB, which is all this test file needs.
const ALL_CAP_ROWS = [
  ...['REGISTRATION', 'UNIVERSAL_MODULES', 'DOMESTIC_CALCULATIONS', 'DOMESTIC_RETIREMENT', 'CROSS_BORDER_RELATIONSHIPS', 'LOCALISED_RESOURCES', 'LOCALISED_REPORTS', 'FX_CONVERSION', 'REGULATORY_GUIDANCE', 'COUNTRY_SPECIFIC_CATALOGUE_ITEMS'].map((cap) => ({
    country_code: 'AU',
    capability: cap,
    enabled: true,
  })),
  { country_code: 'AU', capability: 'DOMESTIC_TAX_OUTPUTS', enabled: false },
  { country_code: 'AU', capability: 'APPROVED_BILLING', enabled: false },
  { country_code: 'AU', capability: 'APPROVED_PRICING', enabled: false },
  ...['UNIVERSAL_MODULES', 'CROSS_BORDER_RELATIONSHIPS'].map((cap) => ({ country_code: 'GB', capability: cap, enabled: true })),
  ...['REGISTRATION', 'DOMESTIC_CALCULATIONS', 'DOMESTIC_RETIREMENT', 'DOMESTIC_TAX_OUTPUTS', 'LOCALISED_RESOURCES', 'LOCALISED_REPORTS', 'APPROVED_BILLING', 'APPROVED_PRICING', 'FX_CONVERSION', 'REGULATORY_GUIDANCE', 'COUNTRY_SPECIFIC_CATALOGUE_ITEMS'].map((cap) => ({
    country_code: 'GB',
    capability: cap,
    enabled: false,
  })),
];

interface Profile {
  country_of_residence: string | null;
  country_confirmed_at: string | null;
  country_source: string | null;
  onboarding_completed: boolean | null;
  primary_country?: string | null;
  primary_country_source?: string | null;
  preferred_currency?: string | null;
  billing_country?: string | null;
  billing_country_confirmed_at?: string | null;
}

let currentProfile: Profile | null = null;

function fakeFrom(table: string) {
  if (table === 'countries') {
    return {
      // Two distinct shapes are queried against this table depending on the
      // caller: loadCountryRegistrySnapshot() (countryGate.ts) does a plain
      // .select() with no filter, while resolveCountryContext()
      // (jurisdiction.ts) does .select(...).eq('country_code', x).maybeSingle().
      // This fake supports both by making the un-awaited select() result
      // thenable (for the first shape) AND carry a callable .eq() (for the
      // second) — genuinely two different real call shapes, not a test
      // convenience shortcut.
      select: () => {
        const result = Promise.resolve({ data: COUNTRY_ROWS, error: null }) as Promise<{
          data: typeof COUNTRY_ROWS;
          error: null;
        }> & { eq: (col: string, value: string) => { maybeSingle: () => Promise<{ data: unknown; error: null }> } };
        result.eq = (_col: string, value: string) => ({
          maybeSingle: () => Promise.resolve({ data: COUNTRY_ROWS.find((c) => c.country_code === value) ?? null, error: null }),
        });
        return result;
      },
    };
  }
  if (table === 'country_capabilities') {
    return {
      select: () => ({
        eq: (col: string, value: string) => {
          if (col === 'capability' && value === 'REGISTRATION') {
            return Promise.resolve({ data: REGISTRATION_CAP_ROWS, error: null });
          }
          // resolveCountryContext's own query: .eq('country_code', primaryCountry)
          if (col === 'country_code') {
            return Promise.resolve({ data: ALL_CAP_ROWS.filter((r) => r.country_code === value), error: null });
          }
          return Promise.resolve({ data: [], error: null });
        },
      }),
    };
  }
  if (table === 'cross_border_relationships') {
    return { select: () => ({ eq: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }) }) };
  }
  // user_profiles
  return {
    select: () => ({
      eq: () => ({
        maybeSingle: () => Promise.resolve({ data: currentProfile, error: null }),
        single: () => Promise.resolve({ data: currentProfile, error: null }),
      }),
    }),
  };
}

const mockGetUser = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: mockGetUser },
    from: (table: string) => fakeFrom(table),
  }),
}));

import { requireModuleCapability } from '@/lib/services/appCapability';

function req(method = 'GET') {
  return new Request('http://test/api/x', { method });
}

beforeEach(() => {
  __resetCountryRegistryCacheForTests();
  __setG4CapabilityLayerFlagForTests(undefined);
  currentProfile = null;
  mockGetUser.mockReset();
});

describe('requireModuleCapability — flag OFF (legacy G3 behaviour)', () => {
  beforeEach(() => {
    __setG4CapabilityLayerFlagForTests(false);
  });

  it('unauthenticated caller is blocked with 401 regardless of module', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });
    const result = await requireModuleCapability('RETIREMENT', req());
    expect(result.user).toBeNull();
    expect(result.blocked?.status).toBe(401);
  });

  it('a confirmed AU user is admitted to every module (byte-identical to requireCountryConfirmedUser)', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'u1' } } });
    currentProfile = { country_of_residence: 'AU', country_confirmed_at: '2026-01-01T00:00:00Z', country_source: 'USER_CONFIRMED', onboarding_completed: true };
    const result = await requireModuleCapability('RETIREMENT', req());
    expect(result.blocked).toBeNull();
    expect(result.user).not.toBeNull();
  });

  it('a confirmed GENERIC (GB) user is refused for EVERY module, including the six G4 would newly enable — flag off means no new access at all', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'u1' } } });
    currentProfile = { country_of_residence: 'GB', country_confirmed_at: '2026-01-01T00:00:00Z', country_source: 'USER_CONFIRMED', onboarding_completed: true };
    for (const moduleKey of ['INCOME', 'EXPENSES', 'INSURANCE', 'SCORES', 'DNA', 'RESILIENCE'] as const) {
      const result = await requireModuleCapability(moduleKey, req());
      expect(result.blocked?.status, moduleKey).toBe(403);
      expect(result.user, moduleKey).toBeNull();
    }
  });
});

describe('requireModuleCapability — flag ON (G4 manifest-driven)', () => {
  beforeEach(() => {
    __setG4CapabilityLayerFlagForTests(true);
  });

  it('a confirmed GENERIC (GB) user IS admitted to the six newly-certified-universal modules', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'u1' } } });
    currentProfile = { country_of_residence: 'GB', country_confirmed_at: '2026-01-01T00:00:00Z', country_source: 'USER_CONFIRMED', onboarding_completed: true };
    for (const moduleKey of ['INCOME', 'EXPENSES', 'INSURANCE', 'SCORES', 'DNA', 'RESILIENCE'] as const) {
      const result = await requireModuleCapability(moduleKey, req());
      expect(result.blocked, moduleKey).toBeNull();
      expect(result.user, moduleKey).not.toBeNull();
      expect(result.decision, moduleKey).toBe('ENABLED');
    }
  });

  it('a confirmed GENERIC (GB) user is STILL refused for a domestic-only module (Retirement) — stable 403, never a raw DB error', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'u1' } } });
    currentProfile = { country_of_residence: 'GB', country_confirmed_at: '2026-01-01T00:00:00Z', country_source: 'USER_CONFIRMED', onboarding_completed: true };
    const result = await requireModuleCapability('RETIREMENT', req());
    expect(result.blocked?.status).toBe(403);
    const body = await result.blocked!.json();
    expect(body.error).toBe('CAPABILITY_NOT_ENABLED');
  });

  it('a confirmed AU user is unaffected — still admitted to Retirement (no regression)', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'u1' } } });
    currentProfile = { country_of_residence: 'AU', country_confirmed_at: '2026-01-01T00:00:00Z', country_source: 'USER_CONFIRMED', onboarding_completed: true };
    const result = await requireModuleCapability('RETIREMENT', req());
    expect(result.blocked).toBeNull();
    expect(result.decision).toBe('ENABLED');
  });

  it('a forged/unresolved country context (no confirmed country) is refused, never treated as GENERIC-admitted', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'u1' } } });
    currentProfile = { country_of_residence: null, country_confirmed_at: null, country_source: null, onboarding_completed: true };
    const result = await requireModuleCapability('INCOME', req());
    expect(result.blocked?.status).toBe(403);
    expect(result.user).toBeNull();
  });

  it('an EXISTING_RECORD_ONLY decision blocks an unsafe method (POST) but this test module never reaches that branch without hasExistingRecords wired — sanity-checks UNAVAILABLE still blocks POST too', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'u1' } } });
    currentProfile = { country_of_residence: 'GB', country_confirmed_at: '2026-01-01T00:00:00Z', country_source: 'USER_CONFIRMED', onboarding_completed: true };
    const result = await requireModuleCapability('RETIREMENT', req('POST'));
    expect(result.blocked?.status).toBe(403);
  });
});
