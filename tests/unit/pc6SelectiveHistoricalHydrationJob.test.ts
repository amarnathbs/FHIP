// PC6/NAV 1.26 — unit tests for the selective historical hydration job.
// Every DB/network effect is injected, so these run with no live database
// and no network call.

import { describe, it, expect, vi } from 'vitest';
import { runSelectiveHistoricalHydration, chunkDateWindow, HISTORICAL_FLOOR_DATE, MAX_FETCH_WINDOW_DAYS, type HydrationDeps } from '@/lib/services/investment-intelligence/pc6/selectiveHistoricalHydrationJob';
import { BENCHMARK_LOOKBACK_DAYS } from '@/lib/services/investment-intelligence/pc6/navRetentionPolicy';
import type { HistoricalNavAdapter, HistoricalNavAdapterResult } from '@/lib/services/investment-intelligence/pc6/adapters/historicalNavAdapter';

const C = '2026-09-21';

function subtractDaysForTest(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

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
    fetchHistoryFloor: vi.fn().mockResolvedValue(null),
    recordHistoryFloor: vi.fn().mockResolvedValue({ error: null }),
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
    // Existing coverage starts well AFTER the grounded benchmark lookback
    // boundary (BENCHMARK_LOOKBACK_DAYS back from C), so a real gap exists
    // for the job to fetch -- unlike the "already covered" test above, which
    // deliberately starts existing coverage BEFORE the requirement.
    const existingEarliest = subtractDaysForTest(C, BENCHMARK_LOOKBACK_DAYS - 30);
    const observationDate = subtractDaysForTest(existingEarliest, 1);
    const deps = makeDeps({
      fetchBenchmarkDependencies: vi.fn().mockResolvedValue(new Map([['inst-2', { instrumentId: 'inst-2', everBenchmarked: true }]])),
      fetchEarliestExistingDate: vi.fn().mockResolvedValue(existingEarliest),
    });
    const adapter = makeAdapter({
      ok: true, schemeIdentifier: '119551', providerSchemeName: 'Test Fund', coverage: 'unknown',
      observations: [{ date: subtractDaysForTest(observationDate, 1), nav: '10.5' }, { date: observationDate, nav: '10.6' }],
      provider: { key: 'tigzig', adapterVersion: '1', requestUrl: 'x', httpStatus: 200, retrievedAt: 'now', rawResponseChecksum: 'abcdef123456' },
    });
    const result = await runSelectiveHistoricalHydration({ changeoverDate: C, adapter, deps });
    expect(deps.writeRows).toHaveBeenCalledTimes(1);
    const writtenRows = (deps.writeRows as any).mock.calls[0][0];
    expect(writtenRows).toHaveLength(2);
    expect(writtenRows[0].instrumentId).toBe('inst-2');
    expect(deps.recordBatch).toHaveBeenCalledTimes(1);
  });

  it('never fetches on or after the changeover date, and a benchmark-only case uses the grounded lookback (not the inception floor)', async () => {
    const deps = makeDeps({
      fetchBenchmarkDependencies: vi.fn().mockResolvedValue(new Map([['inst-3', { instrumentId: 'inst-3', everBenchmarked: true }]])),
      fetchEarliestExistingDate: vi.fn().mockResolvedValue(null), // no coverage at all
    });
    const adapter = makeAdapter({
      ok: true, schemeIdentifier: '119551', providerSchemeName: null, coverage: 'unknown', observations: [],
      provider: { key: 'tigzig', adapterVersion: '1', requestUrl: 'x', httpStatus: 200, retrievedAt: 'now', rawResponseChecksum: 'abcdef123456' },
    });
    await runSelectiveHistoricalHydration({ changeoverDate: C, adapter, deps });
    const calls = (adapter.fetchHistory as any).mock.calls.map((c: any) => c[0]);
    // The overall window is now walked in bounded chunks (NAV 1.23), newest
    // first: the FIRST call's toDate is C-1, and the LAST call's fromDate is
    // the grounded rolling-window lookback boundary, NOT the unbounded
    // HISTORICAL_FLOOR_DATE (2006) — a real, code-grounded tightening (see
    // navRetentionPolicy.ts's BENCHMARK_LOOKBACK_DAYS header for the traced
    // formula).
    expect(calls[0].toDate).toBe('2026-09-20'); // C minus one day
    expect(calls.at(-1).fromDate).toBe(subtractDaysForTest(C, BENCHMARK_LOOKBACK_DAYS));
    expect(calls.at(-1).fromDate).not.toBe(HISTORICAL_FLOOR_DATE);
  });

  it('an accepted complete_from_inception dependency still uses the unbounded floor date, unaffected by the benchmark tightening', async () => {
    const deps = makeDeps({
      fetchAcceptedDependencies: vi.fn().mockResolvedValue(new Map([
        ['inst-6', { instrumentId: 'inst-6', isAccepted: true, historyCompleteness: 'complete_from_inception', earliestTransactionDate: null, certifiedAsOfDate: null }],
      ])),
      fetchEarliestExistingDate: vi.fn().mockResolvedValue(null),
    });
    const adapter = makeAdapter({
      ok: true, schemeIdentifier: '119551', providerSchemeName: null, coverage: 'unknown', observations: [],
      provider: { key: 'tigzig', adapterVersion: '1', requestUrl: 'x', httpStatus: 200, retrievedAt: 'now', rawResponseChecksum: 'abcdef123456' },
    });
    await runSelectiveHistoricalHydration({ changeoverDate: C, adapter, deps });
    const calls = (adapter.fetchHistory as any).mock.calls.map((c: any) => c[0]);
    // A ~20-year unbounded window is now chunked too (NAV 1.23) -- the last,
    // oldest chunk still correctly reaches the true floor date.
    expect(calls.at(-1).fromDate).toBe(HISTORICAL_FLOOR_DATE);
    expect(calls.length).toBeGreaterThan(1);
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
    expect(result.perInstrument).toHaveLength(1); // only ONE instrument actually processed, even though it needs the fetch chunked into several calls
  });

  it('a chunk that fails midway leaves earlier chunks committed and reports a precise resume point', async () => {
    const deps = makeDeps({
      fetchBenchmarkDependencies: vi.fn().mockResolvedValue(new Map([['inst-partial', { instrumentId: 'inst-partial', everBenchmarked: true }]])),
      fetchEarliestExistingDate: vi.fn().mockResolvedValue(null),
      writeRows: vi.fn().mockResolvedValue({ inserted: 1, error: null }),
    });
    // 3 chunks expected for the ~2030-day benchmark window at 730 days/chunk.
    // Succeed on the first (newest) chunk, fail on the second.
    let call = 0;
    const adapter: HistoricalNavAdapter = {
      providerKey: 'tigzig', adapterVersion: '1',
      fetchHistory: vi.fn().mockImplementation(async (req: any) => {
        call++;
        if (call === 1) {
          return {
            ok: true, schemeIdentifier: req.schemeIdentifier, providerSchemeName: null, coverage: 'unknown',
            observations: [{ date: req.toDate, nav: '100.0' }],
            provider: { key: 'tigzig', adapterVersion: '1', requestUrl: 'x', httpStatus: 200, retrievedAt: 'now', rawResponseChecksum: 'abcdef123456' },
          };
        }
        return { ok: false, schemeIdentifier: req.schemeIdentifier, kind: 'rate_limited', detail: 'simulated outage on chunk 2', provider: { key: 'tigzig', adapterVersion: '1', requestUrl: 'x', httpStatus: 429, retrievedAt: 'now' } };
      }),
    };
    const result = await runSelectiveHistoricalHydration({ changeoverDate: C, adapter, deps });
    expect(result.instrumentsPartiallyHydrated).toBe(1);
    expect(result.instrumentsFailed).toBe(0);
    const outcome = result.perInstrument[0];
    expect(outcome.outcome).toBe('partially_hydrated');
    expect(outcome.rowsInserted).toBe(1); // the one row from the successfully-completed first chunk
    expect(outcome.resumeFromDate).toBeDefined();
    // The committed chunk's write must have actually been called (not skipped).
    expect(deps.writeRows).toHaveBeenCalledTimes(1);
  });
});

describe('chunkDateWindow', () => {
  it('returns a single chunk when the window fits within maxDays', () => {
    const chunks = chunkDateWindow('2026-01-01', '2026-06-01', 365);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual({ fromDate: '2026-01-01', toDate: '2026-06-01' });
  });

  it('splits a large window into multiple descending-order chunks that exactly cover the range with no gaps or overlaps', () => {
    const chunks = chunkDateWindow('2020-01-01', '2026-01-01', MAX_FETCH_WINDOW_DAYS);
    expect(chunks.length).toBeGreaterThan(1);
    // Newest first.
    expect(chunks[0].toDate).toBe('2026-01-01');
    expect(chunks.at(-1)!.fromDate).toBe('2020-01-01');
    // No gaps: each chunk's fromDate is exactly one day after the next (older) chunk's toDate.
    for (let i = 0; i < chunks.length - 1; i++) {
      const prevFrom = new Date(`${chunks[i].fromDate}T00:00:00.000Z`);
      const nextTo = new Date(`${chunks[i + 1].toDate}T00:00:00.000Z`);
      expect(prevFrom.getTime() - nextTo.getTime()).toBe(86_400_000); // exactly 1 day apart
    }
    // No chunk exceeds maxDays.
    for (const c of chunks) {
      const days = (Date.parse(`${c.toDate}T00:00:00Z`) - Date.parse(`${c.fromDate}T00:00:00Z`)) / 86_400_000 + 1;
      expect(days).toBeLessThanOrEqual(MAX_FETCH_WINDOW_DAYS);
    }
  });

  it('handles a single-day window', () => {
    const chunks = chunkDateWindow('2026-01-01', '2026-01-01', 730);
    expect(chunks).toEqual([{ fromDate: '2026-01-01', toDate: '2026-01-01' }]);
  });
});
