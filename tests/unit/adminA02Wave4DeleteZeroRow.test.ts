// Admin A0.2 Wave 4 — PO4-4 / DEF4-10: canonical zero-row DELETE contract.
//
// DELETE /api/admin/resources/related/[id] and
// DELETE /api/admin/resources/context/[id] both used a bare
// `.delete().eq('id', id)` with no `.select()` — PostgREST's DELETE does
// not error when zero rows match a filter, so both routes reported a 200
// "removed" success for an id that never existed, indistinguishable from a
// real deletion. Fixed by adding `.select('id')` so the underlying helper
// can report whether a row genuinely existed and was deleted; the route
// now returns 404 for an unknown/already-deleted id instead of a false 200.
import { describe, it, expect, vi, beforeEach } from 'vitest';
// G3: the shared country gate now also reads the countries registry.
import { countryRegistryFrom } from './support/countryRegistryFake';

const mockGetUser = vi.fn();
const mockServerFrom = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: mockGetUser },
    from: mockServerFrom,
  }),
}));

vi.mock('@/lib/resources/permissions', () => ({
  getCurrentResourceRoles: async () => ({ userId: 'admin-under-test', isSuperAdmin: true, roles: [] }),
  canManageDiscovery: () => true,
}));

const CONFIRMED_PROFILE = { country_of_residence: 'AU', country_confirmed_at: '2026-08-29T00:00:00Z', country_source: 'USER_CONFIRMED', onboarding_completed: true };

beforeEach(() => {
  vi.clearAllMocks();
  mockGetUser.mockResolvedValue({ data: { user: { id: 'admin-under-test' } } });
});

describe('DELETE /api/admin/resources/related/[id] — zero-row contract', () => {
  it('an existing row deletes successfully -> 200', async () => {
    mockServerFrom.mockImplementation((table: string) => {
      const registry = countryRegistryFrom(table);
      if (registry) return registry;
      if (table === 'user_profiles') return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: CONFIRMED_PROFILE, error: null }) }) }) };
      if (table === 'resource_related_content') return { delete: () => ({ eq: () => ({ select: async () => ({ data: [{ id: 'rel-1' }], error: null }) }) }) };
      throw new Error(`unexpected table: ${table}`);
    });
    const { DELETE } = await import('@/app/api/admin/resources/related/[id]/route');
    const res = await DELETE(new Request('http://test'), { params: Promise.resolve({ id: 'rel-1' }) });
    expect(res.status).toBe(200);
  });

  it('an unknown id (nothing matched) -> 404, not a false 200', async () => {
    mockServerFrom.mockImplementation((table: string) => {
      const registry = countryRegistryFrom(table);
      if (registry) return registry;
      if (table === 'user_profiles') return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: CONFIRMED_PROFILE, error: null }) }) }) };
      if (table === 'resource_related_content') return { delete: () => ({ eq: () => ({ select: async () => ({ data: [], error: null }) }) }) };
      throw new Error(`unexpected table: ${table}`);
    });
    const { DELETE } = await import('@/app/api/admin/resources/related/[id]/route');
    const res = await DELETE(new Request('http://test'), { params: Promise.resolve({ id: 'does-not-exist' }) });
    expect(res.status).toBe(404);
  });

  it('repeated deletion of the same (now-gone) id -> 404 both times, never a duplicate false success', async () => {
    let callCount = 0;
    mockServerFrom.mockImplementation((table: string) => {
      const registry = countryRegistryFrom(table);
      if (registry) return registry;
      if (table === 'user_profiles') return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: CONFIRMED_PROFILE, error: null }) }) }) };
      if (table === 'resource_related_content') {
        return {
          delete: () => ({
            eq: () => ({
              select: async () => {
                callCount += 1;
                // First call deletes the real row; every call after finds nothing.
                return { data: callCount === 1 ? [{ id: 'rel-2' }] : [], error: null };
              },
            }),
          }),
        };
      }
      throw new Error(`unexpected table: ${table}`);
    });
    const { DELETE } = await import('@/app/api/admin/resources/related/[id]/route');
    const first = await DELETE(new Request('http://test'), { params: Promise.resolve({ id: 'rel-2' }) });
    const second = await DELETE(new Request('http://test'), { params: Promise.resolve({ id: 'rel-2' }) });
    expect(first.status).toBe(200);
    expect(second.status).toBe(404);
  });
});

describe('DELETE /api/admin/resources/context/[id] — zero-row contract', () => {
  it('an existing row deletes successfully -> 200', async () => {
    mockServerFrom.mockImplementation((table: string) => {
      const registry = countryRegistryFrom(table);
      if (registry) return registry;
      if (table === 'user_profiles') return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: CONFIRMED_PROFILE, error: null }) }) }) };
      if (table === 'resource_context_links') return { delete: () => ({ eq: () => ({ select: async () => ({ data: [{ id: 'ctx-1' }], error: null }) }) }) };
      throw new Error(`unexpected table: ${table}`);
    });
    const { DELETE } = await import('@/app/api/admin/resources/context/[id]/route');
    const res = await DELETE(new Request('http://test'), { params: Promise.resolve({ id: 'ctx-1' }) });
    expect(res.status).toBe(200);
  });

  it('an unknown id -> 404, not a false 200', async () => {
    mockServerFrom.mockImplementation((table: string) => {
      const registry = countryRegistryFrom(table);
      if (registry) return registry;
      if (table === 'user_profiles') return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: CONFIRMED_PROFILE, error: null }) }) }) };
      if (table === 'resource_context_links') return { delete: () => ({ eq: () => ({ select: async () => ({ data: [], error: null }) }) }) };
      throw new Error(`unexpected table: ${table}`);
    });
    const { DELETE } = await import('@/app/api/admin/resources/context/[id]/route');
    const res = await DELETE(new Request('http://test'), { params: Promise.resolve({ id: 'does-not-exist' }) });
    expect(res.status).toBe(404);
  });
});
