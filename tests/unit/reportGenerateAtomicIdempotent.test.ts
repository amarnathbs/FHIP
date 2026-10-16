/**
 * generateReport: atomic persistence and idempotency (16-10-2026, PO production report: a "ready" report with no
 * saved sections rendered as a cover page and nothing else; the second click handed that empty report back).
 *
 * Heavy collaborators are faked (resolver, engine, gate); the persistence and the run bookkeeping are REAL, against
 * the in-memory database.
 *
 * NAMED NEGATIVE CONTROLS
 *   NC-A1  the OLD behaviour (sections inserted unchecked, report inserted as 'ready') is reproduced by a database that
 *          rejects the sections: before, that left a 'ready' report with zero sections; now the report is 'failed'.
 *   NC-A2  the OLD idempotency (any ready report is returned as is) would have handed the empty report back; now it is
 *          rebuilt, and the empty one is kept as history (superseded).
 *   NC-A3  two simultaneous clicks: exactly ONE build happens (the resolver is called once) and one report exists.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryDb, type InMemoryDb, type Row } from './support/inMemorySupabase';

let currentDb: InMemoryDb;
let rejectSections = false;
let resolverDelayMs = 0;
const wrapped = {
  from: (table: string) => {
    if (table === 'report_sections' && rejectSections) {
      const real = currentDb.client.from(table) as { select: (...a: unknown[]) => unknown; eq: (...a: unknown[]) => unknown; order: (...a: unknown[]) => unknown };
      return {
        insert: () => Promise.resolve({ data: null, error: { message: 'jsonb rejected the payload' } }),
        select: real.select.bind(real),
        eq: real.eq.bind(real),
        order: real.order.bind(real),
      };
    }
    return currentDb.client.from(table);
  },
};
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => wrapped }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => wrapped }));
const resolveReportSourceData = vi.fn();
vi.mock('@/lib/services/reportSnapshotResolver', () => ({
  resolveReportSourceData: (...a: unknown[]) => resolveReportSourceData(...a),
  buildEligibilityInput: () => ({}),
  isEligibleForOfficialMonthlyReport: () => ({ eligible: true, reason: null }),
  loadReportInputsLastChangedAt: async () => null,
}));
const section = (code: string, order: number, bytes = 10) => ({
  sectionCode: code, sectionTitle: code, displayOrder: order, sectionStatus: 'included', sectionData: { pad: 'x'.repeat(bytes) }, narrativeText: `${code} text`, chartData: null, sourceReferences: {}, confidenceLevel: null, limitationText: null,
});
let engineSections: ReturnType<typeof section>[] = [];
vi.mock('@/lib/engines/reportSections', () => ({ buildReportSections: () => engineSections }));
vi.mock('@/lib/services/dashboardData', () => ({ getFxRateAudInr: async () => 60 }));
vi.mock('@/lib/services/investment-intelligence/pc6/reportNavDependencyWriter', () => ({ writeReportNavDependencyManifest: async () => undefined }));
vi.mock('@/lib/services/investment-intelligence/pc6/userNavHistoryKick', () => ({ kickUserNavHistory: () => true }));
vi.mock('@/lib/services/investment-intelligence/audit', () => ({ emitAuditEvent: async () => ({ error: null }) }));

import { generateReport } from '@/lib/services/reportsData';
import { ReportNotSavedError, ReportPreparationStalledError, ReportPreparingError } from '@/lib/services/reportGenerationErrors';

const USER = 'user-1';
const MONTH = '2026-10-01';
const gen = (over: Record<string, unknown> = {}) =>
  generateReport({ userId: USER, reportType: 'monthly_financial_health', reportMonth: MONTH, triggerType: 'manual', client: wrapped as never, navHistoryGate: async () => null, ...over });

function world(over: Record<string, Row[]> = {}) {
  currentDb = createInMemoryDb();
  currentDb.reset({ report_generation_runs: [], reports: [], report_sections: [], report_snapshots: [], ...over });
  rejectSections = false;
  resolverDelayMs = 0;
  engineSections = [section('executive_summary', 1), section('cash_flow', 2), section('investment_performance', 30), section('india_mf_investment_report', 33)];
  resolveReportSourceData.mockReset();
  resolveReportSourceData.mockImplementation(async () => {
    if (resolverDelayMs) await new Promise((r) => setTimeout(r, resolverDelayMs));
    return { asOfDate: '2026-10-16', currency: 'INR', profile: { countryOfResidence: 'IN' }, financialTwin: null, healthScore: null, resilience: null, dna: null, premium: null, planTier: 'premium' };
  });
  return currentDb;
}
const run = (over: Row) => ({ id: `run-${Math.random().toString(36).slice(2, 8)}`, user_id: USER, output_status: 'started', started_at: new Date().toISOString(), report_id: null, ...over });

beforeEach(() => vi.restoreAllMocks());

describe('atomic persistence', () => {
  it('a normal build stores the report as ready WITH every section, and the run is recorded as succeeded', async () => {
    const db = world();
    const res = await gen();
    expect(res.report.status).toBe('ready');
    expect(db.tables.reports).toHaveLength(1);
    expect(db.tables.report_sections.map((s) => s.section_code)).toEqual(['executive_summary', 'cash_flow', 'investment_performance', 'india_mf_investment_report']);
    expect(db.tables.report_generation_runs[0]).toMatchObject({ output_status: 'succeeded', report_id: db.tables.reports[0].id });
    // result parity: what was stored is exactly what the engine built.
    expect(db.tables.report_sections.map((s) => s.narrative_text)).toEqual(engineSections.map((s) => s.narrativeText));
  });

  it('NC-A1: when the sections cannot be saved, NO ready report is left behind and the caller gets a typed error', async () => {
    const db = world();
    rejectSections = true;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(gen()).rejects.toBeInstanceOf(ReportNotSavedError);
    expect(db.tables.reports.filter((r) => ['ready', 'published'].includes(r.status as string))).toHaveLength(0);
    expect(db.tables.reports[0]).toMatchObject({ status: 'failed', failure_code: 'sections_not_saved' });
    expect(db.tables.report_generation_runs[0]).toMatchObject({ output_status: 'failed' });
  });

  it('NC-A1 (control): the SAME rejection with the old unchecked insert would have produced a ready, empty report', async () => {
    // Reproduces the pre-change sequence directly: insert as ready, ignore the sections result.
    const db = world();
    rejectSections = true;
    await (db.client.from('reports') as { insert: (r: unknown) => Promise<unknown> }).insert({ id: 'old', user_id: USER, status: 'ready' });
    await (wrapped.from('report_sections') as { insert: (r: unknown) => Promise<unknown> }).insert([{}]); // result ignored, as before
    expect(db.tables.reports[0].status).toBe('ready');
    expect(db.tables.report_sections).toHaveLength(0);
  });

  it('a section over a megabyte is saved in its own chunk (no single request carries the whole report)', async () => {
    const db = world();
    engineSections = [section('executive_summary', 1), section('scenario_forecasting', 21, 1_400_000), section('appendices', 40, 1_400_000), section('methodology', 50)];
    await gen();
    const inserts = db.writes.filter((w) => w.table === 'report_sections' && w.kind === 'insert');
    expect(inserts.length).toBeGreaterThanOrEqual(2);
    for (const w of inserts) expect(JSON.stringify(w.payload).length).toBeLessThan(1_600_000); // no request carries the whole ~2.8 MB report
    expect(db.tables.report_sections).toHaveLength(4);
  });

  it('a failure after the report row exists but before it is finished (price-history gate passes, snapshot step throws) retires the shell', async () => {
    const db = world();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // getFxRateAudInr is mocked to resolve; force the snapshot step to throw instead.
    const dash = await import('@/lib/services/dashboardData');
    (dash as unknown as { getFxRateAudInr: () => Promise<number> }).getFxRateAudInr = async () => {
      throw new Error('fx read failed');
    };
    await expect(gen()).rejects.toThrow('fx read failed');
    expect(db.tables.reports.some((r) => ['generating', 'ready'].includes(r.status as string))).toBe(false);
    expect(db.tables.reports[0]).toMatchObject({ status: 'failed', failure_code: 'not_completed' });
    (dash as unknown as { getFxRateAudInr: () => Promise<number> }).getFxRateAudInr = async () => 60;
  });
});

describe('idempotency and recovery', () => {
  it('NC-A2: an existing ready report with NO saved sections is rebuilt (never handed back); the empty one stays as history', async () => {
    const db = world({
      reports: [{ id: 'empty', user_id: USER, report_type_code: 'monthly_financial_health', report_month: MONTH, status: 'ready', generated_at: '2026-10-16T09:00:00Z', created_at: '2026-10-16T09:00:00Z', version_number: 1, revises_report_id: null }],
    });
    const res = await gen();
    expect(res.alreadyExisted).toBe(false);
    expect(res.report).toMatchObject({ status: 'ready', version_number: 2, revises_report_id: 'empty' });
    expect((res.report as unknown as { revision_reason: string }).revision_reason).toBe('Automatically rebuilt: the previous version had no saved content.');
    expect(db.tables.reports.find((r) => r.id === 'empty')!.status).toBe('superseded');
    expect(db.tables.report_sections.length).toBe(4);
  });

  it('a complete, current report is returned as is, with its sections and no rebuild (the old idempotency, kept)', async () => {
    const db = world({
      reports: [{ id: 'r1', user_id: USER, report_type_code: 'monthly_financial_health', report_month: MONTH, status: 'ready', generated_at: '2026-10-16T09:00:00Z', created_at: '2026-10-16T09:00:00Z', version_number: 1, revises_report_id: null }],
      report_sections: [{ id: 's1', report_id: 'r1', user_id: USER, section_code: 'executive_summary', section_title: 'x', display_order: 1, section_status: 'included', section_data_json: {}, narrative_text: 'saved' }],
    });
    const res = await gen();
    expect(res.alreadyExisted).toBe(true);
    expect(res.sections).toHaveLength(1);
    expect(resolveReportSourceData).not.toHaveBeenCalled();
    expect(db.tables.reports).toHaveLength(1);
  });

  it('repeated clicks one after another create exactly one report', async () => {
    const db = world();
    const a = await gen();
    const b = await gen();
    const c = await gen();
    expect([a.alreadyExisted, b.alreadyExisted, c.alreadyExisted]).toEqual([false, true, true]);
    expect(db.tables.reports.filter((r) => r.status === 'ready')).toHaveLength(1);
    expect(resolveReportSourceData).toHaveBeenCalledTimes(1);
  });

  it('NC-A3: two simultaneous clicks build ONCE; the other is told the report is being prepared', async () => {
    const db = world();
    resolverDelayMs = 60;
    const results = await Promise.allSettled([gen(), gen()]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(ReportPreparingError);
    expect(resolveReportSourceData).toHaveBeenCalledTimes(1);
    expect(db.tables.reports.filter((r) => ['ready', 'published'].includes(r.status as string))).toHaveLength(1);
    // After it finished, asking again resumes to the finished report.
    const next = await gen();
    expect(next.alreadyExisted).toBe(true);
    expect(db.tables.report_generation_runs.map((r) => r.output_status).sort()).toEqual(['already_exists', 'deferred_in_flight', 'succeeded']);
  });

  it('an OLDER preparation still running (started moments ago) holds a new request: typed "preparing", nothing built, nothing stored', async () => {
    const db = world({ report_generation_runs: [run({ id: 'older', started_at: new Date(Date.now() - 5000).toISOString() })] });
    await expect(gen()).rejects.toMatchObject({ code: 'REPORT_PREPARING', runId: 'older' });
    expect(resolveReportSourceData).not.toHaveBeenCalled();
    expect(db.tables.reports).toHaveLength(0);
  });

  it('a preparation that was cut off long ago is marked abandoned, its half-saved shell is retired, and the new request builds', async () => {
    const db = world({
      reports: [{ id: 'shell', user_id: USER, report_type_code: 'monthly_financial_health', report_month: MONTH, status: 'generating', version_number: 1, revises_report_id: null }],
      report_generation_runs: [run({ id: 'dead', started_at: new Date(Date.now() - 10 * 60_000).toISOString(), report_id: 'shell' })],
    });
    const res = await gen();
    expect(res.report.status).toBe('ready');
    expect(db.tables.report_generation_runs.find((r) => r.id === 'dead')).toMatchObject({ output_status: 'abandoned' });
    expect(db.tables.reports.find((r) => r.id === 'shell')).toMatchObject({ status: 'failed', failure_code: 'abandoned_generation' });
  });

  it('after three recent cut-off attempts it stops retrying blindly and says so (typed), instead of looping', async () => {
    world({
      report_generation_runs: [1, 2, 3].map((n) => run({ id: `ab${n}`, output_status: 'abandoned', started_at: new Date(Date.now() - n * 60_000).toISOString() })),
    });
    await expect(gen()).rejects.toBeInstanceOf(ReportPreparationStalledError);
    expect(resolveReportSourceData).not.toHaveBeenCalled();
  });

  it('the caller can learn the run id as soon as the preparation is recorded (the poll token)', async () => {
    world();
    const seen: string[] = [];
    await gen({ onRunStarted: (id: string) => seen.push(id) });
    expect(seen).toHaveLength(1);
  });
});
