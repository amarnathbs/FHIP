// PO request 19-10-2026: the Admin sidebar groups "Market Index Data" and "Risk-free Rates" into ONE group, "Market Data",
// with "Market Index Data" and "Risk-free Rate Data" as its two items. Navigation grouping ONLY.
//
// Admin Architecture Standard: s2 (every item keeps its own, separately named capability), s4 (nav visibility is UX, never
// authorisation; the page/API/RPC checks are untouched and covered by their own suites), s13 (fail closed), s14 (no scope
// expansion; unrelated groups unchanged), s18 last bullet (related entries share one group, each gated by its own capability).
//
// There is no DOM test environment, so the nav DECISION is asserted on the pure builder AppShell renders from
// (lib/admin/adminNav.ts), and AppShell is checked to render groups generically (no second, hard-coded nav).
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MARKET_DATA_GROUP_LABEL,
  MARKET_INDEX_DATA_ITEMS,
  NO_ADMIN_CAPABILITIES,
  RISK_FREE_DATA_ITEMS,
  buildAdminNavGroups,
  parseAdminCapabilities,
  parseIsAdmin,
  shouldShowAdminMenu,
  type AdminCapabilities,
  type AdminNavGroup,
} from '@/lib/admin/adminNav';

const ROOT = path.resolve(__dirname, '..', '..');
const INDEX_ITEM = { label: 'Market Index Data', href: '/admin/investment-intelligence/market-index-data' };
const RISK_ITEM = { label: 'Risk-free Rate Data', href: '/admin/investment-intelligence/risk-free-data' };

const caps = (on: Partial<AdminCapabilities>): AdminCapabilities => ({ ...NO_ADMIN_CAPABILITIES, ...on });
const everything = Object.fromEntries(Object.keys(NO_ADMIN_CAPABILITIES).map((k) => [k, true])) as unknown as AdminCapabilities;
const marketGroups = (groups: AdminNavGroup[]) => groups.filter((g) => g.label === 'Market Data');

const MARKET_INDEX_CAPS = ['marketIndexDataUpload', 'benchmarkDataView', 'benchmarkDataPublish', 'benchmarkDataCorrect', 'benchmarkCatalogueManage', 'benchmarkEntitlementApprove'] as const;
const RISK_FREE_CAPS = ['riskFreeDataUpload', 'riskFreeSeriesSwitch'] as const;

describe('Market Data group: shape', () => {
  it('the group is titled "Market Data" and exists exactly once when both items are visible', () => {
    expect(MARKET_DATA_GROUP_LABEL).toBe('Market Data');
    const groups = buildAdminNavGroups(true, everything);
    expect(marketGroups(groups)).toHaveLength(1);
    expect(groups.filter((g) => g.label === MARKET_DATA_GROUP_LABEL)).toHaveLength(1);
  });

  it('holds both items, in order Market Index Data then Risk-free Rate Data, with the routes unchanged', () => {
    const group = marketGroups(buildAdminNavGroups(true, everything))[0];
    expect(group.items).toEqual([INDEX_ITEM, RISK_ITEM]);
    expect(group.matchMode).toBe('exact');
    expect(MARKET_INDEX_DATA_ITEMS).toEqual([INDEX_ITEM]);
    expect(RISK_FREE_DATA_ITEMS).toEqual([RISK_ITEM]);
  });

  it('NO old groups remain: neither "Market Index Data" nor "Risk-free Rates" is a group heading for any capability combination', () => {
    const probes: AdminCapabilities[] = [everything, ...[...MARKET_INDEX_CAPS, ...RISK_FREE_CAPS].map((k) => caps({ [k]: true }))];
    for (const c of probes) {
      for (const isAdmin of [true, false]) {
        const labels = buildAdminNavGroups(isAdmin, c).map((g) => g.label);
        expect(labels).not.toContain('Market Index Data');
        expect(labels).not.toContain('Risk-free Rates');
        expect(labels).not.toContain('Risk-free Rate Data');
      }
    }
  });

  it('each of the two destinations appears exactly once across the whole menu (no duplicate link anywhere)', () => {
    const hrefs = buildAdminNavGroups(true, everything).flatMap((g) => g.items.map((i) => i.href));
    expect(hrefs.filter((h) => h === INDEX_ITEM.href)).toHaveLength(1);
    expect(hrefs.filter((h) => h === RISK_ITEM.href)).toHaveLength(1);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it('every item label is distinct from every group heading', () => {
    const groups = buildAdminNavGroups(true, everything);
    const headings = groups.map((g) => g.label);
    for (const label of groups.flatMap((g) => g.items.map((i) => i.label))) expect(headings, label).not.toContain(label);
  });
});

describe('Market Data group: per-item gating is exactly as before (s2/s4/s13)', () => {
  it('Market Index Data item: shown for each of its six capabilities independently, with no Risk-free item alongside', () => {
    for (const k of MARKET_INDEX_CAPS) {
      const g = marketGroups(buildAdminNavGroups(false, caps({ [k]: true })));
      expect(g, k).toHaveLength(1);
      expect(g[0].items, k).toEqual([INDEX_ITEM]);
    }
  });

  it('Risk-free Rate Data item: shown for EITHER risk-free capability (as before), with no Market Index item alongside', () => {
    for (const k of RISK_FREE_CAPS) {
      const g = marketGroups(buildAdminNavGroups(false, caps({ [k]: true })));
      expect(g, k).toHaveLength(1);
      expect(g[0].items, k).toEqual([RISK_ITEM]);
    }
  });

  it('visible/hidden combinations: neither -> hidden; index only; risk-free only; both', () => {
    expect(marketGroups(buildAdminNavGroups(false, NO_ADMIN_CAPABILITIES))).toHaveLength(0);
    expect(marketGroups(buildAdminNavGroups(false, caps({ marketIndexDataUpload: true })))[0].items).toEqual([INDEX_ITEM]);
    expect(marketGroups(buildAdminNavGroups(false, caps({ riskFreeDataUpload: true })))[0].items).toEqual([RISK_ITEM]);
    expect(marketGroups(buildAdminNavGroups(false, caps({ marketIndexDataUpload: true, riskFreeDataUpload: true })))[0].items).toEqual([INDEX_ITEM, RISK_ITEM]);
    expect(marketGroups(buildAdminNavGroups(false, caps({ benchmarkDataPublish: true, riskFreeSeriesSwitch: true })))[0].items).toEqual([INDEX_ITEM, RISK_ITEM]);
  });

  it('the risk-free upload permission alone never reveals Market Index Data, and no index/benchmark permission reveals Risk-free Rate Data', () => {
    const riskOnly = marketGroups(buildAdminNavGroups(false, caps({ riskFreeDataUpload: true })))[0];
    expect(riskOnly.items.map((i) => i.href)).not.toContain(INDEX_ITEM.href);
    for (const k of MARKET_INDEX_CAPS) {
      const g = marketGroups(buildAdminNavGroups(false, caps({ [k]: true })))[0];
      expect(g.items.map((i) => i.href), k).not.toContain(RISK_ITEM.href);
    }
  });

  it('does not widen anyone: no other capability, and not isAdmin (Super Admin), shows either item or the group', () => {
    const others = Object.keys(NO_ADMIN_CAPABILITIES).filter((k) => ![...MARKET_INDEX_CAPS, ...RISK_FREE_CAPS].includes(k as never));
    const allOthers = Object.fromEntries(others.map((k) => [k, true])) as unknown as AdminCapabilities;
    for (const isAdmin of [true, false]) {
      expect(marketGroups(buildAdminNavGroups(isAdmin, { ...NO_ADMIN_CAPABILITIES, ...allOthers }))).toHaveLength(0);
    }
    // referenceDataQuality is the capability most easily confused with these; it must not show them.
    expect(marketGroups(buildAdminNavGroups(true, caps({ referenceDataQuality: true })))).toHaveLength(0);
  });

  it('the group is dropped when none of its items is visible, so the outer menu hides when it is the only candidate', () => {
    expect(buildAdminNavGroups(false, NO_ADMIN_CAPABILITIES)).toEqual([]);
    expect(shouldShowAdminMenu(false, NO_ADMIN_CAPABILITIES)).toBe(false);
    expect(shouldShowAdminMenu(false, caps({ riskFreeSeriesSwitch: true }))).toBe(true);
  });

  it('fails closed: a malformed /api/admin/me body (truthy non-booleans, missing, null) yields no Market Data group', () => {
    const malformed = { data: { isAdmin: 'true', capabilities: { riskFreeDataUpload: 'true', riskFreeSeriesSwitch: 1, marketIndexDataUpload: {}, benchmarkDataView: 'yes' } } };
    expect(marketGroups(buildAdminNavGroups(parseIsAdmin(malformed), parseAdminCapabilities(malformed)))).toHaveLength(0);
    expect(buildAdminNavGroups(parseIsAdmin(null), parseAdminCapabilities(null))).toEqual([]);
    const ok = { data: { capabilities: { riskFreeDataUpload: true } } };
    expect(marketGroups(buildAdminNavGroups(false, parseAdminCapabilities(ok)))[0].items).toEqual([RISK_ITEM]);
  });
});

describe('Market Data group: unrelated groups are untouched (s14)', () => {
  it('Reference Data, Fund Look-Through and Premium and Promo Codes keep their items; the new group sits before Premium and Promo Codes', () => {
    const groups = buildAdminNavGroups(true, everything);
    const labels = groups.map((g) => g.label);
    expect(labels).toEqual(['General', 'Resources', 'Content', 'Workflow', 'Discovery', 'Reference Data', 'Fund Look-Through', 'Market Data', 'Premium and Promo Codes']);
    expect(groups.find((g) => g.label === 'Reference Data')!.items.map((i) => i.href)).toEqual([
      '/admin/investment-intelligence/reference-data-quality',
      '/admin/investment-intelligence/nav2-monitoring',
    ]);
    expect(groups.find((g) => g.label === 'Premium and Promo Codes')!.items.map((i) => i.href)).toEqual(['/admin/entitlements', '/admin/entitlements/promo-codes']);
  });

  it('a multi-role caller sees the union: Market Data alongside a Premium-only operator\'s group, each item by its own capability', () => {
    const labels = buildAdminNavGroups(false, caps({ riskFreeDataUpload: true, entitlementManagement: true })).map((g) => g.label);
    expect(labels).toEqual(['Market Data', 'Premium and Promo Codes']);
  });
});

describe('Market Data group: single canonical nav, rendering and accessibility', () => {
  const appShell = fs.readFileSync(path.join(ROOT, 'components', 'ui', 'AppShell.tsx'), 'utf8');

  it('AppShell renders the group list from buildAdminNavGroups and hard-codes no Market Data / Risk-free entry of its own', () => {
    expect(appShell).toContain('buildAdminNavGroups(isAdmin, capabilities)');
    expect(appShell).not.toMatch(/Risk-free|Market Index Data|market-index-data|risk-free-data|Market Data/);
  });

  it('the shared renderer keeps group semantics (role=group + aria-label), aria-current on the active item, and Escape handling', () => {
    expect(appShell).toContain('<ul role="group" aria-label={group.label}');
    expect(appShell).toContain("aria-current={itemActive ? 'page' : undefined}");
    expect(appShell).toContain("e.key === 'Escape'");
  });

  it('active highlighting: exact match per item, so on the Risk-free page only that item is current, and on the index page only that one', () => {
    const group = marketGroups(buildAdminNavGroups(true, everything))[0];
    const active = (pathname: string) => group.items.filter((i) => (group.matchMode === 'exact' ? pathname === i.href : pathname.startsWith(i.href))).map((i) => i.label);
    expect(active(RISK_ITEM.href)).toEqual(['Risk-free Rate Data']);
    expect(active(INDEX_ITEM.href)).toEqual(['Market Index Data']);
    expect(active('/admin/investment-intelligence/reference-data-quality')).toEqual([]);
  });

  it('NEGATIVE CONTROL: the previous two-group shape would FAIL the one-group rule', () => {
    const oldShape: AdminNavGroup[] = [
      { label: 'Market Index Data', items: [INDEX_ITEM], matchMode: 'exact' },
      { label: 'Risk-free Rates', items: [RISK_ITEM], matchMode: 'exact' },
    ];
    const oneGroupHoldsBoth = (groups: AdminNavGroup[]) => groups.some((g) => g.items.some((i) => i.href === INDEX_ITEM.href) && g.items.some((i) => i.href === RISK_ITEM.href));
    expect(oneGroupHoldsBoth(buildAdminNavGroups(true, everything))).toBe(true);
    expect(oneGroupHoldsBoth(oldShape)).toBe(false);
    expect(oldShape.map((g) => g.label)).not.toContain('Market Data');
  });

  it('the routes still exist and their page/API capability guards are not part of this change', () => {
    for (const h of [INDEX_ITEM.href, RISK_ITEM.href]) {
      expect(fs.existsSync(path.join(ROOT, 'app', '(app)', h, 'page.tsx')), h).toBe(true);
    }
  });
});
