/**
 * NAV 1 Stage D (D.9) — the hydration batch record.
 *
 * Found by the first real production hydration run on 2026-09-24: it
 * recorded three history floors and NO batch row. The live code inserted a
 * payload that violated both of ii_reference_import_batches' check
 * constraints (terminal status without finished_at; 'failed' without
 * error_code) and discarded the error. No real hydration run had ever been
 * recorded.
 *
 * The constraint half is proven against real Postgres by
 * scripts/nav1_hydration_batch_row_pglite_verification.ts, which also runs the
 * OLD payload as a negative control. This file covers the row's content and
 * the job's handling of a failed save.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  buildHydrationBatchRow,
  HYDRATION_NOTHING_SUCCEEDED_ERROR_CODE,
  runSelectiveHistoricalHydration,
  type HydrationDeps,
  type HydrationJobResult,
} from '@/lib/services/investment-intelligence/pc6/selectiveHistoricalHydrationJob';
import type { HistoricalNavAdapter } from '@/lib/services/investment-intelligence/pc6/adapters/historicalNavAdapter';
import { userHeldInstrumentsToDependencies } from '@/lib/services/investment-intelligence/pc6/navRetentionPolicy';

const summary = (over: Partial<HydrationJobResult> = {}): HydrationJobResult => ({
  status: 'succeeded',
  instrumentsConsidered: 3, instrumentsNeedingHydration: 3, instrumentsAlreadyCovered: 0,
  instrumentsHydrated: 0, instrumentsPartiallyHydrated: 0, instrumentsFailed: 0, totalRowsInserted: 0,
  detail: 'test run', perInstrument: [],
  startedAt: '2026-09-24T09:36:59.000Z', finishedAt: '2026-09-24T09:42:00.000Z',
  ...over,
});

describe('buildHydrationBatchRow', () => {
  it('a finished run carries both its start and finish (terminal_has_finish)', () => {
    const row = buildHydrationBatchRow(summary({ instrumentsAlreadyCovered: 3 }));
    expect(row.status).toBe('succeeded');
    expect(row.started_at).toBe('2026-09-24T09:36:59.000Z');
    expect(row.finished_at).toBe('2026-09-24T09:42:00.000Z');
    expect(row.error_code).toBeNull();
  });

  it('a run where nothing succeeded is failed, WITH an error code and detail (failed_has_error)', () => {
    const row = buildHydrationBatchRow(summary({ instrumentsFailed: 3, detail: 'three fetch failures' }));
    expect(row.status).toBe('failed');
    expect(row.error_code).toBe(HYDRATION_NOTHING_SUCCEEDED_ERROR_CODE);
    expect(row.error_detail).toBe('three fetch failures');
  });

  it('a run that recorded floors for some instruments and failed on one is NOT logged as a total failure', () => {
    // Exactly today's first real run, had one of the three failed: two floors
    // are 'already covered' outcomes. The old rule called that 'failed'.
    const row = buildHydrationBatchRow(summary({ instrumentsAlreadyCovered: 2, instrumentsFailed: 1 }));
    expect(row.status).toBe('succeeded');
    expect(row.error_code).toBeNull();
  });

  it('is logged under AMFI, the primary source since D.3', () => {
    const row = buildHydrationBatchRow(summary());
    expect([row.source_key, row.source_config_id, row.batch_kind]).toEqual(['amfi', 'amfi_nav_history', 'nav_history']);
    expect(row.notes.sources.perRowProvider).toBe('data_version');
  });
});

describe('the job never loses a failed batch save silently', () => {
  const adapter: HistoricalNavAdapter = {
    providerKey: 'sim', adapterVersion: 'v1',
    fetchHistory: async (r) => ({
      ok: false, schemeIdentifier: r.schemeIdentifier, kind: 'not_found', detail: 'none',
      provider: { key: 'sim', adapterVersion: 'v1', requestUrl: null, httpStatus: 200, retrievedAt: 'now' },
    }),
  };
  const deps = (recordBatch: HydrationDeps['recordBatch']): HydrationDeps => ({
    isEnabled: async () => ({ enabled: true, reason: null }),
    fetchAcceptedDependencies: async () => userHeldInstrumentsToDependencies(['i1']),
    fetchBenchmarkDependencies: async () => new Map(),
    fetchEarliestExistingDate: async () => '2018-03-01',
    fetchAdapterIdentifier: async () => '149366',
    fetchExistingObservations: async () => new Map(),
    writeRows: async (rows) => ({ inserted: rows.length, error: null }),
    recordBatch,
    fetchHistoryFloor: async () => null,
    recordHistoryFloor: async () => ({ error: null }),
  });

  it('surfaces the insert error in the result and its detail, without undoing the run', async () => {
    const res = await runSelectiveHistoricalHydration({
      changeoverDate: '2026-09-21', adapter,
      deps: deps(async () => ({ error: 'new row violates check constraint "ii_reference_import_batches_terminal_has_finish" (23514)' })),
    });
    expect(res.batchRecordError).toContain('terminal_has_finish');
    expect(res.detail).toContain('BATCH RECORD NOT SAVED');
    expect(res.status).toBe('succeeded'); // the run's own work still stands
  });

  it('records timestamps on every result, including a dry run, and a dry run never saves a batch', async () => {
    const recordBatch = vi.fn().mockResolvedValue({ error: null });
    const res = await runSelectiveHistoricalHydration({ changeoverDate: '2026-09-21', adapter, deps: deps(recordBatch), dryRun: true });
    expect(recordBatch).not.toHaveBeenCalled();
    expect(res.startedAt <= res.finishedAt).toBe(true);
    expect(res.batchRecordError).toBeUndefined();
  });
});
