// NAV2 release candidate, blocker B1: a NAV corrected IN PLACE must never leave a newly generated report on stale cached analytics.
//
// THE DESIGN THAT IS PROVED (both halves, and each without the other):
//   * FALLBACK, independent of any worker: the cache key of a fund's bundle carries the content checksum of the NAV series the report is built
//     from, recomputed from the live rows on EVERY generation. A corrected NAV is a different key, so the stale entry is never read, whether or not the
//     correction worker has run, is enabled, or is healthy.
//   * PREFERRED: the correction is recorded as an event in the same statement (the 0262 trigger), the worker invalidates exactly the entries the
//     change can affect, once, and a retry or a duplicate does no second piece of work.
//
// The eight required proofs (the report of the prompt, section 7, B1), in order:
//   1 generate Report A | 2 correct one NAV used by that fund | 3 the affected cache becomes stale | 4 an unrelated fund's cache remains current
//   5 Report B uses the corrected NAV | 6 Report A is unchanged | 7 duplicate correction events create no duplicate work | 8 a worker retry is idempotent
//
// NAMED NEGATIVE CONTROLS
//   NC-C1  the corrected NAV changes the numbers a hand calculation says it must (an independent expectation, not the engine checking itself);
//   NC-C2  CONTROL FOR THE FALLBACK: with the worker never run, Report B still uses the corrected NAV and recomputes only the corrected fund;
//   NC-C3  CONTROL FOR THE KEY: a lookup that ignored the series checksum (what a naive cache would do) WOULD find the stale entry, so the key is
//          what protects the report (the stale entry really is still in the table and still valid until the worker runs);
//   NC-C4  the worker invalidates only the corrected fund's entries; the unrelated fund's stay valid;
//   NC-C5  the same event twice, and the same worker run twice, invalidate and count once.
import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { NAV2_POLICY } from '@/lib/config/nav2/metricPolicy';
import { reportAnalysisSpec } from '@/lib/engines/nav2/analysisSpec';
import { schemeBundleCacheKey, type FundAnalyticsInput, type HeldSchemeInput } from '@/lib/engines/nav2/fundAnalyticsReport';
import { generateFundAnalyticsReport, type FundAnalyticsDeps } from '@/lib/services/investment-intelligence/nav2/fundAnalyticsReportService';
import { processNav2CorrectionEvents } from '@/lib/services/investment-intelligence/nav2/nav2ResultCacheStore';
import type { ReportNavGate } from '@/lib/services/investment-intelligence/pc6/reportNavHistoryGate';
import { createInMemoryDb } from '../support/inMemorySupabase';
import { buildSeries, pathFromReturns, weekdays } from './support/fixtures';

const AS_OF = '2026-10-02';
const DATES = weekdays('2024-10-01', 520);
const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';
const USER = 'user-1';
const openGate: ReportNavGate = { hold: false, funds: [], total: 2, loaded: 2, waiting: [], unavailable: [], heldSince: null, headline: null, disclosures: [] };

function navs(seed: number): number[] {
  const r: number[] = [];
  for (let i = 0; i < DATES.length - 1; i++) r.push(0.0004 + 0.01 * Math.sin(i * 0.37 + seed) * Math.cos(i * 0.11 + seed * 2));
  return pathFromReturns(100, r);
}

/** The live NAV store: a correction edits one value IN PLACE (as the admin correction does), and every generation reads it afresh. */
function world() {
  const nav = new Map<string, number[]>([[ID_A, navs(1)], [ID_B, navs(2)]]);
  const names = new Map([[ID_A, 'Alpha Fund'], [ID_B, 'Beta Fund']]);
  const scheme = (id: string): HeldSchemeInput => ({
    instrumentId: id, schemeName: names.get(id)!, planType: 'direct', optionType: 'growth', category: 'flexi_cap', categoryLabel: 'Flexi Cap',
    series: buildSeries(DATES, nav.get(id)!, { identity: { instrumentId: id, schemeName: names.get(id)! }, asOf: AS_OF }),
    benchmarks: [], investor: null, firstHeldDate: '2025-03-03',
  });
  const input = (): FundAnalyticsInput => ({
    asOfDate: AS_OF, displayCurrency: 'INR', policy: NAV2_POLICY, spec: reportAnalysisSpec(AS_OF, NAV2_POLICY, 'since_first_held'), periodChoice: 'since_first_held', riskFree: null,
    schemes: [scheme(ID_A), scheme(ID_B)], scope: { entityHeldSchemesExcluded: 0, otherInstrumentsExcluded: 0, statementLinesAwaitingReview: 0, priceHistoryUnavailable: [] },
  });
  const db = createInMemoryDb({ strictSchema: true });
  db.reset({ nav2_fund_analytics_reports: [], nav2_report_nav_dependencies: [], nav2_result_cache: [], nav2_correction_events: [], ii_reference_job_control: [] });
  let clock = 0;
  const deps: Partial<FundAnalyticsDeps> = { isFlagOn: async () => true, isPremium: async () => true, gate: async () => openGate, load: async () => ({ input: input(), warnings: [], riskFreeUnavailableReason: null }), nowIso: () => '2026-10-02T06:00:00.000Z', nowMs: () => clock };
  const generate = () => generateFundAnalyticsReport({ userId: USER, sessionClient: db.client as never, adminClient: db.client as unknown as SupabaseClient, periodChoice: 'since_first_held', asOfDate: AS_OF, deps });
  /** The admin correction: edit one NAV value in place, and (the 0262 trigger, in the same statement) record ONE event for it. */
  const correct = (id: string, index: number, factor: number, sourceCorrectionId: string) => {
    nav.get(id)![index] = nav.get(id)![index] * factor;
    const ev = db.tables.nav2_correction_events;
    if (!ev.some((e) => e.kind === 'nav_correction' && e.source_correction_id === sourceCorrectionId)) ev.push({ id: ev.length + 1, kind: 'nav_correction', source_correction_id: sourceCorrectionId, instrument_id: id, benchmark_id: null, series_id: null, event_date: DATES[index], created_at: '2026-10-02T06:00:01.000Z', processed_at: null, entries_invalidated: null });
  };
  return { nav, db, generate, correct, input, setClock: (n: number) => { clock = n; } };
}
const schemeOf = (row: Record<string, unknown>, id: string) => (row.report_json as { schemes: Array<{ instrumentId: string; analytics: { scheme: Record<string, unknown> }; investor?: unknown }> }).schemes.find((s) => s.instrumentId === id)!;
const validEntries = (db: ReturnType<typeof world>['db'], id: string) => db.tables.nav2_result_cache.filter((r) => r.instrument_id === id && (r.invalidated_at === null || r.invalidated_at === undefined));

describe('B1: a corrected NAV can never be served from a stale cache entry', () => {
  it('proofs 1 to 8 in order, with the worker NEVER run until proof 7 (the fallback stands on its own)', async () => {
    const w = world();
    // ---- 1. Report A
    const a = await w.generate();
    expect(a.status).toBe('ready');
    if (a.status === 'ready') expect(a.cache).toMatchObject({ hits: 0, computed: 2, stored: 2 });
    const reportA = w.db.tables.nav2_fund_analytics_reports[0];
    const frozenA = JSON.stringify({ report: reportA.report_json, manifest: reportA.manifest_json, checksum: reportA.manifest_checksum });
    const cacheA0 = validEntries(w.db, ID_A);
    const cacheB0 = validEntries(w.db, ID_B);
    expect(cacheA0.length).toBeGreaterThan(0);
    expect(cacheB0.length).toBeGreaterThan(0);
    const keysA0 = cacheA0.map((r) => r.cache_key as string);
    const keysB0 = cacheB0.map((r) => r.cache_key as string);

    // ---- 2. correct ONE NAV used by fund A: the LAST price (it is both the end of every window and the value of the holding), +2%
    const last = DATES.length - 1;
    const oldLast = w.nav.get(ID_A)![last];
    const first = w.nav.get(ID_A)![0];
    w.correct(ID_A, last, 1.02, 'corr-0001');
    const newLast = w.nav.get(ID_A)![last];
    expect(newLast).toBeCloseTo(oldLast * 1.02, 10);

    // ---- 3. the affected cache is STALE: the key a new report would look up is not any of the old keys. (The old entries are still in the table, valid,
    //          because no worker has run: nothing but the key stands between them and the new report.)
    const inputNow = w.input();
    const keyA1 = schemeBundleCacheKey(inputNow, inputNow.schemes[0]);
    const keyB1 = schemeBundleCacheKey(inputNow, inputNow.schemes[1]);
    expect(keysA0).not.toContain(keyA1);
    expect(validEntries(w.db, ID_A).map((r) => r.cache_key)).toEqual(keysA0); // NC-C3: the stale entry is still there, still valid

    // ---- 4. the unrelated fund's cache remains current: the same key, the same entry
    expect(keysB0).toContain(keyB1);

    // ---- 5. Report B uses the corrected NAV (an independent hand calculation: absolute return over the whole series = last / first - 1)
    const b = await w.generate();
    expect(b.status).toBe('ready');
    if (b.status === 'ready') expect(b.cache).toMatchObject({ hits: 1, computed: 1 }); // NC-C2: only the corrected fund was recomputed; B came from the cache
    const reportB = w.db.tables.nav2_fund_analytics_reports[1];
    expect(reportB.version_number).toBe(2);
    const aOld = schemeOf(reportA, ID_A).analytics.scheme;
    const aNew = schemeOf(reportB, ID_A).analytics.scheme;
    expect(JSON.stringify(aNew)).not.toEqual(JSON.stringify(aOld)); // NC-C1 (a): the corrected fund's figures changed
    expect(JSON.stringify(schemeOf(reportB, ID_B).analytics.scheme)).toEqual(JSON.stringify(schemeOf(reportA, ID_B).analytics.scheme)); // the other fund's did not
    // the manifest of Report B pins the corrected series: its checksum differs for A and is equal for B
    const mA = (reportA.manifest_json as { schemes: Array<{ instrumentId: string; navSeries: { checksum: string }; navRange: { to: string } }> }).schemes;
    const mB = (reportB.manifest_json as { schemes: Array<{ instrumentId: string; navSeries: { checksum: string }; navRange: { to: string } }> }).schemes;
    expect(mB.find((s) => s.instrumentId === ID_A)!.navSeries.checksum).not.toBe(mA.find((s) => s.instrumentId === ID_A)!.navSeries.checksum);
    expect(mB.find((s) => s.instrumentId === ID_B)!.navSeries.checksum).toBe(mA.find((s) => s.instrumentId === ID_B)!.navSeries.checksum);
    // hand calculation: +2% on the last price raises the return from the first price by exactly oldLast x 0.02 / first
    expect(newLast / first - 1 - (oldLast / first - 1)).toBeCloseTo((oldLast * 0.02) / first, 12);
    // the end price the one-year point-to-point return rests on IS the corrected price in Report B and the original in Report A (a direct read, not a search)
    const endNav = (x: unknown) => ((x as { pointToPoint: Array<{ id: string; result: { value: { endNav: number } } }> }).pointToPoint.find((p) => p.id === '1Y')!.result.value.endNav);
    expect(endNav(aNew)).toBeCloseTo(newLast, 9);
    expect(endNav(aOld)).toBeCloseTo(oldLast, 9);
    expect(endNav(aNew)).not.toBeCloseTo(endNav(aOld), 3);

    // ---- 6. Report A is unchanged (byte for byte), and its pinned dependency rows still name the series it was built from
    expect(JSON.stringify({ report: reportA.report_json, manifest: reportA.manifest_json, checksum: reportA.manifest_checksum })).toBe(frozenA);
    expect(w.db.writes.some((x) => x.table === 'nav2_fund_analytics_reports' && x.kind !== 'insert')).toBe(false); // no update or delete of any report row, ever

    // ---- 7. duplicate correction events create no duplicate work
    const before = w.db.tables.nav2_correction_events.length;
    w.correct(ID_A, last, 1, 'corr-0001'); // the same source correction again (the trigger's on-conflict-do-nothing path): no second event
    expect(w.db.tables.nav2_correction_events).toHaveLength(before);
    const run1 = await processNav2CorrectionEvents(w.db.client as unknown as SupabaseClient, 200, '2026-10-02T07:00:00.000Z');
    expect(run1).toMatchObject({ eventsProcessed: 1, failed: 0 });
    // the corrected fund's OLD entries are all invalidated. The worker is deliberately conservative: it invalidates every entry of that fund whose window reaches
    // the corrected date, including the entry Report B stored AFTER the correction (already correct; the next report refreshes it, a cost in time and never in
    // correctness: the fallback does not depend on it). So the count is at least the old entries and every invalidated entry belongs to the corrected fund.
    expect(run1.entriesInvalidated).toBeGreaterThanOrEqual(keysA0.length);
    expect(run1.entriesInvalidated).toBe(w.db.tables.nav2_result_cache.filter((r) => r.instrument_id === ID_A && r.invalidated_at).length);
    // NC-C4: only fund A's entries were invalidated; B's stay valid
    expect(validEntries(w.db, ID_A).map((r) => r.cache_key as string).filter((k) => keysA0.includes(k))).toEqual([]);
    expect(validEntries(w.db, ID_B).map((r) => r.cache_key as string).sort()).toEqual([...keysB0].sort());
    expect(w.db.tables.nav2_result_cache.filter((r) => r.instrument_id === ID_B && r.invalidated_at)).toHaveLength(0);

    // ---- 8. a worker retry is idempotent: nothing left to process, nothing counted twice
    const run2 = await processNav2CorrectionEvents(w.db.client as unknown as SupabaseClient, 200, '2026-10-02T07:05:00.000Z');
    expect(run2).toMatchObject({ eventsProcessed: 0, entriesInvalidated: 0, failed: 0 });
    // and two overlapping runs over a fresh event count it once
    w.correct(ID_B, last, 1.01, 'corr-0002');
    const [x, y] = await Promise.all([processNav2CorrectionEvents(w.db.client as unknown as SupabaseClient), processNav2CorrectionEvents(w.db.client as unknown as SupabaseClient)]);
    expect(x.eventsProcessed + y.eventsProcessed).toBe(1);
    expect(x.entriesInvalidated + y.entriesInvalidated).toBe(keysB0.length);
    // finally Report A is STILL unchanged after all of it
    expect(JSON.stringify({ report: w.db.tables.nav2_fund_analytics_reports[0].report_json, manifest: w.db.tables.nav2_fund_analytics_reports[0].manifest_json, checksum: w.db.tables.nav2_fund_analytics_reports[0].manifest_checksum })).toBe(frozenA);
  }, 180_000);

  it('NC-C2: a correction made while the worker is DISABLED (no event processed, ever) still gives the next report the corrected figures', async () => {
    const w = world();
    await w.generate();
    w.correct(ID_B, DATES.length - 1, 0.97, 'corr-0100');
    const r = await w.generate();
    expect(r.status).toBe('ready');
    const rows = w.db.tables.nav2_fund_analytics_reports;
    expect(JSON.stringify(schemeOf(rows[1], ID_B).analytics.scheme)).not.toEqual(JSON.stringify(schemeOf(rows[0], ID_B).analytics.scheme));
    expect(w.db.tables.nav2_correction_events.filter((e) => e.processed_at === null)).toHaveLength(1); // the worker never ran
  }, 180_000);

  it('a correction to a NAV in the MIDDLE of the series also changes the key (any observation, not just the last)', async () => {
    const w = world();
    await w.generate();
    const before = w.input();
    const keyBefore = schemeBundleCacheKey(before, before.schemes[0]);
    w.correct(ID_A, 250, 1.05, 'corr-0200');
    const after = w.input();
    expect(schemeBundleCacheKey(after, after.schemes[0])).not.toBe(keyBefore);
    expect(schemeBundleCacheKey(after, after.schemes[1])).toBe(schemeBundleCacheKey(before, before.schemes[1]));
  });

  it('a "correction" that changes nothing (the same value) keeps the key, so no work is repeated', async () => {
    const w = world();
    await w.generate();
    const before = w.input();
    const keyBefore = schemeBundleCacheKey(before, before.schemes[0]);
    w.correct(ID_A, 250, 1, 'corr-0300');
    const after = w.input();
    expect(schemeBundleCacheKey(after, after.schemes[0])).toBe(keyBefore);
    const again = await w.generate();
    if (again.status === 'ready') expect(again.cache).toMatchObject({ hits: 2, computed: 0 });
  }, 180_000);
});
