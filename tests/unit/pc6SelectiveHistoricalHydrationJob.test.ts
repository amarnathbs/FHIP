// PC6/NAV 1.26 — unit tests for the selective historical hydration job.
// Every DB/network effect is injected, so these run with no live database
// and no network call.

import { describe, it, expect, vi } from 'vitest';
import { runSelectiveHistoricalHydration, HISTORICAL_FLOOR_DATE, type HydrationDeps } from '@/lib/services/investment-intelligence/pc6/selectiveHistoricalHydrationJob';
import type { HistoricalNavAdapter, HistoricalNavAdapterResult } from '@/lib/services/investment-intelligence/pc6/adapters/historicalNavAdapter';

const C = '2026-09-21';

function makeDeps(overrides: Partial<HydrationDeps> = {}): HydrationDeps {
  return {
    isEnabled: vi.fn().mockResolvedValue({ enabled: true, reason: null }),
    fetchAcceptedDependencies: vi.fn().mockResolvedValue(new Map()),
    fetchBenchmarkDependencies: vi.fn().mockResolvedValue(new Map()),
    fetchEarliestExistingDate: vi.fn().mockResolvedValue(null),
    fetchAdapterIdentifier: vi.fn().mockResolvedValue('119551'),
    fetchExistingObservations: vi.fn().mockResolvedValue(new Map()),
    writeRows: vi.fn().mockResolvedValue({ inserted: 0, error: null }),
    recordBatch: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeAdapter(result: HistoricalNavAdapterResult): HistoricalNavAdapter {
  return { providerKey: 'test', adapterVersion: '1', fetchHistory: vi.fn().mockResolvedValue(result) };
}

describe('runSelectiveHistoricalHydration', () => {
  it('refuses to run when the kill switch is disabled, without touching any other dependency', async () => {
    const deps = makeDeps({ isEnabled: vi.fn().mockResolvedValue({ enabled: false, reason: 'deferred human-present step' }) });
    const result = await runSelectiveHistoricalHydration({ changeoverDate: C, adapter: makeAdapter({} as HistoricalNavAdapterResult), deps });
    expect(result.status).toBe('skipped_kill_switch');
    expect(deps.fetchAcceptedDependencies).not.toHaveBeenCalled();
  });

  it('reports zero work when there are no dependencies at all', async () => {
    const deps = makeDeps();
    const result = await runSelectiveHistoricalHydration({ changeoverDate: C, adapter: makeAdapter({} as HistoricalNavAdapterResult), deps });
    expect(result.status).toBe('succeeded');
    expect(result.instrumentsNeedingHydration).toBe(0);
  });

  it('skips an instrument whose existing coverage already satisfies the requirement', async () => {
    const deps = makeDeps({
      fetchAcceptedDependencies: vi.fn().mockResolvedValue(new Map([
        ['inst-1', { instrumentId: 'inst-1', isAccepted: true, historyCompleteness: 'complete_from_known_opening_balance', earliestTransactionDate: '2020-01-01', certifiedAsOfDate: null }],
      ])),
      fetchEarliestExistingDate: vi.fn().mockResolvedValue('2019-06-01'), // already covers 2020-01-01
    });
    const result = await runSelectiveHistoricalHydration({ changeoverDate: C, adapter: makeAdapter({} as HistoricalNavAdapterResult), deps });
    expect(result.instrumentsAlreadyCovered).toBe(1);
    expect(result.instrumentsHydrated).toBe(0);
    expect(result.perInstrument[0].outcome).toBe('already_covered');
  });

  it('hydrates a real gap: fetches, applies decideUpsert, and writes only genuinely new rows', async () => {
    const deps = makeDeps({
      fetchBenchmarkDependencies: vi.fn().mockResolvedValue(new Map([['inst-2', { instrumentId: 'inst-2', everBenchmarked: true }]])),
      fetchEarliestExistingDate: vi.fn().mockResolvedValue('2015-01-01'),
    });
    const adapter = makeAdapter({
      ok: true, schemeIdentifier: '119551', providerSchemeName: 'Test Fund', coverage: 'unknown',
      observations: [{ date: '2014-12-30', nav: '10.5' }, { date: '2014-12-31', nav: '10.6' }],
      provider: { key: 'tigzig', adapterVersion: '1', requestUrl: 'x', httpStatus: 200, retrievedAt: 'now', rawResponseChecksum: 'abcdef123456' },
    });
    const result = await runSelectiveHistoricalHydration({ changeoverDate: C, adapter, deps });
    expect(deps.writeRows).toHaveBeenCalledTimes(1);
    const writtenRows = (deps.writeRows as any).mock.calls[0][0];
    expect(writtenRows).toHaveLength(2);
    expect(writtenRows[0].instrumentId).toBe('inst-2');
    expect(deps.recordBatch).toHaveBeenCalledTimes(1);
  });

  it('never fetches on or after the changeover date', async () => {
    const deps = makeDeps({
      fetchBenchmarkDependencies: vi.fn().mockResolvedValue(new Map([['inst-3', { instrumentId: 'inst-3', everBenchmarked: true }]])),
      fetchEarliestExistingDate: vi.fn().mockResolvedValue(null), // no coverage at all -> window is [floor, C-1]
    });
    const adapter = makeAdapter({
      ok: true, schemeIdentifier: '119551', providerSchemeName: null, coverage: 'unknown', observations: [],
      provider: { key: 'tigzig', adapterVersion: '1', requestUrl: 'x', httpStatus: 200, retrievedAt: 'now', rawResponseChecksum: 'abcdef123456' },
    });
    await runSelectiveHistoricalHydration({ changeoverDate: C, adapter, deps });
    const call = (adapter.fetchHistory as any).mock.calls[0][0];
    expect(call.fromDate).toBe(HISTORICAL_FLOOR_DATE);
    expect(call.toDate).toBe('2026-09-20'); // C minus one day
  });

  it('records a fetch failure without writing anything', async () => {
    const deps = makeDeps({
      fetchBenchmarkDependencies: vi.fn().mockResolvedValue(new Map([['inst-4', { instrumentId: 'inst-4', everBenchmarked: true }]])),
    });
    const adapter = makeAdapter({
      ok: false, schemeIdentifier: '119551', kind: 'not_found', detail: 'zero observations',
      provider: { key: 'tigzig', adapterVersion: '1', requestUrl: 'x', httpStatus: 200, retrievedAt: 'now' },
    });
    const result = await runSelectiveHistoricalHydration({ changeoverDate: C, adapter, deps });
    expect(result.instrumentsFailed).toBe(1);
    expect(deps.writeRows).not.toHaveBeenCalled();
  });

  it('a dry run plans without calling the adapter or writing', async () => {
    const deps = makeDeps({
      fetchBenchmarkDependencies: vi.fn().mockResolvedValue(new Map([['inst-5', { instrumentId: 'inst-5', everBenchmarked: true }]])),
    });
    const adapter = makeAdapter({} as HistoricalNavAdapterResult);
    const result = await runSelectiveHistoricalHydration({ changeoverDate: C, adapter, deps, dryRun: true });
    expect(adapter.fetchHistory).not.toHaveBeenCalled();
    expect(deps.writeRows).not.toHaveBeenCalled();
    expect(deps.recordBatch).not.toHaveBeenCalled();
    expect(result.perInstrument[0].outcome).toBe('planned_dry_run');
  });

  it('respects maxInstruments while still reporting the true total needing hydration', async () => {
    const deps = makeDeps({
      fetchBenchmarkDependencies: vi.fn().mockResolvedValue(new Map([
        ['inst-a', { instrumentId: 'inst-a', everBenchmarked: true }],
        ['inst-b', { instrumentId: 'inst-b', everBenchmarked: true }],
      ])),
    });
    const adapter = makeAdapter({
      ok: true, schemeIdentifier: 'x', providerSchemeName: null, coverage: 'unknown', observations: [],
      provider: { key: 'tigzig', adapterVersion: '1', requestUrl: 'x', httpStatus: 200, retrievedAt: 'now', rawResponseChecksum: 'abcdef123456' },
    });
    const result = await runSelectiveHistoricalHydration({ changeoverDate: C, adapter, deps, maxInstruments: 1 });
    expect(result.instrumentsNeedingHydration).toBe(2);
    expect((adapter.fetchHistory as any).mock.calls.length).toBe(1);
  });
});
