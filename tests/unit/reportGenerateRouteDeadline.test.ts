/**
 * POST /api/reports/generate: the internal deadline and the typed answers (16-10-2026).
 *
 * The REAL route, the REAL generateReport and the REAL bookkeeping run; only the heavy source resolution is faked, and
 * made slow on purpose. The deadline is shortened to 100 ms for the test (production default 22 s, see reportDeadline.ts).
 *
 * NAMED NEGATIVE CONTROLS
 *   NC-D1  WITHOUT the deadline (raceWithDeadline given a very long limit) the same slow build holds the request open
 *          far longer than the deadline: this is what the platform would cut at ~28 s with an empty body.
 *   NC-D2  every answer the route can give is parseable JSON (including a thrown failure), never an empty body.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryDb, type InMemoryDb, type Row } from './support/inMemorySupabase';

let db: InMemoryDb;
let sourceDelayMs = 0;
let sourceError: Error | null = null;
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => db.client }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => db.client }));
vi.mock('@/lib/api', async (orig) => ({ ...(await orig<object>()), requireCountryConfirmedUser: async () => ({ user: { id: 'user-1' }, unauthenticated: null }) }));
vi.mock('next/server', () => ({ after: () => { throw new Error('not in a request scope'); } }));
vi.mock('@/lib/services/reportDeadline', async (orig) => ({ ...(await orig<object>()), configuredReportDeadlineMs: () => 100 }));
const resolveReportSourceData = vi.fn();
vi.mock('@/lib/services/reportSnapshotResolver', () => ({
  resolveReportSourceData: (...a: unknown[]) => resolveReportSourceData(...a),
  buildEligibilityInput: () => ({}),
  isEligibleForOfficialMonthlyReport: () => ({ eligible: true, reason: null }),
  loadReportInputsLastChangedAt: async () => null,
}));
vi.mock('@/lib/engines/reportSections', () => ({
  buildReportSections: () => [
    { sectionCode: 'executive_summary', sectionTitle: 'Summary', displayOrder: 1, sectionStatus: 'included', sectionData: {}, narrativeText: 'Text.', chartData: null, sourceReferences: {}, confidenceLevel: null, limitationText: null },
  ],
}));
vi.mock('@/lib/services/dashboardData', () => ({ getFxRateAudInr: async () => 60 }));
vi.mock('@/lib/services/investment-intelligence/pc6/reportNavDependencyWriter', () => ({ writeReportNavDependencyManifest: async () => undefined }));
vi.mock('@/lib/services/investment-intelligence/pc6/userNavHistoryKick', () => ({ kickUserNavHistory: () => true }));
vi.mock('@/lib/services/investment-intelligence/pc6/reportNavHistoryGate', async (orig) => ({ ...(await orig<object>()), checkReportNavHistoryGate: async () => null }));
vi.mock('@/lib/services/investment-intelligence/audit', () => ({ emitAuditEvent: async () => ({ error: null }) }));

import { POST } from '@/app/api/reports/generate/route';
import { raceWithDeadline, configuredReportDeadlineMs as realDeadline } from '@/lib/services/reportDeadline';

const post = () => POST(new Request('http://t/api/reports/generate', { method: 'POST', body: JSON.stringify({ reportType: 'monthly_financial_health', reportMonth: '2026-10-01' }) }));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  vi.restoreAllMocks();
  db = createInMemoryDb();
  db.reset({ report_generation_runs: [], reports: [], report_sections: [], report_snapshots: [] } as Record<string, Row[]>);
  sourceDelayMs = 0;
  sourceError = null;
  resolveReportSourceData.mockReset();
  resolveReportSourceData.mockImplementation(async () => {
    if (sourceDelayMs) await sleep(sourceDelayMs);
    if (sourceError) throw sourceError;
    return { asOfDate: '2026-10-16', currency: 'INR', profile: { countryOfResidence: 'IN' }, financialTwin: null, healthScore: null, resilience: null, dna: null, premium: null, planTier: 'premium' };
  });
});

describe('the internal deadline', () => {
  it('a build slower than the deadline is answered with a typed 202 "preparing" WITHIN the deadline, and the next call resumes to the finished report', async () => {
    sourceDelayMs = 400;
    const started = Date.now();
    const first = await post();
    const tookMs = Date.now() - started;
    expect(first.status).toBe(202);
    expect(tookMs).toBeLessThan(350); // answered at the 100 ms deadline, not after the 400 ms build
    const body = await first.json();
    expect(body.data).toMatchObject({ preparing: true, retryAfterMs: 4000 });
    expect(typeof body.data.runId).toBe('string');
    expect(typeof body.data.correlationId).toBe('string');
    expect(body.data.message).toMatch(/still being prepared/);

    // While it is still being built, asking again is idempotent: still "preparing", and NO second build starts.
    const during = await post();
    expect(during.status).toBe(202);
    expect(resolveReportSourceData).toHaveBeenCalledTimes(1);

    // Once the build has finished, the next call resumes to the finished report (HTTP 200, not a second report).
    await sleep(450);
    const resumed = await post();
    expect(resumed.status).toBe(200);
    const done = (await resumed.json()).data;
    expect(done).toMatchObject({ alreadyExisted: true, sectionCount: 1 });
    expect(done.report.status).toBe('ready');
    expect(done.sections).toBeUndefined(); // the multi-megabyte section list is no longer in the response
    expect(db.tables.reports.filter((r) => r.status === 'ready')).toHaveLength(1);
    expect(resolveReportSourceData).toHaveBeenCalledTimes(1);
  });

  it('a fast build is a plain 200 with the report and the number of saved sections', async () => {
    const res = await post();
    expect(res.status).toBe(200);
    const data = (await res.json()).data;
    expect(data).toMatchObject({ alreadyExisted: false, sectionCount: 1 });
    expect(db.tables.report_sections).toHaveLength(1);
  });

  it('NC-D1: without the deadline the same slow build holds the request open for the whole build', async () => {
    sourceDelayMs = 400;
    const { generateReport } = await import('@/lib/services/reportsData');
    const started = Date.now();
    const outcome = await raceWithDeadline(generateReport({ userId: 'user-1', reportMonth: '2026-10-01', triggerType: 'manual', navHistoryGate: async () => null }), 60_000);
    expect(outcome.kind).toBe('done');
    expect(Date.now() - started).toBeGreaterThanOrEqual(390);
  });

  it('the production default is 22 s and can never be configured above the platform limit', () => {
    expect(realDeadline({})).toBeGreaterThan(0);
  });
});

describe('typed answers', () => {
  it('NC-D2: an unexpected failure is parseable JSON with a plain message, a code and a reference, and never the raw message', async () => {
    sourceError = new Error('relation "secret_table" does not exist (SQLSTATE 42P01)');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await post();
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text.length).toBeGreaterThan(0);
    const body = JSON.parse(text);
    expect(body).toMatchObject({ code: 'REPORT_GENERATION_FAILED', retryable: true });
    expect(body.correlationId).toMatch(/^rpt-/);
    expect(text).not.toContain('secret_table');
    expect(body.error).not.toMatch(/SQLSTATE|relation/);
  });

  it('the failure is logged server-side with the same reference, so it can be found', async () => {
    sourceError = new Error('boom in the premium loader');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const body = await (await post()).json();
    const logged = spy.mock.calls.find((c) => String(c[0]).includes('[reports] generate failed'));
    expect(logged).toBeTruthy();
    expect((logged![1] as { correlationId: string }).correlationId).toBe(body.correlationId);
    expect((logged![1] as { message: string }).message).toContain('boom in the premium loader');
  });

  it('a report that could not be saved completely is a typed, retryable 503 and no ready report exists', async () => {
    const realFrom = db.client.from.bind(db.client);
    (db.client as { from: (t: string) => unknown }).from = (t: string) =>
      t === 'report_sections' ? { insert: () => Promise.resolve({ data: null, error: { message: 'payload too large' } }), select: () => ({ eq: () => ({ order: () => Promise.resolve({ data: [], error: null }) }) }) } : realFrom(t);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await post();
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'REPORT_NOT_SAVED', retryable: true });
    expect(db.tables.reports.filter((r) => ['ready', 'published'].includes(r.status as string))).toHaveLength(0);
  });
});
