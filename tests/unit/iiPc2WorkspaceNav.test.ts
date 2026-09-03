// II-PC2 — workspace navigation contract (spec sections 8, 9, 31, 32, 45, 52).
//
// This suite exists to protect the ONE property PC2 was commissioned to
// deliver: a user who knows only "Investment Intelligence" can reach every
// analysis without being told a URL.

import { describe, it, expect } from 'vitest';
import {
  II_WORKSPACE_NAV,
  II_WORKSPACE_ROOT,
  II_RELATED_DESTINATIONS,
  isIiNavItemActive,
  activeIiNavItem,
} from '@/lib/investment-intelligence/workspaceNav';

describe('II-PC2 workspace sub-navigation', () => {
  it('exposes every analytics route the spec requires to be discoverable', () => {
    // Spec section 45: if a tester must know /investment-intelligence/xray in
    // advance, the discoverability gate FAILS. Each of these must therefore be
    // present as a nav destination, not merely exist as a route.
    const hrefs = II_WORKSPACE_NAV.map((i) => i.href);
    expect(hrefs).toContain('/investment-intelligence');
    expect(hrefs).toContain('/investment-intelligence/data');
    expect(hrefs).toContain('/investment-intelligence/performance');
    expect(hrefs).toContain('/investment-intelligence/sip');
    expect(hrefs).toContain('/investment-intelligence/xray');
    expect(hrefs).toContain('/investment-intelligence/tax');
    expect(hrefs).toContain('/investment-intelligence/review');
  });

  it('every nav item lives under the workspace root', () => {
    for (const item of II_WORKSPACE_NAV) {
      expect(item.href === II_WORKSPACE_ROOT || item.href.startsWith(`${II_WORKSPACE_ROOT}/`)).toBe(true);
    }
  });

  it('has no duplicate keys or hrefs', () => {
    expect(new Set(II_WORKSPACE_NAV.map((i) => i.key)).size).toBe(II_WORKSPACE_NAV.length);
    expect(new Set(II_WORKSPACE_NAV.map((i) => i.href)).size).toBe(II_WORKSPACE_NAV.length);
  });

  it('does not expose internal engine vocabulary as a user-facing label', () => {
    // Spec section 37: internal names must not be primary UX language. "SIP"
    // and "X-Ray" are the spec's own suggested labels but neither appears on
    // the destination pages, whose headings are "Recurring investments" and
    // "What your funds actually hold".
    const labels = II_WORKSPACE_NAV.map((i) => i.label.toLowerCase());
    for (const forbidden of ['x-ray', 'xray', 'portfolio truth', 'engine', 'snapshot', 'fingerprint']) {
      expect(labels.some((l) => l.includes(forbidden))).toBe(false);
    }
  });

  it('gives every item a non-empty accessible description', () => {
    for (const item of II_WORKSPACE_NAV) {
      expect(item.label.trim().length).toBeGreaterThan(0);
      expect(item.description.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('II-PC2 active-route rule', () => {
  it('marks the Overview tab active ONLY on the workspace root', () => {
    // The regression this guards: a naive startsWith() makes the root prefix-
    // match every child, lighting the Overview tab on all seven pages and
    // emitting aria-current="page" on a link that is not the current page.
    expect(isIiNavItemActive('/investment-intelligence', II_WORKSPACE_ROOT)).toBe(true);
    for (const child of ['/performance', '/sip', '/xray', '/tax', '/review', '/data']) {
      expect(isIiNavItemActive(`${II_WORKSPACE_ROOT}${child}`, II_WORKSPACE_ROOT)).toBe(false);
    }
  });

  it('marks exactly one item active on every workspace route', () => {
    for (const item of II_WORKSPACE_NAV) {
      const activeCount = II_WORKSPACE_NAV.filter((candidate) => isIiNavItemActive(item.href, candidate.href)).length;
      expect(activeCount).toBe(1);
      expect(activeIiNavItem(item.href)?.key).toBe(item.key);
    }
  });

  it('keeps a parent tab active for a deeper descendant route', () => {
    expect(isIiNavItemActive('/investment-intelligence/performance/abc-123', '/investment-intelligence/performance')).toBe(true);
  });

  it('does not let a shared path prefix light the wrong tab', () => {
    // '/investment-intelligence/taxonomy' shares the '/tax' prefix as a raw
    // string but is a different route; the boundary check must reject it.
    expect(isIiNavItemActive('/investment-intelligence/taxonomy', '/investment-intelligence/tax')).toBe(false);
  });

  it('returns null outside the workspace', () => {
    expect(activeIiNavItem('/investments')).toBeNull();
    expect(activeIiNavItem('/goals')).toBeNull();
  });
});

describe('II-PC2 canonical external destinations', () => {
  it('links to the canonical FHIP systems rather than duplicating them', () => {
    // Spec sections 2.2-2.5, 9, 23-26: II must NOT grow its own Goals,
    // Forecasting, Reports or household register. These must remain OUTBOUND
    // links to the canonical routes.
    const byKey = Object.fromEntries(II_RELATED_DESTINATIONS.map((d) => [d.key, d.href]));
    expect(byKey.investments).toBe('/investments');
    expect(byKey.goals).toBe('/goals');
    expect(byKey.forecast).toBe('/forecast/investments');
    expect(byKey.reports).toBe('/reports');
  });

  it('never routes a canonical destination back under the II workspace', () => {
    for (const d of II_RELATED_DESTINATIONS) {
      expect(d.href.startsWith(II_WORKSPACE_ROOT)).toBe(false);
      expect(d.relationship.trim().length).toBeGreaterThan(0);
    }
  });
});
