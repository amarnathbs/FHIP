// NAV2 production release: the Fund Analytics entry under Reports in the user sidebar.
//
// The entry is data (lib/nav/appNavGroups.ts), its visibility is a pure function (lib/nav/appNavCapability.ts) and the answer per
// person comes from GET /api/capabilities/nav (`premiumNavigation`). Visibility is a convenience only: the page, the print route and every
// API enforce Premium themselves (tests/unit/nav2/nav2FundAnalyticsRoutes.test.ts); this file proves a free person is never shown a link
// that ends in a refusal and that every failure leaves the entry hidden.
//
// NAMED NEGATIVE CONTROLS
//   NC-N1  the entry exists in the Reports dropdown, right after the Monthly Report (and the old three entries are still there);
//   NC-N2  without a Premium answer the entry is hidden, even when the module decision is ENABLED (default and malformed answers too);
//   NC-N3  only a literal true shows it; the module decision can still hide it (an UNAVAILABLE Reports module);
//   NC-N4  the route answers true only for a Premium person with the nav2_fund_analytics switch on: free, switch off, switch unreadable,
//          entitlement unreadable and a missing service key all answer false, and the route still answers 200 (the sidebar never breaks);
//   NC-N5  a logged-out caller still gets 401, no premium answer;
//   NC-N6  AppShell passes the Premium answer to the visibility function for both links and dropdown items (source contract).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const mockGetUser = vi.fn();
const mockCanView = vi.fn();
const mockFlag = vi.fn();
const mockAdminClient = vi.fn();

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: mockGetUser } }) }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => mockAdminClient() }));
vi.mock('@/lib/services/entitlements', () => ({ canViewPremiumReport: (...a: unknown[]) => mockCanView(...a) }));
vi.mock('@/lib/services/investment-intelligence/nav2/nav2Flags', async (orig) => {
  const actual = await orig<typeof import('@/lib/services/investment-intelligence/nav2/nav2Flags')>();
  return { ...actual, isNav2FlagOn: (...a: unknown[]) => mockFlag(...a) };
});
vi.mock('@/lib/services/appCapabilityFlag', () => ({ isG4CapabilityLayerEnabled: () => false }));

import { GET } from '@/app/api/capabilities/nav/route';
import { REPORTS_ITEMS, NAV_GROUPS } from '@/lib/nav/appNavGroups';
import { isNavHrefVisible, parsePremiumNavigation, NO_PREMIUM_NAVIGATION, PREMIUM_ONLY_NAV_HREFS } from '@/lib/nav/appNavCapability';
import type { CapabilityDecision } from '@/lib/services/appCapability';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const ENABLED: Record<string, CapabilityDecision> = { REPORTS: 'ENABLED' };
const HREF = '/reports/fund-analytics';

describe('the sidebar entry (data)', () => {
  it('NC-N1: Fund Analytics is in the Reports dropdown right after the Monthly Report, and the other entries are unchanged', () => {
    expect(REPORTS_ITEMS.map((i) => i.label)).toEqual(['Monthly Report', 'Fund Analytics', 'Financial Activity', 'Consolidated Report', 'Forecast Variance']);
    expect(REPORTS_ITEMS.find((i) => i.label === 'Fund Analytics')?.href).toBe(HREF);
    const reports = NAV_GROUPS.flatMap((g) => g.items).find((e) => e.type === 'dropdown' && e.id === 'reports');
    expect(reports && reports.type === 'dropdown' ? reports.items.some((i) => i.href === HREF) : false).toBe(true);
  });
});

describe('the visibility function', () => {
  it('NC-N2: hidden by default and for any answer that is not a literal true', () => {
    expect(isNavHrefVisible(HREF, ENABLED)).toBe(false);
    expect(isNavHrefVisible(HREF, ENABLED, NO_PREMIUM_NAVIGATION)).toBe(false);
    for (const bad of [null, undefined, 'true', 1, [], {}, { fundAnalytics: 'true' }, { fundAnalytics: 1 }, { data: null }, { data: { premiumNavigation: null } }, { data: { premiumNavigation: [] } }, { data: { premiumNavigation: { fundAnalytics: 'yes' } } }]) {
      expect(parsePremiumNavigation(bad)).toEqual({ fundAnalytics: false });
    }
  });

  it('NC-N3: a literal true shows it, but the module decision still wins (UNAVAILABLE Reports hides it); other links are unaffected', () => {
    const yes = parsePremiumNavigation({ data: { premiumNavigation: { fundAnalytics: true } } });
    expect(yes).toEqual({ fundAnalytics: true });
    expect(isNavHrefVisible(HREF, ENABLED, yes)).toBe(true);
    expect(isNavHrefVisible(HREF, { REPORTS: 'UNAVAILABLE' }, yes)).toBe(false);
    expect(isNavHrefVisible(HREF, {}, yes)).toBe(false);
    // the Monthly Report and every other link behave exactly as before, with or without the premium answer
    expect(isNavHrefVisible('/reports', ENABLED)).toBe(true);
    expect(isNavHrefVisible('/reports', ENABLED, yes)).toBe(true);
    expect(Object.keys(PREMIUM_ONLY_NAV_HREFS)).toEqual([HREF]);
  });
});

describe('GET /api/capabilities/nav premiumNavigation', () => {
  beforeEach(() => {
    mockGetUser.mockReset().mockResolvedValue({ data: { user: { id: 'u1' } } });
    mockCanView.mockReset().mockResolvedValue(true);
    mockFlag.mockReset().mockResolvedValue(true);
    mockAdminClient.mockReset().mockReturnValue({ __admin: true });
  });
  const answer = async () => {
    const res = await GET();
    const body = (await res.json()) as { data?: { premiumNavigation?: unknown; decisions?: Record<string, string> } };
    return { status: res.status, premium: body.data?.premiumNavigation, decisions: body.data?.decisions };
  };

  it('NC-N4: true only for a Premium person with the switch on', async () => {
    const r = await answer();
    expect(r.status).toBe(200);
    expect(r.premium).toEqual({ fundAnalytics: true });
    expect(r.decisions?.REPORTS).toBe('ENABLED');
    expect(mockFlag).toHaveBeenCalledWith({ __admin: true }, 'nav2_fund_analytics');
  });

  it('NC-N4: a free person never reads the switch and gets false', async () => {
    mockCanView.mockResolvedValue(false);
    const r = await answer();
    expect(r.status).toBe(200);
    expect(r.premium).toEqual({ fundAnalytics: false });
    expect(mockFlag).not.toHaveBeenCalled();
  });

  it('NC-N4: switch off, switch unreadable, entitlement unreadable and a missing service key all answer false with a 200', async () => {
    mockFlag.mockResolvedValue(false);
    expect((await answer()).premium).toEqual({ fundAnalytics: false });
    mockFlag.mockReset().mockRejectedValue(new Error('relation does not exist'));
    expect((await answer()).premium).toEqual({ fundAnalytics: false });
    mockFlag.mockReset().mockResolvedValue(true);
    mockCanView.mockRejectedValue(new Error('db down'));
    const r = await answer();
    expect(r.status).toBe(200);
    expect(r.premium).toEqual({ fundAnalytics: false });
    mockCanView.mockReset().mockResolvedValue(true);
    mockAdminClient.mockImplementation(() => {
      throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set');
    });
    expect((await answer()).premium).toEqual({ fundAnalytics: false });
  });

  it('NC-N5: a logged-out caller gets 401 and no premium answer', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });
    const r = await answer();
    expect(r.status).toBe(401);
    expect(r.premium).toBeUndefined();
    expect(mockCanView).not.toHaveBeenCalled();
  });
});

describe('AppShell', () => {
  it('NC-N6: reads the premium answer from the nav response, keeps it hidden on a failed fetch, and passes it to every visibility check', () => {
    const src = fs.readFileSync(path.join(ROOT, 'components', 'ui', 'AppShell.tsx'), 'utf8');
    expect(src).toContain('parsePremiumNavigation(j)');
    expect(src).toMatch(/setPremiumNav\(NO_PREMIUM_NAVIGATION\)/);
    expect((src.match(/isNavHrefVisible\([^)]*premiumNav\)/g) ?? []).length).toBe(2);
    expect(src).not.toMatch(/isNavHrefVisible\([^,)]+,\s*navDecisions\)/);
  });
});
