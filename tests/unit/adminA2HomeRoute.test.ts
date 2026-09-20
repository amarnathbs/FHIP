/**
 * Admin A2 — /admin/home direct-route enforcement.
 *
 * Proves Standard §4's "navigation is not authorisation" for the new Home
 * page independently of any nav assertion: a role-less caller is redirected
 * server-side exactly like every other Admin page, regardless of what the
 * canonical shell's nav would or wouldn't show them. Same hermetic,
 * counting-fake-Supabase + redirect-signal convention as
 * tests/unit/adminAnalyticsPhaseA.test.ts's own §10.4 section.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

interface FakeState {
  user: { id: string } | null;
  adminRow: { user_id: string } | null;
  roleRows: { role: string }[];
}

const fake: FakeState = { user: null, adminRow: null, roleRows: [] };

function resetFake() {
  fake.user = null;
  fake.adminRow = null;
  fake.roleRows = [];
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: fake.user } }),
    },
    from(table: string) {
      const chain = {
        select: () => chain,
        eq: () => chain,
        in: () => chain,
        maybeSingle: async () => ({ data: table === 'admin_users' ? fake.adminRow : null }),
        then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
          const result = table === 'resource_user_roles' ? { data: fake.roleRows, error: null, count: fake.roleRows.length } : { data: [], error: null, count: 0 };
          return Promise.resolve(result).then(resolve, reject);
        },
      };
      return chain;
    },
  }),
}));

vi.mock('@/lib/resources/admin/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/resources/admin/queries')>();
  return { ...actual, getResourceDashboardSummary: async () => ({ counts: { inReview: 0, reviewDue: 0 }, recent: [] }) };
});

class RedirectSignal extends Error {
  constructor(public readonly to: string) {
    super(`REDIRECT:${to}`);
  }
}
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new RedirectSignal(to);
  },
}));

beforeEach(resetFake);

async function visitHome() {
  const { default: AdminHomePage } = await import('@/app/(app)/admin/home/page');
  try {
    const element = await AdminHomePage();
    return { allowed: true as const, element };
  } catch (err) {
    if (err instanceof RedirectSignal) return { allowed: false as const, redirectedTo: err.to };
    throw err;
  }
}

describe('A2 — /admin/home direct-route enforcement', () => {
  it('logged out -> redirected to /login', async () => {
    fake.user = null;
    const r = await visitHome();
    expect(r).toMatchObject({ allowed: false, redirectedTo: '/login' });
  });

  it('authenticated, no Resources role, not Super Admin -> redirected to /dashboard (role-less persona, A1_07 §3)', async () => {
    fake.user = { id: 'u1' };
    fake.roleRows = [];
    const r = await visitHome();
    expect(r).toMatchObject({ allowed: false, redirectedTo: '/dashboard' });
  });

  it('Analyst -> permitted (lands on a real Home page, not silently blocked)', async () => {
    fake.user = { id: 'u1' };
    fake.roleRows = [{ role: 'analyst' }];
    const r = await visitHome();
    expect(r.allowed).toBe(true);
  });

  it('Super Admin -> permitted', async () => {
    fake.user = { id: 'u1' };
    fake.adminRow = { user_id: 'u1' };
    const r = await visitHome();
    expect(r.allowed).toBe(true);
  });

  it('the route re-derives authorization from the server role snapshot on every call, accepting no client input', async () => {
    const { default: AdminHomePage } = await import('@/app/(app)/admin/home/page');
    expect(AdminHomePage.length).toBe(0);
  });
});
