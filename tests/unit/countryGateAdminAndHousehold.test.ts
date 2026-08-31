// Mandatory Country Confirmation, round-2 closure — MCC-2 (admin API
// routes) and MCC-7 (app/api/household/route.ts) executable proof: a real
// admin_users-holding admin, a real resource-role-holding staffer, and the
// household route are all now blocked while country-unconfirmed, exactly
// like every other financial route — and the household route specifically
// remains open DURING onboarding, matching lib/api.ts's own bootstrap
// exemption.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetUser = vi.fn();
const mockFrom = vi.fn();
const ADMIN_ID = 'admin-under-test';
const STAFF_ID = 'resources-staff-under-test';
const HOUSEHOLD_USER_ID = 'household-user-under-test';

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: mockGetUser },
    from: mockFrom,
  }),
}));

import { GET as benchmarkSourcesGET } from '@/app/api/admin/benchmarks/sources/route';
import { GET as resourcesContentGET } from '@/app/api/admin/resources/content/route';
import { GET as householdGET, PUT as householdPUT } from '@/app/api/household/route';

type ProfileRow = {
  country_of_residence: string | null;
  country_confirmed_at: string | null;
  country_source: string | null;
  onboarding_completed: boolean;
};

const UNCONFIRMED_ONBOARDED: ProfileRow = { country_of_residence: 'AU', country_confirmed_at: null, country_source: null, onboarding_completed: true };
const NOT_YET_ONBOARDED: ProfileRow = { country_of_residence: null, country_confirmed_at: null, country_source: null, onboarding_completed: false };
const CONFIRMED: ProfileRow = { country_of_residence: 'AU', country_confirmed_at: '2026-08-29T00:00:00Z', country_source: 'USER_CONFIRMED', onboarding_completed: true };

function profileFrom(profile: ProfileRow) {
  return {
    select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: profile, error: null }) }) }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('MCC-2 — admin API routes (requireAdmin) are gated on country confirmation', () => {
  it('a real admin_users-holding admin, country-unconfirmed, is blocked with a stable code (not "Admin access required")', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: ADMIN_ID } } });
    mockFrom.mockImplementation((table: string) => {
      if (table === 'admin_users') return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { user_id: ADMIN_ID }, error: null }) }) }) };
      if (table === 'user_profiles') return profileFrom(UNCONFIRMED_ONBOARDED);
      throw new Error(`unexpected table: ${table}`);
    });
    const res = await benchmarkSourcesGET();
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('COUNTRY_CONFIRMATION_REQUIRED');
  });

  it('a real admin_users-holding admin, CONFIRMED, is not blocked by the country gate (fails later, for an unrelated reason — proves the gate is not overly broad)', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: ADMIN_ID } } });
    mockFrom.mockImplementation((table: string) => {
      if (table === 'admin_users') return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { user_id: ADMIN_ID }, error: null }) }) }) };
      if (table === 'user_profiles') return profileFrom(CONFIRMED);
      throw new Error(`unexpected table: ${table}`);
    });
    const res = await benchmarkSourcesGET();
    // adminClient() (service-role) throws in this test environment (no
    // service-role env vars configured) — adminRoute() catches that and
    // returns a 500, which is exactly the proof this test wants: the
    // request got PAST the country gate and PAST the admin-role gate, and
    // failed only on an unrelated, expected-in-this-harness reason.
    expect(res.status).not.toBe(403);
  });

  it('a non-admin (no admin_users row) is still rejected for admin-access reasons, never the country code — the two gates stay distinguishable', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'nobody' } } });
    mockFrom.mockImplementation((table: string) => {
      if (table === 'admin_users') return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) };
      throw new Error(`unexpected table: ${table}`);
    });
    const res = await benchmarkSourcesGET();
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Admin access required');
  });
});

describe('MCC-2 — Resources admin API routes (39 inline-auth routes) are gated on country confirmation', () => {
  it('a real Resources-role-holding staffer, country-unconfirmed, is blocked before any Resources table is touched', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: STAFF_ID } } });
    mockFrom.mockImplementation((table: string) => {
      if (table === 'user_profiles') return profileFrom(UNCONFIRMED_ONBOARDED);
      throw new Error(`unexpected table touched before the country gate: ${table}`);
    });
    const res = await resourcesContentGET(new Request('http://test/api/admin/resources/content'));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('COUNTRY_CONFIRMATION_REQUIRED');
  });
});

describe('MCC-7 — app/api/household/route.ts is gated post-onboarding, exempt during onboarding', () => {
  it('GET is blocked for a fully-onboarded, country-unconfirmed user', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: HOUSEHOLD_USER_ID } } });
    mockFrom.mockImplementation((table: string) => {
      if (table === 'user_profiles') return profileFrom(UNCONFIRMED_ONBOARDED);
      throw new Error(`unexpected table: ${table}`);
    });
    const res = await householdGET();
    expect(res.status).toBe(403);
  });

  it("PUT (the onboarding wizard's own call) succeeds for a NOT-yet-onboarded user, country completely unset", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: HOUSEHOLD_USER_ID } } });
    mockFrom.mockImplementation((table: string) => {
      if (table === 'user_profiles') return profileFrom(NOT_YET_ONBOARDED);
      if (table === 'households') {
        return {
          select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
          insert: () => ({ select: () => ({ single: async () => ({ data: { id: 'h1' }, error: null }) }) }),
        };
      }
      throw new Error(`unexpected table: ${table}`);
    });
    const res = await householdPUT(
      new Request('http://test/api/household', { method: 'PUT', body: JSON.stringify({ household_type: 'single' }) })
    );
    expect(res.status).toBe(200);
  });
});
