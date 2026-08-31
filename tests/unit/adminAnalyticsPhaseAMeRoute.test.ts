/**
 * FHIP Analyst Analytics Intelligence Centre — Phase A, Wave 1, §10.2.
 *
 * GET /api/admin/me: single shared role resolution, per-capability
 * independence, legacy-field compatibility and fail-closed behaviour.
 *
 * Two independent kinds of evidence are produced here, because neither alone
 * is sufficient:
 *
 *   (a) SINGLE-RESOLUTION: driving the REAL route against a counting
 *       Supabase fake, asserting auth.getUser() runs once and each role
 *       source is read at most once per request.
 *   (b) COUPLING-REGRESSION DETECTOR (Second Corrective Addendum §1.4b): the
 *       five capability predicates are replaced with independent spies
 *       returning a deliberately non-role-correlated true/false/true/false/
 *       true pattern, and the response's capabilities object is asserted
 *       field-for-field against them. An implementation that computed one
 *       shared `const staff = isResourceStaff(current)` and copied it across
 *       four fields cannot produce that pattern, so this test fails against
 *       exactly the design the Product Owner rejected.
 *
 * Hermetic: no DEV/staging/production access, no .env read, no network.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// (a) Single-resolution evidence — real predicates, counting Supabase fake.
// ---------------------------------------------------------------------------

const counters = { getUser: 0, tables: [] as string[], limitCalls: 0 };
const state: { user: { id: string } | null; adminRow: { user_id: string } | null; roleRows: { role: string }[] } = {
  user: null,
  adminRow: null,
  roleRows: [],
};

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => {
        counters.getUser += 1;
        return { data: { user: state.user } };
      },
    },
    from(table: string) {
      counters.tables.push(table);
      const result = table === 'admin_users' ? { data: state.adminRow } : { data: state.roleRows };
      const chain = {
        select: () => chain,
        eq: () => chain,
        // Present so a regression that reintroduces existence-only role
        // logic is detected rather than silently passing.
        limit: () => {
          counters.limitCalls += 1;
          return chain;
        },
        maybeSingle: async () => result,
        then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(result).then(res, rej),
      };
      return chain;
    },
  }),
}));

import { GET } from '@/app/api/admin/me/route';

function reset() {
  counters.getUser = 0;
  counters.tables = [];
  counters.limitCalls = 0;
  state.user = null;
  state.adminRow = null;
  state.roleRows = [];
}

beforeEach(reset);

async function callMe(): Promise<{
  status: number;
  body: { data: { isAdmin: boolean; hasResourcesAccess: boolean; capabilities: Record<string, boolean> } };
}> {
  const res = await GET();
  return { status: res.status, body: await res.json() };
}

describe('Wave 1 §10.2 — /api/admin/me shared role resolution', () => {
  it('resolves the caller exactly once per request: one auth.getUser, one read of each role source', async () => {
    state.user = { id: 'u1' };
    state.roleRows = [{ role: 'analyst' }, { role: 'editor' }];
    await callMe();
    expect(counters.getUser).toBe(1);
    expect(counters.tables.filter((t) => t === 'admin_users')).toHaveLength(1);
    expect(counters.tables.filter((t) => t === 'resource_user_roles')).toHaveLength(1);
  });

  it('reads no table other than the two role sources', async () => {
    state.user = { id: 'u1' };
    state.roleRows = [{ role: 'editor' }];
    await callMe();
    expect(new Set(counters.tables)).toEqual(new Set(['admin_users', 'resource_user_roles']));
  });

  it('does not re-query roles once per capability (five capabilities, still one read each)', async () => {
    state.user = { id: 'u1' };
    state.roleRows = [{ role: 'resource_admin' }];
    const { body } = await callMe();
    expect(Object.keys(body.data.capabilities)).toHaveLength(5);
    expect(counters.tables).toHaveLength(2);
  });

  it('retains no .limit(1) existence-only role logic', async () => {
    state.user = { id: 'u1' };
    state.roleRows = [{ role: 'analyst' }];
    await callMe();
    expect(counters.limitCalls).toBe(0);
  });

  it('holds no route-local Supabase query: the route module imports only the shared helper', () => {
    // A structural guard — the fix is "no duplicate role query inside the
    // route", which a behavioural assertion alone cannot prove.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const source: string = require('fs').readFileSync('app/api/admin/me/route.ts', 'utf8');
    expect(source).not.toContain("from('admin_users')");
    expect(source).not.toContain("from('resource_user_roles')");
    expect(source).not.toContain('@/lib/supabase/server');
    expect(source).not.toContain('auth.getUser');
    expect(source).toContain('getCurrentResourceRoles');
  });

  it('all five capability values come from the same role snapshot (one fetch, five decisions)', async () => {
    state.user = { id: 'u1' };
    state.roleRows = [{ role: 'analyst' }, { role: 'editor' }];
    const { body } = await callMe();
    // Editor grants the four staff capabilities; Analyst grants Analytics.
    // If any field had been derived from a separate, later fetch, the fake's
    // table counter would have moved past two.
    expect(body.data.capabilities).toEqual({
      resourcesDashboard: true,
      resourceContentAdmin: true,
      resourceWorkflowAdmin: true,
      resourceDiscoveryAdmin: true,
      resourceAnalytics: true,
    });
    expect(counters.tables).toHaveLength(2);
  });
});

describe('Wave 1 §10.2 — /api/admin/me capability values', () => {
  const CASES: [string, { admin?: boolean; roles: string[] }, Record<string, boolean>][] = [
    ['authenticated, no role', { roles: [] }, { resourcesDashboard: false, resourceContentAdmin: false, resourceWorkflowAdmin: false, resourceDiscoveryAdmin: false, resourceAnalytics: false }],
    ['Analyst only', { roles: ['analyst'] }, { resourcesDashboard: false, resourceContentAdmin: false, resourceWorkflowAdmin: false, resourceDiscoveryAdmin: false, resourceAnalytics: true }],
    ['Author only', { roles: ['author'] }, { resourcesDashboard: true, resourceContentAdmin: true, resourceWorkflowAdmin: true, resourceDiscoveryAdmin: true, resourceAnalytics: false }],
    ['Editor only', { roles: ['editor'] }, { resourcesDashboard: true, resourceContentAdmin: true, resourceWorkflowAdmin: true, resourceDiscoveryAdmin: true, resourceAnalytics: false }],
    ['Compliance Reviewer only', { roles: ['compliance_reviewer'] }, { resourcesDashboard: true, resourceContentAdmin: true, resourceWorkflowAdmin: true, resourceDiscoveryAdmin: true, resourceAnalytics: false }],
    ['Publisher only', { roles: ['publisher'] }, { resourcesDashboard: true, resourceContentAdmin: true, resourceWorkflowAdmin: true, resourceDiscoveryAdmin: true, resourceAnalytics: false }],
    ['Resource Admin', { roles: ['resource_admin'] }, { resourcesDashboard: true, resourceContentAdmin: true, resourceWorkflowAdmin: true, resourceDiscoveryAdmin: true, resourceAnalytics: true }],
    ['Super Admin', { admin: true, roles: [] }, { resourcesDashboard: true, resourceContentAdmin: true, resourceWorkflowAdmin: true, resourceDiscoveryAdmin: true, resourceAnalytics: true }],
    ['Analyst + Editor', { roles: ['analyst', 'editor'] }, { resourcesDashboard: true, resourceContentAdmin: true, resourceWorkflowAdmin: true, resourceDiscoveryAdmin: true, resourceAnalytics: true }],
    ['malformed role value only', { roles: ['not_a_real_role'] }, { resourcesDashboard: false, resourceContentAdmin: false, resourceWorkflowAdmin: false, resourceDiscoveryAdmin: false, resourceAnalytics: false }],
  ];

  for (const [label, setup, expected] of CASES) {
    it(label, async () => {
      state.user = { id: 'u1' };
      state.adminRow = setup.admin ? { user_id: 'u1' } : null;
      state.roleRows = setup.roles.map((role) => ({ role }));
      const { body } = await callMe();
      expect(body.data.capabilities).toEqual(expected);
    });
  }

  it('a revoked role disappears on the next authenticated capability request', async () => {
    state.user = { id: 'u1' };
    state.roleRows = [{ role: 'analyst' }];
    expect((await callMe()).body.data.capabilities.resourceAnalytics).toBe(true);
    // Role revoked -> the is_active filter no longer returns the row.
    reset();
    state.user = { id: 'u1' };
    state.roleRows = [];
    const after = await callMe();
    expect(after.body.data.capabilities.resourceAnalytics).toBe(false);
    expect(after.body.data.hasResourcesAccess).toBe(false);
  });
});

describe('Wave 1 §10.2 — fail-closed and legacy compatibility', () => {
  it('a logged-out caller receives a stable, fully false capability object', async () => {
    state.user = null;
    const { status, body } = await callMe();
    expect(status).toBe(200);
    expect(body.data).toEqual({
      isAdmin: false,
      hasResourcesAccess: false,
      capabilities: {
        resourcesDashboard: false,
        resourceContentAdmin: false,
        resourceWorkflowAdmin: false,
        resourceDiscoveryAdmin: false,
        resourceAnalytics: false,
      },
    });
    // No role table is read at all for an unauthenticated caller.
    expect(counters.tables).toEqual([]);
  });

  it('the response carries all five capability keys even when every one is false', async () => {
    state.user = null;
    const { body } = await callMe();
    expect(Object.keys(body.data.capabilities).sort()).toEqual([
      'resourceAnalytics',
      'resourceContentAdmin',
      'resourceDiscoveryAdmin',
      'resourceWorkflowAdmin',
      'resourcesDashboard',
    ]);
  });

  it('legacy isAdmin is preserved: true only for an admin_users row', async () => {
    state.user = { id: 'u1' };
    state.adminRow = { user_id: 'u1' };
    expect((await callMe()).body.data.isAdmin).toBe(true);
    reset();
    state.user = { id: 'u1' };
    state.roleRows = [{ role: 'resource_admin' }];
    expect((await callMe()).body.data.isAdmin).toBe(false);
  });

  it('legacy hasResourcesAccess is preserved: any role row, or Super Admin', async () => {
    state.user = { id: 'u1' };
    state.roleRows = [{ role: 'analyst' }];
    expect((await callMe()).body.data.hasResourcesAccess).toBe(true);
    reset();
    state.user = { id: 'u1' };
    state.adminRow = { user_id: 'u1' };
    expect((await callMe()).body.data.hasResourcesAccess).toBe(true);
    reset();
    state.user = { id: 'u1' };
    expect((await callMe()).body.data.hasResourcesAccess).toBe(false);
  });

  it('the legacy fields are not repurposed as capabilities: Analyst has hasResourcesAccess but no staff capability', async () => {
    state.user = { id: 'u1' };
    state.roleRows = [{ role: 'analyst' }];
    const { body } = await callMe();
    expect(body.data.hasResourcesAccess).toBe(true);
    expect(body.data.capabilities.resourcesDashboard).toBe(false);
    expect(body.data.capabilities.resourceContentAdmin).toBe(false);
  });

  it('a role-resolution error propagates instead of becoming a grant', async () => {
    state.user = { id: 'u1' };
    const original = counters.tables;
    // Force the shared helper to throw by making auth.getUser reject.
    const spy = vi.spyOn(await import('@/lib/supabase/server'), 'createClient').mockImplementation(async () => {
      throw new Error('role resolution failed');
    });
    await expect(GET()).rejects.toThrow('role resolution failed');
    spy.mockRestore();
    counters.tables = original;
  });
});

// ---------------------------------------------------------------------------
// (b) Coupling-regression detector. Runs in an isolated module registry so the
// predicate mocks below cannot affect the real-predicate assertions above.
// ---------------------------------------------------------------------------

describe('Wave 1 §10.2 — coupling-regression detector (Second Addendum §1.4b)', () => {
  it('each capability field comes from its OWN named predicate, not one shared boolean', async () => {
    vi.resetModules();

    type Snapshot = { userId: string | null; isSuperAdmin: boolean; roles: string[] };
    const predicate = (value: boolean) =>
      vi.fn((current: Snapshot) => {
        void current; // recorded in mock.calls below; the return value is fixed
        return value;
      });

    const spies = {
      canViewResourceDashboard: predicate(true),
      canViewResourceContent: predicate(false),
      canViewResourceWorkflow: predicate(true),
      canViewResourceDiscovery: predicate(false),
      canViewResourceAnalytics: predicate(true),
      // A trap: if the route still fans out one shared staff check, this is
      // what it would call — and its distinctive value would surface.
      isResourceStaff: predicate(false),
      isResourceAnalyst: predicate(false),
      canManageResources: predicate(false),
      getCurrentResourceRoles: vi.fn(
        async (): Promise<Snapshot> => ({ userId: 'u1', isSuperAdmin: false, roles: ['analyst', 'editor'] })
      ),
    };

    vi.doMock('@/lib/resources/permissions', () => spies);
    const { GET: IsolatedGet } = await import('@/app/api/admin/me/route');
    const body = await (await IsolatedGet()).json();

    // The alternating pattern is not producible by any single-source design.
    expect(body.data.capabilities).toEqual({
      resourcesDashboard: true,
      resourceContentAdmin: false,
      resourceWorkflowAdmin: true,
      resourceDiscoveryAdmin: false,
      resourceAnalytics: true,
    });

    // Every one of the five was actually invoked, exactly once.
    for (const name of [
      'canViewResourceDashboard',
      'canViewResourceContent',
      'canViewResourceWorkflow',
      'canViewResourceDiscovery',
      'canViewResourceAnalytics',
    ] as const) {
      expect(spies[name], name).toHaveBeenCalledTimes(1);
    }

    // The shared role helper was called exactly once, and the five predicates
    // each received that same snapshot object — one fetch, five decisions.
    expect(spies.getCurrentResourceRoles).toHaveBeenCalledTimes(1);
    const snapshot = spies.canViewResourceDashboard.mock.calls[0][0];
    for (const name of [
      'canViewResourceContent',
      'canViewResourceWorkflow',
      'canViewResourceDiscovery',
      'canViewResourceAnalytics',
    ] as const) {
      expect(spies[name].mock.calls[0][0]).toBe(snapshot);
    }

    // The route never reaches around the named predicates to a broad check.
    expect(spies.isResourceStaff).not.toHaveBeenCalled();

    vi.doUnmock('@/lib/resources/permissions');
    vi.resetModules();
  });
});
