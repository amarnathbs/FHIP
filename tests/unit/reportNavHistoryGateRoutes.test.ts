// The routes around the price-history gate (PO 2026-10-03): a held report is a
// 202 with the plain headline (never a failure), the scheduled run records it as
// waiting, and the gate endpoint fails OPEN.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryDb } from './support/inMemorySupabase';
import { countryRegistryFrom } from './support/countryRegistryFake';

const mockGetUser = vi.fn();
const mockUserFrom = vi.fn();
const generateReport = vi.fn();
const checkReportNavHistoryGate = vi.fn();

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: mockGetUser }, from: mockUserFrom }) }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ from: () => ({ select: () => Promise.resolve({ data: [{ user_id: 'user-1' }, { user_id: 'user-2' }], error: null }) }) }) }));
vi.mock('@/lib/services/reportsData', () => ({ generateReport: (...a: unknown[]) => generateReport(...a) }));
vi.mock('@/lib/services/investment-intelligence/pc6/userNavHistoryKick', () => ({ kickUserNavHistory: () => true }));
vi.mock('@/lib/services/investment-intelligence/pc6/reportNavHistoryGate', async (orig) => {
  const actual = await orig<typeof import('@/lib/services/investment-intelligence/pc6/reportNavHistoryGate')>();
  return { ...actual, checkReportNavHistoryGate: (...a: unknown[]) => checkReportNavHistoryGate(...a) };
});

import { POST as generatePOST } from '@/app/api/reports/generate/route';
import { POST as cronPOST } from '@/app/api/reports/cron/monthly-generate/route';
import { GET as gateGET } from '@/app/api/investment-intelligence/nav-history/gate/route';
import { ReportWaitingForPriceHistoryError, evaluateReportNavGate } from '@/lib/services/investment-intelligence/pc6/reportNavHistoryGate';

const USER = 'user-1';
const NOW = '2026-10-03T10:00:00.000Z';
const gap = { state: 'gap' as const, fromDate: '2022-01-01', toDate: '2026-09-20' };
const holdGate = evaluateReportNavGate({ schemes: [{ instrumentId: 'a', schemeName: 'Fund A', gap: { state: 'complete' }, attempt: null, overlapsCoverageGap: false }, { instrumentId: 'b', schemeName: 'Fund B', gap, attempt: null, overlapsCoverageGap: false }], heldSinceIso: NOW, nowIso: NOW });
const post = (body: unknown = {}) => generatePOST(new Request('http://t/x', { method: 'POST', body: JSON.stringify(body) }));

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = 'secret';
  const db = createInMemoryDb();
  db.reset({ user_profiles: [{ user_id: USER, country_of_residence: 'AU', country_confirmed_at: '2026-08-29T00:00:00Z', country_source: 'USER_CONFIRMED', onboarding_completed: true }] });
  mockUserFrom.mockImplementation((table: string) => countryRegistryFrom(table) ?? db.client.from(table));
  mockGetUser.mockResolvedValue({ data: { user: { id: USER, email: 'u@example.com' } } });
});

describe('POST /api/reports/generate', () => {
  it('a held report is HTTP 202 with the plain headline, not an error', async () => {
    generateReport.mockRejectedValue(new ReportWaitingForPriceHistoryError(holdGate));
    const res = await post({ reportType: 'monthly_financial_health' });
    expect(res.status).toBe(202);
    expect((await res.json()).data).toMatchObject({ waiting: true, headline: 'Your report will be ready once price history is loaded (1 of 2 funds loaded)', waitingFunds: ['Fund B'] });
  });

  it('a real failure is still an error, and a generated report is still 200', async () => {
    generateReport.mockRejectedValue(new Error('boom'));
    expect((await post()).status).toBe(400);
    generateReport.mockResolvedValue({ report: { id: 'r1', status: 'ready' }, sections: [], alreadyExisted: false });
    expect((await post()).status).toBe(200);
  });
});

describe('POST /api/reports/cron/monthly-generate', () => {
  it('records a held user as waiting_for_price_history (not error) and carries on with the others', async () => {
    generateReport.mockRejectedValueOnce(new ReportWaitingForPriceHistoryError(holdGate)).mockResolvedValueOnce({ report: { id: 'r2', status: 'ready' } });
    const res = await cronPOST(new Request('http://t/x', { method: 'POST', headers: { 'x-cron-secret': 'secret' } }));
    const body = (await res.json()).data;
    expect(body.results).toEqual([{ userId: 'user-1', status: 'waiting_for_price_history' }, { userId: 'user-2', status: 'ready' }]);
  });
});

describe('GET /api/investment-intelligence/nav-history/gate', () => {
  it('401 unauthenticated', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });
    expect((await gateGET()).status).toBe(401);
  });

  it('reports hold / headline / disclosures for the caller only, and starts the window (createAnchor) with the kick wired', async () => {
    checkReportNavHistoryGate.mockResolvedValue(holdGate);
    const body = (await (await gateGET()).json()).data;
    expect(body).toMatchObject({ hold: true, waiting: true, headline: expect.stringContaining('1 of 2 funds loaded'), waitingFunds: ['Fund B'], disclosures: [] });
    const args = checkReportNavHistoryGate.mock.calls[0][0];
    expect(args.userId).toBe(USER);
    expect(args.createAnchor).toBe(true);
    expect(typeof args.kick).toBe('function');
  });

  it('fails OPEN: if the check cannot run, the screen is told not to hold', async () => {
    checkReportNavHistoryGate.mockRejectedValue(new Error('db down'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const body = (await (await gateGET()).json()).data;
    expect(body).toMatchObject({ hold: false, checkFailed: true });
    spy.mockRestore();
  });
});
