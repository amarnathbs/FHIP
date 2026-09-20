/**
 * Admin A2 — canonical navigation registry integrity (dispatch §8/§24).
 *
 * Hermetic: no DEV/staging/production access, no .env read, no network, no
 * database. Asserts the static NAV_DESTINATIONS metadata is internally
 * consistent, and that getVisibleDestinations() never disagrees with
 * buildAdminAreas() — the actual, already-certified authorization decision.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  NAV_DESTINATIONS,
  getVisibleDestinations,
  type NavDestination,
} from '@/lib/admin/navigationRegistry';
import { buildAdminAreas, CANONICAL_AREA_ORDER } from '@/lib/admin/adminAreas';
import { NO_ADMIN_CAPABILITIES, type AdminCapabilities } from '@/lib/admin/adminNav';
import { ADMIN_TASK_IDS } from '@/lib/admin/taskHelp';

const ALL_CAPS: AdminCapabilities = {
  resourcesDashboard: true,
  resourceContentAdmin: true,
  resourceWorkflowAdmin: true,
  resourceDiscoveryAdmin: true,
  resourceAnalytics: true,
  // PC6/PC7 (Investment Intelligence) — added to AdminCapabilities on `main`
  // after this branch was cut; see docs/admin/A2A5_00_PROGRAMME_RECONCILIATION.md.
  referenceDataQuality: true,
  lookthroughDataQuality: true,
};

describe('A2 — navigation registry structural integrity', () => {
  it('every id is unique', () => {
    const ids = NAV_DESTINATIONS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every route is unique (no duplicate route entries)', () => {
    const routes = NAV_DESTINATIONS.map((d) => d.route);
    expect(new Set(routes).size).toBe(routes.length);
  });

  it('every area is one of the 8 canonical areas, and rows for one area are contiguous with that area\'s own order', () => {
    for (const d of NAV_DESTINATIONS) {
      expect(CANONICAL_AREA_ORDER as readonly string[]).toContain(d.area);
    }
    for (const area of CANONICAL_AREA_ORDER) {
      const rows = NAV_DESTINATIONS.filter((d) => d.area === area);
      const orders = rows.map((d) => d.order);
      expect(orders).toEqual([...orders].sort((a, b) => a - b));
      expect(new Set(orders).size).toBe(orders.length); // no ties within one area
    }
  });

  it('every route resolves to a real page.tsx under app/(app)/admin', () => {
    const appRoot = path.join(process.cwd(), 'app', '(app)');
    for (const d of NAV_DESTINATIONS) {
      const segments = d.route.replace(/^\//, '').split('/');
      const pagePath = path.join(appRoot, ...segments, 'page.tsx');
      expect(fs.existsSync(pagePath), `${d.route} -> expected ${pagePath} to exist`).toBe(true);
    }
  });

  it('every non-null taskManualId references a real entry in lib/admin/taskHelp.ts', () => {
    for (const d of NAV_DESTINATIONS) {
      if (d.taskManualId !== null) {
        expect(ADMIN_TASK_IDS, `${d.id} references unknown task ${d.taskManualId}`).toContain(d.taskManualId);
      }
    }
  });

  it('a null taskManualId always carries an explanatory taskManualNote', () => {
    for (const d of NAV_DESTINATIONS) {
      if (d.taskManualId === null) {
        expect(d.taskManualNote, `${d.id} has no manual and no explanation`).toBeTruthy();
      }
    }
  });

  it('withdrawn/unavailable tasks (ADM-06 Gap review, ADM-10 Scheduled publication, ADM-19 Resources analytics) are never referenced', () => {
    const withdrawn = ['ADM-06', 'ADM-10', 'ADM-19'];
    for (const d of NAV_DESTINATIONS) {
      expect(withdrawn).not.toContain(d.taskManualId);
    }
    // And no destination points at the withdrawn Analytics route itself.
    expect(NAV_DESTINATIONS.map((d) => d.route)).not.toContain('/admin/resources/analytics');
  });

  it('every capability field named on a destination is a real AdminCapabilities key or one of the two documented predicates', () => {
    const validFields = new Set([...Object.keys(NO_ADMIN_CAPABILITIES), 'isAdmin', 'canManageResources']);
    for (const d of NAV_DESTINATIONS) {
      expect(validFields.has(d.capability), `${d.id} names unknown capability "${d.capability}"`).toBe(true);
    }
  });
});

describe('A2 — getVisibleDestinations() never disagrees with buildAdminAreas()', () => {
  function allHrefs(isAdmin: boolean, caps: AdminCapabilities, manage: boolean): Set<string> {
    return new Set(buildAdminAreas(isAdmin, caps, manage).flatMap((a) => a.subGroups.flatMap((g) => g.items.map((i) => i.href))));
  }

  const CASES: [string, boolean, AdminCapabilities, boolean][] = [
    ['role-less', false, NO_ADMIN_CAPABILITIES, false],
    ['Author', false, { ...NO_ADMIN_CAPABILITIES, resourcesDashboard: true, resourceContentAdmin: true, resourceWorkflowAdmin: true }, false],
    ['Resource Admin', false, { ...NO_ADMIN_CAPABILITIES, resourcesDashboard: true, resourceContentAdmin: true, resourceWorkflowAdmin: true, resourceDiscoveryAdmin: true }, true],
    ['Super Admin (all caps)', true, ALL_CAPS, true],
  ];

  for (const [label, isAdmin, caps, manage] of CASES) {
    it(`${label}: every registry row returned is actually present in buildAdminAreas()'s own hrefs`, () => {
      const hrefs = allHrefs(isAdmin, caps, manage);
      const visible = getVisibleDestinations(isAdmin, caps, manage);
      for (const d of visible) {
        expect(hrefs.has(d.route), `${d.id} (${d.route}) returned visible but absent from buildAdminAreas()`).toBe(true);
      }
    });

    it(`${label}: every href buildAdminAreas() shows that also appears in NAV_DESTINATIONS is returned as visible (no silent drop)`, () => {
      const hrefs = allHrefs(isAdmin, caps, manage);
      const registryRoutes = new Set(NAV_DESTINATIONS.map((d) => d.route));
      const visible = getVisibleDestinations(isAdmin, caps, manage);
      const visibleRoutes = new Set(visible.map((d) => d.route));
      for (const href of hrefs) {
        if (registryRoutes.has(href)) {
          expect(visibleRoutes.has(href), `${href} is shown by buildAdminAreas() but missing from getVisibleDestinations()`).toBe(true);
        }
      }
    });
  }

  it('a role-less caller gets zero visible destinations', () => {
    expect(getVisibleDestinations(false, NO_ADMIN_CAPABILITIES, false)).toEqual([]);
  });

  it('no orphan children: every destination with hasChildren true has a route that is itself present as a real page (children live at deeper dynamic paths not individually registered, by design)', () => {
    // hasChildren marks list pages that have [id]/edit or /new children; this
    // asserts the parent itself resolves (checked above) and that no
    // registry row claims children under a route that has no children at
    // all in the real page tree.
    const appRoot = path.join(process.cwd(), 'app', '(app)');
    for (const d of NAV_DESTINATIONS.filter((x) => x.hasChildren)) {
      const dir = path.join(appRoot, ...d.route.replace(/^\//, '').split('/'));
      const entries = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
      const hasDynamicOrNewChild = entries.some((e) => e === 'new' || e.startsWith('['));
      expect(hasDynamicOrNewChild, `${d.id} claims hasChildren but ${dir} has no [id] or new/ subroute`).toBe(true);
    }
  });
});

describe('A2 — no empty visible top-level area ever renders', () => {
  const SAMPLE_CAP_COMBOS: AdminCapabilities[] = [
    NO_ADMIN_CAPABILITIES,
    { ...NO_ADMIN_CAPABILITIES, resourcesDashboard: true },
    { ...NO_ADMIN_CAPABILITIES, resourceContentAdmin: true },
    { ...NO_ADMIN_CAPABILITIES, resourceWorkflowAdmin: true },
    { ...NO_ADMIN_CAPABILITIES, resourceDiscoveryAdmin: true },
    ALL_CAPS,
  ];

  it('every area buildAdminAreas() ever returns has at least one sub-group with at least one item', () => {
    for (const isAdmin of [false, true]) {
      for (const manage of [false, true]) {
        for (const caps of SAMPLE_CAP_COMBOS) {
          const areas = buildAdminAreas(isAdmin, caps, manage);
          for (const area of areas) {
            expect(area.subGroups.length, `${area.label} rendered with zero sub-groups`).toBeGreaterThan(0);
            for (const group of area.subGroups) {
              expect(group.items.length, `${area.label} / ${group.label} rendered with zero items`).toBeGreaterThan(0);
            }
          }
        }
      }
    }
  });
});

describe('A2 — task-manual coverage for every visible destination (dispatch §16/§24)', () => {
  it('every destination is either linked to a real manual entry or explicitly documents why not', () => {
    for (const d of NAV_DESTINATIONS) {
      const hasManual = d.taskManualId !== null && ADMIN_TASK_IDS.includes(d.taskManualId);
      const hasExplicitNote = d.taskManualId === null && !!d.taskManualNote;
      expect(hasManual || hasExplicitNote, `${d.id} has neither a valid manual link nor an explanatory note`).toBe(true);
    }
  });
});

// Type-level smoke check: ensures the exported type still carries every
// field §8 requires, so a future edit that drops a field fails to compile
// (not just fails a runtime assertion).
function _typeCoverage(d: NavDestination) {
  const _id: string = d.id;
  const _area = d.area;
  const _label: string = d.label;
  const _description: string = d.description;
  const _route: string = d.route;
  const _capability = d.capability;
  const _roles: string = d.applicableRolesForDocs;
  const _visibility = d.visibilityState;
  const _availability = d.availabilityState;
  const _manual = d.taskManualId;
  const _order: number = d.order;
  const _matchMode = d.matchMode;
  const _children: boolean = d.hasChildren;
  void [_id, _area, _label, _description, _route, _capability, _roles, _visibility, _availability, _manual, _order, _matchMode, _children];
}
void _typeCoverage;
