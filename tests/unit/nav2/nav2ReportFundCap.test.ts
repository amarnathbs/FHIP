// One report covers at most FUND_ANALYTICS_MAX_FUNDS funds: 10 since the PO decision of 15-10-2026 (the pilot limit; it was 20 on 07-10-2026): the cap, the choice of funds, the time budget.
//
// NAMED NEGATIVE CONTROLS
//   NC-F1  11 held funds without a choice are REFUSED with the plain message and the funds to choose from; nothing is stored (before this change
//          a report for any number of funds was generated and the platform's 28 s limit decided);
//   NC-F2  10 funds are accepted; a choice of 11, an empty choice, a repeated fund and a fund the person does not hold are all refused with ONE message
//          (so another household's fund ids cannot be probed); a free user is told about Premium first, whatever the choice;
//   NC-F3  the choice is stored in the pinned manifest (sorted ids, held count, cap) and changes its checksum; the report says how many funds it covers;
//          a fund's cached figures do not depend on the choice (one entry serves every report that includes the fund);
//   NC-F4  the time budget: engine work that would not fit is not started; the funds that fit are prepared into the cache, the answer is a retryable
//          "in steps" message and no report is stored; the next generation reuses them and finishes.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { CACHE_WRITE_RESERVE_MS, ENGINE_MS_PER_UNCACHED_FUND, FUND_ANALYTICS_MAX_FUNDS, GENERATION_BUDGET_MS, REQUEST_DEADLINE_MS } from '@/lib/config/nav2/reportLimits';
import { NAV2_POLICY } from '@/lib/config/nav2/metricPolicy';
import { reportAnalysisSpec } from '@/lib/engines/nav2/analysisSpec';
import { buildFundAnalyticsReport, MAX_SCHEMES_FOR_PAIRS, manifestChecksum, schemeBundleCacheKey, type FundAnalyticsInput, type HeldSchemeInput, type ReportSelection } from '@/lib/engines/nav2/fundAnalyticsReport';
import { invalidSelectionMessage, tooManyFundsMessage } from '@/lib/engines/nav2/reportWording';
import { resolveFundSelection, type FundChoice, type FundChoiceCandidate } from '@/lib/services/investment-intelligence/nav2/fundAnalyticsLoader';
import { generateFundAnalyticsReport, type FundAnalyticsDeps } from '@/lib/services/investment-intelligence/nav2/fundAnalyticsReportService';
import type { ReportNavGate } from '@/lib/services/investment-intelligence/pc6/reportNavHistoryGate';
import { createInMemoryDb } from '../support/inMemorySupabase';
import { buildSeries, pathFromReturns, weekdays } from './support/fixtures';

const AS_OF = '2026-10-02';
const CAP = FUND_ANALYTICS_MAX_FUNDS; // 10: every number below is derived from it, so a later change of the limit is one edit in lib/config/nav2/reportLimits.ts
const DATES = weekdays('2025-06-02', 260);
const USER = 'user-1';
const idOf = (i: number) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`;
const navsFor = (seed: number): number[] => pathFromReturns(100, Array.from({ length: DATES.length - 1 }, (_, i) => 0.0004 + 0.01 * Math.sin(i * 0.37 + seed) * Math.cos(i * 0.11 + seed * 2)));

function scheme(i: number): HeldSchemeInput {
  const id = idOf(i);
  const name = `Fund ${String(i + 1).padStart(2, '0')}`;
  return { instrumentId: id, schemeName: name, planType: 'direct', optionType: 'growth', category: 'flexi_cap', categoryLabel: 'Flexi Cap', series: buildSeries(DATES, navsFor(i + 1), { identity: { instrumentId: id, schemeName: name }, asOf: AS_OF }), benchmarks: [], investor: null, firstHeldDate: '2025-07-01' };
}
const candidates = (n: number): FundChoiceCandidate[] => Array.from({ length: n }, (_, i) => ({ instrumentId: idOf(i), schemeName: `Fund ${String(i + 1).padStart(2, '0')}`, currentValue: 100_000 - i * 1000 }));
const baseInput = (schemes: HeldSchemeInput[], selection?: ReportSelection): FundAnalyticsInput => ({
  asOfDate: AS_OF, displayCurrency: 'INR', policy: NAV2_POLICY, spec: reportAnalysisSpec(AS_OF, NAV2_POLICY, 'since_first_held'), periodChoice: 'since_first_held', riskFree: null, schemes,
  scope: { entityHeldSchemesExcluded: 0, otherInstrumentsExcluded: 0, statementLinesAwaitingReview: 0, priceHistoryUnavailable: [] }, ...(selection ? { selection } : {}),
});
const openGate: ReportNavGate = { hold: false, funds: [], total: 1, loaded: 1, waiting: [], unavailable: [], heldSince: null, headline: null, disclosures: [] };

function setup(load: FundAnalyticsDeps['load'], over: Partial<FundAnalyticsDeps> = {}) {
  const db = createInMemoryDb({ strictSchema: true });
  db.reset({ nav2_fund_analytics_reports: [], nav2_report_nav_dependencies: [], nav2_result_cache: [], ii_reference_job_control: [] });
  const deps: Partial<FundAnalyticsDeps> = { isFlagOn: async () => true, isPremium: async () => true, gate: async () => openGate, load, nowIso: () => '2026-10-02T06:00:00.000Z', nowMs: () => 0, ...over };
  const call = (fundIds?: readonly string[] | null) => generateFundAnalyticsReport({ userId: USER, sessionClient: db.client as never, adminClient: db.client as unknown as SupabaseClient, periodChoice: 'since_first_held', fundIds, asOfDate: AS_OF, deps });
  return { db, call };
}
const choiceFor = (n: number): FundChoice => ({ candidates: candidates(n), max: FUND_ANALYTICS_MAX_FUNDS, suggestedIds: candidates(n).slice(0, FUND_ANALYTICS_MAX_FUNDS).map((c) => c.instrumentId) });

describe('the limits are consistent with each other and with the platform', () => {
  it('the cap is the pilot limit, not above the correlation limit, and the generation budget is inside the 28 s the platform allows', () => {
    expect(FUND_ANALYTICS_MAX_FUNDS).toBe(10); // PO decision 15-10-2026
    expect(FUND_ANALYTICS_MAX_FUNDS).toBeLessThanOrEqual(MAX_SCHEMES_FOR_PAIRS);
    expect(GENERATION_BUDGET_MS).toBeLessThan(28_000);
    expect(GENERATION_BUDGET_MS).toBeGreaterThanOrEqual(15_000);
  });
  it('the messages are the plain ones the PO asked for', () => {
    expect(tooManyFundsMessage(25, CAP)).toBe('A report covers up to 10 funds. You hold 25, so generate it in two reports.');
    expect(invalidSelectionMessage(CAP)).toBe('Choose between 1 and 10 of the funds you hold.');
  });
});

describe('NC-F1 / NC-F2: which funds a report covers (pure)', () => {
  it('10 held funds, no choice: all 10; 11 held, no choice: a choice is needed, the 10 largest are suggested', () => {
    expect(resolveFundSelection({ candidates: candidates(CAP), chosen: null, max: CAP }).includedIds).toHaveLength(CAP);
    const r = resolveFundSelection({ candidates: candidates(CAP + 1), chosen: null, max: CAP });
    expect(r.problem).toBe('needed');
    expect(r.suggestedIds).toEqual(candidates(CAP).map((c) => c.instrumentId)); // the largest first (the input arrives sorted by value)
  });
  it('a choice of 10 out of 25 is accepted as given; an 11th fund, an empty choice, a repeat and a fund not held are all refused', () => {
    const held = candidates(25);
    const ids = held.slice(2, 2 + CAP).map((c) => c.instrumentId);
    expect(resolveFundSelection({ candidates: held, chosen: ids, max: CAP })).toMatchObject({ includedIds: ids });
    expect(resolveFundSelection({ candidates: held, chosen: held.slice(0, CAP + 1).map((c) => c.instrumentId), max: CAP }).problem).toBe('invalid');
    expect(resolveFundSelection({ candidates: held, chosen: [], max: CAP }).problem).toBe('invalid');
    expect(resolveFundSelection({ candidates: held, chosen: [idOf(0), idOf(0)], max: CAP }).problem).toBe('invalid');
    expect(resolveFundSelection({ candidates: held, chosen: [idOf(0), '99999999-9999-4999-8999-999999999999'], max: CAP }).problem).toBe('invalid'); // another household's fund
  });
  it('a person who holds few funds may still choose a subset', () => {
    expect(resolveFundSelection({ candidates: candidates(5), chosen: [idOf(1), idOf(3)], max: CAP }).includedIds).toEqual([idOf(1), idOf(3)]);
  });
});

describe('NC-F1 / NC-F2: the service', () => {
  it('11 held funds without a choice: refused with the plain message and the funds to choose from; no report, no cache entry, nothing written', async () => {
    const load = vi.fn(async (_a: unknown) => ({ input: null, warnings: [], riskFreeUnavailableReason: null, selectionProblem: 'needed' as const, choice: choiceFor(CAP + 1) }));
    const { db, call } = setup(load);
    const r = await call();
    expect(r.status).toBe('select_funds');
    if (r.status === 'select_funds') {
      expect(r.message).toBe('A report covers up to 10 funds. You hold 11, so generate it in two reports.');
      expect(r.heldFundCount).toBe(CAP + 1);
      expect(r.max).toBe(CAP);
      expect(r.candidates).toHaveLength(CAP + 1);
      expect(r.suggestedIds).toHaveLength(CAP);
    }
    expect(db.tables.nav2_fund_analytics_reports).toHaveLength(0);
    expect(db.tables.nav2_result_cache).toHaveLength(0);
    expect(load.mock.calls[0][0]).toMatchObject({ selection: { max: CAP, chosen: null } });
  });

  it('a choice longer than the cap, empty or repeating a fund is refused BEFORE anything is loaded', async () => {
    const load = vi.fn();
    const { db, call } = setup(load as never);
    for (const bad of [Array.from({ length: CAP + 1 }, (_, i) => idOf(i)), [], [idOf(0), idOf(0)]]) {
      const r = await call(bad);
      expect(r).toEqual({ status: 'invalid_selection', message: 'Choose between 1 and 10 of the funds you hold.' });
    }
    expect(load).not.toHaveBeenCalled();
    expect(db.writes).toEqual([]);
  });

  it('a fund the person does not hold (found by the loader) gets the same one message', async () => {
    const load = vi.fn(async () => ({ input: null, warnings: [], riskFreeUnavailableReason: null, selectionProblem: 'invalid' as const, choice: choiceFor(25) }));
    const { call } = setup(load);
    expect(await call([idOf(0), '99999999-9999-4999-8999-999999999999'])).toEqual({ status: 'invalid_selection', message: 'Choose between 1 and 10 of the funds you hold.' });
  });

  it('a free user is told about Premium first, with any choice, and nothing is loaded', async () => {
    const load = vi.fn();
    const { call } = setup(load as never, { isPremium: async () => false });
    expect(await call(Array.from({ length: CAP + 1 }, (_, i) => idOf(i)))).toMatchObject({ status: 'forbidden', message: expect.stringMatching(/Premium/) });
    expect(await call([idOf(0)])).toMatchObject({ status: 'forbidden' });
    expect(load).not.toHaveBeenCalled();
  });

  it('10 funds are accepted and stored (the largest report of the pilot)', async () => {
    const schemes = Array.from({ length: CAP }, (_, i) => scheme(i));
    const load = vi.fn(async () => ({ input: baseInput(schemes, { basis: 'all_held', heldFundCount: CAP, chosenInstrumentIds: schemes.map((s) => s.instrumentId), max: CAP }), warnings: [], riskFreeUnavailableReason: null }));
    const { db, call } = setup(load);
    const r = await call();
    expect(r.status).toBe('ready');
    expect(db.tables.nav2_fund_analytics_reports).toHaveLength(1);
    expect((db.tables.nav2_fund_analytics_reports[0] as { scheme_count: number }).scheme_count).toBe(CAP);
  }, 120_000);
});

describe('NC-F3: the choice is part of the pinned provenance', () => {
  const schemes = Array.from({ length: 3 }, (_, i) => scheme(i));
  const chosen: ReportSelection = { basis: 'chosen', heldFundCount: 25, chosenInstrumentIds: [idOf(2), idOf(0), idOf(1)], max: CAP };
  const all: ReportSelection = { basis: 'all_held', heldFundCount: 3, chosenInstrumentIds: schemes.map((s) => s.instrumentId), max: CAP };

  it('the manifest records the basis, the held count, the cap and the SORTED chosen ids; the report says it covers 3 of 25', () => {
    const { report, manifest } = buildFundAnalyticsReport(baseInput(schemes, chosen));
    expect(manifest.selection).toEqual({ basis: 'chosen', heldFundCount: 25, chosenInstrumentIds: [idOf(0), idOf(1), idOf(2)], max: CAP });
    expect(report.selection).toEqual({ heldFundCount: 25, chosenCount: 3, max: CAP, chosenInstrumentIds: [idOf(0), idOf(1), idOf(2)] });
    expect(report.notes).toContain('This report covers 3 of your 25 Indian mutual funds, as you chose. The others can go in a second report.');
  });
  it('a report of every fund held says nothing extra, and its manifest still records the coverage', () => {
    const { report, manifest } = buildFundAnalyticsReport(baseInput(schemes, all));
    expect(report.selection).toBeUndefined();
    expect(report.notes.join(' ')).not.toContain('as you chose');
    expect(manifest.selection).toMatchObject({ basis: 'all_held', heldFundCount: 3, max: CAP });
    // an input without any selection (older callers) is the same as all held
    expect(buildFundAnalyticsReport(baseInput(schemes)).manifest.selection).toMatchObject({ basis: 'all_held', heldFundCount: 3 });
  });
  it('a different choice is a different manifest checksum', () => {
    const a = buildFundAnalyticsReport({ ...baseInput(schemes, chosen), calculatedAt: '2026-10-07T00:00:00.000Z' }).manifest;
    const b = buildFundAnalyticsReport({ ...baseInput(schemes, { ...chosen, chosenInstrumentIds: [idOf(0), idOf(1), idOf(2)], heldFundCount: 26 }), calculatedAt: '2026-10-07T00:00:00.000Z' }).manifest;
    expect(manifestChecksum(a)).not.toBe(manifestChecksum(b));
  });
  it('a fund\'s cached figures do not depend on which other funds are in the report: the cache key is the same either way (one entry serves both reports)', () => {
    const base = baseInput(schemes, chosen);
    const other = baseInput([schemes[0]], all);
    expect(schemeBundleCacheKey(base, schemes[0])).toBe(schemeBundleCacheKey(other, schemes[0]));
  });
  it('the service stores the manifest with the choice', async () => {
    const load = vi.fn(async (_a: unknown) => ({ input: baseInput(schemes, chosen), warnings: [], riskFreeUnavailableReason: null }));
    const { db, call } = setup(load);
    expect((await call([idOf(0), idOf(1), idOf(2)])).status).toBe('ready');
    const row = db.tables.nav2_fund_analytics_reports[0] as { manifest_json: { selection: ReportSelection }; report_json: { selection?: { chosenCount: number } } };
    expect(row.manifest_json.selection.chosenInstrumentIds).toEqual([idOf(0), idOf(1), idOf(2)]);
    expect(row.report_json.selection?.chosenCount).toBe(3);
    expect(load.mock.calls[0][0]).toMatchObject({ selection: { max: CAP, chosen: [idOf(0), idOf(1), idOf(2)] } });
  });
});

describe('NC-F4: the time budget', () => {
  it('work that would not fit is not started: the funds that fit are cached, the answer is "in steps", no report is stored; the next generation finishes from the cache', async () => {
    const schemes = Array.from({ length: 4 }, (_, i) => scheme(i));
    const load = vi.fn(async () => ({ input: baseInput(schemes), warnings: [], riskFreeUnavailableReason: null }));
    // the reads used so much of the request that there is room for exactly 2 funds before the deadline minus the cache write; 4 are not cached
    const clock = vi.fn().mockReturnValueOnce(0).mockReturnValue(REQUEST_DEADLINE_MS - CACHE_WRITE_RESERVE_MS - 2 * ENGINE_MS_PER_UNCACHED_FUND - 100);
    const { db, call } = setup(load, { nowMs: clock });
    const first = await call();
    expect(first.status).toBe('in_steps');
    if (first.status === 'in_steps') {
      expect(first.ready).toBe(2);
      expect(first.total).toBe(4);
      expect(first.retryAfterSeconds).toBeGreaterThan(0);
      expect(first.message).toMatch(/prepared in steps \(2 of 4 funds ready\)/);
    }
    expect(db.tables.nav2_fund_analytics_reports).toHaveLength(0);
    expect(db.tables.nav2_result_cache).toHaveLength(2);
    // a fast second call (nothing spent before the build): the 2 cached funds are reused, the other 2 are computed, the report is stored
    const fast = vi.fn().mockReturnValue(0);
    const again = await generateFundAnalyticsReport({ userId: USER, sessionClient: db.client as never, adminClient: db.client as unknown as SupabaseClient, periodChoice: 'since_first_held', asOfDate: AS_OF, deps: { isFlagOn: async () => true, isPremium: async () => true, gate: async () => openGate, load, nowIso: () => '2026-10-02T06:00:00.000Z', nowMs: fast } });
    expect(again.status).toBe('ready');
    if (again.status === 'ready') expect(again.cache).toMatchObject({ hits: 2, computed: 2 });
    expect(db.tables.nav2_fund_analytics_reports).toHaveLength(1);
  }, 120_000);

  it('when no time is left at all nothing is computed, and the message still says to try again', async () => {
    const schemes = Array.from({ length: 2 }, (_, i) => scheme(i));
    const load = vi.fn(async () => ({ input: baseInput(schemes), warnings: [], riskFreeUnavailableReason: null }));
    const clock = vi.fn().mockReturnValueOnce(0).mockReturnValue(REQUEST_DEADLINE_MS);
    const { db, call } = setup(load, { nowMs: clock });
    const r = await call();
    expect(r).toMatchObject({ status: 'in_steps', ready: 0, total: 2 });
    expect(db.tables.nav2_result_cache).toHaveLength(0);
  });
});

describe('the route and the screen', () => {
  const route = readFileSync(path.join(__dirname, '..', '..', '..', 'app', 'api', 'reports', 'fund-analytics', 'route.ts'), 'utf8');
  const client = readFileSync(path.join(__dirname, '..', '..', '..', 'components', 'reports', 'FundAnalyticsReportClient.tsx'), 'utf8');
  it('the route takes the chosen funds as uuids and answers 409 with the choice, 422 for a bad choice, 202 + Retry-After while preparing in steps', () => {
    expect(route).toMatch(/funds: z\.array\(z\.string\(\)\.uuid\(\)\)/);
    expect(route).toMatch(/fundIds: parsed\.data\.funds/);
    expect(route).toMatch(/case 'select_funds':[\s\S]*?status: 409/);
    expect(route).toMatch(/case 'invalid_selection':\s*return bad\(result\.message, 422\)/);
    expect(route).toMatch(/case 'in_steps':[\s\S]*?status: 202[\s\S]*?'Retry-After'/);
  });
  it('the screen lists the funds with their values, ticks the largest by default, caps the ticks at the limit, and offers the rest for a second report', () => {
    expect(client).toContain('data-testid="fund-pick"');
    expect(client).toContain('<CheckField');
    expect(client).toMatch(/disabled=\{!on && pick\.chosen\.length >= pick\.max\}/);
    expect(client).toContain('suggestedIds');
    expect(client).toContain('Choose the other funds');
    expect(client).toMatch(/largest by current value are ticked/);
  });
});
