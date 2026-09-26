/**
 * NAV 1 completion (2026-09-25), brief P1 -- hydration must be FAIR, not just bounded.
 *
 * 7fe349e made maxInstruments bound fetches instead of coverage checks, which
 * fixed the production case (10 covered funds hiding the 7 after them). But
 * the order of the instruments that need a fetch was still fixed. Ten funds
 * that fail on every run -- an AMFI block, a withdrawn scheme, a timeout --
 * would take the whole budget on every run, and a fund after them would never
 * be reached, while every run still logged 'succeeded' (the batch rule counted
 * the already-covered funds as success).
 *
 * The fix: least-recently-attempted-first ordering from a per-instrument
 * attempt ledger (migration 0198), a rotating order when that ledger cannot be
 * read, and a batch status computed from the run's FETCHES.
 *
 * These tests run the real job against a stateful in-memory simulation of the
 * tables it touches (coverage, floors, attempt ledger, batch ledger with the
 * real stale-run reconciliation), across REPEATED runs.
 *
 * NEGATIVE CONTROLS: this file was run against the job as it was on main at
 * 713561d (bounded but fixed order) and at 7fe349e^ (the original loop). The
 * named failures are recorded in docs/nav1/NAV1_Production_Final_Certification_2026-09-25.md.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildHydrationBatchRow,
  HISTORICAL_FLOOR_DATE,
  HYDRATION_NOTHING_SUCCEEDED_ERROR_CODE,
  HYDRATION_STALE_RUNNING_MINUTES,
  runSelectiveHistoricalHydration,
  type HydrationAttemptRecord,
  type HydrationDeps,
  type HydrationJobResult,
} from '@/lib/services/investment-intelligence/pc6/selectiveHistoricalHydrationJob';
import type { HistoricalNavAdapter, HistoricalNavAdapterResult } from '@/lib/services/investment-intelligence/pc6/adapters/historicalNavAdapter';
import { userHeldInstrumentsToDependencies } from '@/lib/services/investment-intelligence/pc6/navRetentionPolicy';
import { reconcileStaleRunningBatches } from '@/lib/services/investment-intelligence/pc6/referenceImportRunner';

const C = '2026-09-21';
const ids = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `inst-${String(from + i).padStart(2, '0')}`);
const T0 = Date.parse('2026-09-25T00:00:00.000Z');
const HALF_HOUR = 30 * 60 * 1000;

type Behaviour = 'good' | 'http_error' | 'timeout' | 'block_page';

/** The tables hydration reads and writes, in memory. Uses the REAL batch-row builder and stale-run reconciliation. */
class SimDb {
  held: string[] = [];
  earliest = new Map<string, string>();
  floors = new Map<string, string>();
  ledger = new Map<string, HydrationAttemptRecord>();
  ledgerBroken = false;
  batches: Array<{ id: string; status: string; started_at: string; row?: ReturnType<typeof buildHydrationBatchRow> }> = [];
  ledgerWrites = 0;
  private nextId = 1;

  deps(): HydrationDeps {
    return {
      isEnabled: async () => ({ enabled: true, reason: null }),
      fetchAcceptedDependencies: async () => userHeldInstrumentsToDependencies([...this.held]),
      fetchBenchmarkDependencies: async () => new Map(),
      fetchEarliestExistingDate: async (id) => this.earliest.get(id) ?? null,
      fetchAdapterIdentifier: async (id) => id,
      fetchExistingObservations: async () => new Map(),
      writeRows: async (rows) => {
        for (const r of rows) {
          const e = this.earliest.get(r.instrumentId);
          if (e === undefined || r.priceDate < e) this.earliest.set(r.instrumentId, r.priceDate);
        }
        return { inserted: rows.length, error: null };
      },
      claimBatch: async (startedAt) => {
        const running = this.batches.filter((b) => b.status === 'running');
        const rec = reconcileStaleRunningBatches(running.map((b) => ({ id: b.id, started_at: b.started_at })), startedAt, HYDRATION_STALE_RUNNING_MINUTES);
        for (const b of this.batches) if (rec.reconciledIds.includes(b.id)) b.status = 'failed';
        if (rec.stillRunning) return { batchId: null, blocked: rec.detail, error: null };
        const id = `batch-${this.nextId++}`;
        this.batches.push({ id, status: 'running', started_at: startedAt });
        return { batchId: id, blocked: null, error: null };
      },
      updateBatchProgress: async () => {},
      recordBatch: async (summary, batchId) => {
        const row = buildHydrationBatchRow(summary);
        const b = this.batches.find((x) => x.id === batchId);
        if (b) { b.status = row.status; b.row = row; }
        return { error: null };
      },
      fetchHistoryFloor: async (id) => this.floors.get(id) ?? null,
      recordHistoryFloor: async (id, floorDate) => {
        const cur = this.floors.get(id);
        this.floors.set(id, cur !== undefined && cur < floorDate ? cur : floorDate);
        return { error: null };
      },
      fetchAttemptLedger: async () =>
        this.ledgerBroken
          ? { records: null, error: 'relation "ii_nav_hydration_attempts" does not exist' }
          : { records: new Map(this.ledger), error: null },
      recordAttempt: async (record) => {
        this.ledgerWrites++;
        if (this.ledgerBroken) return { error: 'relation "ii_nav_hydration_attempts" does not exist' };
        this.ledger.set(record.instrumentId, record);
        return { error: null };
      },
    };
  }
}

/** Each identifier behaves as configured; 'good' returns the whole window, so one run covers the instrument. */
function simAdapter(behaviour: (id: string) => Behaviour, gate?: Promise<void>) {
  const calls: string[] = [];
  const provider = { key: 'amfi', adapterVersion: 'sim', requestUrl: null, httpStatus: 200, retrievedAt: 'now' };
  const adapter: HistoricalNavAdapter = {
    providerKey: 'amfi+tigzig', adapterVersion: 'sim',
    fetchHistory: async (r): Promise<HistoricalNavAdapterResult> => {
      calls.push(r.schemeIdentifier);
      if (gate) await gate;
      const b = behaviour(r.schemeIdentifier);
      if (b === 'http_error') return { ok: false, schemeIdentifier: r.schemeIdentifier, kind: 'http_error', detail: 'HTTP 503', provider };
      if (b === 'timeout') return { ok: false, schemeIdentifier: r.schemeIdentifier, kind: 'network', detail: 'aborted after 45000 ms', provider };
      if (b === 'block_page') return { ok: false, schemeIdentifier: r.schemeIdentifier, kind: 'schema_unexpected', detail: 'unrecognised AMFI body (block page?)', provider };
      return {
        ok: true, schemeIdentifier: r.schemeIdentifier, providerSchemeName: null, coverage: 'complete',
        observations: [{ date: r.fromDate, nav: '10.0000' }, { date: r.toDate, nav: '11.0000' }],
        provider: { ...provider, requestUrl: 'sim', rawResponseChecksum: 'abcdef1234567890' },
      };
    },
  };
  return { adapter, calls, fetchedIds: () => [...new Set(calls)] };
}

let tick = 0;
async function run(db: SimDb, adapter: HistoricalNavAdapter, maxInstruments = 10): Promise<HydrationJobResult> {
  vi.setSystemTime(T0 + tick++ * HALF_HOUR);
  return runSelectiveHistoricalHydration({ changeoverDate: C, adapter, deps: db.deps(), maxInstruments });
}

beforeEach(() => { tick = 0; vi.useFakeTimers({ toFake: ['Date'] }); });
afterEach(() => { vi.useRealTimers(); });

const fullyCovered = (db: SimDb, list: string[]) => list.forEach((id) => db.earliest.set(id, HISTORICAL_FLOOR_DATE));

describe('P1 required tests', () => {
  it('1. 25 held, first 10 covered, 15 uncovered, max 10: exactly 10 UNCOVERED instruments are fetched', async () => {
    const db = new SimDb();
    db.held = ids(1, 25);
    fullyCovered(db, ids(1, 10));
    const { adapter, fetchedIds } = simAdapter(() => 'good');
    const res = await run(db, adapter);
    expect(fetchedIds()).toHaveLength(10);
    expect(fetchedIds().every((id) => !ids(1, 10).includes(id))).toBe(true);
    expect(res.telemetry).toMatchObject({ examined: 25, alreadyCovered: 10, needingFetch: 15, attempted: 10, succeeded: 10, deferred: 5, remaining: 5 });
  });

  it('3. repeated-run fairness: the next run reaches the remaining five; the one after is a no-op', async () => {
    const db = new SimDb();
    db.held = ids(1, 25);
    fullyCovered(db, ids(1, 10));
    const first = simAdapter(() => 'good');
    await run(db, first.adapter);
    const second = simAdapter(() => 'good');
    const res2 = await run(db, second.adapter);
    expect(second.fetchedIds()).toEqual(ids(1, 25).filter((id) => !ids(1, 10).includes(id) && !first.fetchedIds().includes(id)));
    expect(second.fetchedIds()).toHaveLength(5);
    expect(res2.telemetry).toMatchObject({ remaining: 0, deferred: 0 });
    const third = simAdapter(() => 'good');
    await run(db, third.adapter);
    expect(third.calls).toEqual([]);
  });

  it('4. covered instruments do not consume the fetch budget, however many sort first', async () => {
    const db = new SimDb();
    db.held = ids(1, 43);
    fullyCovered(db, ids(1, 40));
    const { adapter, fetchedIds } = simAdapter(() => 'good');
    const res = await run(db, adapter, 3);
    expect(fetchedIds()).toEqual(ids(41, 43));
    expect(res.telemetry).toMatchObject({ alreadyCovered: 40, attempted: 3, deferred: 0 });
  });

  it('5. ten funds that fail on EVERY run do not starve a fund sorted after them (HTTP error)', async () => {
    const db = new SimDb();
    db.held = ids(1, 12);
    const failing = new Set(ids(1, 10));
    const behaviour = (id: string): Behaviour => (failing.has(id) ? 'http_error' : 'good');
    const reached = new Set<string>();
    for (let i = 0; i < 2; i++) {
      const a = simAdapter(behaviour);
      await run(db, a.adapter);
      a.fetchedIds().forEach((id) => reached.add(id));
    }
    // Within ceil(12 / 10) = 2 runs, every fund needing history was attempted.
    expect(ids(11, 12).every((id) => reached.has(id))).toBe(true);
    expect(db.earliest.get('inst-11')).toBe(HISTORICAL_FLOOR_DATE);
    expect(db.earliest.get('inst-12')).toBe(HISTORICAL_FLOOR_DATE);
  });

  it('5b. the same holds when the failures are timeouts', async () => {
    const db = new SimDb();
    db.held = ids(1, 12);
    const behaviour = (id: string): Behaviour => (ids(1, 10).includes(id) ? 'timeout' : 'good');
    await run(db, simAdapter(behaviour).adapter);
    const second = simAdapter(behaviour);
    await run(db, second.adapter);
    expect(second.fetchedIds().slice(0, 2)).toEqual(['inst-11', 'inst-12']); // never attempted -> first in line
  });

  it('5c. without the attempt ledger (0198 not applied), the rotating fallback still reaches every fund, and says it is a fallback', async () => {
    const db = new SimDb();
    db.ledgerBroken = true;
    db.held = ids(1, 12);
    const behaviour = (id: string): Behaviour => (ids(1, 10).includes(id) ? 'http_error' : 'good');
    const reached = new Set<string>();
    let last: HydrationJobResult | undefined;
    for (let i = 0; i < 2; i++) {
      const a = simAdapter(behaviour);
      last = await run(db, a.adapter);
      a.fetchedIds().forEach((id) => reached.add(id));
    }
    expect(ids(11, 12).every((id) => reached.has(id))).toBe(true);
    expect(last!.telemetry!.ordering).toBe('rotation_fallback');
    expect(last!.telemetry!.attemptLedgerError).toContain('does not exist');
    expect(last!.telemetry!.attemptLedgerWriteErrors).toBeGreaterThan(0);
    expect(last!.detail).toContain('ROTATION FALLBACK');
  });

  it('6. the run claim prevents overlapping active hydration batches', async () => {
    const db = new SimDb();
    db.held = ids(1, 3);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const slow = simAdapter(() => 'good', gate);
    vi.setSystemTime(T0);
    const a = runSelectiveHistoricalHydration({ changeoverDate: C, adapter: slow.adapter, deps: db.deps(), maxInstruments: 10 });
    await vi.waitFor(() => expect(slow.calls.length).toBe(1)); // A is in flight, holding its batch
    const second = simAdapter(() => 'good');
    vi.setSystemTime(T0 + 60_000);
    const b = await runSelectiveHistoricalHydration({ changeoverDate: C, adapter: second.adapter, deps: db.deps(), maxInstruments: 10 });
    expect(b.status).toBe('skipped_already_running');
    expect(second.calls).toEqual([]);
    expect(db.batches.filter((x) => x.status === 'running')).toHaveLength(1);
    release();
    await a;
    expect(db.batches.filter((x) => x.status === 'running')).toHaveLength(0);
  });

  it('6b. a running batch older than the stale limit is reconciled as failed, not left blocking forever', async () => {
    const db = new SimDb();
    db.held = ids(1, 1);
    db.batches.push({ id: 'abandoned', status: 'running', started_at: new Date(T0 - (HYDRATION_STALE_RUNNING_MINUTES + 1) * 60_000).toISOString() });
    const res = await run(db, simAdapter(() => 'good').adapter);
    expect(res.status).toBe('succeeded');
    expect(db.batches.find((b) => b.id === 'abandoned')!.status).toBe('failed');
  });

  it('7. a fund added after earlier runs is reached on the next run, ahead of funds that keep failing', async () => {
    const db = new SimDb();
    db.held = ids(1, 10);
    const behaviour = (id: string): Behaviour => (id === 'inst-99' ? 'good' : 'http_error');
    for (let i = 0; i < 3; i++) await run(db, simAdapter(behaviour).adapter);
    db.held = [...ids(1, 10), 'inst-99']; // a new user's fund; sorts after every failing one
    const next = simAdapter(behaviour);
    await run(db, next.adapter);
    expect(next.calls[0]).toBe('inst-99');
    expect(db.earliest.get('inst-99')).toBe(HISTORICAL_FLOOR_DATE);
  });

  it('8. re-running after full coverage makes no provider call, writes no attempt, and is a clean success', async () => {
    const db = new SimDb();
    db.held = ids(1, 17);
    fullyCovered(db, db.held);
    const { adapter, calls } = simAdapter(() => 'good');
    vi.useRealTimers();
    const t = performance.now();
    const res = await runSelectiveHistoricalHydration({ changeoverDate: C, adapter, deps: db.deps(), maxInstruments: 10 });
    expect(performance.now() - t).toBeLessThan(200);
    expect(calls).toEqual([]);
    expect(db.ledgerWrites).toBe(0);
    expect(res.status).toBe('succeeded');
    const row = db.batches[0].row!;
    expect([row.status, row.error_code]).toEqual(['succeeded', null]);
    expect(res.telemetry).toMatchObject({ examined: 17, alreadyCovered: 17, attempted: 0, remaining: 0 });
  });

  it('9. a history floor keeps the EARLIEST valid date across runs', async () => {
    // 'good' returns the window; the next window (older) is not_found only
    // when we say so. Model a fund launched 2014-05-19 with data after it.
    const db = new SimDb();
    db.held = ['inst-01'];
    db.earliest.set('inst-01', '2014-05-19');
    const provider = { key: 'amfi', adapterVersion: 'sim', requestUrl: null, httpStatus: 200, retrievedAt: 'now' };
    const notFound: HistoricalNavAdapter = {
      providerKey: 'amfi+tigzig', adapterVersion: 'sim',
      fetchHistory: async (r) => ({ ok: false, schemeIdentifier: r.schemeIdentifier, kind: 'not_found', detail: 'No data found on the basis of selected parameters', provider }),
    };
    await run(db, notFound);
    expect(db.floors.get('inst-01')).toBe('2014-05-19');
    // A later discovery of a LATER start never moves the floor forward.
    await db.deps().recordHistoryFloor('inst-01', '2016-01-01', 'later');
    expect(db.floors.get('inst-01')).toBe('2014-05-19');
  });

  it('10. an AMFI block page (schema_unexpected) never records a floor, and the run is not a success', async () => {
    const db = new SimDb();
    db.held = ['inst-01'];
    db.earliest.set('inst-01', '2018-03-01'); // newer data on file: the case where a false floor would be tempting
    const res = await run(db, simAdapter(() => 'block_page').adapter);
    expect(db.floors.size).toBe(0);
    expect(res.perInstrument[0].outcome).toBe('fetch_failed');
    expect(res.status).toBe('failed');
    expect(db.batches[0].row!.status).toBe('failed');
  });
});

describe('the batch status tells the truth about the fetches', () => {
  it('NEGATIVE-CONTROL CASE: every fetch failed while 14 funds were already covered -> failed, not succeeded', async () => {
    const db = new SimDb();
    db.held = ids(1, 17);
    fullyCovered(db, ids(1, 14));
    const res = await run(db, simAdapter(() => 'http_error').adapter);
    const row = db.batches[0].row!;
    expect(row.status).toBe('failed'); // before this fix: 'succeeded' (already-covered counted as success)
    expect(row.error_code).toBe(HYDRATION_NOTHING_SUCCEEDED_ERROR_CODE);
    expect(res.telemetry).toMatchObject({ alreadyCovered: 14, attempted: 3, succeeded: 0, failed: 3, remaining: 3 });
  });

  it('some fetches failed, some succeeded -> succeeded WITH error_code HYDRATION_SOME_FETCHES_FAILED', async () => {
    const db = new SimDb();
    db.held = ids(1, 4);
    const res = await run(db, simAdapter((id) => (id === 'inst-02' ? 'http_error' : 'good')).adapter);
    const row = db.batches[0].row!;
    expect([row.status, row.error_code]).toEqual(['succeeded', 'HYDRATION_SOME_FETCHES_FAILED']);
    expect(row.notes.outcome).toBe('partial');
    expect(res.status).toBe('partial');
    expect(row.rows_rejected).toBe(1);
  });

  it('every fetch succeeded but the budget left work -> error_code HYDRATION_WORK_REMAINING', async () => {
    const db = new SimDb();
    db.held = ids(1, 5);
    await run(db, simAdapter(() => 'good').adapter, 2);
    const row = db.batches[0].row!;
    expect([row.status, row.error_code]).toEqual(['succeeded', 'HYDRATION_WORK_REMAINING']);
    expect(row.notes.telemetry).toMatchObject({ attempted: 2, deferred: 3, remaining: 3 });
  });

  it('telemetry adds up, and every held fund appears in perInstrument (deferred ones included)', async () => {
    const db = new SimDb();
    db.held = ids(1, 20);
    fullyCovered(db, ids(1, 6));
    const res = await run(db, simAdapter((id) => (id === 'inst-08' ? 'http_error' : 'good')).adapter, 5);
    const t = res.telemetry!;
    expect(t.examined).toBe(20);
    expect(t.alreadyCovered + t.noGapToFetch + t.needingFetch).toBe(t.required);
    expect(t.attempted + t.deferred).toBe(t.needingFetch);
    expect(t.succeeded + t.partiallyHydrated + t.failed).toBe(t.attempted);
    expect(t.remaining).toBe(t.needingFetch - t.succeeded);
    expect(new Set(res.perInstrument.map((p) => p.instrumentId))).toEqual(new Set(db.held));
    expect(res.perInstrument.filter((p) => p.outcome === 'deferred')).toHaveLength(t.deferred);
  });

  it('a fund failing 3 runs in a row is reported as persistently failing', async () => {
    const db = new SimDb();
    db.held = ids(1, 2);
    const behaviour = (id: string): Behaviour => (id === 'inst-01' ? 'http_error' : 'good');
    let res: HydrationJobResult | undefined;
    for (let i = 0; i < 3; i++) res = await run(db, simAdapter(behaviour).adapter);
    expect(db.ledger.get('inst-01')!.consecutiveFailures).toBe(3);
    expect(db.ledger.get('inst-02')!.consecutiveFailures).toBe(0);
    expect(res!.telemetry!.persistentlyFailing).toBe(1);
    expect(res!.detail).toContain('1 persistently failing');
  });

  it('a dry run records no attempts and reads the same fair order', async () => {
    const db = new SimDb();
    db.held = ids(1, 12);
    db.ledger.set('inst-01', { instrumentId: 'inst-01', lastAttemptedAt: '2026-09-24T00:00:00.000Z', lastOutcome: 'fetch_failed', consecutiveFailures: 1, attemptsTotal: 1, lastSuccessAt: null });
    vi.setSystemTime(T0);
    const res = await runSelectiveHistoricalHydration({ changeoverDate: C, adapter: simAdapter(() => 'good').adapter, deps: db.deps(), maxInstruments: 11, dryRun: true });
    expect(db.ledgerWrites).toBe(0);
    const planned = res.perInstrument.filter((p) => p.outcome === 'planned_dry_run').map((p) => p.instrumentId);
    expect(planned).toEqual(ids(2, 12)); // inst-01 was attempted most recently -> last, and deferred
  });
});
