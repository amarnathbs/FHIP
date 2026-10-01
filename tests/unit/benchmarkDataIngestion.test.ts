// BENCH-1 Phase 2 - recurring ingestion, watermarks, leases, kill switches, calendar, pending imports and demand.
// J/L Scheduling: disabled source, kill switches, lease expiry, overlapping jobs, late publication, empty-200,
// rate limit, authentication failure, outage recovery, correction lookback, accurate watermarks.
// Every fake below is SYNTHETIC; nothing here contacts any source.
import { describe, it, expect, vi } from 'vitest';
import { runBenchmarkIngestion, planWindow, DAILY_RETRY_BUDGET, CORRECTION_LOOKBACK_DAYS, type AdapterOutcome, type AttemptRecord, type BenchmarkFeedAdapter, type IngestionStateRow, type OrchestratorDeps } from '@/lib/services/investment-intelligence/benchmarkData/ingestion/orchestrator';
import { assessCompleteness, expectedLatestSession, findGapRuns, latestWeekdayOnOrBefore, weekdaysAfter } from '@/lib/services/investment-intelligence/benchmarkData/ingestion/calendar';
import { assessPendingImport } from '@/lib/services/investment-intelligence/benchmarkData/ingestion/pending';
import { aggregateBenchmarkDemand, schemeFamilyKey, type DemandInstrument } from '@/lib/services/investment-intelligence/benchmarkData/demand';
import { environmentMatches, projectRefFromUrl } from '@/lib/services/investment-intelligence/benchmarkData/ingestion/liveDeps';
import type { EntitlementRecord } from '@/lib/services/investment-intelligence/benchmarkData/entitlements';
import { BENCHMARK_FEED_ADAPTERS } from '@/lib/services/investment-intelligence/benchmarkData/ingestion/adapters';

const NOW = '2026-10-01T10:00:00.000Z'; // Thursday
const EXPECTED = '2026-09-30'; // Wednesday (lag 1)

function state(o: Partial<IngestionStateRow> = {}): IngestionStateRow {
  return { benchmarkId: 'b1', benchmarkKey: 'IN_TEST_TRI', ingestionMode: 'automated', adapterId: 'fx', automationEnabled: true, publicationLagDays: 1, latestValidDataDate: '2026-09-29', completenessWatermark: '2026-09-29', consecutiveFailures: 0, nextAttemptNotBefore: null, retriesUsedInWindow: 0, retryWindowDate: null, returnVariant: 'total_return', currencyCode: 'INR', ...o };
}
const ent = (o: Partial<EntitlementRecord> = {}): EntitlementRecord => ({ id: 'e1', benchmarkId: 'b1', kind: 'commercial_licence', status: 'approved', returnVariant: 'total_return', currencyCode: 'INR', allowManualIngest: true, allowAutomation: true, allowStorage: true, allowCalculation: true, allowCustomerDisplay: true, allowReportExport: false, dataFrom: null, dataTo: null, validFrom: '2020-01-01', validTo: '2099-12-31', postExpiryStorage: 'retain', postExpiryCalculation: false, postExpiryDisplay: false, ...o });

/** every weekday from 2026-09-01 to the given date (stored levels) */
function stored(through: string, from = '2026-09-01'): Map<string, number> {
  const m = new Map<string, number>();
  for (let d = Date.parse(`${from}T00:00:00Z`); d <= Date.parse(`${through}T00:00:00Z`); d += 86400000) {
    const iso = new Date(d).toISOString().slice(0, 10);
    const dow = new Date(d).getUTCDay();
    if (dow !== 0 && dow !== 6) m.set(iso, 1000 + m.size);
  }
  return m;
}

interface Harness {
  deps: OrchestratorDeps;
  attempts: Array<{ rec: AttemptRecord; skip: boolean }>;
  writes: Array<{ rows: Array<{ date: string; value: number }>; host: string }>;
  fetches: Array<{ from: string; to: string }>;
  sleeps: number[];
  leaseCalls: string[];
}
function harness(opts: { states?: IngestionStateRow[]; global?: boolean; write?: boolean; entitlements?: EntitlementRecord[]; storedThrough?: string; outcome?: AdapterOutcome; leaseFree?: boolean; adapters?: Map<string, BenchmarkFeedAdapter>; storedDates?: Map<string, number> } = {}): Harness {
  const h: Harness = { deps: undefined as never, attempts: [], writes: [], fetches: [], sleeps: [], leaseCalls: [] };
  let storedNow = opts.storedDates ?? stored(opts.storedThrough ?? '2026-09-29');
  const adapter: BenchmarkFeedAdapter = {
    id: 'fx', sourceHost: 'feed.example.test', minIntervalMs: 2500, maxRequestsPerRun: 5,
    fetchRange: async (a) => { h.fetches.push({ from: a.from, to: a.to }); return opts.outcome ?? { kind: 'ok', rows: [{ date: '2026-09-30', value: 1100 }], httpStatus: 200 }; },
  };
  h.deps = {
    nowIso: NOW, holderId: 'runner-1', sleep: async (ms) => { h.sleeps.push(ms); },
    adapters: opts.adapters ?? new Map([['fx', adapter]]),
    isGlobalEnabled: async () => opts.global ?? true,
    isWriteEnabled: async () => opts.write ?? true,
    loadStates: async () => opts.states ?? [state()],
    loadEntitlements: async (id) => (opts.entitlements ?? [ent()]).map((e) => ({ ...e, benchmarkId: id })),
    claimLease: async (id, holder) => { h.leaseCalls.push(`claim:${id}:${holder}`); return opts.leaseFree ?? true; },
    releaseLease: async (id, holder) => { h.leaseCalls.push(`release:${id}:${holder}`); },
    loadStoredDates: async () => storedNow,
    loadDemandFloor: async () => '2026-09-01',
    writeRows: async (_id, rows, host) => { h.writes.push({ rows, host }); for (const r of rows) storedNow = new Map(storedNow).set(r.date, r.value); return { inserted: rows.length, identical: 0, conflicts: 0, error: null }; },
    recordAttempt: async (_id, rec, skip) => { h.attempts.push({ rec, skip }); },
  };
  return h;
}
const lastStatus = (h: Harness) => h.attempts[h.attempts.length - 1].rec.status;

describe('J gates: nothing is fetched or written unless EVERY gate holds', () => {
  it('the adapter registry ships EMPTY (no source has a verified automation right)', () => {
    expect(BENCHMARK_FEED_ADAPTERS.size).toBe(0);
  });
  it('global kill switch OFF: no entitlement read, no lease, no fetch, no write, no attempt recorded', async () => {
    const h = harness({ global: false });
    const spy = vi.spyOn(h.deps, 'loadEntitlements');
    const r = await runBenchmarkIngestion(h.deps, { runKind: 'daily' });
    expect(r.status).toBe('disabled_global');
    expect(spy).not.toHaveBeenCalled();
    expect(h.fetches).toEqual([]);
    expect(h.writes).toEqual([]);
    expect(h.attempts).toEqual([]);
    expect(h.leaseCalls).toEqual([]);
  });
  it('manual_import / disabled benchmarks are skipped as source-disabled without any request (and a skip is not an attempt)', async () => {
    for (const ingestionMode of ['manual_import', 'disabled'] as const) {
      const h = harness({ states: [state({ ingestionMode })] });
      await runBenchmarkIngestion(h.deps, { runKind: 'daily' });
      expect(h.fetches).toEqual([]);
      expect(lastStatus(h)).toBe('skipped_source_disabled');
      expect(h.attempts[0].skip).toBe(true);
    }
  });
  it('the per-benchmark SOURCE switch (automation_enabled=false) stops the run even in automated mode', async () => {
    const h = harness({ states: [state({ automationEnabled: false })] });
    await runBenchmarkIngestion(h.deps, { runKind: 'daily' });
    expect(h.fetches).toEqual([]);
    expect(lastStatus(h)).toBe('skipped_source_disabled');
  });
  it('NO automation entitlement (a manual-ingest licence only): skipped_not_entitled, no lease, no fetch', async () => {
    const h = harness({ entitlements: [ent({ allowAutomation: false })] });
    const r = await runBenchmarkIngestion(h.deps, { runKind: 'daily' });
    expect(lastStatus(h)).toBe('skipped_not_entitled');
    expect(h.fetches).toEqual([]);
    expect(h.leaseCalls).toEqual([]);
    expect(r.alerts.some((a) => a.code === 'NOT_ENTITLED')).toBe(true);
  });
  it('entitlement revoked / expired / wrong variant: skipped_not_entitled', async () => {
    for (const e of [ent({ status: 'revoked' }), ent({ validTo: '2026-01-01', postExpiryStorage: 'delete' }), ent({ returnVariant: 'price' })]) {
      const h = harness({ entitlements: [e] });
      await runBenchmarkIngestion(h.deps, { runKind: 'daily' });
      expect(lastStatus(h)).toBe('skipped_not_entitled');
      expect(h.fetches).toEqual([]);
    }
  });
  it('backoff window active: skipped_backoff; expired backoff runs', async () => {
    let h = harness({ states: [state({ nextAttemptNotBefore: '2026-10-01T12:00:00.000Z' })] });
    await runBenchmarkIngestion(h.deps, { runKind: 'daily' });
    expect(lastStatus(h)).toBe('skipped_backoff');
    expect(h.fetches).toEqual([]);
    h = harness({ states: [state({ nextAttemptNotBefore: '2026-10-01T09:00:00.000Z' })] });
    await runBenchmarkIngestion(h.deps, { runKind: 'daily' });
    expect(h.fetches.length).toBe(1);
  });
  it('overlapping jobs: when the lease is held by another runner nothing is fetched (single-flight)', async () => {
    const h = harness({ leaseFree: false });
    await runBenchmarkIngestion(h.deps, { runKind: 'daily' });
    expect(lastStatus(h)).toBe('skipped_lease');
    expect(h.fetches).toEqual([]);
  });
  it('the lease is ALWAYS released, even when the adapter throws', async () => {
    const h = harness();
    h.deps.adapters = new Map([['fx', { id: 'fx', sourceHost: 'x', minIntervalMs: 0, maxRequestsPerRun: 1, fetchRange: async () => { throw new Error('boom'); } }]]);
    await expect(runBenchmarkIngestion(h.deps, { runKind: 'daily' })).rejects.toThrow('boom');
    expect(h.leaseCalls).toEqual(['claim:b1:runner-1', 'release:b1:runner-1']);
  });
  it('an unregistered adapter id is skipped, never guessed', async () => {
    const h = harness({ adapters: new Map() });
    await runBenchmarkIngestion(h.deps, { runKind: 'daily' });
    expect(lastStatus(h)).toBe('skipped_source_disabled');
  });
  it('WRITE kill switch OFF: the source is fetched and validated but NOTHING is written (dry_run, not success)', async () => {
    const h = harness({ write: false });
    await runBenchmarkIngestion(h.deps, { runKind: 'daily' });
    expect(h.fetches.length).toBe(1);
    expect(h.writes).toEqual([]);
    expect(lastStatus(h)).toBe('dry_run');
    expect(h.attempts[0].rec.success).toBe(false);
  });
});

describe('J success is honest', () => {
  it('a normal run writes the new session and records success + an advanced watermark', async () => {
    const h = harness();
    const r = await runBenchmarkIngestion(h.deps, { runKind: 'daily' });
    expect(r.results[0]).toMatchObject({ status: 'succeeded', success: true, rowsInserted: 1 });
    expect(h.writes[0].host).toBe('feed.example.test');
    expect(h.attempts[0].rec.completenessWatermark).toBe('2026-09-30');
    expect(h.attempts[0].rec.errorCode).toBeNull();
  });
  it('HTTP 200 with NO expected data is NOT success while coverage is behind (empty_response, failure counted, backoff set)', async () => {
    const h = harness({ outcome: { kind: 'empty', httpStatus: 200 } });
    await runBenchmarkIngestion(h.deps, { runKind: 'daily' });
    const rec = h.attempts[0].rec;
    expect(rec.status).toBe('empty_response');
    expect(rec.success).toBe(false);
    expect(rec.httpStatus).toBe(200);
    expect(rec.nextAttemptNotBefore).not.toBeNull();
  });
  it('a no-row run IS successful only when coverage is independently already complete through the expected session', async () => {
    const h = harness({ states: [state({ latestValidDataDate: '2026-09-30' })], storedThrough: '2026-09-30', outcome: { kind: 'empty', httpStatus: 200 } });
    await runBenchmarkIngestion(h.deps, { runKind: 'daily' });
    expect(lastStatus(h)).toBe('complete_no_new_data');
    expect(h.attempts[0].rec.success).toBe(true);
  });
  it('blocked (403/captcha): STOP - the run records blocked, makes one request and skips later benchmarks', async () => {
    const h = harness({ states: [state(), state({ benchmarkId: 'b2', benchmarkKey: 'IN_TEST2_TRI' })], outcome: { kind: 'blocked', httpStatus: 403, detail: 'forbidden' } });
    const r = await runBenchmarkIngestion(h.deps, { runKind: 'daily' });
    expect(h.fetches.length).toBe(1);
    expect(r.results[0].status).toBe('blocked');
    expect(r.results[1].status).toBe('skipped_source_disabled');
    expect(r.alerts.some((a) => a.severity === 'critical' && a.code === 'INGEST_BLOCKED')).toBe(true);
  });
  it('authentication failure: failed with AUTH_FAILED, no retry, later benchmarks not probed', async () => {
    const h = harness({ states: [state(), state({ benchmarkId: 'b2', benchmarkKey: 'B2' })], outcome: { kind: 'auth_failed', httpStatus: 401, detail: 'bad key' } });
    await runBenchmarkIngestion(h.deps, { runKind: 'daily' });
    expect(h.attempts[0].rec).toMatchObject({ status: 'failed', errorCode: 'AUTH_FAILED', httpStatus: 401, success: false });
    expect(h.fetches.length).toBe(1);
  });
  it('rate limit (429): failed, no retry in this run, next attempt honours Retry-After (>= 60s)', async () => {
    const h = harness({ outcome: { kind: 'rate_limited', httpStatus: 429, retryAfterSeconds: 1800 } });
    await runBenchmarkIngestion(h.deps, { runKind: 'daily' });
    const rec = h.attempts[0].rec;
    expect(rec.errorCode).toBe('RATE_LIMITED');
    expect(Date.parse(rec.nextAttemptNotBefore as string) - Date.parse(NOW)).toBe(1800 * 1000);
    expect(h.fetches.length).toBe(1);
  });
  it('outage: failed with exponential backoff that grows with consecutive failures; recovery clears it', async () => {
    const h1 = harness({ outcome: { kind: 'outage', detail: 'HTTP 503' }, states: [state({ consecutiveFailures: 0 })] });
    const h4 = harness({ outcome: { kind: 'outage', detail: 'HTTP 503' }, states: [state({ consecutiveFailures: 3 })] });
    await runBenchmarkIngestion(h1.deps, { runKind: 'daily' });
    await runBenchmarkIngestion(h4.deps, { runKind: 'daily' });
    expect(Date.parse(h4.attempts[0].rec.nextAttemptNotBefore as string)).toBeGreaterThan(Date.parse(h1.attempts[0].rec.nextAttemptNotBefore as string));
    const ok = harness({ states: [state({ consecutiveFailures: 3, nextAttemptNotBefore: null })] });
    await runBenchmarkIngestion(ok.deps, { runKind: 'daily' });
    expect(ok.attempts[0].rec).toMatchObject({ success: true, nextAttemptNotBefore: null });
  });
  it('implausible rows (>25% spike) and invalid rows are never written; the run is partial, not success, and a critical alert is raised', async () => {
    const h = harness({ outcome: { kind: 'ok', rows: [{ date: '2026-09-30', value: 5000 }, { date: '2026-09-29', value: -1 }], httpStatus: 200 } });
    const r = await runBenchmarkIngestion(h.deps, { runKind: 'daily' });
    expect(h.writes).toEqual([]);
    expect(r.alerts.some((a) => a.code === 'FEED_OUTLIER_REJECTED' && a.severity === 'critical')).toBe(true);
    expect(h.attempts[0].rec.success).toBe(false);
  });
  it('a database write refusal is a failure with WRITE_FAILED (not success)', async () => {
    const h = harness();
    h.deps.writeRows = async () => ({ inserted: 0, identical: 0, conflicts: 0, error: 'refused' });
    await runBenchmarkIngestion(h.deps, { runKind: 'daily' });
    expect(h.attempts[0].rec).toMatchObject({ status: 'failed', errorCode: 'WRITE_FAILED', success: false });
  });
  it('a conflicting stored value is reported (warning) and left unchanged for a correction job', async () => {
    const h = harness();
    h.deps.writeRows = async () => ({ inserted: 0, identical: 0, conflicts: 1, error: null });
    const r = await runBenchmarkIngestion(h.deps, { runKind: 'daily' });
    expect(r.alerts.some((a) => a.code === 'FEED_VALUE_CONFLICT')).toBe(true);
  });
  it('late publication: the daily retry budget is bounded (late_retry is skipped once the budget is spent)', async () => {
    const h = harness({ states: [state({ retriesUsedInWindow: DAILY_RETRY_BUDGET, retryWindowDate: '2026-10-01' })] });
    await runBenchmarkIngestion(h.deps, { runKind: 'late_retry' });
    expect(lastStatus(h)).toBe('skipped_backoff');
    expect(h.fetches).toEqual([]);
    const fresh = harness({ states: [state({ retriesUsedInWindow: DAILY_RETRY_BUDGET, retryWindowDate: '2026-09-30' })] });
    await runBenchmarkIngestion(fresh.deps, { runKind: 'late_retry' });
    expect(fresh.fetches.length).toBe(1);
  });
  it('provider rate limit: a sleep of minIntervalMs separates REAL requests across benchmarks, and none before the first', async () => {
    const h = harness({ states: [state(), state({ benchmarkId: 'b2', benchmarkKey: 'B2' })] });
    await runBenchmarkIngestion(h.deps, { runKind: 'daily' });
    expect(h.fetches.length).toBe(2);
    expect(h.sleeps).toEqual([2500]);
  });
  it('bounded batch: at most MAX_BENCHMARKS_PER_RUN benchmarks per invocation', async () => {
    const many = Array.from({ length: 25 }, (_, i) => state({ benchmarkId: `b${i}`, benchmarkKey: `K${i}` }));
    const h = harness({ states: many });
    const r = await runBenchmarkIngestion(h.deps, { runKind: 'daily' });
    expect(r.results.length).toBe(10);
  });
});

describe('J windows: correction lookback, gap detection, resumable bounded history expansion', () => {
  it('daily asks for the last stored date minus the correction lookback up to the expected session', () => {
    const w = planWindow('daily', { latestValidDataDate: '2026-09-29', completenessWatermark: null }, EXPECTED, '2026-09-01', '2026-09-01', new Set(), undefined);
    expect(w).toEqual({ from: '2026-09-24', to: EXPECTED });
    expect(CORRECTION_LOOKBACK_DAYS).toBe(5);
  });
  it('weekly_gap targets the FIRST gap run; null when coverage is complete', () => {
    const have = stored('2026-09-30');
    have.delete('2026-09-10'); have.delete('2026-09-11'); have.delete('2026-09-14');
    expect(planWindow('weekly_gap', { latestValidDataDate: '2026-09-30', completenessWatermark: null }, EXPECTED, '2026-09-01', '2026-09-01', new Set(have.keys()), undefined)).toEqual({ from: '2026-09-10', to: '2026-09-14' });
    expect(planWindow('weekly_gap', { latestValidDataDate: '2026-09-30', completenessWatermark: null }, EXPECTED, '2026-09-01', '2026-09-01', new Set(stored('2026-09-30').keys()), undefined)).toBeNull();
  });
  it('history_expansion walks NEWEST-first in bounded (<= 366 day) chunks toward the demand floor and stops when covered', () => {
    const w = planWindow('history_expansion', { latestValidDataDate: '2026-09-30', completenessWatermark: null }, EXPECTED, '2006-03-24', '2024-06-03', new Set(), undefined);
    expect(w?.to).toBe('2024-06-02');
    expect(Date.parse(`${w?.to}T00:00:00Z`) - Date.parse(`${w?.from}T00:00:00Z`)).toBeLessThanOrEqual(365 * 86400000);
    expect(planWindow('history_expansion', { latestValidDataDate: '2026-09-30', completenessWatermark: null }, EXPECTED, '2024-06-03', '2024-06-03', new Set(), undefined)).toBeNull();
  });
  it('monthly_reconcile looks back 35 days; the feed write path reports (never applies) differences', () => {
    expect(planWindow('monthly_reconcile', { latestValidDataDate: null, completenessWatermark: null }, EXPECTED, null, null, new Set(), undefined)).toEqual({ from: '2026-08-26', to: EXPECTED });
  });
});

describe('watermarks and the calendar', () => {
  it('expected latest session: lag-aware and weekday-snapped (Saturday/Sunday roll back to Friday)', () => {
    expect(expectedLatestSession('2026-10-01T10:00:00Z', 1)).toBe('2026-09-30');
    expect(expectedLatestSession('2026-10-05T10:00:00Z', 1)).toBe('2026-10-02'); // Monday - 1 day = Sunday -> Friday
    expect(latestWeekdayOnOrBefore('2026-10-04')).toBe('2026-10-02');
    expect(expectedLatestSession('2026-10-01T10:00:00Z', 1, new Set(['2026-09-30']))).toBe('2026-09-29');
  });
  it('completeness: full coverage -> watermark = last date; a short gap (<= 3 weekdays) is tolerated and disclosed; a long gap stops the watermark before it', () => {
    const full = stored('2026-09-30');
    expect(assessCompleteness(new Set(full.keys()), '2026-09-01', '2026-09-30').watermark).toBe('2026-09-30');
    const short = new Set(full.keys()); short.delete('2026-09-10'); short.delete('2026-09-11');
    const a = assessCompleteness(short, '2026-09-01', '2026-09-30');
    expect(a.watermark).toBe('2026-09-30');
    expect(a.toleratedGaps).toEqual([{ from: '2026-09-10', to: '2026-09-11', weekdaysMissing: 2 }]);
    const long = new Set(full.keys()); for (const d of ['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18']) long.delete(d);
    const b = assessCompleteness(long, '2026-09-01', '2026-09-30');
    expect(b.watermark).toBe('2026-09-11');
    expect(b.firstIntolerableGap).toEqual({ from: '2026-09-14', to: '2026-09-18', weekdaysMissing: 5 });
  });
  it('a leading gap (history missing at the start) or no data at all gives a NULL watermark (never a claim of coverage)', () => {
    const full = stored('2026-09-30', '2026-09-22');
    expect(assessCompleteness(new Set(full.keys()), '2026-09-01', '2026-09-30').watermark).toBeNull();
    expect(assessCompleteness(new Set(), '2026-09-01', '2026-09-30').watermark).toBeNull();
  });
  it('an operator holiday set removes those days from "missing"', () => {
    const have = stored('2026-09-30'); have.delete('2026-09-10'); have.delete('2026-09-11'); have.delete('2026-09-14'); have.delete('2026-09-15');
    const withHolidays = assessCompleteness(new Set(have.keys()), '2026-09-01', '2026-09-30', { holidays: new Set(['2026-09-10', '2026-09-11', '2026-09-14', '2026-09-15']) });
    expect(withHolidays.toleratedGaps).toEqual([]);
    expect(findGapRuns(new Set(have.keys()), '2026-09-01', '2026-09-30')[0].weekdaysMissing).toBe(4);
    expect(weekdaysAfter('2026-09-29', '2026-10-01')).toBe(2);
  });
});

describe('manual-import mode: pending-import task (never described as automatic)', () => {
  const base = { benchmarkKey: 'IN_X_TRI', benchmarkLabel: 'X TRI', ingestionMode: 'manual_import' as const, publicationLagDays: 1, requiredFrom: '2026-09-01' };
  it('never imported => never_imported (critical when demand exists), with an upload instruction that says manual', () => {
    const t = assessPendingImport({ ...base, latestValidDataDate: null }, NOW);
    expect(t.status).toBe('never_imported');
    expect(t.severity).toBe('critical');
    expect(t.action).toMatch(/manual import, not an automatic update/);
  });
  it('current / due / overdue by weekdays behind the expected session', () => {
    expect(assessPendingImport({ ...base, latestValidDataDate: '2026-09-30' }, NOW).status).toBe('current');
    expect(assessPendingImport({ ...base, latestValidDataDate: '2026-09-28' }, NOW).status).toBe('due');
    const overdue = assessPendingImport({ ...base, latestValidDataDate: '2026-09-18' }, NOW);
    expect(overdue.status).toBe('overdue');
    expect(overdue.severity).toBe('critical');
    expect(overdue.weekdaysBehind).toBe(8);
    expect(overdue.action).toMatch(/nothing updates automatically/);
  });
  it('history missing at the start makes an otherwise current benchmark DUE', () => {
    const have = stored('2026-09-30', '2026-09-22');
    const t = assessPendingImport({ ...base, latestValidDataDate: '2026-09-30', storedDates: new Set(have.keys()) }, NOW);
    expect(t.status).toBe('due');
    expect(t.historyMissingFrom).toBe('2026-09-01');
  });
  it('automated / disabled benchmarks are not manual tasks', () => {
    expect(assessPendingImport({ ...base, ingestionMode: 'automated', latestValidDataDate: null }, NOW).status).toBe('not_manual');
    expect(assessPendingImport({ ...base, ingestionMode: 'disabled', latestValidDataDate: null }, NOW).action).toMatch(/disabled/);
  });
});

describe('I selective-history demand: aggregated by exact benchmark, mapping-bounded, no full-universe backfill', () => {
  const inst = (id: string, tx: string | null, nav: string | null, held = true, fam = id): DemandInstrument => ({ instrumentId: id, familyKey: fam, held, earliestTransactionDate: tx, earliestNavDate: nav });
  const insts = new Map<string, DemandInstrument>([
    ['i1', inst('i1', '2015-08-21', '2006-04-03', true, 'fam-a')],
    ['i2', inst('i2', '2022-12-02', '2022-12-02', true, 'fam-a')],
    ['i3', inst('i3', '2018-01-01', '2018-01-01', false, 'fam-c')],
    ['i4', inst('i4', null, null, true, 'fam-d')],
  ]);
  it('takes the earliest date across held schemes (engine rule minus the 10-day alignment lookback) and counts schemes/families once', () => {
    const rows = aggregateBenchmarkDemand([
      { instrumentId: 'i1', benchmarkId: 'bm1', effectiveFrom: '1900-01-01', effectiveTo: null },
      { instrumentId: 'i2', benchmarkId: 'bm1', effectiveFrom: '1900-01-01', effectiveTo: null },
    ], insts, EXPECTED);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ benchmark_id: 'bm1', required_from: '2006-03-24', required_from_investor: '2015-08-11', required_to: EXPECTED, scheme_count: 2, family_count: 1 });
  });
  it('NOT held, or with no dated history, creates NO demand (no full-universe backfill)', () => {
    const rows = aggregateBenchmarkDemand([
      { instrumentId: 'i3', benchmarkId: 'bm2', effectiveFrom: '1900-01-01', effectiveTo: null },
      { instrumentId: 'i4', benchmarkId: 'bm3', effectiveFrom: '1900-01-01', effectiveTo: null },
    ], insts, EXPECTED);
    expect(rows).toEqual([]);
  });
  it('mapping-effective periods bound the demand: a mapping that ended before the scheme history began creates none; a later start clamps the window', () => {
    expect(aggregateBenchmarkDemand([{ instrumentId: 'i2', benchmarkId: 'bm4', effectiveFrom: '1900-01-01', effectiveTo: '2020-01-01' }], insts, EXPECTED)).toEqual([]);
    const clamped = aggregateBenchmarkDemand([{ instrumentId: 'i1', benchmarkId: 'bm5', effectiveFrom: '2023-10-31', effectiveTo: null }], insts, EXPECTED);
    expect(clamped[0].required_from).toBe('2023-10-21');
  });
  it('demand expands when an older transaction appears', () => {
    const before = aggregateBenchmarkDemand([{ instrumentId: 'i2', benchmarkId: 'bm1', effectiveFrom: '1900-01-01', effectiveTo: null }], insts, EXPECTED)[0].required_from;
    const older = new Map(insts); older.set('i2', inst('i2', '2010-01-04', '2022-12-02'));
    const after = aggregateBenchmarkDemand([{ instrumentId: 'i2', benchmarkId: 'bm1', effectiveFrom: '1900-01-01', effectiveTo: null }], older, EXPECTED)[0].required_from;
    expect(after < before).toBe(true);
    expect(after).toBe('2009-12-25');
  });
  it('schemeFamilyKey groups plans/options but is only a grouping key', () => {
    expect(schemeFamilyKey('HDFC Mutual Fund', 'HDFC Large Cap Fund - Direct Plan - Growth')).toBe(schemeFamilyKey('HDFC Mutual Fund', 'HDFC Large Cap Fund - Regular Plan - IDCW'));
  });
});

describe('environment guard: a DEV job can never write production and vice versa', () => {
  it('refuses when the project ref is not configured, absent, or different from the connected project', () => {
    const url = 'https://vqycarelcoijzwlpkpcz.supabase.co';
    expect(projectRefFromUrl(url)).toBe('vqycarelcoijzwlpkpcz');
    expect(environmentMatches({ NEXT_PUBLIC_SUPABASE_URL: url }).ok).toBe(false);
    expect(environmentMatches({ NEXT_PUBLIC_SUPABASE_URL: url, BENCHMARK_INGESTION_PROJECT_REF: 'twwpnltizhtjxhamyoxt' }).ok).toBe(false);
    expect(environmentMatches({ BENCHMARK_INGESTION_PROJECT_REF: 'x' }).ok).toBe(false);
    expect(environmentMatches({ NEXT_PUBLIC_SUPABASE_URL: url, BENCHMARK_INGESTION_PROJECT_REF: 'vqycarelcoijzwlpkpcz' }).ok).toBe(true);
  });
});
