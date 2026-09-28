/**
 * NAV 1 production incident (2026-09-28) -- a leftover synthetic test
 * fixture (AMFI code 999999, "NAV1 P4 Unresolvable Test Scheme") left an
 * accepted-statement dependency in PRODUCTION on a scheme neither AMFI nor
 * TIGZIG will ever resolve. Every 30-minute hydration tick retried it with
 * the FULL budget (TIGZIG: up to 6 attempts x 60s each), and the batch
 * history shows at least one run (13:30 UTC, 2026-09-28) stalled the full
 * 30-minute stale-running window before being reconciled as abandoned --
 * consistent with the platform killing the invocation mid-fetch before it
 * ever reached the ledger write, silently dropping that tick's attempt
 * record.
 *
 * FIX: once an instrument's own attempt ledger already shows
 * HYDRATION_PERSISTENT_FAILURE_THRESHOLD+ consecutive failures, the job asks
 * the adapter with a small, bounded retry budget (HistoricalNavRequest.
 * retryBudget) instead of the provider's full default -- enough to notice a
 * provider that starts answering again, without risking the run.
 */

import { describe, expect, it } from 'vitest';
import {
  HYDRATION_PERSISTENT_FAILURE_THRESHOLD,
  runSelectiveHistoricalHydration,
  type HydrationAttemptRecord,
  type HydrationDeps,
} from '@/lib/services/investment-intelligence/pc6/selectiveHistoricalHydrationJob';
import type { HistoricalNavAdapter, HistoricalNavAdapterResult, HistoricalNavRequest } from '@/lib/services/investment-intelligence/pc6/adapters/historicalNavAdapter';
import { userHeldInstrumentsToDependencies } from '@/lib/services/investment-intelligence/pc6/navRetentionPolicy';

const C = '2026-09-21';

function makeDeps(ledgerSeed: Map<string, HydrationAttemptRecord>, held: string[]): { deps: HydrationDeps; ledger: Map<string, HydrationAttemptRecord> } {
  const ledger = new Map(ledgerSeed);
  const deps: HydrationDeps = {
    isEnabled: async () => ({ enabled: true, reason: null }),
    fetchAcceptedDependencies: async () => userHeldInstrumentsToDependencies(held),
    fetchBenchmarkDependencies: async () => new Map(),
    fetchEarliestExistingDate: async () => null,
    fetchAdapterIdentifier: async (id) => id,
    fetchExistingObservations: async () => new Map(),
    writeRows: async (rows) => ({ inserted: rows.length, error: null }),
    claimBatch: async (startedAt) => ({ batchId: 'batch-1', blocked: null, error: null }),
    updateBatchProgress: async () => {},
    recordBatch: async () => ({ error: null }),
    fetchHistoryFloor: async () => null,
    recordHistoryFloor: async () => ({ error: null }),
    fetchAttemptLedger: async () => ({ records: new Map(ledger), error: null }),
    recordAttempt: async (record) => { ledger.set(record.instrumentId, record); return { error: null }; },
  };
  return { deps, ledger };
}

function recordingAdapter() {
  const requests: HistoricalNavRequest[] = [];
  const provider = { key: 'sim', adapterVersion: 'sim', requestUrl: null, httpStatus: 200, retrievedAt: 'now' };
  const adapter: HistoricalNavAdapter = {
    providerKey: 'sim', adapterVersion: 'sim',
    fetchHistory: async (r): Promise<HistoricalNavAdapterResult> => {
      requests.push(r);
      return { ok: false, schemeIdentifier: r.schemeIdentifier, kind: 'not_found', detail: 'never resolvable', provider };
    },
  };
  return { adapter, requests };
}

describe('NAV 1 incident fix: reduced retry budget for an already-persistently-failing instrument', () => {
  it('a fresh instrument (no ledger history) is fetched with NO retryBudget override (provider default applies)', async () => {
    const { deps } = makeDeps(new Map(), ['bad-scheme']);
    const { adapter, requests } = recordingAdapter();
    await runSelectiveHistoricalHydration({ changeoverDate: C, adapter, deps });
    expect(requests).toHaveLength(1);
    expect(requests[0].retryBudget).toBeUndefined();
  });

  it('an instrument below the persistent-failure threshold still gets the full budget', async () => {
    const seed = new Map<string, HydrationAttemptRecord>([
      ['bad-scheme', { instrumentId: 'bad-scheme', lastAttemptedAt: '2026-09-28T05:00:00.000Z', lastOutcome: 'fetch_failed', consecutiveFailures: HYDRATION_PERSISTENT_FAILURE_THRESHOLD - 1, attemptsTotal: HYDRATION_PERSISTENT_FAILURE_THRESHOLD - 1, lastSuccessAt: null }],
    ]);
    const { deps } = makeDeps(seed, ['bad-scheme']);
    const { adapter, requests } = recordingAdapter();
    await runSelectiveHistoricalHydration({ changeoverDate: C, adapter, deps });
    expect(requests[0].retryBudget).toBeUndefined();
  });

  it('an instrument AT the persistent-failure threshold gets a small, bounded retry budget', async () => {
    const seed = new Map<string, HydrationAttemptRecord>([
      ['bad-scheme', { instrumentId: 'bad-scheme', lastAttemptedAt: '2026-09-28T05:00:00.000Z', lastOutcome: 'fetch_failed', consecutiveFailures: HYDRATION_PERSISTENT_FAILURE_THRESHOLD, attemptsTotal: HYDRATION_PERSISTENT_FAILURE_THRESHOLD, lastSuccessAt: null }],
    ]);
    const { deps } = makeDeps(seed, ['bad-scheme']);
    const { adapter, requests } = recordingAdapter();
    const result = await runSelectiveHistoricalHydration({ changeoverDate: C, adapter, deps });
    expect(requests[0].retryBudget).toEqual({ maxAttempts: 1, timeoutMs: 20_000 });
    // The instrument is still genuinely attempted and its failure still
    // recorded -- this is a cost reduction, not a silent skip.
    expect(result.instrumentsFailed).toBe(1);
  });

  it('an instrument well past the threshold (the real production case: 12 consecutive failures) still gets the bounded budget, never the full one', async () => {
    const seed = new Map<string, HydrationAttemptRecord>([
      ['bad-scheme', { instrumentId: 'bad-scheme', lastAttemptedAt: '2026-09-28T13:32:00.000Z', lastOutcome: 'fetch_failed', consecutiveFailures: 12, attemptsTotal: 12, lastSuccessAt: null }],
    ]);
    const { deps } = makeDeps(seed, ['bad-scheme']);
    const { adapter, requests } = recordingAdapter();
    await runSelectiveHistoricalHydration({ changeoverDate: C, adapter, deps });
    expect(requests[0].retryBudget).toEqual({ maxAttempts: 1, timeoutMs: 20_000 });
  });
});
