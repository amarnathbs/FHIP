// Admin A2 — Canonical Admin Shell and Navigation.
//
// Builds the PO-2-approved 8-area canonical navigation structure
// (docs/admin/A1_06_INFORMATION_ARCHITECTURE.md, A1_07_NAVIGATION_BLUEPRINT_BY_ROLE.md)
// on top of the EXISTING capability resolver in lib/admin/adminNav.ts and
// lib/resources/permissions.ts — this module adds no new capability
// predicate and re-implements no authorization decision. It only re-groups
// the same items those modules already expose (same hrefs, same gating
// booleans) into the 8 canonical top-level areas, because A1_08's own
// migration map is explicit that A2 moves no route — every "move"/"relabel"
// disposition there is a nav-parent change, never a URL change
// (A1_08_MIGRATION_MAP.md §10).
//
// Deliberately NOT touched: lib/admin/adminNav.ts's existing exports
// (buildAdminNavGroups, getAdminUnavailableNotice, shouldShowAdminMenu,
// AdminCapabilities, NO_ADMIN_CAPABILITIES, ADMIN_GENERAL_ITEMS,
// RESOURCES_ITEMS, CONTENT_TYPE_ITEMS, WORKFLOW_ITEMS, DISCOVERY_ITEMS,
// ANALYTICS_ITEMS, parseAdminCapabilities, parseIsAdmin). Those remain the
// pre-existing main-app AppShell "Admin" dropdown's contract, exhaustively
// certified by tests/unit/adminAnalyticsPhaseA.test.ts and
// tests/unit/adminAnalyticsPhaseAMeRoute.test.ts — a byte-for-byte
// regression bar this module must not put at risk. This module is
// ADDITIVE: a second, independent consumer of the same underlying item
// lists and the same capability booleans, feeding the NEW canonical
// /admin/** shell (components/admin/AdminShell.tsx) instead of the old
// sidebar-embedded dropdown.

import {
  RESOURCES_ITEMS,
  CONTENT_TYPE_ITEMS,
  WORKFLOW_ITEMS,
  DISCOVERY_ITEMS,
  shouldShowAdminMenu,
  type AdminCapabilities,
} from './adminNav';

export interface AdminAreaItem {
  label: string;
  href: string;
}

export interface AdminAreaSubGroup {
  label: string;
  items: AdminAreaItem[];
  matchMode: 'exact' | 'prefix';
}

export interface AdminArea {
  /** Stable identifier for tests/DOM ids — never rendered as user-facing text. */
  key: string;
  /** One of the 8 PO-2-approved area labels, in PO-2-approved order. */
  label: string;
  subGroups: AdminAreaSubGroup[];
}

// PO-2 binding order (A1_06 §1): Home, Content, Recommendations,
// Data Governance, Operations, Analytics, Security & Support, Administration.
export const CANONICAL_AREA_ORDER = [
  'Home',
  'Content',
  'Recommendations',
  'Data Governance',
  'Operations',
  'Analytics',
  'Security & Support',
  'Administration',
] as const;

/**
 * Builds the 8-area canonical nav for one caller, omitting every area that
 * would render empty (A1_06 §3 rule 2) and every destination the caller
 * lacks the capability for (rule 3). Today, per A1_06 §2.2 and A1_07 §1:
 *
 *  - Operations and Security & Support have ZERO genuinely usable
 *    destinations for ANY caller (ADM-23/ADM-26 are operational-with-no-UI;
 *    every other task in those areas is future) — omitted entirely, not
 *    shown as an empty group and not shown as a fake placeholder link,
 *    because no page exists yet to link to.
 *  - Analytics stays unexposed regardless of capability, per PO-2's own
 *    binding rule (A1_06 §3 rule 9: "do not expose Analytics until it
 *    contains a genuinely functional authorized destination") — identical
 *    to the pre-existing behaviour buildAdminNavGroups() already
 *    implements for the old dropdown (Wave 3 Gate 3), just restated here
 *    for the canonical shell.
 *  - Data Governance renders only its operational Benchmarks portion; the
 *    FDH-governance portion renders no nav item at all today (A1_06 §3
 *    rule 1).
 *
 * `canManageResourceUsers` is passed in separately (rather than read off
 * `AdminCapabilities`) because it is not one of the five fields
 * `/api/admin/me` returns — reusing `canManageResources()` from
 * lib/resources/permissions.ts directly, computed server-side in
 * app/(app)/admin/layout.tsx from the same `CurrentResourceRoles` snapshot
 * every other Resources predicate already uses, rather than widening the
 * `/api/admin/me` response contract (which tests/unit/adminAnalyticsPhaseA*
 * assert field-for-field and would break on any added key).
 */
export function buildAdminAreas(isAdmin: boolean, capabilities: AdminCapabilities, canManageResourceUsers: boolean): AdminArea[] {
  const areas: AdminArea[] = [];

  // Home — present whenever the caller holds ANY admin capability at all,
  // reusing shouldShowAdminMenu() (the existing resolver) verbatim rather
  // than re-deriving "does this caller have some admin capability" as a
  // second, parallel condition that could silently drift from the first.
  if (shouldShowAdminMenu(isAdmin, capabilities)) {
    areas.push({
      key: 'home',
      label: 'Home',
      subGroups: [{ label: 'Home', items: [{ label: 'Admin Home', href: '/admin/home' }], matchMode: 'exact' }],
    });
  }

  // Content — Resources dashboard + content-type CRUD + workflow queues +
  // Discovery, folded into one canonical area per A1_06 §2.2 (the old
  // "Resources"/"Content"/"Workflow"/"Discovery" flat groups become
  // sub-groups of one Content area, not four top-level areas). Each
  // sub-group still reads its OWN capability field independently — no
  // shared boolean gates more than one (Standard §2).
  const contentSubGroups: AdminAreaSubGroup[] = [];
  if (capabilities.resourcesDashboard) {
    contentSubGroups.push({ label: 'Dashboard', items: RESOURCES_ITEMS, matchMode: 'exact' });
  }
  if (capabilities.resourceContentAdmin) {
    contentSubGroups.push({ label: 'Content types', items: CONTENT_TYPE_ITEMS, matchMode: 'prefix' });
  }
  if (capabilities.resourceWorkflowAdmin) {
    contentSubGroups.push({ label: 'Queues', items: WORKFLOW_ITEMS, matchMode: 'exact' });
  }
  if (capabilities.resourceDiscoveryAdmin) {
    contentSubGroups.push({ label: 'Discovery', items: DISCOVERY_ITEMS, matchMode: 'exact' });
  }
  if (contentSubGroups.length > 0) {
    areas.push({ key: 'content', label: 'Content', subGroups: contentSubGroups });
  }

  // Recommendations — split out of the old "General" group per PO-2
  // (A1_06 §4). Still Super Admin only, exactly as ADMIN_GENERAL_ITEMS was
  // gated in the old dropdown (buildAdminNavGroups gates "General" on
  // `isAdmin` alone) — same authorization, new label/grouping only.
  if (isAdmin) {
    areas.push({
      key: 'recommendations',
      label: 'Recommendations',
      subGroups: [{ label: 'Recommendations', items: [{ label: 'Recommendations', href: '/admin/recommendations' }], matchMode: 'exact' }],
    });
  }

  // Data Governance — Benchmarks folds in here per PO-2's consolidation
  // (A1_06 §1/§4), not a standalone "Reference Data & Benchmarks" area.
  // Same Super-Admin-only gate as the old "General" group's Benchmarks
  // entry. The FDH-governance portion (ADM-30-36,40) has no operational
  // task yet, so it contributes no sub-group here at all today.
  //
  // A2A5 reconciliation finding: PC6/PC7 (Investment Intelligence Reference
  // Data / Fund Look-Through quality) shipped real pages
  // (app/(app)/admin/investment-intelligence/{reference-data-quality,
  // lookthrough-data-quality}/page.tsx) on `main` after this branch was
  // originally cut, gated on their own capability booleans
  // (referenceDataQuality/lookthroughDataQuality) — separate from isAdmin,
  // per Standard §2 ("capabilities may share lower-level role-resolution
  // helpers... but each remains separately named/tested"). Without this,
  // the canonical shell would have zero entry point to two real, authorized,
  // usable destinations for whoever holds those capabilities — exactly the
  // "route exists but is not falsely hidden" failure mode A2-WP's own
  // binding instructions (capability-driven visibility) exist to prevent.
  const dataGovernanceSubGroups: AdminAreaSubGroup[] = [];
  if (isAdmin) {
    dataGovernanceSubGroups.push({ label: 'Benchmarks', items: [{ label: 'Benchmarks', href: '/admin/benchmarks' }], matchMode: 'exact' });
  }
  if (capabilities.referenceDataQuality) {
    dataGovernanceSubGroups.push({
      label: 'Reference Data',
      items: [{ label: 'Reference Data Quality', href: '/admin/investment-intelligence/reference-data-quality' }],
      matchMode: 'exact',
    });
  }
  if (capabilities.lookthroughDataQuality) {
    dataGovernanceSubGroups.push({
      label: 'Fund Look-Through',
      items: [{ label: 'Fund Look-Through Quality', href: '/admin/investment-intelligence/lookthrough-data-quality' }],
      matchMode: 'exact',
    });
  }
  if (dataGovernanceSubGroups.length > 0) {
    areas.push({ key: 'data-governance', label: 'Data Governance', subGroups: dataGovernanceSubGroups });
  }

  // Operations, Analytics, Security & Support — intentionally absent. See
  // this function's own doc comment above.

  // Administration — role assignment (Resources users/roles) only, per
  // A1_08 §4 ("move... under Administration (role assignment)") and A1_07's
  // persona table ("Resource Admin: Administration (Resources-role
  // assignment slice only)"). Gated on canManageResources() — the same
  // predicate app/(app)/admin/resources/users/page.tsx already enforces at
  // the route layer — not on isAdmin alone, so a Resource Admin (not Super
  // Admin) sees this area exactly as A1_07 §2 specifies.
  if (canManageResourceUsers) {
    areas.push({
      key: 'administration',
      label: 'Administration',
      subGroups: [{ label: 'Roles', items: [{ label: 'Users & Roles', href: '/admin/resources/users' }], matchMode: 'exact' }],
    });
  }

  return areas;
}

// ---------------------------------------------------------------------------
// Breadcrumbs
// ---------------------------------------------------------------------------

export interface BreadcrumbSegment {
  label: string;
  href: string;
}

export interface BreadcrumbResolution {
  /** The canonical area label this page belongs to, or null if unmapped. */
  area: string | null;
  /** Ordered crumbs, root first, current page last. Never includes "Admin" itself — the shell renders that separately. */
  crumbs: BreadcrumbSegment[];
}

// Longest-prefix-wins route registry covering every existing Admin page
// (A1_08_MIGRATION_MAP.md §1-8's full 36-page inventory) mapped onto its
// PO-2 target area. A dynamic detail route (e.g. .../content/[id]/edit)
// deliberately falls back to its parent list's own crumb rather than
// fabricating a record title here — breadcrumbs never guess at data they
// were not given (Standard §13's "never a value a caller could mistake for
// real data" applies equally to a fabricated breadcrumb label).
const ROUTE_BREADCRUMBS: { prefix: string; area: string; crumbs: BreadcrumbSegment[] }[] = [
  { prefix: '/admin/home', area: 'Home', crumbs: [{ label: 'Home', href: '/admin/home' }] },

  // Content — dashboard
  { prefix: '/admin/resources/content/new', area: 'Content', crumbs: [
    { label: 'Content', href: '/admin/resources/content' },
    { label: 'New Content', href: '/admin/resources/content/new' },
  ] },
  { prefix: '/admin/resources/content/drafts', area: 'Content', crumbs: [
    { label: 'Content', href: '/admin/resources/content' },
    { label: 'Drafts', href: '/admin/resources/content/drafts' },
  ] },
  { prefix: '/admin/resources/content/review-due', area: 'Content', crumbs: [
    { label: 'Content', href: '/admin/resources/content' },
    { label: 'Review Due', href: '/admin/resources/content/review-due' },
  ] },
  { prefix: '/admin/resources/content/review', area: 'Content', crumbs: [
    { label: 'Content', href: '/admin/resources/content' },
    { label: 'Review Queue', href: '/admin/resources/content/review' },
  ] },
  { prefix: '/admin/resources/content/scheduled', area: 'Content', crumbs: [
    { label: 'Content', href: '/admin/resources/content' },
    { label: 'Scheduled', href: '/admin/resources/content/scheduled' },
  ] },
  { prefix: '/admin/resources/content/published', area: 'Content', crumbs: [
    { label: 'Content', href: '/admin/resources/content' },
    { label: 'Published', href: '/admin/resources/content/published' },
  ] },
  { prefix: '/admin/resources/content/archived', area: 'Content', crumbs: [
    { label: 'Content', href: '/admin/resources/content' },
    { label: 'Archived', href: '/admin/resources/content/archived' },
  ] },
  { prefix: '/admin/resources/content', area: 'Content', crumbs: [{ label: 'Content', href: '/admin/resources/content' }] },

  { prefix: '/admin/resources/videos', area: 'Content', crumbs: [
    { label: 'Content', href: '/admin/resources/content' },
    { label: 'Videos', href: '/admin/resources/videos' },
  ] },
  { prefix: '/admin/resources/glossary', area: 'Content', crumbs: [
    { label: 'Content', href: '/admin/resources/content' },
    { label: 'Glossary', href: '/admin/resources/glossary' },
  ] },
  { prefix: '/admin/resources/faqs', area: 'Content', crumbs: [
    { label: 'Content', href: '/admin/resources/content' },
    { label: 'FAQs', href: '/admin/resources/faqs' },
  ] },
  { prefix: '/admin/resources/money-updates', area: 'Content', crumbs: [
    { label: 'Content', href: '/admin/resources/content' },
    { label: 'Money Updates', href: '/admin/resources/money-updates' },
  ] },

  { prefix: '/admin/resources/related', area: 'Content', crumbs: [
    { label: 'Content', href: '/admin/resources/content' },
    { label: 'Discovery', href: '/admin/resources/related' },
    { label: 'Related Content', href: '/admin/resources/related' },
  ] },
  { prefix: '/admin/resources/ctas', area: 'Content', crumbs: [
    { label: 'Content', href: '/admin/resources/content' },
    { label: 'Discovery', href: '/admin/resources/related' },
    { label: 'CTAs', href: '/admin/resources/ctas' },
  ] },
  { prefix: '/admin/resources/context', area: 'Content', crumbs: [
    { label: 'Content', href: '/admin/resources/content' },
    { label: 'Discovery', href: '/admin/resources/related' },
    { label: 'Context Mapping', href: '/admin/resources/context' },
  ] },

  // Administration — role assignment
  { prefix: '/admin/resources/users', area: 'Administration', crumbs: [
    { label: 'Administration', href: '/admin/resources/users' },
    { label: 'Users & Roles', href: '/admin/resources/users' },
  ] },

  // ADM-19 — deliberately reachable by direct URL only (nav-suppressed, per
  // Wave 3 Gate 3 / A1_06 §3 rule 9); still gets an honest breadcrumb if a
  // caller with the capability navigates there directly.
  { prefix: '/admin/resources/analytics', area: 'Analytics', crumbs: [{ label: 'Analytics', href: '/admin/resources/analytics' }] },

  // Content — dashboard landing page itself (checked after every more
  // specific /admin/resources/* prefix above, since '/admin/resources' is a
  // prefix of all of them).
  { prefix: '/admin/resources', area: 'Content', crumbs: [
    { label: 'Content', href: '/admin/resources/content' },
    { label: 'Dashboard', href: '/admin/resources' },
  ] },

  { prefix: '/admin/recommendations', area: 'Recommendations', crumbs: [{ label: 'Recommendations', href: '/admin/recommendations' }] },
  { prefix: '/admin/benchmarks', area: 'Data Governance', crumbs: [
    { label: 'Data Governance', href: '/admin/benchmarks' },
    { label: 'Benchmarks', href: '/admin/benchmarks' },
  ] },
];

/**
 * Resolves the current pathname to its canonical area + breadcrumb chain,
 * by longest-matching-prefix. Never fabricates a page title for a route it
 * doesn't recognise — an unmapped path (e.g. a future route not yet added
 * here) falls back to a single generic "Admin" crumb rather than guessing.
 */
export function resolveBreadcrumbs(pathname: string): BreadcrumbResolution {
  let best: { prefix: string; area: string; crumbs: BreadcrumbSegment[] } | null = null;
  for (const route of ROUTE_BREADCRUMBS) {
    if (pathname === route.prefix || pathname.startsWith(`${route.prefix}/`)) {
      if (!best || route.prefix.length > best.prefix.length) best = route;
    }
  }
  if (!best) return { area: null, crumbs: [{ label: 'Admin', href: '/admin/home' }] };
  return { area: best.area, crumbs: best.crumbs };
}
