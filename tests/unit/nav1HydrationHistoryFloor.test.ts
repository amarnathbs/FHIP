/**
 * NAV 1 Stage D (D.4 prerequisite) — the per-instrument history floor (0190).
 *
 * Hydration walks an instrument's history back to AMFI's 2006 floor, newest
 * window first, and stops at the first window with no data. For a fund
 * launched later, that empty pre-launch window used to be re-requested on
 * EVERY run -- a fund-house download each time once AMFI became primary.
 *
 * These tests drive the real job against a simulated provider for a fund
 * launched on 2018-03-01. The central check compares a second run WITH the
 * recorded floor against the same run WITHOUT it: the floor is proven by the
 * request it removes, not by reading the code.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  runSelectiveHistoricalHydration,
  type HydrationDeps,
  type HydrationWriteRow,
} from '@/lib/services/investment-intelligence/pc6/selectiveHistoricalHydrationJob';
import type {
  HistoricalNavAdapter,
  HistoricalNavAdapterResult,
  HistoricalNavRequest,
} from '@/lib/services/investment-intelligence/pc6/adapters/historicalNavAdapter';
import { userHeldInstrumentsToDependencies } from '@/lib/services/investment-intelligence/pc6/navRetentionPolicy';

const C = '2026-09-21';
const LAUNCH = '2018-03-01';
const INSTRUMENT = 'inst-launched-2018';

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** A provider whose fund publishes weekly from LAUNCH onward, and knows nothing before it. */
function launchedFund(kind: 'not_found' | 'http_error' = 'not_found', launch = LAUNCH) {
  const requests: HistoricalNavRequest[] = [];
  const adapter: HistoricalNavAdapter = {
    providerKey: 'sim',
    adapterVersion: 'sim-v1',
    async fetchHistory(r): Promise<HistoricalNavAdapterResult> {
      requests.push(r);
      const obs: { date: string; nav: string }[] = [];
      for (let d = r.fromDate > launch ? r.fromDate : launch; d <= r.toDate; d = addDays(d, 7)) obs.push({ date: d, nav: '10.0' });
      if (obs.length === 0) {
        return {
          ok: false, schemeIdentifier: r.schemeIdentifier, kind, detail: `${kind} for [${r.fromDate}, ${r.toDate}]`,
          provider: { key: 'sim', adapterVersion: 'sim-v1', requestUrl: null, httpStatus: kind === 'http_error' ? 503 : 200, retrievedAt: 'now' },
        };
      }
      return {
        ok: true, schemeIdentifier: r.schemeIdentifier, providerSchemeName: null, observations: obs, coverage: 'unknown',
        provider: { key: 'sim', adapterVersion: 'sim-v1', requestUrl: 'x', httpStatus: 200, retrievedAt: 'now', rawResponseChecksum: 'simchecksum00' },
      };
    },
  };
  return { adapter, requests };
}

function deps(over: Partial<HydrationDeps> = {}) {
  const written: HydrationWriteRow[] = [];
  const recordHistoryFloor = vi.fn().mockResolvedValue({ error: null });
  const d: HydrationDeps = {
    isEnabled: async () => ({ enabled: true, reason: null }),
    fetchAcceptedDependencies: async () => userHeldInstrumentsToDependencies([INSTRUMENT]),
    fetchBenchmarkDependencies: async () => new Map(),
    fetchEarliestExistingDate: async () => null,
    fetchAdapterIdentifier: async () => '149366',
    fetchExistingObservations: async () => new Map(),
    writeRows: async (rows) => { written.push(...rows); return { inserted: rows.length, error: null }; },
    recordBatch: async () => ({ error: null }),
    fetchHistoryFloor: async () => null,
    recordHistoryFloor,
    ...over,
  };
  return { d, written, recordHistoryFloor };
}

describe('the first run discovers and records where history starts', () => {
  it('walks back past the launch, records the floor, and reports success -- not a partial failure', async () => {
    const { adapter } = launchedFund();
    const { d, recordHistoryFloor } = deps();
    const res = await runSelectiveHistoricalHydration({ changeoverDate: C, adapter, deps: d });
    const out = res.perInstrument[0];
    expect(out.outcome).toBe('hydrated');
    expect(out.historyFloorRecorded).toBe(LAUNCH);
    expect(recordHistoryFloor).toHaveBeenCalledTimes(1);
    expect(recordHistoryFloor.mock.calls[0][1]).toBe(LAUNCH);
    expect(res.instrumentsPartiallyHydrated).toBe(0);
    expect(res.instrumentsFailed).toBe(0);
  });
});

describe('the floor stops the empty window being requested again', () => {
  // Second run: rows now exist from LAUNCH onward.
  const secondRun = async (floor: string | null) => {
    const { adapter, requests } = launchedFund();
    const { d } = deps({
      fetchEarliestExistingDate: async () => LAUNCH,
      fetchHistoryFloor: async () => floor,
    });
    const res = await runSelectiveHistoricalHydration({ changeoverDate: C, adapter, deps: d });
    return { res, requests };
  };

  it('WITHOUT a floor, the second run re-requests the empty pre-launch window (the defect)', async () => {
    const { requests } = await secondRun(null);
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((r) => r.toDate < LAUNCH)).toBe(true); // every request is for data that does not exist
  });

  it('WITH the floor, the second run makes no request at all', async () => {
    const { res, requests } = await secondRun(LAUNCH);
    expect(requests).toHaveLength(0);
    expect(res.perInstrument[0].outcome).toBe('already_covered');
    expect(res.perInstrument[0].detail).toContain('the recorded history floor');
  });
});

describe('a floor is recorded ONLY for "walked past the start", never for anything else', () => {
  it('an unknown scheme -- not found, and no data anywhere -- is NOT frozen out', async () => {
    const { adapter } = launchedFund('not_found', '2999-01-01'); // provider knows nothing
    const { d, recordHistoryFloor } = deps();
    const res = await runSelectiveHistoricalHydration({ changeoverDate: C, adapter, deps: d });
    expect(recordHistoryFloor).not.toHaveBeenCalled();
    expect(res.perInstrument[0].outcome).toBe('fetch_failed');
  });

  it('a real provider error before the launch is NOT treated as the start of history', async () => {
    const { adapter } = launchedFund('http_error');
    const { d, recordHistoryFloor } = deps();
    const res = await runSelectiveHistoricalHydration({ changeoverDate: C, adapter, deps: d });
    expect(recordHistoryFloor).not.toHaveBeenCalled();
    expect(res.perInstrument[0].outcome).toBe('partially_hydrated');
  });

  it('existing newer data plus an empty adjacent window records the floor at the existing earliest date, in one request', async () => {
    const { adapter, requests } = launchedFund();
    const { d, recordHistoryFloor } = deps({ fetchEarliestExistingDate: async () => LAUNCH });
    const res = await runSelectiveHistoricalHydration({ changeoverDate: C, adapter, deps: d });
    expect(requests).toHaveLength(1);
    expect(recordHistoryFloor.mock.calls[0][1]).toBe(LAUNCH);
    expect(res.perInstrument[0].outcome).toBe('already_covered');
  });

  it('a dry run honours the floor but never records one', async () => {
    const { adapter, requests } = launchedFund();
    const { d, recordHistoryFloor } = deps({
      fetchEarliestExistingDate: async () => '2020-01-01',
      fetchHistoryFloor: async () => LAUNCH,
    });
    const res = await runSelectiveHistoricalHydration({ changeoverDate: C, adapter, deps: d, dryRun: true });
    expect(res.perInstrument[0].detail).toContain(`would fetch [${LAUNCH}, 2019-12-31]`);
    expect(requests).toHaveLength(0);
    expect(recordHistoryFloor).not.toHaveBeenCalled();
  });

  it('a floor that fails to save leaves the instrument hydrated, and says so', async () => {
    const { adapter } = launchedFund();
    const { d } = deps({ recordHistoryFloor: vi.fn().mockResolvedValue({ error: 'permission denied' }) });
    const res = await runSelectiveHistoricalHydration({ changeoverDate: C, adapter, deps: d });
    expect(res.perInstrument[0].outcome).toBe('hydrated');
    expect(res.perInstrument[0].historyFloorRecorded).toBeUndefined();
    expect(res.perInstrument[0].detail).toContain('could not be saved');
  });
});

describe('hydration never requests on or after the changeover date', () => {
  it('even for a fund whose earliest row is itself after the changeover', async () => {
    const { adapter, requests } = launchedFund('not_found', '2026-10-05');
    const { d } = deps({ fetchEarliestExistingDate: async () => '2026-10-05' });
    await runSelectiveHistoricalHydration({ changeoverDate: C, adapter, deps: d });
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((r) => r.toDate < C)).toBe(true);
  });
});
