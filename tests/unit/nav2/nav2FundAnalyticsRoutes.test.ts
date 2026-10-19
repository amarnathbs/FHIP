// NAV2 Stage 2 -- the Fund analytics report's customer routes, print route and render tokens.
//
// Matrix: Stage 2 rows S2-03 (Premium only, explicit 403, never an empty 200), S2-04 (switch off answers 404 and does nothing),
// S2-06 (another user's report is a 404 on every route), S2-19 (PDF: Premium and ownership are checked BEFORE any token or render),
// S2-20 (single-use render token: unknown / malformed / expired is refused).
//
// NAMED NEGATIVE CONTROLS
//   NC-F1  a free user is refused with the Premium sentence on list, generate, read and export (never an empty list);
//   NC-F2  export checks Premium and ownership before the renderer (and so before any render token) is ever reached;
//   NC-F3  the print route opens a report only for the user the TOKEN names, loaded with that user's id as the filter;
//   NC-F4  an expired, malformed or unknown token opens nothing;
//   NC-F5  no route reads a user id from the request body or query string.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createInMemoryDb } from '../support/inMemorySupabase';

const mockGetUser = vi.fn();
const mockCanView = vi.fn();
const mockCanExport = vi.fn();
const mockGenerate = vi.fn();
const mockList = vi.fn();
const mockFlag = vi.fn();
const mockGet = vi.fn();
const mockRender = vi.fn();
const mockResolveToken = vi.fn();
const redirectSpy = vi.fn((to: string) => {
  throw new Error(`REDIRECT:${to}`);
});
const notFoundSpy = vi.fn(() => {
  throw new Error('NEXT_NOT_FOUND');
});

vi.mock('next/navigation', () => ({ redirect: (to: string) => redirectSpy(to), notFound: () => notFoundSpy() }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: mockGetUser }, from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { country_of_residence: 'IN', country_confirmed_at: '2026-08-29T00:00:00Z', country_source: 'USER_CONFIRMED', onboarding_completed: true }, error: null }) }) }) }) }) }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ __admin: true }) }));
vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>();
  return {
    ...actual,
    requireCountryConfirmedUser: async () => {
      const { data } = await mockGetUser();
      return data.user ? { user: data.user, unauthenticated: null } : { user: null, unauthenticated: actual.bad('unauthenticated', 401) };
    },
  };
});
vi.mock('@/lib/services/investment-intelligence/nav2/nav2Flags', async (orig) => {
  const actual = await orig<typeof import('@/lib/services/investment-intelligence/nav2/nav2Flags')>();
  return { ...actual, isNav2FlagOn: (...a: unknown[]) => mockFlag(...a) };
});
vi.mock('@/lib/services/entitlements', () => ({ canViewPremiumReport: (...a: unknown[]) => mockCanView(...a), canExportReports: (...a: unknown[]) => mockCanExport(...a) }));
vi.mock('@/lib/services/investment-intelligence/nav2/fundAnalyticsReportService', async (orig) => {
  const actual = await orig<typeof import('@/lib/services/investment-intelligence/nav2/fundAnalyticsReportService')>();
  return { ...actual, generateFundAnalyticsReport: (...a: unknown[]) => mockGenerate(...a), listFundAnalyticsReports: (...a: unknown[]) => mockList(...a), getFundAnalyticsReport: (...a: unknown[]) => mockGet(...a) };
});
vi.mock('@/lib/services/investment-intelligence/nav2/fundAnalyticsPdfRenderer', async (orig) => {
  const actual = await orig<typeof import('@/lib/services/investment-intelligence/nav2/fundAnalyticsPdfRenderer')>();
  return { ...actual, renderFundAnalyticsReportToPdf: (...a: unknown[]) => mockRender(...a) };
});
// the print page resolves tokens through the browser-free module (it must load without playwright), so that is where the token lookup is mocked
vi.mock('@/lib/services/investment-intelligence/nav2/fundAnalyticsRenderToken', async (orig) => {
  const actual = await orig<typeof import('@/lib/services/investment-intelligence/nav2/fundAnalyticsRenderToken')>();
  return { ...actual, resolveNav2RenderToken: (...a: unknown[]) => mockResolveToken(...a) };
});

import { GET as listGET, POST as generatePOST } from '@/app/api/reports/fund-analytics/route';
import { GET as oneGET } from '@/app/api/reports/fund-analytics/[id]/route';
import { GET as exportGET } from '@/app/api/reports/fund-analytics/[id]/export/route';
import FundAnalyticsPrintPage from '@/app/(print)/reports/fund-analytics/print/page';
import { createNav2RenderToken, NAV2_RENDER_TOKEN_TTL_MS } from '@/lib/services/investment-intelligence/nav2/fundAnalyticsPdfRenderer';
import { FUND_ANALYTICS_PREMIUM_MESSAGE } from '@/lib/services/investment-intelligence/nav2/fundAnalyticsReportService';

const ME = 'user-1';
const ID = '66666666-6666-4666-8666-666666666666';
const ROOT = path.resolve(__dirname, '..', '..', '..');
const ctx = (id = ID) => ({ params: Promise.resolve({ id }) });
const post = (body: unknown) => new Request('http://test/api/reports/fund-analytics', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) });
const found = { summary: { id: ID, versionNumber: 3, asOfDate: '2026-10-02', schemeCount: 2, createdAt: '2026-10-02T06:00:00Z', periodChoice: 'all_history' }, report: { schemes: [], notes: [], periodChoice: 'all_history', asOfDate: '2026-10-02', displayCurrency: 'INR' }, manifestChecksum: 'a'.repeat(64) };

beforeEach(() => {
  vi.clearAllMocks();
  mockGetUser.mockResolvedValue({ data: { user: { id: ME } } });
  mockCanView.mockResolvedValue(true);
  mockCanExport.mockResolvedValue(true);
  mockList.mockResolvedValue([found.summary]);
  mockFlag.mockResolvedValue(true);
  mockGet.mockResolvedValue(found);
  mockRender.mockResolvedValue(Buffer.from('%PDF-1.7 synthetic'));
  mockGenerate.mockResolvedValue({ status: 'ready', report: found.summary, cache: { hits: 0, computed: 2, stored: 2 } });
});

describe('401 / 403 on every verb (NC-F1)', () => {
  const verbs: Array<[string, () => Promise<Response>]> = [
    ['GET list', () => listGET()],
    ['POST generate', () => generatePOST(post({}))],
    ['GET one', () => oneGET(new Request('http://t'), ctx())],
    ['GET export', () => exportGET(new Request('http://t'), ctx())],
  ];
  for (const [name, run] of verbs) {
    it(`${name}: unauthenticated -> 401`, async () => {
      mockGetUser.mockResolvedValue({ data: { user: null } });
      expect((await run()).status).toBe(401);
      expect(mockGenerate).not.toHaveBeenCalled();
      expect(mockRender).not.toHaveBeenCalled();
    });
  }
  it('a FREE user is refused with the Premium sentence on list, read and export, never an empty list or report', async () => {
    mockCanView.mockResolvedValue(false);
    mockCanExport.mockResolvedValue(false);
    for (const run of [() => listGET(), () => oneGET(new Request('http://t'), ctx()), () => exportGET(new Request('http://t'), ctx())]) {
      const res = await run();
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(JSON.stringify(body)).toMatch(/Premium|premium/);
      expect(body.data).toBeUndefined();
    }
    expect(mockList).not.toHaveBeenCalled();
    expect(mockGet).not.toHaveBeenCalled();
    expect(mockRender).not.toHaveBeenCalled();
  });
});

describe('authorisation comes BEFORE body validation on generate (Stage 3 fix 4)', () => {
  it('NC-F6: a FREE user posting a bad body, an unknown field or broken JSON gets 403, never 422 / 400; the service never runs', async () => {
    mockCanView.mockResolvedValue(false);
    for (const body of [{ period: 'forever' }, { userId: 'someone-else' }, '{not json']) {
      const res = await generatePOST(post(body));
      expect(res.status).toBe(403);
      expect(JSON.stringify(await res.json())).toMatch(/Premium|premium/);
    }
    expect(mockGenerate).not.toHaveBeenCalled();
  });
  it('a Premium user with a bad body still gets the 422 / 400 (validation is not removed)', async () => {
    expect((await generatePOST(post({ period: 'forever' }))).status).toBe(422);
    expect((await generatePOST(post('{not json'))).status).toBe(400);
  });
});

describe('deploy order safety: the list answers a plain 404, never a 500, while the schema or the switch is not there', () => {
  it('NC-F7: switch off, switch unreadable (table or row missing) and a missing service key all answer 404 with the unavailable sentence; the database is not asked for reports', async () => {
    mockFlag.mockResolvedValue(false);
    let res = await listGET();
    expect(res.status).toBe(404);
    expect(JSON.stringify(await res.json())).toMatch(/not available yet/i);
    mockFlag.mockRejectedValue(new Error('relation ii_reference_job_control does not exist'));
    res = await listGET();
    expect(res.status).toBe(404);
    expect(mockList).not.toHaveBeenCalled();
  });
  it('NC-F7: a FREE user is still refused with the 403 Premium sentence first (the switch never reveals more than the Premium check)', async () => {
    mockCanView.mockResolvedValue(false);
    mockFlag.mockResolvedValue(false);
    expect((await listGET()).status).toBe(403);
    expect(mockFlag).not.toHaveBeenCalled();
  });
});

describe('list and generate', () => {
  it('a Premium user lists their own versions', async () => {
    const res = await listGET();
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual([found.summary]);
    expect(mockList.mock.calls[0][1]).toBe(ME);
  });

  it('generate maps every service status to its own HTTP answer: forbidden 403, disabled 404, preparing 202, no funds 200, ready 201', async () => {
    mockGenerate.mockResolvedValueOnce({ status: 'forbidden', message: FUND_ANALYTICS_PREMIUM_MESSAGE });
    expect((await generatePOST(post({}))).status).toBe(403);
    mockGenerate.mockResolvedValueOnce({ status: 'disabled', message: 'The Fund analytics report is not available yet.' });
    const d = await generatePOST(post({}));
    expect(d.status).toBe(404);
    expect((await d.json()).error).toMatch(/not available yet/);
    mockGenerate.mockResolvedValueOnce({ status: 'preparing', message: 'Your report will be ready once price history is loaded (1 of 2 funds loaded)', waiting: { waiting: true, headline: 'x', loaded: 1, total: 2, waitingFunds: ['A Fund'], unavailableFunds: [], retryWindowMinutes: 30 } });
    const p = await generatePOST(post({}));
    expect(p.status).toBe(202);
    expect((await p.json()).data).toMatchObject({ status: 'preparing', loaded: 1, total: 2, waitingFunds: ['A Fund'] });
    mockGenerate.mockResolvedValueOnce({ status: 'no_funds', message: 'The Fund analytics report covers Indian mutual funds.' });
    const n = await generatePOST(post({}));
    expect(n.status).toBe(200);
    expect((await n.json()).data.status).toBe('no_funds');
    const r = await generatePOST(post({ period: '3y' }));
    expect(r.status).toBe(201);
    expect((await r.json()).data.report.versionNumber).toBe(3);
    expect(mockGenerate.mock.calls.at(-1)?.[0]).toMatchObject({ userId: ME, periodChoice: '3y' });
  });

  it('NC-F5: the user comes only from the session; a body naming a user, or an unknown period, is refused before the service runs', async () => {
    expect((await generatePOST(post({ userId: 'someone-else' }))).status).toBe(422);
    expect((await generatePOST(post({ period: 'forever' }))).status).toBe(422);
    expect((await generatePOST(post('{not json'))).status).toBe(400);
    expect(mockGenerate).not.toHaveBeenCalled();
    await generatePOST(post(''));
    expect(mockGenerate.mock.calls[0][0].userId).toBe(ME);
  });

  it('a service failure is a 500 that does not leak its message', async () => {
    mockGenerate.mockRejectedValueOnce(new Error('relation nav2_secret does not exist'));
    const res = await generatePOST(post({}));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('nav2_secret');
  });
});

describe('read one and export (NC-F2, matrix 46)', () => {
  it('another user\'s id, a missing id and a malformed id are all the same 404', async () => {
    mockGet.mockResolvedValueOnce(null);
    expect((await oneGET(new Request('http://t'), ctx())).status).toBe(404);
    expect((await oneGET(new Request('http://t'), ctx('not-a-uuid'))).status).toBe(404);
    mockGet.mockResolvedValueOnce(null);
    expect((await exportGET(new Request('http://t'), ctx())).status).toBe(404);
    expect(mockRender).not.toHaveBeenCalled(); // no render, so no token, for a report that is not theirs
    expect(mockGet.mock.calls.every((c) => c[1] === ME)).toBe(true);
  });

  it('the caller\'s own report is returned with no-store caching', async () => {
    const res = await oneGET(new Request('http://t'), ctx());
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect((await res.json()).data.summary.versionNumber).toBe(3);
  });

  it('export streams a PDF with a dated, versioned file name, no-store caching, and renders for the caller and that report only', async () => {
    const res = await exportGET(new Request('http://t'), ctx());
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/pdf');
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="fund-analytics-report-02-10-2026-v3.pdf"');
    expect(mockRender.mock.calls[0].slice(1)).toEqual([ME, ID, { versionNumber: 3, createdAt: '2026-10-02T06:00:00Z' }]); // the running header carries the version and the made-on time
    expect(res.headers.get('Content-Disposition')).toMatch(/^attachment;/);
  });

  it('?disposition=inline serves the same PDF inline (the route is no longer used by the page: the page offers Print / Save as PDF); anything else stays an attachment', async () => {
    const inline = await exportGET(new Request('http://t/x?disposition=inline'), ctx());
    expect(inline.headers.get('Content-Disposition')).toBe('inline; filename="fund-analytics-report-02-10-2026-v3.pdf"');
    expect(inline.headers.get('Cache-Control')).toBe('private, no-store');
    const other = await exportGET(new Request('http://t/x?disposition=whatever'), ctx());
    expect(other.headers.get('Content-Disposition')).toMatch(/^attachment;/);
  });

  it('a browser that cannot launch is a typed 503 renderer_unavailable with a plain sentence that points to Print, not the internal error', async () => {
    mockRender.mockRejectedValueOnce(new Error('browserType.launch: Executable does not exist at C:/secret/path'));
    const res = await exportGET(new Request('http://t'), ctx());
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toMatchObject({ code: 'EXPORT_RENDER_FAILED', reason: 'renderer_unavailable' });
    expect(body.error).toMatch(/Print, then choose Save as PDF/);
    expect(JSON.stringify(body)).not.toContain('secret');
  });

  it('any other render failure is a typed 502 render_failed, never a bare 500', async () => {
    mockRender.mockRejectedValueOnce(new Error('something odd'));
    const res = await exportGET(new Request('http://t'), ctx());
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ reason: 'render_failed' });
  });
});

describe('print route (NC-F3)', () => {
  const page = (sp: { token?: string; id?: string }) => FundAnalyticsPrintPage({ searchParams: Promise.resolve(sp) });

  it('a valid token opens the report for the user THE TOKEN names, loaded with that user id as the filter', async () => {
    mockResolveToken.mockResolvedValueOnce({ userId: 'token-user', reportId: ID });
    await page({ token: 'a'.repeat(64) });
    expect(mockGet.mock.calls[0].slice(1)).toEqual(['token-user', ID]);
    expect(mockGetUser).not.toHaveBeenCalled(); // no session is consulted on the token path
  });

  it('an unknown token, or a token whose report does not exist for that user, is a 404', async () => {
    mockResolveToken.mockResolvedValueOnce(null);
    await expect(page({ token: 'b'.repeat(64) })).rejects.toThrow('NEXT_NOT_FOUND');
    mockResolveToken.mockResolvedValueOnce({ userId: 'token-user', reportId: ID });
    mockGet.mockResolvedValueOnce(null);
    await expect(page({ token: 'a'.repeat(64) })).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('without a token: no session -> login; a free user or a missing id -> 404; a Premium user sees their own report only', async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: null } });
    await expect(page({ id: ID })).rejects.toThrow('REDIRECT:/login');
    mockCanView.mockResolvedValueOnce(false);
    await expect(page({ id: ID })).rejects.toThrow('NEXT_NOT_FOUND');
    await expect(page({})).rejects.toThrow('NEXT_NOT_FOUND');
    mockGet.mockClear();
    await page({ id: ID });
    expect(mockGet.mock.calls[0].slice(1)).toEqual([ME, ID]);
  });
});

describe('render tokens (NC-F4, matrix 61)', () => {
  const tokens = (rows: Array<Record<string, unknown>> = []) => {
    const db = createInMemoryDb({ strictSchema: true });
    db.reset({ nav2_report_render_tokens: rows });
    return { db, admin: db.client as unknown as SupabaseClient };
  };

  it('creates a 64-hex token for one user and one report that lives five minutes', async () => {
    const { db, admin } = tokens();
    const now = Date.parse('2026-10-04T10:00:00.000Z');
    const t = await createNav2RenderToken(admin, ME, ID, now);
    expect(t).toMatch(/^[0-9a-f]{64}$/);
    expect(db.tables.nav2_report_render_tokens[0]).toMatchObject({ token: t, user_id: ME, report_id: ID, expires_at: new Date(now + NAV2_RENDER_TOKEN_TTL_MS).toISOString() });
    expect(NAV2_RENDER_TOKEN_TTL_MS).toBe(300000);
  });

  it('resolves a live token, and refuses an expired, an unknown and a malformed one', async () => {
    const live = 'c'.repeat(64);
    const old = 'd'.repeat(64);
    const { admin } = tokens([
      { token: live, user_id: ME, report_id: ID, expires_at: '2026-10-04T10:04:00.000Z' },
      { token: old, user_id: ME, report_id: ID, expires_at: '2026-10-04T09:00:00.000Z' },
    ]);
    const now = Date.parse('2026-10-04T10:00:00.000Z');
    const { resolveNav2RenderToken: realResolve } = await vi.importActual<typeof import('@/lib/services/investment-intelligence/nav2/fundAnalyticsRenderToken')>('@/lib/services/investment-intelligence/nav2/fundAnalyticsRenderToken');
    expect(await realResolve(admin, live, now)).toEqual({ userId: ME, reportId: ID });
    expect(await realResolve(admin, old, now)).toBeNull();
    expect(await realResolve(admin, 'e'.repeat(64), now)).toBeNull();
    expect(await realResolve(admin, "'; drop table x; --", now)).toBeNull();
    expect(await realResolve(admin, '', now)).toBeNull();
  });
});

describe('the proxy lets the headless PDF browser reach exactly the token print routes', () => {
  const rule = (): RegExp => {
    const src = fs.readFileSync(path.join(ROOT, 'proxy.ts'), 'utf8');
    const m = /const isTokenAuthorizedPrintRoute = (\/\^.*?\$\/)\.test\(pathname\)/.exec(src);
    if (!m) throw new Error('rule not found');
    return new Function(`return ${m[1]}`)() as RegExp;
  };
  it('matches the Fund analytics, Monthly report and forecast print routes and nothing broader', () => {
    const r = rule();
    for (const p of ['/reports/fund-analytics/print', '/reports/0b6a0c5e-1111-4111-8111-111111111111/print', '/forecast/report/print']) expect(r.test(p), p).toBe(true);
    for (const p of ['/forecast/report', '/forecast/report/print/x', '/forecast/print', '/reports/print', '/reports/a/b/print', '/admin/reports/x/print', '/forecast/report/print2']) expect(r.test(p), p).toBe(false);
  });
});

describe('static contract', () => {
  it('no route reads a user id from the request (NC-F5) and none uses an unscoped read of another user\'s report', () => {
    for (const f of ['app/api/reports/fund-analytics/route.ts', 'app/api/reports/fund-analytics/[id]/route.ts', 'app/api/reports/fund-analytics/[id]/export/route.ts']) {
      const t = fs.readFileSync(path.join(ROOT, f), 'utf8');
      expect(t, f).not.toMatch(/searchParams\.get\(['"](user|userId|user_id)['"]\)/);
      expect(t, f).not.toMatch(/body\.(user|userId|user_id)\b/);
    }
  });
  it('the Reports menu and the nav capability map list the new page; the page states the Premium rule and the switch rule', () => {
    expect(fs.readFileSync(path.join(ROOT, 'lib/nav/appNavGroups.ts'), 'utf8')).toMatch(/label: 'Fund Analytics', href: '\/reports\/fund-analytics'/);
    expect(fs.readFileSync(path.join(ROOT, 'lib/nav/appNavCapability.ts'), 'utf8')).toMatch(/'\/reports\/fund-analytics': 'REPORTS'/);
    const page = fs.readFileSync(path.join(ROOT, 'app/(app)/reports/fund-analytics/page.tsx'), 'utf8');
    expect(page).toMatch(/FUND_ANALYTICS_PREMIUM_MESSAGE/);
    expect(page).toMatch(/FUND_ANALYTICS_DISABLED_MESSAGE/);
    expect(page.indexOf('canViewPremiumReport')).toBeLessThan(page.indexOf('<FundAnalyticsReportClient'));
  });
});

describe('the Fund analytics print page and token load WITHOUT a headless browser (Amplify packs none: the 18-10-2026 slimming removed playwright)', () => {
  const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  it('the print page imports the token module, never the renderer; the token module imports no browser', () => {
    const page = code(read('app/(print)/reports/fund-analytics/print/page.tsx'));
    expect(page).toContain("nav2/fundAnalyticsRenderToken'");
    expect(page).not.toMatch(/fundAnalyticsPdfRenderer|playwright/);
    expect(code(read('lib/services/investment-intelligence/nav2/fundAnalyticsRenderToken.ts'))).not.toMatch(/playwright|fundAnalyticsPdfRenderer/);
  });
  it('NC-PW1: the old import (the page importing the renderer, which imports playwright at its top level) is exactly what the scanner flags', () => {
    expect(code(read('lib/services/investment-intelligence/nav2/fundAnalyticsPdfRenderer.ts'))).toMatch(/from 'playwright'/);
    const old = "import { resolveNav2RenderToken } from '@/lib/services/investment-intelligence/nav2/fundAnalyticsPdfRenderer';";
    expect(old).toMatch(/fundAnalyticsPdfRenderer|playwright/);
  });
  it('the export route loads the renderer on demand inside its try (a typed answer, not a failure while the route loads)', () => {
    const route = code(read('app/api/reports/fund-analytics/[id]/export/route.ts'));
    expect(route).not.toMatch(/^import .*fundAnalyticsPdfRenderer/m);
    expect(route).toMatch(/await import\('@\/lib\/services\/investment-intelligence\/nav2\/fundAnalyticsPdfRenderer'\)/);
  });
  it('the renderer still exports the token functions for existing callers (re-export)', async () => {
    const mod = await vi.importActual<typeof import('@/lib/services/investment-intelligence/nav2/fundAnalyticsPdfRenderer')>('@/lib/services/investment-intelligence/nav2/fundAnalyticsPdfRenderer');
    expect(typeof mod.createNav2RenderToken).toBe('function');
    expect(typeof mod.resolveNav2RenderToken).toBe('function');
  });
});
