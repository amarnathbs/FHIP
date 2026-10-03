// generateReport is the ONE builder of a report; the price-history gate lives
// inside it (PO decision 2026-10-03). Heavy collaborators are faked; no network.
//
// NAMED NEGATIVE CONTROLS
//   NC-G1  OLD behaviour (generate immediately, "not available" cells while history
//          loads) vs the gated behaviour.
//   NC-G2  no path bypasses the gate (single builder; routes; export renders stored
//          sections only).
import fs from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { createInMemoryDb, type InMemoryDb, type Row } from './support/inMemorySupabase';

let currentDb: InMemoryDb;
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => currentDb.client }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => currentDb.client }));
const resolveReportSourceData = vi.fn();
vi.mock('@/lib/services/reportSnapshotResolver', () => ({
  resolveReportSourceData: (...a: unknown[]) => resolveReportSourceData(...a),
  buildEligibilityInput: () => ({}),
  isEligibleForOfficialMonthlyReport: () => ({ eligible: true, reason: null }),
  loadReportInputsLastChangedAt: async () => null,
}));
const builtSections = () => [
  { sectionCode: 'executive_summary', sectionTitle: 'Summary', displayOrder: 1, sectionStatus: 'included', sectionData: {}, narrativeText: 'Summary text.', chartData: null, sourceReferences: {}, confidenceLevel: null, limitationText: null },
  { sectionCode: 'investment_performance', sectionTitle: 'Performance', displayOrder: 30, sectionStatus: 'included', sectionData: {}, narrativeText: 'Performance text.', chartData: null, sourceReferences: {}, confidenceLevel: null, limitationText: null },
  { sectionCode: 'india_mf_investment_report', sectionTitle: 'MF report', displayOrder: 33, sectionStatus: 'included', sectionData: { report: {} }, narrativeText: 'MF text.', chartData: null, sourceReferences: {}, confidenceLevel: null, limitationText: null },
];
vi.mock('@/lib/engines/reportSections', () => ({ buildReportSections: () => builtSections() }));
vi.mock('@/lib/services/dashboardData', () => ({ getFxRateAudInr: async () => 60 }));
vi.mock('@/lib/services/investment-intelligence/pc6/reportNavDependencyWriter', () => ({ writeReportNavDependencyManifest: async () => undefined }));
vi.mock('@/lib/services/investment-intelligence/pc6/userNavHistoryKick', () => ({ kickUserNavHistory: () => true }));
vi.mock('@/lib/services/investment-intelligence/audit', () => ({ emitAuditEvent: async () => ({ error: null }) }));

import { generateReport } from '@/lib/services/reportsData';
import { ReportWaitingForPriceHistoryError, evaluateReportNavGate, waitingResponseFor, type GateSchemeInput, type ReportNavGate } from '@/lib/services/investment-intelligence/pc6/reportNavHistoryGate';
import { PriceHistoryWaitingNotice } from '@/components/reports/PriceHistoryWaitingNotice';

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');
const NOW = '2026-10-03T10:00:00.000Z';
const USER = 'user-1';
const gap = { state: 'gap' as const, fromDate: '2022-01-01', toDate: '2026-09-20' };
const fund = (id: string, over: Partial<GateSchemeInput> = {}): GateSchemeInput => ({ instrumentId: id, schemeName: `Fund ${id}`, gap, attempt: null, overlapsCoverageGap: false, ...over });
const loaded = (id: string) => fund(id, { gap: { state: 'complete' } });

function reportWorld(over: Record<string, Row[]> = {}) {
  currentDb = createInMemoryDb();
  currentDb.reset({ report_generation_runs: [], reports: [], report_sections: [], report_snapshots: [], ...over });
  resolveReportSourceData.mockReset();
  resolveReportSourceData.mockResolvedValue({ asOfDate: '2026-10-01', currency: 'INR', profile: { countryOfResidence: 'IN' }, financialTwin: null, healthScore: null, resilience: null, dna: null, premium: null });
  return currentDb;
}
const holdGate: ReportNavGate = evaluateReportNavGate({ schemes: [loaded('a'), fund('b')], heldSinceIso: NOW, nowIso: NOW });
const releasedGate: ReportNavGate = evaluateReportNavGate({ schemes: [loaded('a'), loaded('b')], heldSinceIso: null, nowIso: NOW });
const disclosedGate: ReportNavGate = evaluateReportNavGate({ schemes: [loaded('a'), fund('hsbc', { overlapsCoverageGap: true, schemeName: 'HSBC Short Term Fund' })], heldSinceIso: NOW, nowIso: NOW });
const generate = (gate?: (u: string, d: never) => Promise<ReportNavGate | null>, reportType: 'monthly_financial_health' | 'net_worth' = 'monthly_financial_health') =>
  generateReport({ userId: USER, reportType, reportMonth: '2026-10-01', triggerType: 'manual', client: currentDb.client as never, navHistoryGate: gate as never });

describe('generateReport honours the gate', () => {
  it('HOLDS while history is loading: throws the waiting error, builds NOTHING, stores NO report, and records the run as waiting (not failed)', async () => {
    const db = reportWorld();
    await expect(generate(async () => holdGate)).rejects.toBeInstanceOf(ReportWaitingForPriceHistoryError);
    expect(resolveReportSourceData).not.toHaveBeenCalled(); // no India MF / Performance section was even assembled
    expect(db.tables.reports).toHaveLength(0);
    expect(db.tables.report_sections).toHaveLength(0);
    expect(db.tables.report_generation_runs[0]).toMatchObject({ output_status: 'waiting_for_price_history' });
  });

  it('RELEASES when every fund is loaded: the report is generated, with no disclosure added', async () => {
    const db = reportWorld();
    const res = await generate(async () => releasedGate);
    expect(res.report.status).toBe('ready');
    expect(db.tables.reports).toHaveLength(1);
    expect(db.tables.report_sections.find((s) => s.section_code === 'india_mf_investment_report')!.narrative_text).toBe('MF text.');
  });

  it('RELEASES WITH DISCLOSURE for an unloadable fund: generated, and the fund is named in plain words in the MF and Performance sections', async () => {
    const db = reportWorld();
    const res = await generate(async () => disclosedGate);
    expect(res.report.status).toBe('ready');
    const text = 'Price history for HSBC Short Term Fund could not be loaded; its figures are marked not available.';
    expect(db.tables.report_sections.find((s) => s.section_code === 'india_mf_investment_report')!.narrative_text).toContain(text);
    expect(db.tables.report_sections.find((s) => s.section_code === 'investment_performance')!.narrative_text).toContain(text);
    expect(db.tables.report_sections.find((s) => s.section_code === 'executive_summary')!.narrative_text).toBe('Summary text.');
  });

  it('a user with no gaps sees no change: the report is exactly the engine\'s sections', async () => {
    const db = reportWorld();
    await generate(async () => evaluateReportNavGate({ schemes: [], heldSinceIso: null, nowIso: NOW }));
    expect(db.tables.report_sections.map((s) => s.narrative_text)).toEqual(['Summary text.', 'Performance text.', 'MF text.']);
  });

  it('fails OPEN: a gate that cannot be evaluated never traps the user (and the failure is logged)', async () => {
    const db = reportWorld();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await generate(async () => { throw new Error('db down'); });
    expect(res.report.status).toBe('ready');
    expect(db.tables.reports).toHaveLength(1);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('only the monthly report is gated', async () => {
    reportWorld();
    const gateFn = vi.fn(async () => holdGate);
    await expect(generate(gateFn as never, 'net_worth')).resolves.toMatchObject({ alreadyExisted: false });
    expect(gateFn).not.toHaveBeenCalled();
  });

  it('an up-to-date existing report is returned as before, without consulting the gate', async () => {
    reportWorld({ reports: [{ id: 'r1', user_id: USER, report_type_code: 'monthly_financial_health', report_month: '2026-10-01', status: 'ready', generated_at: '2026-10-02T00:00:00Z', created_at: '2026-10-02T00:00:00Z', version_number: 1 }] });
    const g = vi.fn(async () => holdGate);
    const res = await generate(g as never);
    expect(res.alreadyExisted).toBe(true);
    expect(g).not.toHaveBeenCalled();
  });

  it('NC-G1: the OLD behaviour (no gate) generated immediately while history was still loading; the gated behaviour does not', async () => {
    reportWorld();
    const old = await generate(async () => null); // what the code did before: nothing consulted the price history
    expect(old.report.status).toBe('ready'); // ...so a report with "not available" cells was built
    reportWorld();
    await expect(generate(async () => holdGate)).rejects.toBeInstanceOf(ReportWaitingForPriceHistoryError);
  });
});

describe('NC-G2: no path can bypass the gate', () => {
  const norm = (f: string) => f.split(path.sep).join('/');
  const walk = (dir: string): string[] => fs.readdirSync(path.join(process.cwd(), dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`]));
  const files = [...walk('app'), ...walk('lib'), ...walk('components')].filter((f) => /\.(ts|tsx)$/.test(f)).map(norm);

  it('generateReport is the ONLY place report sections are built and the India MF data is assembled for a report', () => {
    const builders = files.filter((f) => read(f).includes('buildReportSections(') && !f.startsWith('lib/engines/reportSections'));
    expect(builders).toEqual(['lib/services/reportsData.ts']);
    const resolvers = files.filter((f) => /resolveReportSourceData\(/.test(read(f)) && f !== 'lib/services/reportSnapshotResolver.ts');
    expect(resolvers.sort()).toEqual(['app/api/reports/availability/route.ts', 'lib/services/reportsData.ts']);
    const indiaLoaders = files.filter((f) => /loadIndiaMfReportForReport\(/.test(read(f)) && f !== 'lib/services/investment-intelligence/indiaMfReportData.ts');
    expect(indiaLoaders).toEqual(['lib/services/reportSnapshotResolver.ts']);
  });

  it('the availability route resolves data but builds and stores nothing', () => {
    const src = read('app/api/reports/availability/route.ts');
    expect(src).not.toMatch(/buildReportSections|\.insert\(|generateReport/);
  });

  it('every route that generates (manual, retry, revise, scheduled) goes through generateReport and answers a held report with 202 / a waiting status', () => {
    for (const f of ['app/api/reports/generate/route.ts', 'app/api/reports/[id]/retry/route.ts', 'app/api/reports/[id]/revise/route.ts']) {
      const src = read(f);
      expect(src, f).toContain('generateReport(');
      expect(src, f).toContain('waitingResponseFor(e)');
    }
    const cron = read('app/api/reports/cron/monthly-generate/route.ts');
    expect(cron).toContain('generateReport(');
    expect(cron).toContain('waiting_for_price_history');
  });

  it('the export / print routes render STORED sections only: they build nothing, so they cannot produce an ungated report', () => {
    const exportsRoute = read('app/api/reports/[id]/exports/route.ts');
    expect(exportsRoute).not.toMatch(/buildReportSections|resolveReportSourceData|loadIndiaMfReportForReport|generateReport/);
  });

  it('the gate is evaluated INSIDE generateReport before any section data is resolved', () => {
    const src = read('lib/services/reportsData.ts');
    const gate = src.indexOf('await navHistoryGateFor(params, supabase)');
    const resolve = src.indexOf('await resolveReportSourceData(params.userId, reportMonth, supabase)');
    expect(gate).toBeGreaterThan(0);
    expect(gate).toBeLessThan(resolve);
    expect(src).toContain('throw new ReportWaitingForPriceHistoryError(navGate)');
  });
});

describe('waiting response and the waiting UI', () => {
  it('a held report is HTTP 202 with the plain headline and fund names', async () => {
    const res = waitingResponseFor(new ReportWaitingForPriceHistoryError(holdGate))!;
    expect(res.status).toBe(202);
    const body = (await res.json()).data;
    expect(body).toMatchObject({ waiting: true, headline: 'Your report will be ready once price history is loaded (1 of 2 funds loaded)', loaded: 1, total: 2, waitingFunds: ['Fund b'], retryWindowMinutes: 10 });
    expect(waitingResponseFor(new Error('x'))).toBeNull();
  });

  it('the notice says what is happening, that it is automatic, the bounded wait, and names unloadable funds; it never says "not available" for a fund still loading', () => {
    const state = { headline: holdGate.headline, loaded: 1, total: 2, waitingFunds: ['Fund b'], unavailableFunds: ['HSBC Short Term Fund'], retryWindowMinutes: 10 };
    const html = renderToStaticMarkup(createElement(PriceHistoryWaitingNotice, { state }));
    expect(html).toContain('Your report will be ready once price history is loaded (1 of 2 funds loaded)');
    expect(html).toContain('generated automatically');
    expect(html).toContain('about 10 minutes');
    expect(html).toContain('Loading price history for Fund b');
    expect(html).toContain('Price history for HSBC Short Term Fund could not be loaded; its figures are marked not available.');
    expect(html).toContain('role="status"');
    const onlyLoading = renderToStaticMarkup(createElement(PriceHistoryWaitingNotice, { state: { ...state, unavailableFunds: [] } }));
    expect(onlyLoading).not.toContain('not available');
  });

  it('the Generate button retries on its own (and drives the fetch) while held; the Performance page is wrapped by the same gate and fails open', () => {
    const btn = read('components/reports/GenerateReportButton.tsx');
    expect(btn).toContain('res.status === 202');
    expect(btn).toContain('/api/investment-intelligence/nav-history');
    expect(btn).toContain('MAX_POLLS');
    const page = read('app/(app)/investment-intelligence/performance/page.tsx');
    expect(page).toMatch(/<PriceHistoryGate>[\s\S]*<PerformanceClient \/>[\s\S]*<\/PriceHistoryGate>/);
    expect(read('components/investment-intelligence/PriceHistoryGate.tsx')).toContain('failedOpen');
  });
});
