/**
 * NAV 1 Stage D (D.9 follow-up) — each hydration run claims itself.
 *
 * The second real production run (2026-09-24) was ended by the platform with
 * nothing recorded: the batch row was only ever written at the END. A run now
 * opens a 'running' batch first, records progress after each instrument, and
 * refuses to overlap a run that is still genuinely in flight.
 *
 * The claim/reconcile database logic reuses the PC6 ingest job's tested
 * reconcileStaleRunningBatches(); it is exercised against production by the
 * server proof run. This file covers the job's use of it.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  runSelectiveHistoricalHydration,
  type HydrationDeps,
  type PerInstrumentOutcome,
} from '@/lib/services/investment-intelligence/pc6/selectiveHistoricalHydrationJob';
import type { HistoricalNavAdapter } from '@/lib/services/investment-intelligence/pc6/adapters/historicalNavAdapter';
import { userHeldInstrumentsToDependencies } from '@/lib/services/investment-intelligence/pc6/navRetentionPolicy';

const notFound: HistoricalNavAdapter = {
  providerKey: 'sim', adapterVersion: 'v',
  fetchHistory: async (r) => ({
    ok: false, schemeIdentifier: r.schemeIdentifier, kind: 'not_found', detail: 'none',
    provider: { key: 'sim', adapterVersion: 'v', requestUrl: null, httpStatus: 200, retrievedAt: 'now' },
  }),
};

function deps(over: Partial<HydrationDeps> = {}) {
  const calls = {
    claimBatch: vi.fn().mockResolvedValue({ batchId: 'batch-1', blocked: null, error: null }),
    updateBatchProgress: vi.fn().mockResolvedValue(undefined),
    recordBatch: vi.fn().mockResolvedValue({ error: null }),
    fetchAcceptedDependencies: vi.fn().mockResolvedValue(userHeldInstrumentsToDependencies(['i1', 'i2', 'i3'])),
  };
  const d: HydrationDeps = {
    isEnabled: async () => ({ enabled: true, reason: null }),
    fetchAcceptedDependencies: calls.fetchAcceptedDependencies,
    fetchBenchmarkDependencies: async () => new Map(),
    fetchEarliestExistingDate: async () => '2018-03-01', // each instrument: one request, then a floor
    fetchAdapterIdentifier: async () => '149366',
    fetchExistingObservations: async () => new Map(),
    writeRows: async (rows) => ({ inserted: rows.length, error: null }),
    fetchHistoryFloor: async () => null,
    recordHistoryFloor: async () => ({ error: null }),
    claimBatch: calls.claimBatch,
    updateBatchProgress: calls.updateBatchProgress,
    recordBatch: calls.recordBatch,
    ...over,
  };
  return { d, calls };
}

describe('a run claims itself before doing any work', () => {
  it('refuses to overlap a run still in flight -- and does nothing else at all', async () => {
    const { d, calls } = deps({ claimBatch: vi.fn().mockResolvedValue({ batchId: null, blocked: 'A batch is still genuinely running', error: null }) });
    const fetchHistory = vi.fn();
    const res = await runSelectiveHistoricalHydration({ changeoverDate: '2026-09-21', adapter: { ...notFound, fetchHistory }, deps: d });
    expect(res.status).toBe('skipped_already_running');
    expect(res.detail).toContain('still genuinely running');
    expect(calls.fetchAcceptedDependencies).not.toHaveBeenCalled();
    expect(fetchHistory).not.toHaveBeenCalled();
    expect(calls.recordBatch).not.toHaveBeenCalled();
  });

  it('closes the SAME batch it opened', async () => {
    const { d, calls } = deps();
    await runSelectiveHistoricalHydration({ changeoverDate: '2026-09-21', adapter: notFound, deps: d });
    expect(calls.claimBatch).toHaveBeenCalledTimes(1);
    expect(calls.recordBatch).toHaveBeenCalledTimes(1);
    expect(calls.recordBatch.mock.calls[0][1]).toBe('batch-1');
  });

  it('records progress before each later instrument, so a killed run still shows how far it got', async () => {
    const { d, calls } = deps();
    await runSelectiveHistoricalHydration({ changeoverDate: '2026-09-21', adapter: notFound, deps: d });
    // Three instruments: progress is written before the 2nd and the 3rd.
    const sizes = calls.updateBatchProgress.mock.calls.map((c) => (c[1] as PerInstrumentOutcome[]).length);
    expect(sizes).toEqual([1, 2]);
    expect(calls.updateBatchProgress.mock.calls.every((c) => c[0] === 'batch-1')).toBe(true);
  });

  it('if the running batch cannot be opened, the run still proceeds and says so', async () => {
    const { d, calls } = deps({ claimBatch: vi.fn().mockResolvedValue({ batchId: null, blocked: null, error: 'insert failed' }) });
    const res = await runSelectiveHistoricalHydration({ changeoverDate: '2026-09-21', adapter: notFound, deps: d });
    expect(res.status).toBe('succeeded');
    expect(res.detail).toContain("no 'running' batch could be opened");
    expect(calls.updateBatchProgress).not.toHaveBeenCalled();
    expect(calls.recordBatch.mock.calls[0][1]).toBeNull(); // falls back to inserting at the end
  });

  it('a dry run claims nothing and records nothing', async () => {
    const { d, calls } = deps();
    await runSelectiveHistoricalHydration({ changeoverDate: '2026-09-21', adapter: notFound, deps: d, dryRun: true });
    expect(calls.claimBatch).not.toHaveBeenCalled();
    expect(calls.recordBatch).not.toHaveBeenCalled();
  });

  it('with the kill switch off, it does not even claim', async () => {
    const { d, calls } = deps({ isEnabled: async () => ({ enabled: false, reason: 'off' }) });
    const res = await runSelectiveHistoricalHydration({ changeoverDate: '2026-09-21', adapter: notFound, deps: d });
    expect(res.status).toBe('skipped_kill_switch');
    expect(calls.claimBatch).not.toHaveBeenCalled();
  });
});
