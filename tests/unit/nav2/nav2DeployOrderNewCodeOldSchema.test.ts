// NAV2 production release, DEPLOY ORDER: the NEW code running on the OLD database (migrations 0260-0263 and 0269-0271 NOT applied).
//
// The fake database below answers exactly what Postgres answers on production before the migrations (checked on PGlite by
// scripts/nav2_production_deploy_order_proof.mjs group B): an undefined table is error 42P01, an undefined column is 42703, an undefined
// function is 42883, and the NAV2 job-control rows simply are not there (no row, no error). Every customer-visible NAV2 surface must then
// answer a plain, deliberate 401/403/404 or an inert value, never a 500, and nothing old may change.
//
// NAMED NEGATIVE CONTROLS
//   NC-D1  Premium person, list: 404 with the unavailable sentence, never 500;
//   NC-D2  Premium person, generate: 404 (the switch row is missing, so the switch is OFF) and no report work is started;
//   NC-D3  Premium person, read one report and PDF export: 404 not found, never 500, no render started;
//   NC-D4  free person: the same 403 Premium sentence as always (the missing schema never changes what a free person sees);
//   NC-D5  the sidebar answer says the Fund Analytics entry is hidden (premiumNavigation false) and the nav route itself answers 200;
//   NC-D6  the price history kick takes the EXISTING path (the planner switch row is missing, so it is OFF) and does not touch NAV2;
//   NC-D7  the admin capability reads fail closed to "no capability" (missing column), never to a grant, and /api/admin/me still answers;
//   NC-D8  the correction worker route skips with no read and no write;
//   NC-D9  control: with the switch row present and ON, and the tables answering, the same routes work (the tests above are not vacuous).
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Result = { data: unknown; error: { code: string; message: string } | null };
const missing = (what: string, code = '42P01'): Result => ({ data: null, error: { code, message: `${what} does not exist` } });

/** A chainable fake of the Supabase query builder. `answer(table)` decides what the final await returns. */
function fakeDb(answer: (table: string) => Result) {
  const calls: string[] = [];
  const builder = (table: string) => {
    const b: Record<string, unknown> = {};
    const chain = () => b;
    for (const m of ['select', 'eq', 'in', 'order', 'limit', 'is', 'gte', 'lte', 'neq', 'insert', 'update', 'upsert', 'delete', 'filter']) b[m] = chain;
    b.maybeSingle = async () => answer(table);
    b.single = async () => answer(table);
    b.then = (res: (v: Result) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(answer(table)).then(res, rej);
    return b;
  };
  return {
    calls,
    from: (table: string) => {
      calls.push(table);
      return builder(table);
    },
    auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) },
    rpc: async () => missing('function', '42883'),
  };
}

const OLD_SCHEMA = (table: string): Result => {
  if (table === 'ii_reference_job_control') return { data: null, error: null }; // the table exists, the NAV2 rows do not
  if (table === 'admin_users') return missing('column can_upload_risk_free_data', '42703');
  return missing(`relation ${table}`);
};

let db = fakeDb(OLD_SCHEMA);
const mockPremium = vi.fn();
const mockExport = vi.fn();
const mockRender = vi.fn();
const mockLegacy = vi.fn();

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => db }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => db }));
vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>();
  return {
    ...actual,
    requireCountryConfirmedUser: async () => ({ user: { id: 'u1' }, unauthenticated: null }),
  };
});
vi.mock('@/lib/services/entitlements', () => ({ canViewPremiumReport: (...a: unknown[]) => mockPremium(...a), canExportReports: (...a: unknown[]) => mockExport(...a) }));
vi.mock('@/lib/services/investment-intelligence/nav2/fundAnalyticsPdfRenderer', async (orig) => {
  const actual = await orig<typeof import('@/lib/services/investment-intelligence/nav2/fundAnalyticsPdfRenderer')>();
  return { ...actual, renderFundAnalyticsReportToPdf: (...a: unknown[]) => mockRender(...a) };
});
vi.mock('@/lib/services/appCapabilityFlag', () => ({ isG4CapabilityLayerEnabled: () => false }));

import { GET as listGET, POST as generatePOST } from '@/app/api/reports/fund-analytics/route';
import { GET as oneGET } from '@/app/api/reports/fund-analytics/[id]/route';
import { GET as exportGET } from '@/app/api/reports/fund-analytics/[id]/export/route';
import { GET as navGET } from '@/app/api/capabilities/nav/route';
import { POST as workerPOST } from '@/app/api/investment-intelligence/cron/nav2-correction-worker/route';
import { runUserNavHistoryForKick } from '@/lib/services/investment-intelligence/nav2/nav2TriggerRunner';
import { readRiskFreeCapabilityFlags } from '@/lib/services/investment-intelligence/nav2/riskFreeAdmin';
import { isNav2FlagOn, NAV2_JOB_KEYS } from '@/lib/services/investment-intelligence/nav2/nav2Flags';

const ID = '66666666-6666-4666-8666-666666666666';
const ctx = { params: Promise.resolve({ id: ID }) };

beforeEach(() => {
  vi.clearAllMocks();
  db = fakeDb(OLD_SCHEMA);
  mockPremium.mockResolvedValue(true);
  mockExport.mockResolvedValue(true);
  mockRender.mockResolvedValue(Buffer.from('%PDF'));
  process.env.CRON_SECRET = 'x';
});

describe('new code on the old database: ordinary people never see a 500', () => {
  it('NC-D1: a Premium person asking for the list gets the plain 404, not a 500', async () => {
    const res = await listGET();
    expect(res.status).toBe(404);
    expect(JSON.stringify(await res.json())).toMatch(/not available yet/i);
    expect(db.calls).not.toContain('nav2_fund_analytics_reports');
  });

  it('NC-D2: a Premium person generating a report gets 404 (the switch is OFF because its row is missing) and no report work starts', async () => {
    const res = await generatePOST(new Request('http://t/api/reports/fund-analytics', { method: 'POST', body: '{}' }));
    expect(res.status).toBe(404);
    expect(db.calls).not.toContain('nav2_fund_analytics_reports');
    expect(db.calls).not.toContain('nav2_result_cache');
    expect(db.calls).not.toContain('ii_prices_nav');
  });

  it('NC-D3: reading one report and exporting a PDF answer 404 not found, never 500, and no render starts', async () => {
    const one = await oneGET(new Request('http://t'), ctx);
    expect(one.status).toBe(404);
    const exp = await exportGET(new Request('http://t'), ctx);
    expect(exp.status).toBe(404);
    expect(mockRender).not.toHaveBeenCalled();
  });

  it('NC-D4: a free person gets the same 403 Premium sentence on every verb as with the schema in place', async () => {
    mockPremium.mockResolvedValue(false);
    mockExport.mockResolvedValue(false);
    for (const run of [() => listGET(), () => generatePOST(new Request('http://t', { method: 'POST', body: '{}' })), () => oneGET(new Request('http://t'), ctx), () => exportGET(new Request('http://t'), ctx)]) {
      const res = await run();
      expect(res.status).toBe(403);
      expect(JSON.stringify(await res.json())).toMatch(/Premium|premium/);
    }
  });

  it('NC-D5: the sidebar answer hides the Fund Analytics entry and the route still answers 200', async () => {
    const res = await navGET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { premiumNavigation: { fundAnalytics: boolean }; decisions: Record<string, string> } };
    expect(body.data.premiumNavigation).toEqual({ fundAnalytics: false });
    expect(body.data.decisions.REPORTS).toBe('ENABLED'); // the rest of the menu is untouched
  });

  it('NC-D6: the price history kick takes the existing path and never plans', async () => {
    const planned = vi.fn();
    mockLegacy.mockResolvedValue({ attempted: 0 });
    const out = await runUserNavHistoryForKick('u1', { legacy: (u: string) => mockLegacy(u), planned });
    expect(out).toEqual({ attempted: 0 });
    expect(mockLegacy).toHaveBeenCalledWith('u1');
    expect(planned).not.toHaveBeenCalled();
  });

  it('NC-D7: a missing capability column is "no capability" for both permissions, never a grant', async () => {
    const flags = await readRiskFreeCapabilityFlags(db as never, 'u1');
    expect(flags).toEqual({ upload: false, switch: false });
  });

  it('NC-D8: the correction worker route skips with no event read and no write', async () => {
    const res = await workerPOST(new Request('http://t', { method: 'POST', headers: { 'x-cron-secret': 'x' }, body: '{}' }));
    expect(res.status).toBe(200);
    expect(JSON.stringify(await res.json())).toMatch(/skipped_kill_switch/);
    expect(db.calls).not.toContain('nav2_correction_events');
    expect(db.calls).not.toContain('nav2_result_cache');
  });

  it('every NAV2 switch reads OFF when its row is missing', async () => {
    for (const key of Object.values(NAV2_JOB_KEYS)) expect(await isNav2FlagOn(db as never, key), key).toBe(false);
  });
});

describe('NC-D9 control: the same surfaces with the schema present and the switch ON', () => {
  it('the list answers 200 and the nav answer shows the entry for a Premium person', async () => {
    db = fakeDb((table) => {
      if (table === 'ii_reference_job_control') return { data: { enabled: true }, error: null };
      if (table === 'nav2_fund_analytics_reports') return { data: [], error: null };
      return missing(`relation ${table}`);
    });
    const res = await listGET();
    expect(res.status).toBe(200);
    const nav = (await (await navGET()).json()) as { data: { premiumNavigation: { fundAnalytics: boolean } } };
    expect(nav.data.premiumNavigation.fundAnalytics).toBe(true);
  });
});
