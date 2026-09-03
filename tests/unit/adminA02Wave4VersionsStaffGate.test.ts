// Admin A0.2 Wave 4 — found while building the authorization register:
// the 4 "revision history" GET routes (content/videos/glossary/money-updates
// [id]/versions) previously checked authentication only, relying entirely
// on resource_post_versions' own RLS policy to withhold data from a
// non-staff caller. RLS did correctly prevent real data disclosure, but
// Standard §4 requires independent API-layer enforcement too. Each route
// now also checks isResourceStaff() and returns 403 for a non-staff caller.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetUser = vi.fn();
const mockServerFrom = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: mockGetUser },
    from: mockServerFrom,
  }),
}));

const CONFIRMED_PROFILE = { country_of_residence: 'AU', country_confirmed_at: '2026-08-29T00:00:00Z', country_source: 'USER_CONFIRMED', onboarding_completed: true };

beforeEach(() => {
  vi.clearAllMocks();
  mockGetUser.mockResolvedValue({ data: { user: { id: 'user-under-test' } } });
});

function mockRoles(opts: { admin?: boolean; roles?: { role: string; is_active: boolean }[] } = {}) {
  mockServerFrom.mockImplementation((table: string) => {
    if (table === 'user_profiles') return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: CONFIRMED_PROFILE, error: null }) }) }) };
    if (table === 'admin_users') return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: opts.admin ? { user_id: 'user-under-test' } : null, error: null }) }) }) };
    if (table === 'resource_user_roles') return { select: () => ({ eq: () => ({ eq: async () => ({ data: opts.roles ?? [], error: null }) }) }) };
    throw new Error(`unexpected table: ${table}`);
  });
}

const ROUTES = [
  ['content', () => import('@/app/api/admin/resources/content/[id]/versions/route')],
  ['videos', () => import('@/app/api/admin/resources/videos/[id]/versions/route')],
  ['glossary', () => import('@/app/api/admin/resources/glossary/[id]/versions/route')],
  ['money-updates', () => import('@/app/api/admin/resources/money-updates/[id]/versions/route')],
] as const;

describe.each(ROUTES)('GET .../%s/[id]/versions — staff gate', (_label, load) => {
  it('a non-staff authenticated caller is refused 403, not a silent empty list', async () => {
    mockRoles({ admin: false, roles: [] });
    const { GET } = await load();
    const res = await GET(new Request('http://test'), { params: Promise.resolve({ id: 'post-1' }) });
    expect(res.status).toBe(403);
  });

  it('an unauthenticated caller is refused 401', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });
    const { GET } = await load();
    const res = await GET(new Request('http://test'), { params: Promise.resolve({ id: 'post-1' }) });
    expect(res.status).toBe(401);
  });
});
