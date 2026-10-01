// BENCH-1 Phase 2 - benchmark-specific recurring-ingestion orchestrator.
//
// SHIPS DISABLED. No source is automatable today (no verified automation
// right exists - SOURCE_DECISION.md), so the registry of adapters is EMPTY and
// every benchmark stays in manual_import mode. This module is the proven
// machinery that makes a future licensed feed safe to switch on:
//
//   GATES (all must pass, each fails closed):
//     1. environment switch (BENCHMARK_INGESTION_ENABLED='true'), enforced by the
//        cron route before anything is built;
//     2. global kill switch  (ii_reference_job_control 'benchmark_ingestion_global');
//     3. per-benchmark state: mode 'automated' AND automation_enabled;
//     4. central entitlement: an approved, in-term record granting
//        'automation' + 'storage' for the exact benchmark/variant/currency
//        (the SAME predicate the database re-checks in publish_benchmark_feed_rows);
//     5. backoff window not active; 6. single-flight lease (leases expire);
//     7. write kill switch ('benchmark_ingestion_write'): when OFF a run
//        fetches and validates but writes NOTHING (status dry_run).
//
//   SUCCESS IS HONEST. HTTP 200 with no expected data is NOT success. A run
//   that adds no rows is successful only when expected coverage is
//   INDEPENDENTLY already complete (complete_no_new_data). last_attempt_at
//   moves on every attempt; last_successful_run_at only on success;
//   latest_valid_data_date and completeness_watermark are recomputed from the
//   stored series, so they can never claim coverage the data does not have.
//
//   BOUNDED AND RESUMABLE. One bounded window per run (daily: from the latest
//   stored date minus a correction lookback; weekly_gap: the first intolerable
//   gap; history_expansion: newest-first chunks toward the demand floor; monthly
//   reconcile: a lookback comparison that REPORTS differing values - the feed
//   write path never overwrites). Retry budget per day, provider rate limit,
//   exponential backoff on failure.
//
// All I/O is injected (OrchestratorDeps), so every rule above is unit-tested
// without a database or a network.
import { nextAttemptAfter } from '@/lib/services/investment-intelligence/pc6/referenceImportRunner';
import type { Alert } from '@/lib/services/investment-intelligence/pc6/referenceImportRunner';
import { actionAllowed, describeMissingRights, type EntitlementRecord } from '../entitlements';
import { addDaysIso, assessCompleteness, expectedLatestSession, findGapRuns } from './calendar';

export const ORCHESTRATOR_VERSION = 'bench1-ingestion-v1';
export const CORRECTION_LOOKBACK_DAYS = 5;
export const RECONCILE_LOOKBACK_DAYS = 35;
export const MAX_HISTORY_WINDOW_DAYS = 366;
export const DAILY_RETRY_BUDGET = 3;
export const LEASE_TTL_SECONDS = 600;
export const MAX_BENCHMARKS_PER_RUN = 10;
export const FEED_OUTLIER_FRACTION = 0.25;

export type RunKind = 'daily' | 'late_retry' | 'weekly_gap' | 'monthly_reconcile' | 'history_expansion' | 'probe';

export type AdapterOutcome =
  | { kind: 'ok'; rows: Array<{ date: string; value: number }>; httpStatus?: number }
  /** HTTP 200 (or equivalent) but nothing of what was expected. NOT success by itself. */
  | { kind: 'empty'; httpStatus?: number }
  | { kind: 'blocked'; httpStatus?: number; detail: string }
  | { kind: 'rate_limited'; httpStatus?: number; retryAfterSeconds?: number }
  | { kind: 'auth_failed'; httpStatus?: number; detail: string }
  | { kind: 'outage'; detail: string; httpStatus?: number }
  | { kind: 'not_configured'; detail: string };

export interface BenchmarkFeedAdapter {
  id: string;
  /** Host recorded in the ledger (never a URL with credentials). */
  sourceHost: string;
  /** Minimum gap between real requests (provider limit). */
  minIntervalMs: number;
  /** Requests allowed per run. */
  maxRequestsPerRun: number;
  fetchRange(args: { benchmarkKey: string; from: string; to: string }): Promise<AdapterOutcome>;
}

export interface IngestionStateRow {
  benchmarkId: string;
  benchmarkKey: string;
  ingestionMode: 'disabled' | 'manual_import' | 'automated';
  adapterId: string | null;
  automationEnabled: boolean;
  publicationLagDays: number;
  latestValidDataDate: string | null;
  completenessWatermark: string | null;
  consecutiveFailures: number;
  nextAttemptNotBefore: string | null;
  retriesUsedInWindow: number;
  retryWindowDate: string | null;
  returnVariant: 'price' | 'total_return' | 'net_total_return' | null;
  currencyCode: string | null;
}

export interface AttemptRecord {
  runKind: RunKind;
  status:
    | 'succeeded'
    | 'complete_no_new_data'
    | 'empty_response'
    | 'partial'
    | 'failed'
    | 'blocked'
    | 'skipped_global_kill'
    | 'skipped_source_disabled'
    | 'skipped_not_entitled'
    | 'skipped_lease'
    | 'skipped_backoff'
    | 'skipped_write_kill'
    | 'dry_run';
  success: boolean;
  startedAt: string;
  windowFrom: string | null;
  windowTo: string | null;
  httpStatus: number | null;
  rowsFetched: number;
  rowsInserted: number;
  rowsIdentical: number;
  rowsConflicting: number;
  completenessWatermark: string | null;
  errorCode: string | null;
  errorDetail: string | null;
  nextAttemptNotBefore: string | null;
  leaseHolder: string | null;
}

export interface OrchestratorDeps {
  nowIso: string;
  holderId: string;
  holidays?: ReadonlySet<string>;
  sleep(ms: number): Promise<void>;
  adapters: ReadonlyMap<string, BenchmarkFeedAdapter>;
  /** Job-control switches; MUST fail closed (missing row => false). */
  isGlobalEnabled(): Promise<boolean>;
  isWriteEnabled(): Promise<boolean>;
  loadStates(benchmarkKeys?: string[]): Promise<IngestionStateRow[]>;
  loadEntitlements(benchmarkId: string): Promise<EntitlementRecord[]>;
  claimLease(benchmarkId: string, holder: string, ttlSeconds: number): Promise<boolean>;
  releaseLease(benchmarkId: string, holder: string): Promise<void>;
  /** Stored level dates in [from, to] for the benchmark (live rows only). */
  loadStoredDates(benchmarkId: string, from: string, to: string): Promise<Map<string, number>>;
  loadDemandFloor(benchmarkId: string): Promise<string | null>;
  /** Persist rows through publish_benchmark_feed_rows (service role). Never overwrites. */
  writeRows(benchmarkId: string, rows: Array<{ date: string; value: number }>, sourceHost: string, runKind: RunKind): Promise<{ inserted: number; identical: number; conflicts: number; error: string | null; batchId?: string }>;
  /** Persist the attempt (record_benchmark_ingestion_attempt) - or, for a skip, just the run row. */
  recordAttempt(benchmarkId: string, rec: AttemptRecord, isSkip: boolean): Promise<void>;
}

export interface BenchmarkRunResult {
  benchmarkKey: string;
  status: AttemptRecord['status'];
  success: boolean;
  detail: string;
  rowsFetched: number;
  rowsInserted: number;
  rowsConflicting: number;
  requests: number;
  windowFrom: string | null;
  windowTo: string | null;
  completenessWatermark: string | null;
}

export interface OrchestratorResult {
  version: typeof ORCHESTRATOR_VERSION;
  runKind: RunKind;
  status: 'completed' | 'disabled_global' | 'nothing_to_do';
  results: BenchmarkRunResult[];
  alerts: Alert[];
}

/** Pure: the window a run asks the source for. */
export function planWindow(runKind: RunKind, state: Pick<IngestionStateRow, 'latestValidDataDate' | 'completenessWatermark'>, expectedLatest: string, demandFloor: string | null, firstStoredDate: string | null, storedDates: ReadonlySet<string>, holidays?: ReadonlySet<string>): { from: string; to: string } | null {
  switch (runKind) {
    case 'daily':
    case 'late_retry': {
      // Correction lookback: re-fetch the last few sessions so a late correction is SEEN (and reported as a conflict), never silently applied.
      const base = state.latestValidDataDate ?? addDaysIso(expectedLatest, -CORRECTION_LOOKBACK_DAYS);
      const from = addDaysIso(base, -CORRECTION_LOOKBACK_DAYS);
      return from <= expectedLatest ? { from, to: expectedLatest } : null;
    }
    case 'weekly_gap': {
      const floor = demandFloor ?? firstStoredDate;
      if (!floor) return null;
      const runs = findGapRuns(storedDates, floor, expectedLatest, holidays).filter((r) => r.weekdaysMissing > 0);
      if (runs.length === 0) return null;
      return { from: runs[0].from, to: runs[0].to };
    }
    case 'monthly_reconcile':
      return { from: addDaysIso(expectedLatest, -RECONCILE_LOOKBACK_DAYS), to: expectedLatest };
    case 'history_expansion': {
      if (!demandFloor || !firstStoredDate) return demandFloor ? { from: demandFloor, to: addDaysIso(demandFloor, MAX_HISTORY_WINDOW_DAYS - 1) } : null;
      if (firstStoredDate <= demandFloor) return null; // demand floor already covered
      const to = addDaysIso(firstStoredDate, -1);
      const from = addDaysIso(to, -(MAX_HISTORY_WINDOW_DAYS - 1));
      return { from: from < demandFloor ? demandFloor : from, to };
    }
    case 'probe':
      return { from: addDaysIso(expectedLatest, -2), to: expectedLatest };
    default:
      return null;
  }
}

function skip(state: IngestionStateRow, runKind: RunKind, status: AttemptRecord['status'], detail: string, deps: OrchestratorDeps): { rec: AttemptRecord; res: BenchmarkRunResult } {
  const rec: AttemptRecord = { runKind, status, success: false, startedAt: deps.nowIso, windowFrom: null, windowTo: null, httpStatus: null, rowsFetched: 0, rowsInserted: 0, rowsIdentical: 0, rowsConflicting: 0, completenessWatermark: null, errorCode: status.toUpperCase(), errorDetail: detail, nextAttemptNotBefore: null, leaseHolder: null };
  return { rec, res: { benchmarkKey: state.benchmarkKey, status, success: false, detail, rowsFetched: 0, rowsInserted: 0, rowsConflicting: 0, requests: 0, windowFrom: null, windowTo: null, completenessWatermark: null } };
}

export async function runBenchmarkIngestion(deps: OrchestratorDeps, opts: { runKind: RunKind; benchmarkKeys?: string[]; maxBenchmarks?: number }): Promise<OrchestratorResult> {
  const alerts: Alert[] = [];
  const base = { version: ORCHESTRATOR_VERSION as typeof ORCHESTRATOR_VERSION, runKind: opts.runKind, alerts };
  const results: BenchmarkRunResult[] = [];

  // GATE 2: global kill switch. Nothing else is touched (no entitlement read, no lease, no request).
  if (!(await deps.isGlobalEnabled())) return { ...base, status: 'disabled_global', results };

  const states = (await deps.loadStates(opts.benchmarkKeys)).slice(0, Math.min(opts.maxBenchmarks ?? MAX_BENCHMARKS_PER_RUN, MAX_BENCHMARKS_PER_RUN));
  if (states.length === 0) return { ...base, status: 'nothing_to_do', results };
  const writeEnabled = await deps.isWriteEnabled();
  const today = deps.nowIso.slice(0, 10);
  let blockedBySource = false;
  let totalRequests = 0;

  for (const state of states) {
    // GATE 3: mode + source switch.
    if (state.ingestionMode !== 'automated' || !state.automationEnabled || !state.adapterId) {
      const { rec, res } = skip(state, opts.runKind, 'skipped_source_disabled', state.ingestionMode === 'manual_import' ? 'Governed manual-import mode: no automated fetch is permitted or attempted.' : 'Automation is not enabled for this benchmark.', deps);
      results.push(res);
      await deps.recordAttempt(state.benchmarkId, rec, true);
      continue;
    }
    // GATE 4: central entitlement (automation + storage), same predicate as the database.
    const records = await deps.loadEntitlements(state.benchmarkId);
    const identity = { benchmarkId: state.benchmarkId, returnVariant: state.returnVariant, currencyCode: state.currencyCode };
    const decision = actionAllowed(identity, records, 'publish_automated', today);
    if (!decision.allowed) {
      const { rec, res } = skip(state, opts.runKind, 'skipped_not_entitled', describeMissingRights(decision.missing), deps);
      results.push(res);
      await deps.recordAttempt(state.benchmarkId, rec, true);
      alerts.push({ severity: 'warning', code: 'NOT_ENTITLED', detail: `${state.benchmarkKey}: ${rec.errorDetail}` });
      continue;
    }
    // GATE 5: backoff.
    if (state.nextAttemptNotBefore && state.nextAttemptNotBefore > deps.nowIso) {
      const { rec, res } = skip(state, opts.runKind, 'skipped_backoff', `Backing off until ${state.nextAttemptNotBefore}.`, deps);
      results.push(res);
      await deps.recordAttempt(state.benchmarkId, rec, true);
      continue;
    }
    // Retry budget per day (late retries and re-tries share it).
    const used = state.retryWindowDate === today ? state.retriesUsedInWindow : 0;
    if (opts.runKind === 'late_retry' && used >= DAILY_RETRY_BUDGET) {
      const { rec, res } = skip(state, opts.runKind, 'skipped_backoff', `The daily late-publication retry budget (${DAILY_RETRY_BUDGET}) is spent.`, deps);
      results.push(res);
      await deps.recordAttempt(state.benchmarkId, rec, true);
      continue;
    }
    const adapter = deps.adapters.get(state.adapterId);
    if (!adapter) {
      const { rec, res } = skip(state, opts.runKind, 'skipped_source_disabled', `No adapter '${state.adapterId}' is registered in this runtime.`, deps);
      results.push(res);
      await deps.recordAttempt(state.benchmarkId, rec, true);
      continue;
    }
    if (blockedBySource) {
      const { rec, res } = skip(state, opts.runKind, 'skipped_source_disabled', 'An earlier benchmark in this run was refused by its source; the run stops rather than probing further.', deps);
      results.push(res);
      await deps.recordAttempt(state.benchmarkId, rec, true);
      continue;
    }
    // GATE 6: single-flight lease.
    if (!(await deps.claimLease(state.benchmarkId, deps.holderId, LEASE_TTL_SECONDS))) {
      const { rec, res } = skip(state, opts.runKind, 'skipped_lease', 'Another run holds the lease for this benchmark.', deps);
      results.push(res);
      await deps.recordAttempt(state.benchmarkId, rec, true);
      continue;
    }

    try {
      const expected = expectedLatestSession(deps.nowIso, state.publicationLagDays, deps.holidays);
      const demandFloor = await deps.loadDemandFloor(state.benchmarkId);
      const wideFrom = demandFloor ?? addDaysIso(expected, -RECONCILE_LOOKBACK_DAYS * 3);
      const stored = await deps.loadStoredDates(state.benchmarkId, wideFrom, expected);
      const storedSet = new Set(stored.keys());
      const firstStored = [...storedSet].sort()[0] ?? null;
      const window = planWindow(opts.runKind, state, expected, demandFloor, firstStored, storedSet, deps.holidays);
      const startedAt = deps.nowIso;

      const finish = async (status: AttemptRecord['status'], success: boolean, extra: Partial<AttemptRecord>, detail: string, requests: number) => {
        const afterStored = await deps.loadStoredDates(state.benchmarkId, wideFrom, expected);
        const assess = assessCompleteness(new Set(afterStored.keys()), demandFloor ?? wideFrom, expected, { holidays: deps.holidays });
        const failed = !success && status !== 'dry_run';
        const rec: AttemptRecord = {
          runKind: opts.runKind,
          status,
          success,
          startedAt,
          windowFrom: window?.from ?? null,
          windowTo: window?.to ?? null,
          httpStatus: null,
          rowsFetched: 0,
          rowsInserted: 0,
          rowsIdentical: 0,
          rowsConflicting: 0,
          completenessWatermark: assess.watermark,
          errorCode: success ? null : status.toUpperCase(),
          errorDetail: success ? null : detail,
          nextAttemptNotBefore: failed ? nextAttemptAfter(deps.nowIso, state.consecutiveFailures + 1) : null,
          leaseHolder: deps.holderId,
          ...extra,
        };
        await deps.recordAttempt(state.benchmarkId, rec, false);
        results.push({ benchmarkKey: state.benchmarkKey, status, success, detail, rowsFetched: rec.rowsFetched, rowsInserted: rec.rowsInserted, rowsConflicting: rec.rowsConflicting, requests, windowFrom: rec.windowFrom, windowTo: rec.windowTo, completenessWatermark: assess.watermark });
        if (failed) alerts.push({ severity: status === 'blocked' ? 'critical' : 'warning', code: `INGEST_${status.toUpperCase()}`, detail: `${state.benchmarkKey}: ${detail}` });
        return assess;
      };

      if (!window) {
        // Nothing to ask for. Success ONLY because coverage is independently complete.
        const assess = assessCompleteness(storedSet, demandFloor ?? wideFrom, expected, { holidays: deps.holidays });
        const complete = assess.watermark !== null && assess.watermark >= expected && state.latestValidDataDate !== null;
        await finish(complete ? 'complete_no_new_data' : 'partial', complete, {}, complete ? 'Coverage is already complete through the expected session.' : 'No window to fetch, but coverage is not complete.', 0);
        continue;
      }

      // Provider rate limit + request budget.
      let requests = 0;
      if (adapter.maxRequestsPerRun < 1) {
        await finish('failed', false, { errorCode: 'REQUEST_BUDGET' }, 'The provider request budget for this run is zero.', requests);
        continue;
      }
      // Provider rate limit: pause only between REAL requests in this run.
      if (totalRequests > 0) await deps.sleep(adapter.minIntervalMs);
      totalRequests += 1;
      const outcome = await adapter.fetchRange({ benchmarkKey: state.benchmarkKey, from: window.from, to: window.to });
      requests += 1;

      switch (outcome.kind) {
        case 'not_configured':
          await finish('skipped_source_disabled', false, { httpStatus: null }, outcome.detail, requests);
          break;
        case 'blocked':
          // Bot protection / forbidden: STOP. No retry, no route-around.
          blockedBySource = true;
          await finish('blocked', false, { httpStatus: outcome.httpStatus ?? null }, outcome.detail, requests);
          break;
        case 'auth_failed':
          blockedBySource = true;
          await finish('failed', false, { httpStatus: outcome.httpStatus ?? 401, errorCode: 'AUTH_FAILED' }, `Authentication to the source failed: ${outcome.detail}`, requests);
          break;
        case 'rate_limited':
          blockedBySource = true;
          await finish('failed', false, { httpStatus: outcome.httpStatus ?? 429, errorCode: 'RATE_LIMITED', nextAttemptNotBefore: new Date(Date.parse(deps.nowIso) + Math.max(60, outcome.retryAfterSeconds ?? 900) * 1000).toISOString() }, 'The source rate-limited the run; no retry in this run.', requests);
          break;
        case 'outage':
          await finish('failed', false, { httpStatus: outcome.httpStatus ?? null, errorCode: 'SOURCE_OUTAGE' }, outcome.detail, requests);
          break;
        case 'empty': {
          // HTTP 200 with nothing expected. Successful ONLY if coverage is independently complete already.
          const assess = assessCompleteness(storedSet, demandFloor ?? wideFrom, expected, { holidays: deps.holidays });
          const complete = assess.watermark !== null && assess.watermark >= expected && state.latestValidDataDate !== null && state.latestValidDataDate >= expected;
          await finish(complete ? 'complete_no_new_data' : 'empty_response', complete, { httpStatus: outcome.httpStatus ?? 200 }, complete ? 'The source returned no new rows and coverage is already complete.' : 'The source answered but returned none of the expected data; coverage is NOT complete, so this is not a successful ingestion.', requests);
          break;
        }
        case 'ok': {
          const validRows: Array<{ date: string; value: number }> = [];
          let invalid = 0;
          let outliers = 0;
          const prev = [...stored.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
          let lastValue: number | null = prev.length ? prev[prev.length - 1][1] : null;
          for (const r of [...outcome.rows].sort((a, b) => (a.date < b.date ? -1 : 1))) {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date) || !Number.isFinite(r.value) || r.value <= 0 || r.date > today || r.date > window.to || r.date < window.from) {
              invalid += 1;
              continue;
            }
            // Same plausibility rule as an upload: a >25% spike against the previous close is NOT written (and alerted).
            const ref = stored.get(r.date) !== undefined ? null : lastValue;
            if (ref !== null && Math.abs(r.value / ref - 1) > FEED_OUTLIER_FRACTION) {
              outliers += 1;
              continue;
            }
            validRows.push(r);
            if (stored.get(r.date) === undefined) lastValue = r.value;
          }
          if (outliers > 0) alerts.push({ severity: 'critical', code: 'FEED_OUTLIER_REJECTED', detail: `${state.benchmarkKey}: ${outliers} row(s) moved by more than ${FEED_OUTLIER_FRACTION * 100}% and were not written.` });
          if (validRows.length === 0) {
            const assess = assessCompleteness(storedSet, demandFloor ?? wideFrom, expected, { holidays: deps.holidays });
            const complete = assess.watermark !== null && assess.watermark >= expected;
            await finish(complete ? 'complete_no_new_data' : 'empty_response', complete, { httpStatus: outcome.httpStatus ?? 200, rowsFetched: outcome.rows.length }, 'No usable rows were returned.', requests);
            break;
          }
          if (!writeEnabled) {
            await finish('dry_run', false, { httpStatus: outcome.httpStatus ?? 200, rowsFetched: validRows.length, errorCode: 'WRITE_KILL_SWITCH' }, 'The write kill switch is OFF: rows were fetched and validated but NOTHING was written.', requests);
            break;
          }
          const w = await deps.writeRows(state.benchmarkId, validRows, adapter.sourceHost, opts.runKind);
          if (w.error) {
            await finish('failed', false, { httpStatus: outcome.httpStatus ?? 200, rowsFetched: validRows.length, errorCode: 'WRITE_FAILED' }, `The database refused the write: ${w.error}`, requests);
            break;
          }
          if (w.conflicts > 0) alerts.push({ severity: 'warning', code: 'FEED_VALUE_CONFLICT', detail: `${state.benchmarkKey}: ${w.conflicts} stored level(s) differ from the source and were left unchanged for review (use a correction job).` });
          const partial = invalid > 0 || outliers > 0;
          await finish(partial ? 'partial' : 'succeeded', !partial, { httpStatus: outcome.httpStatus ?? 200, rowsFetched: validRows.length, rowsInserted: w.inserted, rowsIdentical: w.identical, rowsConflicting: w.conflicts }, partial ? `${invalid} invalid and ${outliers} implausible row(s) were not written.` : 'Run finished.', requests);
          break;
        }
      }
    } finally {
      await deps.releaseLease(state.benchmarkId, deps.holderId);
    }
  }
  return { ...base, status: 'completed', results };
}

