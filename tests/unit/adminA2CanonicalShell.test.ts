/**
 * Admin A2 — Canonical Admin Shell and Navigation.
 *
 * Three independent surfaces, each hermetic (no DEV/staging/production
 * access, no .env read, no network, no database):
 *
 *  1. buildAdminAreas() — the 8-area canonical nav builder
 *     (lib/admin/adminAreas.ts), driven through the exact 9-persona matrix
 *     docs/admin/A1_07_NAVIGATION_BLUEPRINT_BY_ROLE.md §2/§3 specifies for
 *     the "today" (not "future") state, plus the pre-existing
 *     lib/admin/adminNav.ts exports remaining byte-for-byte unchanged
 *     (guards against this task silently touching the certified old
 *     dropdown's contract).
 *  2. resolveBreadcrumbs() — the route->area/crumb registry, checked against
 *     every existing Admin page path.
 *  3. gatherHomeQueues() — Admin Home's role-gated, independently-failing
 *     work-queue sources (lib/admin/homeQueues.ts), against a narrow,
 *     purpose-built hermetic Supabase fake plus a mocked
 *     getResourceDashboardSummary (isolating this test from that function's
 *     own, separately-tested, complex query-builder chain).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { CurrentResourceRoles } from '@/lib/resources/permissions';
import type { ResourceRole } from '@/lib/resources/types';
import {
  buildAdminAreas,
  resolveBreadcrumbs,
  CANONICAL_AREA_ORDER,
  type AdminArea,
} from '@/lib/admin/adminAreas';
import {
  NO_ADMIN_CAPABILITIES,
  RESOURCES_ITEMS,
  CONTENT_TYPE_ITEMS,
  WORKFLOW_ITEMS,
  DISCOVERY_ITEMS,
  type AdminCapabilities,
} from '@/lib/admin/adminNav';
import { canViewResourceDashboard, canViewResourceContent, canViewResourceWorkflow, canViewResourceDiscovery, canViewResourceAnalytics, canManageResources } from '@/lib/resources/permissions';

function roles(list: ResourceRole[], isSuperAdmin = false): CurrentResourceRoles {
  return { userId: 'user-fixture', isSuperAdmin, roles: list };
}

function capsFor(current: CurrentResourceRoles): AdminCapabilities {
  return {
    resourcesDashboard: canViewResourceDashboard(current),
    resourceContentAdmin: canViewResourceContent(current),
    resourceWorkflowAdmin: canViewResourceWorkflow(current),
    resourceDiscoveryAdmin: canViewResourceDiscovery(current),
    resourceAnalytics: canViewResourceAnalytics(current),
    // Not derivable from a Resources role snapshot (PC6/PC7 live on
    // admin_users, read independently — see
    // lib/admin/investmentIntelligenceAdminCapabilities.ts). This test
    // suite is about Resources-role-driven areas only; PC6/PC7's own
    // Data Governance sub-groups have their own coverage need if/when this
    // suite is extended for them.
    referenceDataQuality: false,
    lookthroughDataQuality: false,
  };
}

function areaLabels(areas: AdminArea[]): string[] {
  return areas.map((a) => a.label);
}

// ---------------------------------------------------------------------------
// 1. buildAdminAreas() — persona matrix (A1_07 §2 "today" state: Operations,
//    Analytics and Security & Support all correctly render for NO persona
//    today, since none has a genuinely usable destination yet — A1_06 §3
//    rules 1/9).
// ---------------------------------------------------------------------------

describe('A2 — buildAdminAreas() canonical area order', () => {
  it('CANONICAL_AREA_ORDER matches the PO-2 binding order exactly', () => {
    expect(CANONICAL_AREA_ORDER).toEqual([
      'Home',
      'Content',
      'Recommendations',
      'Data Governance',
      'Operations',
      'Analytics',
      'Security & Support',
      'Administration',
    ]);
  });

  it('every area buildAdminAreas() can ever emit appears in CANONICAL_AREA_ORDER, in that relative order', () => {
    const all = buildAdminAreas(true, { resourcesDashboard: true, resourceContentAdmin: true, resourceWorkflowAdmin: true, resourceDiscoveryAdmin: true, resourceAnalytics: true, referenceDataQuality: false, lookthroughDataQuality: false }, true);
    const labels = areaLabels(all);
    const indices = labels.map((l) => (CANONICAL_AREA_ORDER as readonly string[]).indexOf(l));
    expect(indices.every((i) => i >= 0)).toBe(true);
    expect([...indices].sort((a, b) => a - b)).toEqual(indices);
  });
});

describe('A2 — buildAdminAreas() persona matrix (today state)', () => {
  const CASES: [string, CurrentResourceRoles, string[]][] = [
    ['role-less authenticated user', roles([]), []],
    ['Analyst only', roles(['analyst']), ['Home']],
    ['Author only', roles(['author']), ['Home', 'Content']],
    ['Editor only', roles(['editor']), ['Home', 'Content']],
    ['Compliance Reviewer only', roles(['compliance_reviewer']), ['Home', 'Content']],
    ['Publisher only', roles(['publisher']), ['Home', 'Content']],
    ['Resource Admin', roles(['resource_admin']), ['Home', 'Content', 'Administration']],
    ['Super Admin', roles([], true), ['Home', 'Content', 'Recommendations', 'Data Governance', 'Administration']],
    ['Analyst + Resource Admin', roles(['analyst', 'resource_admin']), ['Home', 'Content', 'Administration']],
  ];

  for (const [label, current, expected] of CASES) {
    it(`${label} sees exactly [${expected.join(', ')}]`, () => {
      const areas = buildAdminAreas(current.isSuperAdmin, capsFor(current), canManageResources(current));
      expect(areaLabels(areas)).toEqual(expected);
    });
  }

  it('no persona ever sees Operations, Analytics or Security & Support today (no genuinely usable destination exists yet)', () => {
    for (const [, current] of CASES) {
      const areas = buildAdminAreas(current.isSuperAdmin, capsFor(current), canManageResources(current));
      const labels = areaLabels(areas);
      expect(labels).not.toContain('Operations');
      expect(labels).not.toContain('Analytics');
      expect(labels).not.toContain('Security & Support');
    }
    // Even a caller with every legacy capability true and isAdmin true.
    const all = buildAdminAreas(true, { resourcesDashboard: true, resourceContentAdmin: true, resourceWorkflowAdmin: true, resourceDiscoveryAdmin: true, resourceAnalytics: true, referenceDataQuality: false, lookthroughDataQuality: false }, true);
    expect(areaLabels(all)).not.toContain('Operations');
    expect(areaLabels(all)).not.toContain('Analytics');
    expect(areaLabels(all)).not.toContain('Security & Support');
  });

  it('role-less caller sees zero areas (no Admin entry point at all, matching A1_07 §3 row 1)', () => {
    expect(buildAdminAreas(false, NO_ADMIN_CAPABILITIES, false)).toEqual([]);
  });

  it('Content area sub-groups reuse the exact pre-existing item lists (same hrefs, no route change per A1_08 §10)', () => {
    const superAdminCaps: AdminCapabilities = { resourcesDashboard: true, resourceContentAdmin: true, resourceWorkflowAdmin: true, resourceDiscoveryAdmin: true, resourceAnalytics: true, referenceDataQuality: false, lookthroughDataQuality: false };
    const areas = buildAdminAreas(true, superAdminCaps, true);
    const content = areas.find((a) => a.label === 'Content');
    expect(content).toBeDefined();
    const allItems = content!.subGroups.flatMap((g) => g.items);
    expect(allItems).toEqual([...RESOURCES_ITEMS, ...CONTENT_TYPE_ITEMS, ...WORKFLOW_ITEMS, ...DISCOVERY_ITEMS]);
  });

  it('each Content sub-group is independently gated on its own capability field', () => {
    const only = (field: keyof AdminCapabilities) => buildAdminAreas(false, { ...NO_ADMIN_CAPABILITIES, [field]: true }, false);
    expect(only('resourcesDashboard').find((a) => a.label === 'Content')?.subGroups.map((g) => g.label)).toEqual(['Dashboard']);
    expect(only('resourceContentAdmin').find((a) => a.label === 'Content')?.subGroups.map((g) => g.label)).toEqual(['Content types']);
    expect(only('resourceWorkflowAdmin').find((a) => a.label === 'Content')?.subGroups.map((g) => g.label)).toEqual(['Queues']);
    expect(only('resourceDiscoveryAdmin').find((a) => a.label === 'Content')?.subGroups.map((g) => g.label)).toEqual(['Discovery']);
  });

  it('Recommendations and Data Governance are Super-Admin-only, matching the old "General" group gate exactly', () => {
    const resourceAdminOnly = buildAdminAreas(false, capsFor(roles(['resource_admin'])), true);
    expect(areaLabels(resourceAdminOnly)).not.toContain('Recommendations');
    expect(areaLabels(resourceAdminOnly)).not.toContain('Data Governance');
    const superAdmin = buildAdminAreas(true, NO_ADMIN_CAPABILITIES, false);
    expect(areaLabels(superAdmin)).toEqual(expect.arrayContaining(['Recommendations', 'Data Governance']));
  });

  it('Administration is gated on canManageResources(), independent of isAdmin — a Resource Admin (not Super Admin) still sees it', () => {
    const resourceAdmin = buildAdminAreas(false, capsFor(roles(['resource_admin'])), canManageResources(roles(['resource_admin'])));
    expect(areaLabels(resourceAdmin)).toContain('Administration');
    const editor = buildAdminAreas(false, capsFor(roles(['editor'])), canManageResources(roles(['editor'])));
    expect(areaLabels(editor)).not.toContain('Administration');
  });

  it('Home is present exactly when shouldShowAdminMenu() would be true — reuses the existing resolver verbatim', () => {
    // Analyst-only: old dropdown showed zero groups + a notice; canonical
    // shell shows Home (a real landing page) instead of a notice fragment —
    // still gated by the identical underlying condition.
    const analyst = buildAdminAreas(false, capsFor(roles(['analyst'])), false);
    expect(areaLabels(analyst)).toEqual(['Home']);
  });
});

describe('A2 — pre-existing lib/admin/adminNav.ts contract is untouched', () => {
  // A2A5 reconciliation finding: this assertion was written when
  // AdminCapabilities had exactly 5 keys. PC6/PC7 (Investment Intelligence
  // Reference Data / Fund Look-Through quality) added 2 more
  // (referenceDataQuality/lookthroughDataQuality) on `main` after this
  // branch was originally cut — both real, both correctly `false` in
  // NO_ADMIN_CAPABILITIES. Updated to 7 keys rather than deleted, so this
  // test still catches an UNEXPECTED 8th key appearing later.
  it('NO_ADMIN_CAPABILITIES still has exactly its original 5 keys plus PC6/PC7\'s 2, all false (7 total)', () => {
    expect(NO_ADMIN_CAPABILITIES).toEqual({
      resourcesDashboard: false,
      resourceContentAdmin: false,
      resourceWorkflowAdmin: false,
      resourceDiscoveryAdmin: false,
      resourceAnalytics: false,
      referenceDataQuality: false,
      lookthroughDataQuality: false,
    });
  });

  it('the 4 pre-existing item lists are unchanged in content and order', () => {
    expect(RESOURCES_ITEMS.map((i) => i.href)).toEqual(['/admin/resources', '/admin/resources/content', '/admin/resources/content/new']);
    expect(CONTENT_TYPE_ITEMS.map((i) => i.href)).toEqual(['/admin/resources/videos', '/admin/resources/glossary', '/admin/resources/faqs', '/admin/resources/money-updates']);
    expect(WORKFLOW_ITEMS.map((i) => i.href)).toEqual([
      '/admin/resources/content/drafts',
      '/admin/resources/content/review',
      '/admin/resources/content/scheduled',
      '/admin/resources/content/published',
      '/admin/resources/content/review-due',
      '/admin/resources/content/archived',
    ]);
    expect(DISCOVERY_ITEMS.map((i) => i.href)).toEqual(['/admin/resources/related', '/admin/resources/ctas', '/admin/resources/context']);
  });
});

// ---------------------------------------------------------------------------
// 2. resolveBreadcrumbs() — every existing page path resolves to a sensible
//    area + crumb chain; compatibility routing proof (every route still has
//    a place in the canonical IA).
// ---------------------------------------------------------------------------

describe('A2 — resolveBreadcrumbs() route coverage', () => {
  const EXISTING_ROUTES: [string, string][] = [
    ['/admin/home', 'Home'],
    ['/admin/benchmarks', 'Data Governance'],
    ['/admin/recommendations', 'Recommendations'],
    ['/admin/resources', 'Content'],
    ['/admin/resources/content', 'Content'],
    ['/admin/resources/content/new', 'Content'],
    ['/admin/resources/content/drafts', 'Content'],
    ['/admin/resources/content/review', 'Content'],
    ['/admin/resources/content/review-due', 'Content'],
    ['/admin/resources/content/scheduled', 'Content'],
    ['/admin/resources/content/published', 'Content'],
    ['/admin/resources/content/archived', 'Content'],
    ['/admin/resources/content/abc-123', 'Content'],
    ['/admin/resources/content/abc-123/edit', 'Content'],
    ['/admin/resources/content/abc-123/preview', 'Content'],
    ['/admin/resources/videos', 'Content'],
    ['/admin/resources/videos/abc-123/edit', 'Content'],
    ['/admin/resources/glossary', 'Content'],
    ['/admin/resources/faqs', 'Content'],
    ['/admin/resources/money-updates', 'Content'],
    ['/admin/resources/related', 'Content'],
    ['/admin/resources/ctas', 'Content'],
    ['/admin/resources/ctas/new', 'Content'],
    ['/admin/resources/context', 'Content'],
    ['/admin/resources/users', 'Administration'],
    ['/admin/resources/analytics', 'Analytics'],
  ];

  for (const [path, expectedArea] of EXISTING_ROUTES) {
    it(`${path} -> area "${expectedArea}"`, () => {
      expect(resolveBreadcrumbs(path).area).toBe(expectedArea);
    });
  }

  it('the last crumb always matches the resolved page itself (never fabricates a deeper title than it was given)', () => {
    const { crumbs } = resolveBreadcrumbs('/admin/resources/content/abc-123/edit');
    expect(crumbs[crumbs.length - 1].label).toBe('Content'); // falls back to the parent list, not a guessed record title
  });

  it('an unmapped/future path falls back to a generic "Admin" crumb, never a fabricated label', () => {
    const { area, crumbs } = resolveBreadcrumbs('/admin/some-future-route-not-yet-built');
    expect(area).toBeNull();
    expect(crumbs).toEqual([{ label: 'Admin', href: '/admin/home' }]);
  });

  it('longest-prefix-wins: a more specific route is never shadowed by a shorter sibling prefix', () => {
    expect(resolveBreadcrumbs('/admin/resources/content/drafts').crumbs.at(-1)?.label).toBe('Drafts');
    expect(resolveBreadcrumbs('/admin/resources/content').crumbs.at(-1)?.label).toBe('Content');
    expect(resolveBreadcrumbs('/admin/resources').crumbs.at(-1)?.label).toBe('Dashboard');
  });
});

// ---------------------------------------------------------------------------
// 3. gatherHomeQueues() — role gating + independent failure behaviour.
// ---------------------------------------------------------------------------

const dashboardSummaryMock = vi.fn();
vi.mock('@/lib/resources/admin/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/resources/admin/queries')>();
  return { ...actual, getResourceDashboardSummary: (...args: unknown[]) => dashboardSummaryMock(...args) };
});

// A narrow, table-keyed fake — each of the 4 new count queries this module
// adds touches a DIFFERENT table (resource_posts / action_recommendation_master
// / benchmark_sources / benchmark_datasets), so a fake keyed purely by table
// name is sufficient and unambiguous (unlike getResourceDashboardSummary,
// which issues several distinct queries against the SAME table — mocked
// above instead of faked here for exactly that reason).
function makeFakeSupabase(counts: Record<string, number | 'error'>): SupabaseClient {
  return {
    from(table: string) {
      const chain = {
        select: () => chain,
        eq: () => chain,
        in: () => chain,
        then(resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) {
          const value = counts[table];
          if (value === 'error') return Promise.resolve({ count: null, data: null, error: { message: 'boom', code: 'XXERR' } }).then(resolve, reject);
          return Promise.resolve({ count: value ?? 0, data: [], error: null }).then(resolve, reject);
        },
      };
      return chain;
    },
  } as unknown as SupabaseClient;
}

describe('A2 — gatherHomeQueues() role gating', () => {
  beforeEach(() => {
    dashboardSummaryMock.mockReset();
  });

  it('role-less caller (no roles, not Super Admin) receives zero items and no recent activity', async () => {
    const supabase = makeFakeSupabase({});
    const result = await import('@/lib/admin/homeQueues').then((m) => m.gatherHomeQueues(supabase, roles([])));
    expect(result.items).toEqual([]);
    expect(result.recentActivity).toBeNull();
    expect(dashboardSummaryMock).not.toHaveBeenCalled();
  });

  it('Analyst-only receives zero items (no mutation-oriented queue item, per A1_09 §4)', async () => {
    const supabase = makeFakeSupabase({});
    const { gatherHomeQueues } = await import('@/lib/admin/homeQueues');
    const result = await gatherHomeQueues(supabase, roles(['analyst']));
    expect(result.items).toEqual([]);
    expect(dashboardSummaryMock).not.toHaveBeenCalled();
  });

  it('Author-only sees own-drafts only (not the review-stage queues, which need Editor/Compliance Reviewer/Resource Admin/Super Admin)', async () => {
    const supabase = makeFakeSupabase({ resource_posts: 3 });
    dashboardSummaryMock.mockResolvedValue({ counts: { inReview: 9, reviewDue: 1 }, recent: [{ id: 'p1', title: 'Post', status: 'draft' }] });
    const { gatherHomeQueues } = await import('@/lib/admin/homeQueues');
    const result = await gatherHomeQueues(supabase, roles(['author']));
    expect(result.items.map((i) => i.id)).toEqual(['own-drafts']);
    expect(result.items[0].count).toBe(3);
    // Author is not in seesReviewQueues, but IS in seesOwnDrafts, so the
    // shared dashboard summary IS fetched (for recentActivity) even though
    // no review-queue tile is rendered.
    expect(result.recentActivity).toEqual([{ id: 'p1', title: 'Post', status: 'draft' }]);
  });

  it('Editor-only sees own-drafts (A1_09 §2 lists Editor) plus the two review-stage queues', async () => {
    const supabase = makeFakeSupabase({ resource_posts: 6 });
    dashboardSummaryMock.mockResolvedValue({ counts: { inReview: 4, reviewDue: 2 }, recent: [] });
    const { gatherHomeQueues } = await import('@/lib/admin/homeQueues');
    const result = await gatherHomeQueues(supabase, roles(['editor']));
    expect(result.items.map((i) => i.id)).toEqual(['own-drafts', 'content-awaiting-review', 'content-review-due']);
    expect(result.items[0].count).toBe(6);
    expect(result.items[1].count).toBe(4);
    expect(result.items[2].count).toBe(2);
  });

  it('Compliance Reviewer-only sees the two review-stage queues but NOT own-drafts (not in A1_09 §2\'s own-drafts role list)', async () => {
    const supabase = makeFakeSupabase({});
    dashboardSummaryMock.mockResolvedValue({ counts: { inReview: 4, reviewDue: 2 }, recent: [] });
    const { gatherHomeQueues } = await import('@/lib/admin/homeQueues');
    const result = await gatherHomeQueues(supabase, roles(['compliance_reviewer']));
    expect(result.items.map((i) => i.id)).toEqual(['content-awaiting-review', 'content-review-due']);
    expect(result.items[0].count).toBe(4);
    expect(result.items[1].count).toBe(2);
  });

  it('Super Admin sees every "today" queue source, including own-drafts and the three Super-Admin-only sources', async () => {
    const supabase = makeFakeSupabase({
      resource_posts: 0,
      action_recommendation_master: 5,
      benchmark_sources: 2,
      benchmark_datasets: 1,
    });
    dashboardSummaryMock.mockResolvedValue({ counts: { inReview: 0, reviewDue: 0 }, recent: [] });
    const { gatherHomeQueues } = await import('@/lib/admin/homeQueues');
    const result = await gatherHomeQueues(supabase, roles([], true));
    expect(result.items.map((i) => i.id)).toEqual([
      'own-drafts',
      'content-awaiting-review',
      'content-review-due',
      'recommendations-pending-activation',
      'benchmark-sources-pending-approval',
      'benchmark-datasets-pending-validation',
    ]);
    const recs = result.items.find((i) => i.id === 'recommendations-pending-activation')!;
    expect(recs.count).toBe(5);
    expect(recs.state).toBe('ok');
  });

  it('a genuine zero is `ok` with count 0, never confused with an error (Standard §8)', async () => {
    const supabase = makeFakeSupabase({ action_recommendation_master: 0, benchmark_sources: 0, benchmark_datasets: 0 });
    dashboardSummaryMock.mockResolvedValue({ counts: { inReview: 0, reviewDue: 0 }, recent: [] });
    const { gatherHomeQueues } = await import('@/lib/admin/homeQueues');
    const result = await gatherHomeQueues(supabase, roles([], true));
    const recs = result.items.find((i) => i.id === 'recommendations-pending-activation')!;
    expect(recs.state).toBe('ok');
    expect(recs.count).toBe(0);
  });

  it('one failing source becomes `error` for that tile only, without taking down independent sibling tiles (A1_09 §5)', async () => {
    const supabase = makeFakeSupabase({
      action_recommendation_master: 'error',
      benchmark_sources: 7,
      benchmark_datasets: 1,
    });
    dashboardSummaryMock.mockResolvedValue({ counts: { inReview: 2, reviewDue: 0 }, recent: [] });
    const { gatherHomeQueues } = await import('@/lib/admin/homeQueues');
    const result = await gatherHomeQueues(supabase, roles([], true));
    const recs = result.items.find((i) => i.id === 'recommendations-pending-activation')!;
    const sources = result.items.find((i) => i.id === 'benchmark-sources-pending-approval')!;
    expect(recs.state).toBe('error');
    expect(recs.count).toBeNull();
    expect(recs.errorMessage).toBeTruthy();
    // Sibling tile, backed by a different table, is unaffected.
    expect(sources.state).toBe('ok');
    expect(sources.count).toBe(7);
  });

  it('a dashboard-summary failure marks both review-stage tiles AND recent activity as failed together, honestly', async () => {
    // Compliance Reviewer deliberately, not Editor: Compliance Reviewer has
    // no own-drafts item at all (see the role-gating test above), so every
    // item this caller sees comes from the mocked, rejecting dashboard
    // summary — isolating this assertion from the separately-tested
    // own-drafts source, which does not depend on that summary.
    const supabase = makeFakeSupabase({});
    dashboardSummaryMock.mockRejectedValue(new Error('db unavailable'));
    const { gatherHomeQueues } = await import('@/lib/admin/homeQueues');
    const result = await gatherHomeQueues(supabase, roles(['compliance_reviewer']));
    expect(result.items.every((i) => i.state === 'error')).toBe(true);
    expect(result.items.every((i) => i.count === null)).toBe(true);
    expect(result.recentActivityError).toBeTruthy();
  });
});
