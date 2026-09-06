// Admin A2 — canonical navigation registry (dispatch §8).
//
// This module is the SINGLE typed source of navigation metadata described
// by A2 §8: stable ID, top-level area, label, description, route, the
// required capability (by name — never re-derived here), the roles the
// capability corresponds to (documentation only), visibility/availability
// state, a task-manual reference, ordering, active-route match mode, a
// children flag and (for anything not yet available) the owning future
// stage.
//
// It is deliberately layered ON TOP of the existing, already-certified
// decision functions — lib/admin/adminAreas.ts's buildAdminAreas() (which
// itself reuses lib/admin/adminNav.ts and lib/resources/permissions.ts) —
// rather than re-implementing capability logic. NAV_DESTINATIONS below is
// static metadata only (no capability evaluation happens in this file);
// `getVisibleDestinations()` cross-references buildAdminAreas()'s actual
// output (the same authorization decision every route's own server-side
// gate already makes) against this metadata purely to attach description,
// manual reference and stable IDs to what buildAdminAreas() already decided
// is visible. If a destination is missing from buildAdminAreas()'s output,
// it is absent here too — this file cannot show anything buildAdminAreas()
// itself would hide, and cannot hide anything it shows.
//
// Every href here is verified against ROUTE_BREADCRUMBS test coverage and
// the real page tree (tests/unit/adminA2NavigationRegistry.test.ts) — no
// entry may reference a route with no corresponding app/(app)/admin page.
//
// Withdrawn/unavailable tasks (Recommendations Gap review = ADM-06,
// Scheduled publication = ADM-10, Resources analytics = ADM-19) are
// deliberately NOT listed here: A1_06 §3 rule 9 / this dispatch's §9 forbid
// showing them in navigation at all (not even as a disabled or "coming
// soon" entry). Their traceability lives in docs/admin/A1_16_FDH13_TRACEABILITY_MATRIX.md
// and lib/admin/taskHelp.ts's own `not_operational` entries, which every
// caller can still reach by direct, capability-gated URL per §17's
// compatibility-routing rules.

import type { AdminCapabilities } from './adminNav';
import { buildAdminAreas, CANONICAL_AREA_ORDER, type AdminArea } from './adminAreas';

export type CanonicalArea = (typeof CANONICAL_AREA_ORDER)[number];

export interface NavDestination {
  /** Stable, never-reused identifier. Independent of label/href so a rename or route move never breaks a reference to this destination. */
  id: string;
  /** One of the eight PO-approved canonical top-level areas, in canonical order. */
  area: CanonicalArea;
  label: string;
  description: string;
  route: string;
  /**
   * Name of the existing capability predicate/field that gates this
   * destination — documentation of WHICH check applies, not a re-check.
   * One of an `AdminCapabilities` field name, `'isAdmin'` (Super Admin /
   * admin_users), or `'canManageResources'`.
   */
  capability: keyof AdminCapabilities | 'isAdmin' | 'canManageResources';
  /** Canonical roles expected to hold that capability today, for documentation only — access is decided by `capability`, never by this list. */
  applicableRolesForDocs: string;
  /** This registry only lists destinations that are Available when the capability holds — see the file header for why Hidden/Unavailable are not modelled as rows here. */
  visibilityState: 'available';
  availabilityState: 'operational';
  /** In-product task-help id (lib/admin/taskHelp.ts) that documents this destination, or null with a reason when the destination is oriented by its own on-page copy instead of a single task entry. */
  taskManualId: string | null;
  taskManualNote?: string;
  /** Position within its area, 1-based, matching render order. */
  order: number;
  matchMode: 'exact' | 'prefix';
  hasChildren: boolean;
}

// Order within each area matches lib/admin/adminAreas.ts's own sub-group and
// item order exactly (RESOURCES_ITEMS, then CONTENT_TYPE_ITEMS, then
// WORKFLOW_ITEMS, then DISCOVERY_ITEMS for Content; single items for the
// other areas) — this file does not introduce a second ordering decision.
export const NAV_DESTINATIONS: NavDestination[] = [
  {
    id: 'home',
    area: 'Home',
    label: 'Admin Home',
    description: 'Role-aware work queue: what needs attention, by when, and where to act on it.',
    route: '/admin/home',
    capability: 'isAdmin', // shouldShowAdminMenu() gate — see buildAdminAreas() Home branch; any admin capability qualifies, isAdmin is the closest single documented field.
    applicableRolesForDocs: 'Any caller holding at least one Resources or Super Admin capability.',
    visibilityState: 'available',
    availabilityState: 'operational',
    taskManualId: null,
    taskManualNote: 'Home is oriented by its own on-page guidance (queue cards + "Need help with a task?"), not a single ADM task entry.',
    order: 1,
    matchMode: 'exact',
    hasChildren: false,
  },
  // -- Content -----------------------------------------------------------
  {
    id: 'content-dashboard',
    area: 'Content',
    label: 'Dashboard',
    description: 'See what needs attention across Resources content and jump to the right queue.',
    route: '/admin/resources',
    capability: 'resourcesDashboard',
    applicableRolesForDocs: 'Resource Admin, Author, Editor, Compliance Reviewer, Publisher, Super Admin.',
    visibilityState: 'available',
    availabilityState: 'operational',
    taskManualId: 'ADM-07',
    order: 1,
    matchMode: 'exact',
    hasChildren: false,
  },
  {
    id: 'content-all',
    area: 'Content',
    label: 'All Content',
    description: 'Browse, search and open every content item regardless of workflow stage; start new content.',
    route: '/admin/resources/content',
    capability: 'resourcesDashboard',
    applicableRolesForDocs: 'Resource Admin, Author, Editor, Compliance Reviewer, Publisher, Super Admin.',
    visibilityState: 'available',
    availabilityState: 'operational',
    taskManualId: 'ADM-08',
    order: 2,
    matchMode: 'exact',
    hasChildren: false,
  },
  {
    id: 'content-new',
    area: 'Content',
    label: 'New Content',
    description: 'Create a new article, guide or FHIP explainer.',
    route: '/admin/resources/content/new',
    capability: 'resourcesDashboard',
    applicableRolesForDocs: 'Author, Editor, Resource Admin, Super Admin (route itself further gates on canCreateResource()).',
    visibilityState: 'available',
    availabilityState: 'operational',
    taskManualId: 'ADM-08',
    order: 3,
    matchMode: 'exact',
    hasChildren: false,
  },
  {
    id: 'content-videos',
    area: 'Content',
    label: 'Videos',
    description: 'Maintain the video library, including transcript and chapters.',
    route: '/admin/resources/videos',
    capability: 'resourceContentAdmin',
    applicableRolesForDocs: 'Author, Editor, Resource Admin, Super Admin (create/edit); other Resources roles view.',
    visibilityState: 'available',
    availabilityState: 'operational',
    taskManualId: 'ADM-11',
    order: 4,
    matchMode: 'prefix',
    hasChildren: true,
  },
  {
    id: 'content-glossary',
    area: 'Content',
    label: 'Glossary',
    description: 'Maintain the plain-English glossary the rest of the product links into.',
    route: '/admin/resources/glossary',
    capability: 'resourceContentAdmin',
    applicableRolesForDocs: 'Author, Editor, Resource Admin, Super Admin (create/edit); other Resources roles view.',
    visibilityState: 'available',
    availabilityState: 'operational',
    taskManualId: 'ADM-12',
    order: 5,
    matchMode: 'prefix',
    hasChildren: true,
  },
  {
    id: 'content-faqs',
    area: 'Content',
    label: 'FAQs',
    description: 'Maintain reusable questions and answers that can be attached to any Resources content.',
    route: '/admin/resources/faqs',
    capability: 'resourceContentAdmin',
    applicableRolesForDocs: 'Editor, Resource Admin, Super Admin.',
    visibilityState: 'available',
    availabilityState: 'operational',
    taskManualId: 'ADM-14',
    order: 6,
    matchMode: 'prefix',
    hasChildren: true,
  },
  {
    id: 'content-money-updates',
    area: 'Content',
    label: 'Money Updates',
    description: 'Publish a short, dated explanation of a real-world financial development.',
    route: '/admin/resources/money-updates',
    capability: 'resourceContentAdmin',
    applicableRolesForDocs: 'Author, Editor, Resource Admin, Super Admin (create/edit); other Resources roles view.',
    visibilityState: 'available',
    availabilityState: 'operational',
    taskManualId: 'ADM-13',
    order: 7,
    matchMode: 'prefix',
    hasChildren: true,
  },
  {
    id: 'content-drafts',
    area: 'Content',
    label: 'Drafts',
    description: 'Content at the Draft stage only.',
    route: '/admin/resources/content/drafts',
    capability: 'resourceWorkflowAdmin',
    applicableRolesForDocs: 'Resource Admin, Author, Editor, Compliance Reviewer, Publisher, Super Admin.',
    visibilityState: 'available',
    availabilityState: 'operational',
    taskManualId: 'ADM-21',
    order: 8,
    matchMode: 'exact',
    hasChildren: false,
  },
  {
    id: 'content-review',
    area: 'Content',
    label: 'Review Queue',
    description: 'Content awaiting editorial or compliance review.',
    route: '/admin/resources/content/review',
    capability: 'resourceWorkflowAdmin',
    applicableRolesForDocs: 'Resource Admin, Editor, Compliance Reviewer, Super Admin.',
    visibilityState: 'available',
    availabilityState: 'operational',
    taskManualId: 'ADM-21',
    order: 9,
    matchMode: 'exact',
    hasChildren: false,
  },
  {
    id: 'content-scheduled',
    area: 'Content',
    label: 'Scheduled',
    description: 'Content marked for future publication (manual Publish now is still required — see ADM-10).',
    route: '/admin/resources/content/scheduled',
    capability: 'resourceWorkflowAdmin',
    applicableRolesForDocs: 'Resource Admin, Publisher, Super Admin.',
    visibilityState: 'available',
    availabilityState: 'operational',
    taskManualId: 'ADM-21',
    order: 10,
    matchMode: 'exact',
    hasChildren: false,
  },
  {
    id: 'content-published',
    area: 'Content',
    label: 'Published',
    description: 'Content currently live on the public site.',
    route: '/admin/resources/content/published',
    capability: 'resourceWorkflowAdmin',
    applicableRolesForDocs: 'Resource Admin, Author, Editor, Compliance Reviewer, Publisher, Super Admin.',
    visibilityState: 'available',
    availabilityState: 'operational',
    taskManualId: 'ADM-21',
    order: 11,
    matchMode: 'exact',
    hasChildren: false,
  },
  {
    id: 'content-review-due',
    area: 'Content',
    label: 'Review Due',
    description: 'Published content past its scheduled review date.',
    route: '/admin/resources/content/review-due',
    capability: 'resourceWorkflowAdmin',
    applicableRolesForDocs: 'Resource Admin, Editor, Compliance Reviewer, Super Admin.',
    visibilityState: 'available',
    availabilityState: 'operational',
    taskManualId: 'ADM-21',
    order: 12,
    matchMode: 'exact',
    hasChildren: false,
  },
  {
    id: 'content-archived',
    area: 'Content',
    label: 'Archived',
    description: 'Content withdrawn from active workflow and from the public site.',
    route: '/admin/resources/content/archived',
    capability: 'resourceWorkflowAdmin',
    applicableRolesForDocs: 'Resource Admin, Author, Editor, Compliance Reviewer, Publisher, Super Admin.',
    visibilityState: 'available',
    availabilityState: 'operational',
    taskManualId: 'ADM-21',
    order: 13,
    matchMode: 'exact',
    hasChildren: false,
  },
  {
    id: 'content-related',
    area: 'Content',
    label: 'Related Content',
    description: 'Choose exactly which other resources appear alongside a given resource.',
    route: '/admin/resources/related',
    capability: 'resourceDiscoveryAdmin',
    applicableRolesForDocs: 'Resource Admin, Super Admin.',
    visibilityState: 'available',
    availabilityState: 'operational',
    taskManualId: 'ADM-16',
    order: 14,
    matchMode: 'exact',
    hasChildren: false,
  },
  {
    id: 'content-ctas',
    area: 'Content',
    label: 'CTAs',
    description: 'Maintain the controlled set of calls to action bridging content to the rest of FHIP.',
    route: '/admin/resources/ctas',
    capability: 'resourceDiscoveryAdmin',
    applicableRolesForDocs: 'Resource Admin, Super Admin.',
    visibilityState: 'available',
    availabilityState: 'operational',
    taskManualId: 'ADM-15',
    order: 15,
    matchMode: 'exact',
    hasChildren: true,
  },
  {
    id: 'content-context',
    area: 'Content',
    label: 'Context Mapping',
    description: 'Decide which resource an in-product "What does this mean?" link opens.',
    route: '/admin/resources/context',
    capability: 'resourceDiscoveryAdmin',
    applicableRolesForDocs: 'Resource Admin, Super Admin.',
    visibilityState: 'available',
    availabilityState: 'operational',
    taskManualId: 'ADM-17',
    order: 16,
    matchMode: 'exact',
    hasChildren: false,
  },
  // -- Recommendations -----------------------------------------------------
  {
    id: 'recommendations',
    area: 'Recommendations',
    label: 'Recommendations',
    description: 'Maintain the recommendation library and its activation state.',
    route: '/admin/recommendations',
    capability: 'isAdmin',
    applicableRolesForDocs: 'Super Admin only.',
    visibilityState: 'available',
    availabilityState: 'operational',
    taskManualId: 'ADM-04',
    taskManualNote: 'Also documents bulk CSV import (ADM-05); coverage-gap review (ADM-06) is withdrawn and not linked from navigation.',
    order: 1,
    matchMode: 'exact',
    hasChildren: false,
  },
  // -- Data Governance -----------------------------------------------------
  {
    id: 'data-governance-benchmarks',
    area: 'Data Governance',
    label: 'Benchmarks',
    description: 'Govern benchmark sources and datasets: approve, suspend, validate, activate and retire.',
    route: '/admin/benchmarks',
    capability: 'isAdmin',
    applicableRolesForDocs: 'Super Admin only.',
    visibilityState: 'available',
    availabilityState: 'operational',
    taskManualId: 'ADM-01',
    taskManualNote: 'Also documents dataset lifecycle (ADM-02) and read-only reference/audit tabs (ADM-03), selected per active tab.',
    order: 1,
    matchMode: 'exact',
    hasChildren: false,
  },
  // -- Administration ------------------------------------------------------
  {
    id: 'administration-users',
    area: 'Administration',
    label: 'Users & Roles',
    description: 'Assign or remove Resources roles for an FHIP account.',
    route: '/admin/resources/users',
    capability: 'canManageResources',
    applicableRolesForDocs: 'Resource Admin, Super Admin.',
    visibilityState: 'available',
    availabilityState: 'operational',
    taskManualId: 'ADM-18',
    order: 1,
    matchMode: 'exact',
    hasChildren: false,
  },
];

/**
 * Cross-references NAV_DESTINATIONS against buildAdminAreas()'s real,
 * authorization-derived output for one caller, returning only the metadata
 * rows for hrefs that caller's own areas actually contain. This function
 * makes NO capability decision itself — a destination absent from
 * `areas` (because the caller lacks the capability, or the whole area is
 * empty) is absent from the result, full stop.
 */
export function getVisibleDestinations(
  isAdmin: boolean,
  capabilities: AdminCapabilities,
  canManageResourceUsers: boolean
): NavDestination[] {
  const areas: AdminArea[] = buildAdminAreas(isAdmin, capabilities, canManageResourceUsers);
  const visibleHrefs = new Set(areas.flatMap((a) => a.subGroups.flatMap((g) => g.items.map((i) => i.href))));
  return NAV_DESTINATIONS.filter((d) => visibleHrefs.has(d.route));
}
