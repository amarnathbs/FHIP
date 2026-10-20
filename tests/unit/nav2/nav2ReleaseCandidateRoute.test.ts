// NAV2 release candidate, blocker B3 (the route): the typed answers a client can rely on. See nav2ReleaseCandidateDeadlineIdempotency.test.ts for the
// service. Evidence level: UNIT-TESTED.
//
// NAMED NEGATIVE CONTROL
//   NC-T8  a malformed key is a 422 before any work; a replay is 200 and a new report 201; an expired deadline is a typed 503 with Retry-After;
//          a failure is a typed retryable 500 with no internals; in steps is a typed 202; a key conflict is a typed 409.
import { describe, expect, it, vi } from 'vitest';
import { REQUEST_DEADLINE_MS } from '@/lib/config/nav2/reportLimits';

const AS_OF = '2026-10-02';
const KEY = '0f8fad5b-d9cb-469f-a165-70867728950e';
const mockGetUser = vi.fn();
const mockCanView = vi.fn();
const mockGenerate = vi.fn();
const mockFlag = vi.fn();
vi.mock('next/navigation', () => ({ redirect: () => undefined, notFound: () => undefined }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: mockGetUser }, from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { country_of_residence: 'IN', country_confirmed_at: '2026-08-29T00:00:00Z', country_source: 'USER_CONFIRMED', onboarding_completed: true }, error: null }) }) }) }) }) }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ __admin: true }) }));
vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>();
  return { ...actual, requireCountryConfirmedUser: async () => ({ user: { id: 'user-1' }, unauthenticated: null }) };
});
vi.mock('@/lib/services/investment-intelligence/nav2/nav2Flags', async (orig) => {
  const actual = await orig<typeof import('@/lib/services/investment-intelligence/nav2/nav2Flags')>();
  return { ...actual, isNav2FlagOn: (...a: unknown[]) => mockFlag(...a) };
});
vi.mock('@/lib/services/entitlements', () => ({ canViewPremiumReport: (...a: unknown[]) => mockCanView(...a), canExportReports: async () => true }));
vi.mock('@/lib/services/investment-intelligence/nav2/fundAnalyticsReportService', async (orig) => {
  const actual = await orig<typeof import('@/lib/services/investment-intelligence/nav2/fundAnalyticsReportService')>();
  return { ...actual, generateFundAnalyticsReport: (...a: unknown[]) => mockGenerate(...a) };
});
import { POST as generatePOST } from '@/app/api/reports/fund-analytics/route';

const summary = { id: '66666666-6666-4666-8666-666666666666', versionNumber: 1, asOfDate: AS_OF, schemeCount: 2, createdAt: '2026-10-02T06:00:00Z', periodChoice: 'since_first_held' };
const post = (body: unknown = {}, headers: Record<string, string> = {}) => new Request('http://test/api/reports/fund-analytics', { method: 'POST', headers, body: JSON.stringify(body) });

describe('NC-T8: the route', () => {
  it('a malformed Idempotency-Key is a 422 before any work', async () => {
    mockCanView.mockResolvedValue(true);
    mockFlag.mockResolvedValue(true);
    mockGenerate.mockClear();
    for (const bad of ['short', 'x'.repeat(100), 'bad key with spaces 12345']) {
      const res = await generatePOST(post({}, { 'Idempotency-Key': bad }));
      expect(res.status).toBe(422);
    }
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('passes the key and the route-entry time to the service; a new report is 201, a replay is 200 with replayed true', async () => {
    mockCanView.mockResolvedValue(true);
    mockGenerate.mockReset();
    mockGenerate.mockResolvedValueOnce({ status: 'ready', report: summary, cache: { hits: 0, computed: 2, stored: 2 } });
    const before = Date.now();
    const created = await generatePOST(post({ period: 'all_history' }, { 'Idempotency-Key': KEY }));
    expect(created.status).toBe(201);
    const args = mockGenerate.mock.calls[0][0] as { idempotencyKey: string; requestStartedMs: number };
    expect(args.idempotencyKey).toBe(KEY);
    expect(args.requestStartedMs).toBeGreaterThanOrEqual(before - 5);
    expect(args.requestStartedMs).toBeLessThanOrEqual(Date.now());
    mockGenerate.mockResolvedValueOnce({ status: 'ready', report: summary, cache: { hits: 0, computed: 0, stored: 0 }, replayed: true });
    const replay = await generatePOST(post({}, { 'Idempotency-Key': KEY }));
    expect(replay.status).toBe(200);
    expect((await replay.json()).data).toMatchObject({ status: 'ready', replayed: true, report: { id: summary.id } });
  });

  it('no header means no key (an older client): the service gets null', async () => {
    mockGenerate.mockReset();
    mockGenerate.mockResolvedValueOnce({ status: 'ready', report: summary, cache: { hits: 0, computed: 1, stored: 1 } });
    await generatePOST(post({}));
    expect((mockGenerate.mock.calls[0][0] as { idempotencyKey: unknown }).idempotencyKey).toBeNull();
  });

  it('in steps is a typed 202 with Retry-After; a conflict is a typed 409', async () => {
    mockGenerate.mockReset();
    mockGenerate.mockResolvedValueOnce({ status: 'in_steps', message: 'Your report is large (8 of 20 funds ready)', ready: 8, total: 20, retryAfterSeconds: 60 });
    const steps = await generatePOST(post({}, { 'Idempotency-Key': KEY }));
    expect(steps.status).toBe(202);
    expect(steps.headers.get('Retry-After')).toBe('60');
    expect((await steps.json()).data).toMatchObject({ status: 'in_steps', loaded: 8, total: 20 });
    mockGenerate.mockResolvedValueOnce({ status: 'idempotency_conflict', message: 'used for a different request' });
    const conflict = await generatePOST(post({}, { 'Idempotency-Key': KEY }));
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).data).toMatchObject({ status: 'idempotency_conflict' });
  });

  it('a generation that outlives the deadline is answered with a typed 503 and Retry-After, never the platform page', async () => {
    vi.useFakeTimers();
    try {
      mockGenerate.mockReset();
      mockGenerate.mockImplementation(() => new Promise(() => undefined)); // never answers
      const pending = generatePOST(post({}, { 'Idempotency-Key': KEY }));
      await vi.advanceTimersByTimeAsync(REQUEST_DEADLINE_MS + 50);
      const res = await pending;
      expect(res.status).toBe(503);
      expect(res.headers.get('Retry-After')).toBe('5');
      const body = await res.json();
      expect(body.data).toMatchObject({ status: 'timed_out', retryable: true });
      expect(body.error).toMatch(/Nothing was lost/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a failure is a typed retryable 500, with a plain sentence and no internals', async () => {
    mockGenerate.mockReset();
    mockGenerate.mockRejectedValueOnce(new Error('relation "secret_table" does not exist'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await generatePOST(post({}, { 'Idempotency-Key': KEY }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.data).toMatchObject({ status: 'failed', retryable: true });
    expect(JSON.stringify(body)).not.toContain('secret_table');
    err.mockRestore();
  });
});
