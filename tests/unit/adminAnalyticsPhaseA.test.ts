/**
 * FHIP Analyst Analytics Intelligence Centre — Phase A, Wave 1.
 *
 * Capability truth table (§10.1), Admin navigation behaviour (§10.3), the
 * protected /admin/resources/analytics route shell (§10.4), and the Wave 1
 * regression set (§10.6).
 *
 * The /api/admin/me single-resolution and coupling-regression evidence lives
 * in tests/unit/adminAnalyticsPhaseAMeRoute.test.ts, and the eight-route API
 * access matrix in tests/unit/adminAnalyticsPhaseARouteMatrix.test.ts — both
 * need whole-module mocks that must not leak into this file's assertions
 * about the REAL predicates.
 *
 * Everything here runs hermetically: no DEV/staging/production access, no
 * .env read, no network, no database. The Supabase client is a deliberately
 * narrow in-memory fake (the convention established by
 * tests/unit/twinDataCountryResolution.test.ts), not a general mock.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CurrentResourceRoles } from '@/lib/resources/permissions';
import type { ResourceRole } from '@/lib/resources/types';

// ---------------------------------------------------------------------------
// Hermetic Supabase fake — shared by the getCurrentResourceRoles and
// route-shell sections below. Records every table it is asked for so a test
// can assert how many times each role source was read.
// ---------------------------------------------------------------------------

interface FakeState {
  user: { id: string } | null;
  adminRow: { user_id: string } | null;
  roleRows: { role: string }[];
  getUserCalls: number;
  tables: string[];
}

const fake: FakeState = { user: null, adminRow: null, roleRows: [], getUserCalls: 0, tables: [] };

function resetFake() {
  fake.user = null;
  fake.adminRow = null;
  fake.roleRows = [];
  fake.getUserCalls = 0;
  fake.tables = [];
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => {
        fake.getUserCalls += 1;
        return { data: { user: fake.user } };
      },
    },
    from(table: string) {
      fake.tables.push(table);
      const result = table === 'admin_users' ? { data: fake.adminRow } : { data: fake.roleRows };
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => result,
        then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(result).then(res, rej),
      };
      return chain;
    },
  }),
}));

// next/navigation's redirect() throws in production; the fake throws a tagged
// error carrying the destination so a test can assert both that execution
// stopped and where the caller was sent.
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

// Imported after the mocks above (vitest hoists vi.mock regardless of order).
import {
  getCurrentResourceRoles,
  canViewResourceDashboard,
  canViewResourceContent,
  canViewResourceWorkflow,
  canViewResourceDiscovery,
  canViewResourceAnalytics,
  isResourceStaff,
  isResourceAnalyst,
  canManageResources,
  canManageDiscovery,
  canManageFaqs,
  canCreateResource,
  canEditResource,
  canPublishResource,
  canReviewResource,
  canComplianceApproveResource,
  canCreateSpecialistContent,
} from '@/lib/resources/permissions';
import {
  buildAdminNavGroups,
  shouldShowAdminMenu,
  parseAdminCapabilities,
  parseIsAdmin,
  NO_ADMIN_CAPABILITIES,
  ADMIN_GENERAL_ITEMS,
  ANALYTICS_ITEMS,
  RESOURCES_ITEMS,
  CONTENT_TYPE_ITEMS,
  WORKFLOW_ITEMS,
  DISCOVERY_ITEMS,
  type AdminCapabilities,
} from '@/lib/admin/adminNav';
import ResourceAnalyticsPage from '@/app/(app)/admin/resources/analytics/page';

beforeEach(resetFake);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function roles(list: ResourceRole[], isSuperAdmin = false): CurrentResourceRoles {
  return { userId: 'user-fixture', isSuperAdmin, roles: list };
}

const LOGGED_OUT: CurrentResourceRoles = { userId: null, isSuperAdmin: false, roles: [] };

/** [label, fixture, [dashboard, content, workflow, discovery, analytics]] */
const TRUTH_TABLE: [string, CurrentResourceRoles, [boolean, boolean, boolean, boolean, boolean]][] = [
  ['logged out', LOGGED_OUT, [false, false, false, false, false]],
  ['authenticated, no role', roles([]), [false, false, false, false, false]],
  ['Analyst only', roles(['analyst']), [false, false, false, false, true]],
  ['Author only', roles(['author']), [true, true, true, true, false]],
  ['Editor only', roles(['editor']), [true, true, true, true, false]],
  ['Compliance Reviewer only', roles(['compliance_reviewer']), [true, true, true, true, false]],
  ['Publisher only', roles(['publisher']), [true, true, true, true, false]],
  ['Resource Admin', roles(['resource_admin']), [true, true, true, true, true]],
  ['Super Admin', roles([], true), [true, true, true, true, true]],
  ['Analyst + Author', roles(['analyst', 'author']), [true, true, true, true, true]],
  ['Analyst + Editor', roles(['analyst', 'editor']), [true, true, true, true, true]],
  ['Analyst + Compliance Reviewer', roles(['analyst', 'compliance_reviewer']), [true, true, true, true, true]],
  ['Analyst + Publisher', roles(['analyst', 'publisher']), [true, true, true, true, true]],
  ['Analyst + Resource Admin', roles(['analyst', 'resource_admin']), [true, true, true, true, true]],
  ['revoked/inactive role only (resolves to an empty role list)', roles([]), [false, false, false, false, false]],
  ['malformed/unknown role value only', roles(['not_a_real_role' as ResourceRole]), [false, false, false, false, false]],
  [
    'malformed role value alongside a real Analyst role',
    roles(['not_a_real_role' as ResourceRole, 'analyst']),
    [false, false, false, false, true],
  ],
];

// ---------------------------------------------------------------------------
// §10.1 Capability truth-table tests — each predicate asserted independently,
// in its own describe block, so a future divergence in exactly one of the
// four isResourceStaff-backed capabilities fails that one block alone.
// ---------------------------------------------------------------------------

describe('Wave 1 §10.1 — canViewResourceDashboard', () => {
  for (const [label, current, expected] of TRUTH_TABLE) {
    it(`${label} -> ${expected[0]}`, () => {
      expect(canViewResourceDashboard(current)).toBe(expected[0]);
    });
  }
});

describe('Wave 1 §10.1 — canViewResourceContent', () => {
  for (const [label, current, expected] of TRUTH_TABLE) {
    it(`${label} -> ${expected[1]}`, () => {
      expect(canViewResourceContent(current)).toBe(expected[1]);
    });
  }
});

describe('Wave 1 §10.1 — canViewResourceWorkflow', () => {
  for (const [label, current, expected] of TRUTH_TABLE) {
    it(`${label} -> ${expected[2]}`, () => {
      expect(canViewResourceWorkflow(current)).toBe(expected[2]);
    });
  }
});

describe('Wave 1 §10.1 — canViewResourceDiscovery', () => {
  for (const [label, current, expected] of TRUTH_TABLE) {
    it(`${label} -> ${expected[3]}`, () => {
      expect(canViewResourceDiscovery(current)).toBe(expected[3]);
    });
  }
});

describe('Wave 1 §10.1 — canViewResourceAnalytics', () => {
  for (const [label, current, expected] of TRUTH_TABLE) {
    it(`${label} -> ${expected[4]}`, () => {
      expect(canViewResourceAnalytics(current)).toBe(expected[4]);
    });
  }
});

describe('Wave 1 §10.1 — structural properties of the capability set', () => {
  const PREDICATES = [
    canViewResourceDashboard,
    canViewResourceContent,
    canViewResourceWorkflow,
    canViewResourceDiscovery,
    canViewResourceAnalytics,
  ];

  it('all five are distinct function objects, not one function re-exported under five names', () => {
    expect(new Set(PREDICATES).size).toBe(5);
  });

  it('all five fail closed for a logged-out caller', () => {
    for (const p of PREDICATES) expect(p(LOGGED_OUT)).toBe(false);
  });

  it('all five fail closed for an authenticated caller with no role', () => {
    for (const p of PREDICATES) expect(p(roles([]))).toBe(false);
  });

  it('additive union: Analyst + X is never weaker than X alone, for every other role', () => {
    const others: ResourceRole[] = ['author', 'editor', 'compliance_reviewer', 'publisher', 'resource_admin'];
    for (const other of others) {
      for (const p of PREDICATES) {
        const alone = p(roles([other]));
        const withAnalyst = p(roles([other, 'analyst']));
        // Never narrower than the other role alone...
        expect(withAnalyst || !alone).toBe(true);
      }
      // ...and strictly adds Analytics where the other role lacked it.
      expect(canViewResourceAnalytics(roles([other, 'analyst']))).toBe(true);
    }
  });

  it('additive union: Analyst + X is never weaker than Analyst alone', () => {
    const others: ResourceRole[] = ['author', 'editor', 'compliance_reviewer', 'publisher', 'resource_admin'];
    for (const other of others) {
      for (const p of PREDICATES) {
        if (p(roles(['analyst']))) expect(p(roles(['analyst', other]))).toBe(true);
      }
    }
  });

  it('role order does not affect any capability', () => {
    for (const p of PREDICATES) {
      expect(p(roles(['analyst', 'editor']))).toBe(p(roles(['editor', 'analyst'])));
    }
  });

  it('Analyst alone never receives any editorial/workflow/discovery/dashboard capability', () => {
    const analyst = roles(['analyst']);
    expect(canViewResourceDashboard(analyst)).toBe(false);
    expect(canViewResourceContent(analyst)).toBe(false);
    expect(canViewResourceWorkflow(analyst)).toBe(false);
    expect(canViewResourceDiscovery(analyst)).toBe(false);
  });

  it('no non-Analyst, non-admin role silently acquires Analytics', () => {
    for (const r of ['author', 'editor', 'compliance_reviewer', 'publisher'] as ResourceRole[]) {
      expect(canViewResourceAnalytics(roles([r]))).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Revoked-role evidence at the resolution layer: getCurrentResourceRoles()
// only ever reads is_active rows, so a revoked role is simply absent from the
// snapshot every predicate is evaluated against.
// ---------------------------------------------------------------------------

describe('Wave 1 — revoked role disappears from the resolved role snapshot', () => {
  it('an Analyst whose only role row is inactive resolves to zero roles and zero capabilities', async () => {
    fake.user = { id: 'u1' };
    fake.adminRow = null;
    fake.roleRows = []; // the is_active=true filter excludes the revoked row
    const current = await getCurrentResourceRoles();
    expect(current.roles).toEqual([]);
    expect(canViewResourceAnalytics(current)).toBe(false);
    expect(canViewResourceDashboard(current)).toBe(false);
  });

  it('the same caller with the role active resolves to Analytics only', async () => {
    fake.user = { id: 'u1' };
    fake.roleRows = [{ role: 'analyst' }];
    const current = await getCurrentResourceRoles();
    expect(current.roles).toEqual(['analyst']);
    expect(canViewResourceAnalytics(current)).toBe(true);
    expect(canViewResourceDashboard(current)).toBe(false);
  });

  it('a logged-out caller is resolved without reading either role table at all', async () => {
    fake.user = null;
    const current = await getCurrentResourceRoles();
    expect(current).toEqual({ userId: null, isSuperAdmin: false, roles: [] });
    expect(fake.tables).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// §10.3 Navigation tests. This repository has no DOM test environment, so the
// nav DECISION is asserted directly, group by group, against the pure builder
// AppShell renders from.
// ---------------------------------------------------------------------------

function capsFor(current: CurrentResourceRoles): AdminCapabilities {
  return {
    resourcesDashboard: canViewResourceDashboard(current),
    resourceContentAdmin: canViewResourceContent(current),
    resourceWorkflowAdmin: canViewResourceWorkflow(current),
    resourceDiscoveryAdmin: canViewResourceDiscovery(current),
    resourceAnalytics: canViewResourceAnalytics(current),
  };
}

function navFor(current: CurrentResourceRoles): string[] {
  return buildAdminNavGroups(current.isSuperAdmin, capsFor(current)).map((g) => g.label);
}

const NAV_MATRIX: [string, CurrentResourceRoles, string[]][] = [
  ['no role', roles([]), []],
  ['Analyst only', roles(['analyst']), ['Analytics']],
  ['Author only', roles(['author']), ['Resources', 'Content', 'Workflow', 'Discovery']],
  ['Editor only', roles(['editor']), ['Resources', 'Content', 'Workflow', 'Discovery']],
  ['Compliance Reviewer only', roles(['compliance_reviewer']), ['Resources', 'Content', 'Workflow', 'Discovery']],
  ['Publisher only', roles(['publisher']), ['Resources', 'Content', 'Workflow', 'Discovery']],
  ['Resource Admin', roles(['resource_admin']), ['Analytics', 'Resources', 'Content', 'Workflow', 'Discovery']],
  ['Super Admin', roles([], true), ['General', 'Analytics', 'Resources', 'Content', 'Workflow', 'Discovery']],
  ['Analyst + Author', roles(['analyst', 'author']), ['Analytics', 'Resources', 'Content', 'Workflow', 'Discovery']],
  ['Analyst + Editor', roles(['analyst', 'editor']), ['Analytics', 'Resources', 'Content', 'Workflow', 'Discovery']],
  [
    'Analyst + Compliance Reviewer',
    roles(['analyst', 'compliance_reviewer']),
    ['Analytics', 'Resources', 'Content', 'Workflow', 'Discovery'],
  ],
  ['Analyst + Publisher', roles(['analyst', 'publisher']), ['Analytics', 'Resources', 'Content', 'Workflow', 'Discovery']],
  [
    'Analyst + Resource Admin',
    roles(['analyst', 'resource_admin']),
    ['Analytics', 'Resources', 'Content', 'Workflow', 'Discovery'],
  ],
];

describe('Wave 1 §10.3 — Admin navigation group visibility', () => {
  for (const [label, current, expected] of NAV_MATRIX) {
    it(`${label} sees exactly [${expected.join(', ')}]`, () => {
      expect(navFor(current)).toEqual(expected);
    });
  }

  it('Analyst-only sees an Analytics entry and NO other Resources administrative group', () => {
    const groups = buildAdminNavGroups(false, capsFor(roles(['analyst'])));
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe('Analytics');
    expect(groups[0].items).toEqual([{ label: 'Analytics', href: '/admin/resources/analytics' }]);
  });

  it('no existing non-Analyst Resources role automatically receives the Analytics entry', () => {
    for (const r of ['author', 'editor', 'compliance_reviewer', 'publisher'] as ResourceRole[]) {
      expect(navFor(roles([r]))).not.toContain('Analytics');
    }
  });

  it('each group is driven by its own capability field, independently of the others', () => {
    // Five one-field-true probes: exactly one group must appear each time.
    const fields: (keyof AdminCapabilities)[] = [
      'resourcesDashboard',
      'resourceContentAdmin',
      'resourceWorkflowAdmin',
      'resourceDiscoveryAdmin',
      'resourceAnalytics',
    ];
    const expectedLabel: Record<keyof AdminCapabilities, string> = {
      resourcesDashboard: 'Resources',
      resourceContentAdmin: 'Content',
      resourceWorkflowAdmin: 'Workflow',
      resourceDiscoveryAdmin: 'Discovery',
      resourceAnalytics: 'Analytics',
    };
    for (const field of fields) {
      const caps = { ...NO_ADMIN_CAPABILITIES, [field]: true } as AdminCapabilities;
      const labels = buildAdminNavGroups(false, caps).map((g) => g.label);
      expect(labels).toEqual([expectedLabel[field]]);
    }
  });

  it('each group is hidden by its own capability field, independently of the others', () => {
    const allTrue: AdminCapabilities = {
      resourcesDashboard: true,
      resourceContentAdmin: true,
      resourceWorkflowAdmin: true,
      resourceDiscoveryAdmin: true,
      resourceAnalytics: true,
    };
    const expectedLabel: Record<string, string> = {
      resourcesDashboard: 'Resources',
      resourceContentAdmin: 'Content',
      resourceWorkflowAdmin: 'Workflow',
      resourceDiscoveryAdmin: 'Discovery',
      resourceAnalytics: 'Analytics',
    };
    for (const field of Object.keys(allTrue) as (keyof AdminCapabilities)[]) {
      const labels = buildAdminNavGroups(false, { ...allTrue, [field]: false }).map((g) => g.label);
      expect(labels).not.toContain(expectedLabel[field]);
      expect(labels).toHaveLength(4);
    }
  });

  it('the outer Admin menu is hidden when no group would render, and shown when any would', () => {
    expect(shouldShowAdminMenu(false, NO_ADMIN_CAPABILITIES)).toBe(false);
    expect(shouldShowAdminMenu(true, NO_ADMIN_CAPABILITIES)).toBe(true); // Super Admin: General group
    expect(shouldShowAdminMenu(false, { ...NO_ADMIN_CAPABILITIES, resourceAnalytics: true })).toBe(true);
  });
});

describe('Wave 1 §7.1 — loading, failure and revocation behaviour', () => {
  it('initial render (before /api/admin/me resolves) exposes no Admin navigation at all', () => {
    expect(parseIsAdmin(undefined)).toBe(false);
    expect(parseAdminCapabilities(undefined)).toEqual(NO_ADMIN_CAPABILITIES);
    expect(shouldShowAdminMenu(false, NO_ADMIN_CAPABILITIES)).toBe(false);
  });

  it('a failed /api/admin/me (null body, as AppShell passes on a non-OK response) fails closed', () => {
    expect(parseIsAdmin(null)).toBe(false);
    expect(parseAdminCapabilities(null)).toEqual(NO_ADMIN_CAPABILITIES);
    expect(buildAdminNavGroups(parseIsAdmin(null), parseAdminCapabilities(null))).toEqual([]);
  });

  it('a successful response drives the nav from the capabilities object only', () => {
    const body = {
      data: {
        isAdmin: false,
        hasResourcesAccess: true,
        capabilities: { ...NO_ADMIN_CAPABILITIES, resourceAnalytics: true },
      },
    };
    expect(navFor(roles(['analyst']))).toEqual(['Analytics']);
    expect(buildAdminNavGroups(parseIsAdmin(body), parseAdminCapabilities(body)).map((g) => g.label)).toEqual(['Analytics']);
  });

  it('a truthy legacy hasResourcesAccess NEVER grants a group on its own', () => {
    const body = { data: { isAdmin: false, hasResourcesAccess: true } }; // no capabilities key at all
    expect(parseAdminCapabilities(body)).toEqual(NO_ADMIN_CAPABILITIES);
    expect(buildAdminNavGroups(parseIsAdmin(body), parseAdminCapabilities(body))).toEqual([]);
  });

  it('malformed capability values (truthy non-booleans) are treated as denied', () => {
    const body = {
      data: {
        capabilities: {
          resourcesDashboard: 'yes',
          resourceContentAdmin: 1,
          resourceWorkflowAdmin: {},
          resourceDiscoveryAdmin: [],
          resourceAnalytics: 'true',
        },
      },
    };
    expect(parseAdminCapabilities(body)).toEqual(NO_ADMIN_CAPABILITIES);
  });

  it.each([[{}], [{ data: null }], [{ data: [] }], [{ data: { capabilities: null } }], [{ data: { capabilities: [] } }], ['nonsense'], [42]])(
    'malformed body %# fails closed',
    (body) => {
      expect(parseAdminCapabilities(body)).toEqual(NO_ADMIN_CAPABILITIES);
      expect(parseIsAdmin(body)).toBe(false);
    }
  );

  it('role revocation: the next /api/admin/me response removes the group', () => {
    const before = { data: { isAdmin: false, capabilities: { ...NO_ADMIN_CAPABILITIES, resourceAnalytics: true } } };
    const after = { data: { isAdmin: false, capabilities: { ...NO_ADMIN_CAPABILITIES } } };
    expect(buildAdminNavGroups(parseIsAdmin(before), parseAdminCapabilities(before)).map((g) => g.label)).toEqual(['Analytics']);
    expect(buildAdminNavGroups(parseIsAdmin(after), parseAdminCapabilities(after))).toEqual([]);
  });

  it('the fail-closed default is frozen, so no caller can mutate it into a grant', () => {
    expect(Object.isFrozen(NO_ADMIN_CAPABILITIES)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §10.4 Direct-route tests — enforcement re-derived on the server, proven
// independently of the navigation assertions above.
// ---------------------------------------------------------------------------

async function visitAnalytics(setup: { user: { id: string } | null; adminRow?: { user_id: string } | null; roleRows?: { role: string }[] }) {
  resetFake();
  fake.user = setup.user;
  fake.adminRow = setup.adminRow ?? null;
  fake.roleRows = setup.roleRows ?? [];
  try {
    const element = await ResourceAnalyticsPage();
    return { allowed: true as const, element };
  } catch (err) {
    if (err instanceof RedirectSignal) return { allowed: false as const, redirectedTo: err.to };
    throw err;
  }
}

describe('Wave 1 §10.4 — /admin/resources/analytics direct-route enforcement', () => {
  it('logged out -> redirected to /login, page body never produced', async () => {
    const r = await visitAnalytics({ user: null });
    expect(r.allowed).toBe(false);
    expect(r).toMatchObject({ redirectedTo: '/login' });
  });

  it('authenticated with no Resources role -> redirected to /dashboard', async () => {
    const r = await visitAnalytics({ user: { id: 'u' }, roleRows: [] });
    expect(r.allowed).toBe(false);
    expect(r).toMatchObject({ redirectedTo: '/dashboard' });
  });

  for (const role of ['author', 'editor', 'compliance_reviewer', 'publisher']) {
    it(`${role}-only -> denied, redirected away from Analytics`, async () => {
      const r = await visitAnalytics({ user: { id: 'u' }, roleRows: [{ role }] });
      expect(r.allowed).toBe(false);
      expect(r).toMatchObject({ redirectedTo: '/admin/resources' });
    });
  }

  it('Analyst only -> permitted', async () => {
    const r = await visitAnalytics({ user: { id: 'u' }, roleRows: [{ role: 'analyst' }] });
    expect(r.allowed).toBe(true);
  });

  it('Resource Admin -> permitted', async () => {
    const r = await visitAnalytics({ user: { id: 'u' }, roleRows: [{ role: 'resource_admin' }] });
    expect(r.allowed).toBe(true);
  });

  it('Super Admin (no resource_user_roles row) -> permitted', async () => {
    const r = await visitAnalytics({ user: { id: 'u' }, adminRow: { user_id: 'u' }, roleRows: [] });
    expect(r.allowed).toBe(true);
  });

  for (const other of ['author', 'editor', 'compliance_reviewer', 'publisher', 'resource_admin']) {
    it(`Analyst + ${other} -> permitted (union)`, async () => {
      const r = await visitAnalytics({ user: { id: 'u' }, roleRows: [{ role: 'analyst' }, { role: other }] });
      expect(r.allowed).toBe(true);
    });
  }

  it('a caller whose only role row is a malformed value is denied', async () => {
    const r = await visitAnalytics({ user: { id: 'u' }, roleRows: [{ role: 'not_a_real_role' }] });
    expect(r.allowed).toBe(false);
    expect(r).toMatchObject({ redirectedTo: '/admin/resources' });
  });

  it('the route re-derives the capability from the server role snapshot, not from any client input', async () => {
    // No argument of any kind is accepted by the page component — there is no
    // searchParam, header or prop through which a caller could assert a role.
    expect(ResourceAnalyticsPage.length).toBe(0);
    const r = await visitAnalytics({ user: { id: 'u' }, roleRows: [{ role: 'analyst' }] });
    expect(r.allowed).toBe(true);
    // Exactly one auth resolution and one read of each role source.
    expect(fake.getUserCalls).toBe(1);
    expect(fake.tables.filter((t) => t === 'admin_users')).toHaveLength(1);
    expect(fake.tables.filter((t) => t === 'resource_user_roles')).toHaveLength(1);
  });
});

describe('Wave 1 §8 — the Analytics route shell contains no analytics', () => {
  function collectText(node: unknown, out: string[] = []): string[] {
    if (node === null || node === undefined || typeof node === 'boolean') return out;
    if (typeof node === 'string' || typeof node === 'number') {
      out.push(String(node));
      return out;
    }
    if (Array.isArray(node)) {
      for (const n of node) collectText(n, out);
      return out;
    }
    const el = node as { props?: { children?: unknown } };
    if (el.props && 'children' in el.props) collectText(el.props.children, out);
    return out;
  }

  it('renders the approved title and contains no digit anywhere that could read as a live figure', async () => {
    const r = await visitAnalytics({ user: { id: 'u' }, roleRows: [{ role: 'analyst' }] });
    expect(r.allowed).toBe(true);
    const text = collectText((r as { element: unknown }).element).join(' ');
    expect(text).toContain('Analytics Intelligence Centre');
    expect(text).toMatch(/read-only/i);
    expect(text).toMatch(/subsequent authorised waves/i);
    expect(text).not.toMatch(/\d/); // no count, percentage, sample value or date
  });

  it('offers no export control and no link to editorial, workflow, publishing, compliance or role-management pages', async () => {
    const r = await visitAnalytics({ user: { id: 'u' }, roleRows: [{ role: 'analyst' }] });
    const text = collectText((r as { element: unknown }).element).join(' ');
    expect(text).not.toMatch(/export|download|csv|pdf/i);
    const source = ResourceAnalyticsPage.toString();
    for (const forbidden of ['/admin/resources/content', '/admin/resources/users', '/admin/resources/videos', 'href']) {
      expect(source).not.toContain(forbidden);
    }
  });

  it('makes no analytics API or database call of its own', async () => {
    resetFake();
    fake.user = { id: 'u' };
    fake.roleRows = [{ role: 'analyst' }];
    await ResourceAnalyticsPage();
    // Only the two role-resolution reads; nothing analytics-related.
    expect(fake.tables).toEqual(['admin_users', 'resource_user_roles']);
  });
});

// ---------------------------------------------------------------------------
// §10.6 Regression set — every pre-existing predicate keeps its exact prior
// behaviour, so content creation, editing, workflow, compliance, scheduling,
// publishing, role management and Discovery administration are untouched.
// ---------------------------------------------------------------------------

describe('Wave 1 §10.6 — pre-existing permission predicates are unchanged', () => {
  const ALL: [string, CurrentResourceRoles][] = [
    ['loggedOut', LOGGED_OUT],
    ['noRole', roles([])],
    ['analyst', roles(['analyst'])],
    ['author', roles(['author'])],
    ['editor', roles(['editor'])],
    ['complianceReviewer', roles(['compliance_reviewer'])],
    ['publisher', roles(['publisher'])],
    ['resourceAdmin', roles(['resource_admin'])],
    ['superAdmin', roles([], true)],
    ['analyst+editor', roles(['analyst', 'editor'])],
  ];

  // Expected values transcribed from the predicates' pre-Wave-1 definitions,
  // which Wave 1 did not touch.
  const EXPECTED: Record<string, Record<string, boolean>> = {
    isResourceStaff: { loggedOut: false, noRole: false, analyst: false, author: true, editor: true, complianceReviewer: true, publisher: true, resourceAdmin: true, superAdmin: true, 'analyst+editor': true },
    isResourceAnalyst: { loggedOut: false, noRole: false, analyst: true, author: false, editor: false, complianceReviewer: false, publisher: false, resourceAdmin: false, superAdmin: true, 'analyst+editor': true },
    canManageResources: { loggedOut: false, noRole: false, analyst: false, author: false, editor: false, complianceReviewer: false, publisher: false, resourceAdmin: true, superAdmin: true, 'analyst+editor': false },
    canCreateResource: { loggedOut: false, noRole: false, analyst: false, author: true, editor: true, complianceReviewer: true, publisher: true, resourceAdmin: true, superAdmin: true, 'analyst+editor': true },
    canEditResource: { loggedOut: false, noRole: false, analyst: false, author: true, editor: true, complianceReviewer: true, publisher: true, resourceAdmin: true, superAdmin: true, 'analyst+editor': true },
    canPublishResource: { loggedOut: false, noRole: false, analyst: false, author: false, editor: false, complianceReviewer: false, publisher: true, resourceAdmin: true, superAdmin: true, 'analyst+editor': false },
    canReviewResource: { loggedOut: false, noRole: false, analyst: false, author: false, editor: true, complianceReviewer: true, publisher: false, resourceAdmin: true, superAdmin: true, 'analyst+editor': true },
    canComplianceApproveResource: { loggedOut: false, noRole: false, analyst: false, author: false, editor: false, complianceReviewer: true, publisher: false, resourceAdmin: true, superAdmin: true, 'analyst+editor': false },
    canCreateSpecialistContent: { loggedOut: false, noRole: false, analyst: false, author: true, editor: true, complianceReviewer: false, publisher: false, resourceAdmin: true, superAdmin: true, 'analyst+editor': true },
    canManageFaqs: { loggedOut: false, noRole: false, analyst: false, author: true, editor: true, complianceReviewer: false, publisher: false, resourceAdmin: true, superAdmin: true, 'analyst+editor': true },
    canManageDiscovery: { loggedOut: false, noRole: false, analyst: false, author: false, editor: true, complianceReviewer: false, publisher: false, resourceAdmin: true, superAdmin: true, 'analyst+editor': true },
  };

  const FNS: Record<string, (c: CurrentResourceRoles) => boolean> = {
    isResourceStaff,
    isResourceAnalyst,
    canManageResources,
    canCreateResource,
    canEditResource,
    canPublishResource,
    canReviewResource,
    canComplianceApproveResource,
    canCreateSpecialistContent,
    canManageFaqs,
    canManageDiscovery,
  };

  for (const [name, fn] of Object.entries(FNS)) {
    describe(name, () => {
      for (const [label, current] of ALL) {
        it(`${label} -> ${EXPECTED[name][label]}`, () => {
          expect(fn(current)).toBe(EXPECTED[name][label]);
        });
      }
    });
  }
});

describe('Wave 1 §10.6 — existing navigation content is unchanged', () => {
  it('the General (non-Resources Admin) group still holds exactly Benchmarks and Recommendations', () => {
    expect(ADMIN_GENERAL_ITEMS).toEqual([
      { label: 'Benchmarks', href: '/admin/benchmarks' },
      { label: 'Recommendations', href: '/admin/recommendations' },
    ]);
  });

  it('the General group is still gated on Super Admin alone, never on a Resources capability', () => {
    expect(buildAdminNavGroups(true, NO_ADMIN_CAPABILITIES).map((g) => g.label)).toEqual(['General']);
    const allResources: AdminCapabilities = {
      resourcesDashboard: true,
      resourceContentAdmin: true,
      resourceWorkflowAdmin: true,
      resourceDiscoveryAdmin: true,
      resourceAnalytics: true,
    };
    expect(buildAdminNavGroups(false, allResources).map((g) => g.label)).not.toContain('General');
  });

  it('every pre-existing Resources nav item list is unchanged', () => {
    expect(RESOURCES_ITEMS.map((i) => i.href)).toEqual([
      '/admin/resources',
      '/admin/resources/content',
      '/admin/resources/content/new',
    ]);
    expect(CONTENT_TYPE_ITEMS.map((i) => i.href)).toEqual([
      '/admin/resources/videos',
      '/admin/resources/glossary',
      '/admin/resources/faqs',
      '/admin/resources/money-updates',
    ]);
    expect(WORKFLOW_ITEMS.map((i) => i.href)).toEqual([
      '/admin/resources/content/drafts',
      '/admin/resources/content/review',
      '/admin/resources/content/scheduled',
      '/admin/resources/content/published',
      '/admin/resources/content/review-due',
      '/admin/resources/content/archived',
    ]);
    expect(DISCOVERY_ITEMS.map((i) => i.href)).toEqual([
      '/admin/resources/related',
      '/admin/resources/ctas',
      '/admin/resources/context',
    ]);
  });

  it('Analytics adds exactly one destination and no metric sub-navigation', () => {
    expect(ANALYTICS_ITEMS).toHaveLength(1);
    expect(ANALYTICS_ITEMS[0]).toEqual({ label: 'Analytics', href: '/admin/resources/analytics' });
  });

  it('group order and match modes for pre-existing groups are unchanged', () => {
    const all: AdminCapabilities = {
      resourcesDashboard: true,
      resourceContentAdmin: true,
      resourceWorkflowAdmin: true,
      resourceDiscoveryAdmin: true,
      resourceAnalytics: true,
    };
    const groups = buildAdminNavGroups(true, all);
    expect(groups.map((g) => `${g.label}:${g.matchMode}`)).toEqual([
      'General:exact',
      'Analytics:exact',
      'Resources:exact',
      'Content:prefix',
      'Workflow:exact',
      'Discovery:exact',
    ]);
  });
});
