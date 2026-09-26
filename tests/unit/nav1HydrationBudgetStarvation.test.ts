/**
 * NAV 1 Stage D — maxInstruments must bound FETCHES, not coverage checks.
 *
 * Found 2026-09-24 by the first scheduled production run: users held 17
 * funds, the run examined exactly 10 (all already covered) and never looked
 * at the other 7. Every examined instrument counted against maxInstruments,
 * and the order never changes -- so the first 10 used up the budget on every
 * run, and a new fund sorting after them would never have been hydrated
 * while every run still reported 'succeeded'.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  runSelectiveHistoricalHydration,
  HISTORICAL_FLOOR_DATE,
  type HydrationDeps,
} from '@/lib/services/investment-intelligence/pc6/selectiveHistoricalHydrationJob';
import type { HistoricalNavAdapter } from '@/lib/services/investment-intelligence/pc6/adapters/historicalNavAdapter';
import { userHeldInstrumentsToDependencies } from '@/lib/services/investment-intelligence/pc6/navRetentionPolicy';

const C = '2026-09-21';
const ids = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `inst-${String(from + i).padStart(2, '0')}`);

/** The adapter reports each instrument by its identifier, so we can see exactly which were fetched. */
function recordingAdapter() {
  const fetched: string[] = [];
  const adapter: HistoricalNavAdapter = {
    providerKey: 'sim', adapterVersion: 'v',
    fetchHistory: async (r) => {
      fetched.push(r.schemeIdentifier);
      return {
        ok: false, schemeIdentifier: r.schemeIdentifier, kind: 'not_found', detail: 'none',
        provider: { key: 'sim', adapterVersion: 'v', requestUrl: null, httpStatus: 200, retrievedAt: 'now' },
      };
    },
  };
  return { adapter, fetched: () => [...new Set(fetched)] };
}

/** `covered` instruments already hold history back to the floor date; every other one has none. */
function deps(held: string[], covered: Set<string>, over: Partial<HydrationDeps> = {}) {
  const updateBatchProgress = vi.fn().mockResolvedValue(undefined);
  const d: HydrationDeps = {
    isEnabled: async () => ({ enabled: true, reason: null }),
    fetchAcceptedDependencies: async () => userHeldInstrumentsToDependencies(held),
    fetchBenchmarkDependencies: async () => new Map(),
    fetchEarliestExistingDate: async (id) => (covered.has(id) ? HISTORICAL_FLOOR_DATE : null),
    fetchAdapterIdentifier: async (id) => id,
    fetchExistingObservations: async () => new Map(),
    writeRows: async (rows) => ({ inserted: rows.length, error: null }),
    fetchHistoryFloor: async () => null,
    recordHistoryFloor: async () => ({ error: null }),
    claimBatch: async () => ({ batchId: 'batch-1', blocked: null, error: null }),
    updateBatchProgress,
    recordBatch: async () => ({ error: null }),
    // An empty attempt ledger (0198): nothing attempted yet, so the fair order
    // is the candidate order. Fairness itself is in nav1HydrationFairOrdering.test.ts.
    fetchAttemptLedger: async () => ({ records: new Map(), error: null }),
    recordAttempt: async () => ({ error: null }),
    ...over,
  };
  return { d, updateBatchProgress };
}

describe('maxInstruments bounds fetches, not coverage checks', () => {
  it('THE PRODUCTION CASE: 10 covered funds sorting first do not hide the new funds after them', async () => {
    const held = ids(1, 17);
    const covered = new Set(ids(1, 10));
    const { adapter, fetched } = recordingAdapter();
    const res = await runSelectiveHistoricalHydration({ changeoverDate: C, adapter, deps: deps(held, covered).d, maxInstruments: 10 });

    expect(fetched()).toEqual(ids(11, 17)); // before the fix: [] -- never examined
    expect(res.instrumentsAlreadyCovered).toBe(10);
    expect(res.perInstrument.map((p) => p.instrumentId)).toEqual(held); // every held fund accounted for
  });

  it('the limit still bounds the fetches themselves; the rest are deferred, and the run says so', async () => {
    const held = ids(1, 25);
    const covered = new Set(ids(1, 10));
    const { adapter, fetched } = recordingAdapter();
    const res = await runSelectiveHistoricalHydration({ changeoverDate: C, adapter, deps: deps(held, covered).d, maxInstruments: 10 });

    expect(fetched()).toEqual(ids(11, 20)); // exactly 10 fetched, none of them a covered fund
    expect(res.instrumentsAlreadyCovered).toBe(10);
    expect(res.instrumentsNeedingHydration).toBe(25);
    expect(res.detail).toContain('5 deferred to a later run');
  });

  it('a later run reaches the deferred funds (the next run picks up where this one stopped)', async () => {
    const held = ids(1, 25);
    const covered = new Set(ids(1, 20)); // the first run's 10 fetches are now on file
    const { adapter, fetched } = recordingAdapter();
    await runSelectiveHistoricalHydration({ changeoverDate: C, adapter, deps: deps(held, covered).d, maxInstruments: 10 });
    expect(fetched()).toEqual(ids(21, 25));
  });

  it('all covered: every held fund is examined, nothing is fetched, nothing deferred', async () => {
    const held = ids(1, 17);
    const { adapter, fetched } = recordingAdapter();
    const res = await runSelectiveHistoricalHydration({ changeoverDate: C, adapter, deps: deps(held, new Set(held)).d, maxInstruments: 10 });
    expect(fetched()).toEqual([]);
    expect(res.instrumentsAlreadyCovered).toBe(17);
    expect(res.detail).toContain('0 fetched this invocation');
    expect(res.detail).toContain('0 deferred');
  });

  it('a dry run plans against the same budget: covered funds use none of it', async () => {
    const held = ids(1, 17);
    const covered = new Set(ids(1, 10));
    const { adapter, fetched } = recordingAdapter();
    const res = await runSelectiveHistoricalHydration({ changeoverDate: C, adapter, deps: deps(held, covered).d, maxInstruments: 5, dryRun: true });
    expect(fetched()).toEqual([]);
    expect(res.perInstrument.filter((p) => p.outcome === 'planned_dry_run').map((p) => p.instrumentId)).toEqual(ids(11, 15));
    expect(res.detail).toContain('2 deferred to a later run');
  });

  it('coverage checks do not each write a progress update; progress is written before each fetch', async () => {
    const held = ids(1, 13);
    const covered = new Set(ids(1, 10));
    const { adapter } = recordingAdapter();
    const { d, updateBatchProgress } = deps(held, covered);
    await runSelectiveHistoricalHydration({ changeoverDate: C, adapter, deps: d, maxInstruments: 10 });
    // Three fetches (11, 12, 13); before each, everything finished so far is saved.
    const sizes = updateBatchProgress.mock.calls.map((c) => (c[1] as unknown[]).length);
    expect(sizes).toEqual([10, 11, 12]);
  });
});
