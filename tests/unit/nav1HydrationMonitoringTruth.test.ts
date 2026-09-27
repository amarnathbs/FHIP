/**
 * NAV 1 completion (2026-09-27) -- P1 "hydration monitoring truthfulness" and
 * an independent re-verification of the P1 fairness claims.
 *
 * Production evidence that motivated this file (read-only, 26 Sep 2026):
 * ii_reference_job_control.pc6_selective_historical_hydration.last_success_at
 * was NULL although 46 scheduled hydration batches that day all 'succeeded'.
 * The admin surface therefore printed "Last success never" for a healthy job.
 * Cause: hydration wrote its batch row but never the job-control row.
 *
 * Also here: a fairness hole the 2026-09-25 tests did not cover. An instrument
 * whose fetch THROWS (the live fund-house resolver and the paged reads throw
 * on a database error) aborted the whole run before its attempt was recorded,
 * so it stayed "never attempted", went first again next run, threw again, and
 * starved every instrument behind it forever.
 *
 * NEGATIVE CONTROLS (recorded in docs/nav1/NAV1_Production_Final_Certification_2026-09-27.md):
 *   - against bc47a9f (main, deployed): the monitoring and thrown-error tests fail by name;
 *   - against a115ee5 (pre-merge) and 0939ecf (= 7fe349e^): the independent selection tests fail as stated there.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildHydrationBatchRow,
  HISTORICAL_FLOOR_DATE,
  planHydrationJobControlUpdate,
  runSelectiveHistoricalHydration,
  type HydrationAttemptRecord,
  type HydrationDeps,
  type HydrationJobControlOutcome,
} from '@/lib/services/investment-intelligence/pc6/selectiveHistoricalHydrationJob';
import type { HistoricalNavAdapter, HistoricalNavAdapterResult } from '@/lib/services/investment-intelligence/pc6/adapters/historicalNavAdapter';
import { userHeldInstrumentsToDependencies } from '@/lib/services/investment-intelligence/pc6/navRetentionPolicy';

const C = '2026-09-21';
const T0 = Date.parse('2026-09-27T01:00:00.000Z');
const HALF_HOUR = 30 * 60 * 1000;
// UUID-shaped ids, so ordering is the same lexical instrument_id order production uses.
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => uid(a + i));

/** ii_reference_job_control for one job, applying a plan exactly as the live SQL does (the monotonic guard included). */
class JobControlRow {
  last_success_at: string | null = null;
  last_success_batch_id: string | null = null;
  last_failure_at: string | null = null;
  consecutive_failures = 0;
  writes = 0;
  record(outcome: HydrationJobControlOutcome) {
    const plan = planHydrationJobControlUpdate(outcome, this.consecutive_failures);
    if (plan === null) return { error: null };
    const current = this[plan.column];
    if (current !== null && !(current < plan.onlyIfOlderThan)) return { error: null }; // guard: 0 rows updated
    Object.assign(this, plan.set);
    this.writes++;
    return { error: null };
  }
}

type Mode = 'good' | 'fail' | 'throw';

function world(held: string[], covered: string[] = []) {
  const earliest = new Map<string, string>(covered.map((id) => [id, HISTORICAL_FLOOR_DATE]));
  const ledger = new Map<string, HydrationAttemptRecord>();
  const jc = new JobControlRow();
  const batches: Array<{ id: string; status: string; row?: ReturnType<typeof buildHydrationBatchRow> }> = [];
  let n = 0;
  let batchSaveError: string | null = null;
  let jcError: string | null = null;
  const jcCalls: HydrationJobControlOutcome[] = [];
  const deps: HydrationDeps = {
    isEnabled: async () => ({ enabled: true, reason: null }),
    fetchAcceptedDependencies: async () => userHeldInstrumentsToDependencies([...held]),
    fetchBenchmarkDependencies: async () => new Map(),
    fetchEarliestExistingDate: async (id) => earliest.get(id) ?? null,
    fetchAdapterIdentifier: async (id) => id,
    fetchExistingObservations: async () => new Map(),
    writeRows: async (rows) => {
      for (const r of rows) {
        const e = earliest.get(r.instrumentId);
        if (e === undefined || r.priceDate < e) earliest.set(r.instrumentId, r.priceDate);
      }
      return { inserted: rows.length, error: null };
    },
    claimBatch: async (startedAt) => {
      const id = `batch-${++n}`;
      batches.push({ id, status: 'running' });
      void startedAt;
      return { batchId: id, blocked: null, error: null };
    },
    updateBatchProgress: async () => {},
    recordBatch: async (summary, batchId) => {
      if (batchSaveError) return { error: batchSaveError };
      const b = batches.find((x) => x.id === batchId)!;
      b.row = buildHydrationBatchRow(summary);
      b.status = b.row.status;
      return { error: null, batchId };
    },
    fetchHistoryFloor: async () => null,
    recordHistoryFloor: async () => ({ error: null }),
    fetchAttemptLedger: async () => ({ records: new Map(ledger), error: null }),
    recordAttempt: async (r) => { ledger.set(r.instrumentId, r); return { error: null }; },
    recordJobControlOutcome: async (o) => {
      jcCalls.push(o);
      if (jcError) return { error: jcError };
      return jc.record(o);
    },
  };
  return {
    deps, jc, jcCalls, batches, ledger, earliest,
    failBatchSave: (e: string) => { batchSaveError = e; },
    failJobControl: (e: string) => { jcError = e; },
  };
}

function adapterFor(mode: (id: string) => Mode) {
  const calls: string[] = [];
  const provider = { key: 'amfi', adapterVersion: 'sim', requestUrl: null, httpStatus: 200, retrievedAt: 'now' };
  const adapter: HistoricalNavAdapter = {
    providerKey: 'amfi+tigzig', adapterVersion: 'sim',
    fetchHistory: async (r): Promise<HistoricalNavAdapterResult> => {
      calls.push(r.schemeIdentifier);
      const m = mode(r.schemeIdentifier);
      if (m === 'throw') throw new Error('could not read the fund house for scheme: canceling statement due to statement timeout');
      if (m === 'fail') return { ok: false, schemeIdentifier: r.schemeIdentifier, kind: 'http_error', detail: 'HTTP 503', provider };
      return {
        ok: true, schemeIdentifier: r.schemeIdentifier, providerSchemeName: null, coverage: 'complete',
        observations: [{ date: r.fromDate, nav: '10.0000' }, { date: r.toDate, nav: '10.5000' }],
        provider: { ...provider, requestUrl: 'sim', rawResponseChecksum: '0123456789abcdef' },
      };
    },
  };
  return { adapter, calls, distinct: () => [...new Set(calls)] };
}

let tick = 0;
const run = (deps: HydrationDeps, adapter: HistoricalNavAdapter, maxInstruments = 10, dryRun = false) => {
  vi.setSystemTime(T0 + tick++ * HALF_HOUR);
  return runSelectiveHistoricalHydration({ changeoverDate: C, adapter, deps, maxInstruments, dryRun });
};

beforeEach(() => { tick = 0; vi.useFakeTimers({ toFake: ['Date'] }); });
afterEach(() => { vi.useRealTimers(); });

describe('monitoring truthfulness: ii_reference_job_control reflects terminal outcomes', () => {
  it('M1. a no-op run (every held fund already covered) is a success: last_success_at advances, the batch is referenced', async () => {
    const w = world(range(1, 17), range(1, 17));
    const res = await run(w.deps, adapterFor(() => 'good').adapter);
    expect(res.status).toBe('succeeded');
    expect(w.jcCalls).toEqual([{ status: 'succeeded', finishedAt: res.finishedAt, batchId: 'batch-1' }]);
    expect(w.jc.last_success_at).toBe(res.finishedAt);
    expect(w.jc.last_success_batch_id).toBe('batch-1');
    expect(w.jc.consecutive_failures).toBe(0);
  });

  it('M2. a run that writes history is a success too', async () => {
    const w = world(range(1, 3));
    const res = await run(w.deps, adapterFor(() => 'good').adapter);
    expect(res.totalRowsInserted).toBeGreaterThan(0);
    expect(w.jc.last_success_at).toBe(res.finishedAt);
  });

  it('M3. a failed run records last_failure_at and extends the streak; it never touches last_success_at', async () => {
    const w = world(range(1, 3));
    w.jc.last_success_at = '2026-09-26T22:30:01.000Z';
    const r1 = await run(w.deps, adapterFor(() => 'fail').adapter);
    const r2 = await run(w.deps, adapterFor(() => 'fail').adapter);
    expect([r1.status, r2.status]).toEqual(['failed', 'failed']);
    expect(w.jc.last_failure_at).toBe(r2.finishedAt);
    expect(w.jc.consecutive_failures).toBe(2);
    expect(w.jc.last_success_at).toBe('2026-09-26T22:30:01.000Z');
    // ...and the next success resets the streak.
    const r3 = await run(w.deps, adapterFor(() => 'good').adapter);
    expect(r3.status).toBe('succeeded');
    expect(w.jc.consecutive_failures).toBe(0);
    expect(w.jc.last_success_at).toBe(r3.finishedAt);
  });

  it('M4. a partial run (one fetch failed) changes neither timestamp nor the streak -- it is visible in the batch error_code only', async () => {
    const w = world(range(1, 3));
    const res = await run(w.deps, adapterFor((id) => (id === uid(2) ? 'fail' : 'good')).adapter);
    expect(res.status).toBe('partial');
    expect(w.jcCalls.map((c) => c.status)).toEqual(['partial']);
    expect([w.jc.last_success_at, w.jc.last_failure_at, w.jc.consecutive_failures, w.jc.writes]).toEqual([null, null, 0, 0]);
    expect(w.batches[0].row!.error_code).toBe('HYDRATION_SOME_FETCHES_FAILED');
  });

  it('M5. budget-deferred work is partial as well: success is not claimed while funds wait', async () => {
    const w = world(range(1, 5));
    const res = await run(w.deps, adapterFor(() => 'good').adapter, 2);
    expect(res.status).toBe('partial');
    expect(w.jc.last_success_at).toBeNull();
  });

  it('M6. dry runs, kill-switch skips and overlap skips never write job control', async () => {
    const w = world(range(1, 3));
    await run(w.deps, adapterFor(() => 'good').adapter, 10, true);
    const off = { ...w.deps, isEnabled: async () => ({ enabled: false, reason: 'off' }) };
    await run(off, adapterFor(() => 'good').adapter);
    const busy = { ...w.deps, claimBatch: async () => ({ batchId: null, blocked: 'a run is in flight', error: null }) };
    await run(busy, adapterFor(() => 'good').adapter);
    expect(w.jcCalls).toEqual([]);
  });

  it('M7. recording the same outcome twice neither double-counts a failure nor moves a timestamp backwards', () => {
    const jc = new JobControlRow();
    const f = { status: 'failed' as const, finishedAt: '2026-09-27T01:00:01.000Z', batchId: 'b1' };
    jc.record(f);
    jc.record(f); // the same run recorded again (e.g. a retry)
    expect(jc.consecutive_failures).toBe(1);
    jc.record({ status: 'succeeded', finishedAt: '2026-09-27T02:00:01.000Z', batchId: 'b2' });
    jc.record({ status: 'succeeded', finishedAt: '2026-09-27T01:30:01.000Z', batchId: 'b0' }); // older, arrives late
    expect(jc.last_success_at).toBe('2026-09-27T02:00:01.000Z');
    expect(jc.last_success_batch_id).toBe('b2');
  });

  it('M8. a batch that could not be saved is never referenced; a job-control write error is surfaced, not thrown', async () => {
    const w = world(range(1, 2), range(1, 2));
    w.failBatchSave('insert violates check constraint');
    const res = await run(w.deps, adapterFor(() => 'good').adapter);
    expect(w.jcCalls[0].batchId).toBeNull();
    expect(res.batchRecordError).toContain('check constraint');
    const w2 = world(range(1, 2), range(1, 2));
    w2.failJobControl('permission denied');
    const res2 = await run(w2.deps, adapterFor(() => 'good').adapter);
    expect(res2.status).toBe('succeeded');
    expect(res2.jobControlError).toBe('permission denied');
    expect(res2.detail).toContain('JOB-CONTROL OUTCOME NOT SAVED');
  });
});

describe('a THROWN fetch error is that instrument\'s failure, not a permanent block', () => {
  it('T1. a fund whose fetch always throws does not starve the fund behind it (max 1 per run)', async () => {
    const w = world([uid(1), uid(2)]);
    const mode = (id: string): Mode => (id === uid(1) ? 'throw' : 'good');
    const a1 = adapterFor(mode);
    const r1 = await run(w.deps, a1.adapter, 1); // before the fix: rejects, nothing recorded
    expect(r1.status).toBe('failed');
    expect(r1.perInstrument.find((p) => p.instrumentId === uid(1))!.outcome).toBe('fetch_failed');
    expect(w.ledger.get(uid(1))!.consecutiveFailures).toBe(1);
    const a2 = adapterFor(mode);
    await run(w.deps, a2.adapter, 1);
    expect(a2.distinct()).toEqual([uid(2)]); // before the fix: uid(1) again, forever
    expect(w.earliest.get(uid(2))).toBe(HISTORICAL_FLOOR_DATE);
  });

  it('T2. the run still closes its batch and records its outcome when one fetch throws', async () => {
    const w = world(range(1, 3));
    const res = await run(w.deps, adapterFor((id) => (id === uid(2) ? 'throw' : 'good')).adapter);
    expect(res.status).toBe('partial');
    expect(w.batches[0].status).toBe('succeeded');
    expect(w.batches[0].row!.error_code).toBe('HYDRATION_SOME_FETCHES_FAILED');
    expect(res.perInstrument.find((p) => p.instrumentId === uid(2))!.detail).toContain('error thrown');
  });
});

describe('independent re-verification of the P1 selection claims (selection only -- no telemetry assertions)', () => {
  it('S1. 25 held, first 10 covered, max 10: exactly the 10 first UNCOVERED funds are fetched', async () => {
    const w = world(range(1, 25), range(1, 10));
    const a = adapterFor(() => 'good');
    await run(w.deps, a.adapter, 10);
    expect(a.distinct()).toEqual(range(11, 20));
  });

  it('S2. the next run reaches the remaining five, and the one after makes no provider call', async () => {
    const w = world(range(1, 25), range(1, 10));
    await run(w.deps, adapterFor(() => 'good').adapter, 10);
    const a = adapterFor(() => 'good');
    await run(w.deps, a.adapter, 10);
    expect(a.distinct()).toEqual(range(21, 25));
    const b = adapterFor(() => 'good');
    await run(w.deps, b.adapter, 10);
    expect(b.calls).toEqual([]);
  });

  it('S3. ten always-failing funds sorted first do not starve funds 11-12 (reached within 2 runs)', async () => {
    const w = world(range(1, 12));
    const mode = (id: string): Mode => (range(1, 10).includes(id) ? 'fail' : 'good');
    const reached = new Set<string>();
    for (let i = 0; i < 2; i++) {
      const a = adapterFor(mode);
      await run(w.deps, a.adapter, 10);
      a.distinct().forEach((x) => reached.add(x));
    }
    expect(reached.has(uid(11)) && reached.has(uid(12))).toBe(true);
  });

  it('S4. a fund added later is attempted on the very next run, ahead of funds that keep failing', async () => {
    const held = range(1, 10);
    const w = world(held);
    const mode = (id: string): Mode => (id === uid(99) ? 'good' : 'fail');
    for (let i = 0; i < 2; i++) await run(w.deps, adapterFor(mode).adapter, 10);
    held.push(uid(99));
    const a = adapterFor(mode);
    await run(w.deps, a.adapter, 10);
    expect(a.calls[0]).toBe(uid(99));
  });
});
