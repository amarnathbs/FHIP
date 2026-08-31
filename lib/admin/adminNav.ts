// Admin navigation capability contract — Analyst Analytics Phase A, Wave 1.
//
// This module holds the *decision* half of the Admin nav (which groups a
// caller may see) as pure, dependency-free functions, separated from
// components/ui/AppShell.tsx's rendering half. Two reasons, both required by
// the Admin Architecture Standard:
//
//  - §2: every capability decision must be independently named and
//    independently testable. This repository has no DOM test environment
//    (vitest runs `environment: 'node'`, and neither jsdom nor
//    @testing-library is a dependency), so a decision function embedded in a
//    'use client' React component could not be exercised group-by-group.
//    Extracting it makes each nav group's visibility a directly assertable
//    unit, not something inferred from a rendered dropdown.
//  - §4: navigation visibility is a UX convenience, never authorisation.
//    Keeping the nav decision in its own module, physically separate from
//    every server-side gate, makes that separation structural rather than a
//    comment.
//
// WAVE 1 SCOPE: this file introduces the Analytics group and moves the
// existing nav-item constants and adminGroups construction out of
// AppShell.tsx verbatim. It changes no item, label, href, ordering or match
// mode of any pre-existing group.

// -- Nav item lists (moved verbatim from components/ui/AppShell.tsx) --------

// R1.2 Admin Resources shell nav — spec §41. Future routes named in the spec
// (§8 — videos/glossary/faqs/categories/etc.) are deliberately not listed
// here at all, rather than shown disabled, per spec §8's "omit until
// implementation" option.
// R1.3 adds "New Content" (spec §10) — role-gated server-side by
// /admin/resources/content/new itself (canCreateResource()), not by this
// list; a Resources-role user without create rights simply sees a friendly
// "you don't have permission" message on that page rather than the link
// being hidden, matching this list's own stated convention above.
export const RESOURCES_ITEMS: { label: string; href: string }[] = [
  { label: 'Dashboard', href: '/admin/resources' },
  { label: 'All Content', href: '/admin/resources/content' },
  { label: 'New Content', href: '/admin/resources/content/new' },
];

// The two pre-existing Super Admin surfaces (Benchmarks, Recommendations) —
// pulled into the same collapsible "Admin" section as everything below so
// there's one admin entry point in the sidebar, not three independent
// flat sections at the top level.
export const ADMIN_GENERAL_ITEMS: { label: string; href: string }[] = [
  { label: 'Benchmarks', href: '/admin/benchmarks' },
  { label: 'Recommendations', href: '/admin/recommendations' },
];

// R1.4 (spec §64): specialist content-type shortcuts so admins can reach
// Video/Glossary/FAQ/Money Update management without going through All
// Content for every workflow (spec §110).
export const CONTENT_TYPE_ITEMS: { label: string; href: string }[] = [
  { label: 'Videos', href: '/admin/resources/videos' },
  { label: 'Glossary', href: '/admin/resources/glossary' },
  { label: 'FAQs', href: '/admin/resources/faqs' },
  { label: 'Money Updates', href: '/admin/resources/money-updates' },
];

export const WORKFLOW_ITEMS: { label: string; href: string }[] = [
  { label: 'Drafts', href: '/admin/resources/content/drafts' },
  { label: 'Review Queue', href: '/admin/resources/content/review' },
  { label: 'Scheduled', href: '/admin/resources/content/scheduled' },
  { label: 'Published', href: '/admin/resources/content/published' },
  { label: 'Review Due', href: '/admin/resources/content/review-due' },
  { label: 'Archived', href: '/admin/resources/content/archived' },
];

// R1.6 (spec §75): only the three Discovery surfaces that have real screens
// behind them — "Do not add dead links."
export const DISCOVERY_ITEMS: { label: string; href: string }[] = [
  { label: 'Related Content', href: '/admin/resources/related' },
  { label: 'CTAs', href: '/admin/resources/ctas' },
  { label: 'Context Mapping', href: '/admin/resources/context' },
];

// Phase A Wave 1 (Plan §8 item 2): the single Analytics destination. No
// metric sub-navigation exists in Wave 1 — the individual metric surfaces
// (A3-A8) are later, separately authorised waves.
export const ANALYTICS_ITEMS: { label: string; href: string }[] = [{ label: 'Analytics', href: '/admin/resources/analytics' }];

// -- Capability contract ---------------------------------------------------

/**
 * The `capabilities` object returned by GET /api/admin/me. One field per
 * independently named server-side capability predicate — never a broad
 * catch-all flag (Standard §2).
 */
export interface AdminCapabilities {
  resourcesDashboard: boolean;
  resourceContentAdmin: boolean;
  resourceWorkflowAdmin: boolean;
  resourceDiscoveryAdmin: boolean;
  resourceAnalytics: boolean;
}

/**
 * The fail-closed default (Standard §13). This is the value the nav holds
 * before /api/admin/me resolves, and the value it falls back to when that
 * request fails, returns a non-OK status, or returns a malformed body — an
 * error must never become a default grant of access.
 */
export const NO_ADMIN_CAPABILITIES: AdminCapabilities = Object.freeze({
  resourcesDashboard: false,
  resourceContentAdmin: false,
  resourceWorkflowAdmin: false,
  resourceDiscoveryAdmin: false,
  resourceAnalytics: false,
});

function readBooleanField(source: Record<string, unknown>, key: keyof AdminCapabilities): boolean {
  // Strictly `=== true`. A truthy-but-not-boolean value (a non-empty string,
  // a number, an object) is treated as absent, so a malformed or
  // partially-populated payload can never widen access.
  return source[key] === true;
}

/**
 * Fail-closed parse of a GET /api/admin/me response body into an
 * AdminCapabilities value. Any shape other than an object carrying literal
 * `true` in a given field yields `false` for that field.
 *
 * Deliberately does NOT fall back to `isAdmin` or `hasResourcesAccess`:
 * legacy broad flags must never be repurposed as a capability (Standard §2).
 */
export function parseAdminCapabilities(body: unknown): AdminCapabilities {
  const data = (body as { data?: unknown } | null | undefined)?.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ...NO_ADMIN_CAPABILITIES };
  const caps = (data as { capabilities?: unknown }).capabilities;
  if (!caps || typeof caps !== 'object' || Array.isArray(caps)) return { ...NO_ADMIN_CAPABILITIES };
  const source = caps as Record<string, unknown>;
  return {
    resourcesDashboard: readBooleanField(source, 'resourcesDashboard'),
    resourceContentAdmin: readBooleanField(source, 'resourceContentAdmin'),
    resourceWorkflowAdmin: readBooleanField(source, 'resourceWorkflowAdmin'),
    resourceDiscoveryAdmin: readBooleanField(source, 'resourceDiscoveryAdmin'),
    resourceAnalytics: readBooleanField(source, 'resourceAnalytics'),
  };
}

/** Fail-closed read of the legacy `isAdmin` flag from the same response body. */
export function parseIsAdmin(body: unknown): boolean {
  const data = (body as { data?: unknown } | null | undefined)?.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  return (data as Record<string, unknown>).isAdmin === true;
}

// -- Nav group construction ------------------------------------------------

export interface AdminNavGroup {
  label: string;
  items: { label: string; href: string }[];
  matchMode: 'exact' | 'prefix';
}

/**
 * Builds the Admin dropdown's group list. Each group reads its OWN
 * capability field — there is no shared staff variable, and no group's
 * visibility is derived from another group's (Standard §2). A multi-role
 * caller therefore sees the union of the groups their roles authorise,
 * because each group's condition is evaluated independently.
 *
 * `isAdmin` (Super Admin, from admin_users) gates only the pre-existing
 * General group, exactly as it did before Wave 1.
 */
export function buildAdminNavGroups(isAdmin: boolean, capabilities: AdminCapabilities): AdminNavGroup[] {
  return [
    ...(isAdmin ? [{ label: 'General', items: ADMIN_GENERAL_ITEMS, matchMode: 'exact' as const }] : []),
    ...(capabilities.resourceAnalytics ? [{ label: 'Analytics', items: ANALYTICS_ITEMS, matchMode: 'exact' as const }] : []),
    ...(capabilities.resourcesDashboard ? [{ label: 'Resources', items: RESOURCES_ITEMS, matchMode: 'exact' as const }] : []),
    ...(capabilities.resourceContentAdmin ? [{ label: 'Content', items: CONTENT_TYPE_ITEMS, matchMode: 'prefix' as const }] : []),
    ...(capabilities.resourceWorkflowAdmin ? [{ label: 'Workflow', items: WORKFLOW_ITEMS, matchMode: 'exact' as const }] : []),
    ...(capabilities.resourceDiscoveryAdmin ? [{ label: 'Discovery', items: DISCOVERY_ITEMS, matchMode: 'exact' as const }] : []),
  ];
}

/**
 * Whether the outer "Admin" entry point is shown at all. Deliberately flat
 * and derived — it is true exactly when at least one group would render, so
 * it can never show an empty dropdown and can never itself act as a
 * capability check for any specific destination (Standard §2/§4).
 */
export function shouldShowAdminMenu(isAdmin: boolean, capabilities: AdminCapabilities): boolean {
  return buildAdminNavGroups(isAdmin, capabilities).length > 0;
}
