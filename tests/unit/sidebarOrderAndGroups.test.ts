// PO review 06-10-2026, findings F9 and F10 (sidebar).
//
//   F9  "It has been told to bring this on top first item, still reflecting on bottom"
//       -> Account / Profile is the FIRST entry of the user sidebar.
//   F10 "Both are interrelated can you keep both under one head / menu"
//       -> Premium Access and Promo Codes live in ONE Admin menu group, while each item is
//          still gated by its own, separately named capability (Admin Standard sections 2/3/4).
//
// There is no DOM test environment here, so the sidebar's ORDER and GROUPING are tested on the pure modules
// AppShell renders from (lib/nav/appNavGroups.ts, lib/admin/adminNav.ts). NEGATIVE CONTROLS re-run the same
// assertions on a deliberately broken copy and require them to fail.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NAV_GROUPS, type NavGroup } from '@/lib/nav/appNavGroups';
import { NAV_HREF_MODULE_MAP } from '@/lib/nav/appNavCapability';
import {
  buildAdminNavGroups,
  NO_ADMIN_CAPABILITIES,
  PREMIUM_AND_PROMO_GROUP_LABEL,
  shouldShowAdminMenu,
  type AdminCapabilities,
} from '@/lib/admin/adminNav';

const ROOT = path.resolve(__dirname, '..', '..');

/** The first link the sidebar shows, in reading order. */
function firstLink(groups: NavGroup[]): { label: string; href: string } | null {
  for (const g of groups) {
    for (const e of g.items) {
      if (e.type === 'link') return { label: e.label, href: e.href };
      if (e.items.length > 0) return e.items[0];
    }
  }
  return null;
}

const accountIsFirst = (groups: NavGroup[]): boolean => groups[0]?.label === 'Account' && firstLink(groups)?.href === '/profile';

describe('F9: Account / Profile is the first item of the user sidebar', () => {
  it('the first group is Account and its first link is Profile at /profile', () => {
    expect(NAV_GROUPS[0].label).toBe('Account');
    expect(NAV_GROUPS[0].items).toEqual([{ type: 'link', label: 'Profile', href: '/profile' }]);
    expect(firstLink(NAV_GROUPS)).toEqual({ label: 'Profile', href: '/profile' });
    expect(accountIsFirst(NAV_GROUPS)).toBe(true);
  });

  it('nothing was lost or renamed: every other group is still present, once, in its previous order', () => {
    expect(NAV_GROUPS.map((g) => g.label)).toEqual(['Account', 'Overview', 'Your finances', 'Plan & improve', 'Forecasting', 'Review & share']);
    const hrefs = NAV_GROUPS.flatMap((g) => g.items.flatMap((e) => (e.type === 'link' ? [e.href] : e.items.map((i) => i.href))));
    expect(new Set(hrefs).size).toBe(hrefs.length); // no duplicate route
    for (const must of ['/dashboard', '/profile', '/income', '/expenses', '/assets', '/liabilities', '/investments', '/insurance', '/companies', '/goals', '/score', '/dna', '/resilience', '/financial-twin', '/investment-intelligence', '/forecast', '/recommendations', '/reports', '/ai-insights']) {
      expect(hrefs, must).toContain(must);
    }
  });

  it('every route the sidebar links to still has its page (every route keeps working)', () => {
    const hrefs = NAV_GROUPS.flatMap((g) => g.items.flatMap((e) => (e.type === 'link' ? [e.href] : e.items.map((i) => i.href))));
    for (const h of hrefs) expect(existsSync(path.join(ROOT, 'app', '(app)', h, 'page.tsx')), h).toBe(true);
    // a mapped route keeps its capability module; an unmapped one is simply always shown (nav visibility is UX, not authorisation)
    for (const h of Object.keys(NAV_HREF_MODULE_MAP)) expect(hrefs, h).toContain(h);
  });

  it('NEGATIVE CONTROL (F9): with Account moved back to the bottom the very same check FAILS', () => {
    const broken = [...NAV_GROUPS.slice(1), NAV_GROUPS[0]];
    expect(accountIsFirst(broken)).toBe(false);
    expect(firstLink(broken)?.href).toBe('/dashboard');
  });
});

const only = (patch: Partial<AdminCapabilities>): AdminCapabilities => ({ ...NO_ADMIN_CAPABILITIES, ...patch });
const labels = (g: { label: string }[]) => g.map((x) => x.label);

describe('F10: Premium Access and Promo Codes share one Admin menu group', () => {
  it('the group label is "Premium and Promo Codes"', () => {
    expect(PREMIUM_AND_PROMO_GROUP_LABEL).toBe('Premium and Promo Codes');
  });

  it('an operator with BOTH capabilities sees ONE group holding both items, Premium Access first', () => {
    const groups = buildAdminNavGroups(false, only({ entitlementManagement: true, promoCodeManagement: true }));
    expect(labels(groups)).toEqual(['Premium and Promo Codes']);
    expect(groups[0].items).toEqual([
      { label: 'Premium Access', href: '/admin/entitlements' },
      { label: 'Promo Codes', href: '/admin/entitlements/promo-codes' },
    ]);
    // the old two separate group headings are gone
    expect(labels(groups)).not.toContain('Entitlements');
    expect(labels(groups)).not.toContain('Promo Codes');
  });

  it('capability gating per item is unchanged: only entitlementManagement shows only Premium Access', () => {
    const groups = buildAdminNavGroups(false, only({ entitlementManagement: true }));
    expect(labels(groups)).toEqual(['Premium and Promo Codes']);
    expect(groups[0].items.map((i) => i.label)).toEqual(['Premium Access']);
  });

  it('capability gating per item is unchanged: only promoCodeManagement shows only Promo Codes', () => {
    const groups = buildAdminNavGroups(false, only({ promoCodeManagement: true }));
    expect(labels(groups)).toEqual(['Premium and Promo Codes']);
    expect(groups[0].items.map((i) => i.label)).toEqual(['Promo Codes']);
  });

  it('the group is hidden when neither capability is held (Super Admin and every other capability do not imply it)', () => {
    expect(labels(buildAdminNavGroups(false, NO_ADMIN_CAPABILITIES))).toEqual([]);
    expect(labels(buildAdminNavGroups(true, NO_ADMIN_CAPABILITIES))).not.toContain('Premium and Promo Codes');
    const everythingElse = only({
      resourcesDashboard: true,
      resourceContentAdmin: true,
      resourceWorkflowAdmin: true,
      resourceDiscoveryAdmin: true,
      resourceAnalytics: true,
      referenceDataQuality: true,
      lookthroughDataQuality: true,
      marketIndexDataUpload: true,
      benchmarkDataView: true,
    });
    expect(labels(buildAdminNavGroups(true, everythingElse))).not.toContain('Premium and Promo Codes');
    expect(shouldShowAdminMenu(false, only({ promoCodeManagement: true }))).toBe(true);
    expect(shouldShowAdminMenu(false, NO_ADMIN_CAPABILITIES)).toBe(false);
  });

  it('the group sits where the two old groups were: after Market Index Data, last', () => {
    const all = only({ resourcesDashboard: true, marketIndexDataUpload: true, entitlementManagement: true, promoCodeManagement: true });
    const g = labels(buildAdminNavGroups(true, all));
    expect(g[g.length - 1]).toBe('Premium and Promo Codes');
    expect(g.indexOf('Market Index Data')).toBeLessThan(g.indexOf('Premium and Promo Codes'));
  });

  it('NEGATIVE CONTROL (F10): a menu that put each item back into its own group would FAIL the one-group rule', () => {
    const separate = [
      { label: 'Entitlements', items: [{ label: 'Premium Access', href: '/admin/entitlements' }] },
      { label: 'Promo Codes', items: [{ label: 'Promo Codes', href: '/admin/entitlements/promo-codes' }] },
    ];
    const real = buildAdminNavGroups(false, only({ entitlementManagement: true, promoCodeManagement: true }));
    const oneGroupHoldsBoth = (groups: { label: string; items: { href: string }[] }[]) =>
      groups.some((g) => g.items.some((i) => i.href === '/admin/entitlements') && g.items.some((i) => i.href === '/admin/entitlements/promo-codes'));
    expect(oneGroupHoldsBoth(real)).toBe(true);
    expect(oneGroupHoldsBoth(separate)).toBe(false);
  });
});
