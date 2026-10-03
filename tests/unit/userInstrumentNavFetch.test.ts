// PO decisions 2026-10-03: fetch a user's missing NAV history right away, for
// ONE scheme and ONE window, through the NAV 1 adapter contract and the
// hydration job's own insert rule. No live network: every adapter here is a fake.
//
// NAMED NEGATIVE CONTROLS
//   NC-B1  fetch is bounded to one instrument + window (no request leaves it).
//   NC-B2  failure never loses anything / never throws.
//   NC-B3  concurrent saves do ONE fetch.
//   NC-B4  no brute-force path is reachable from the new modules.
//   NC-B5  insert rule parity: provenance and "never overwrite a date on file" are
//          the hydration job's own (buildHydrationWriteRows), not a copy.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { HistoricalNavAdapter, HistoricalNavAdapterResult, HistoricalNavRequest } from '@/lib/services/investment-intelligence/pc6/adapters/historicalNavAdapter';
import { MAX_FETCH_WINDOW_DAYS, buildHydrationWriteRows, type HydrationWriteRow } from '@/lib/services/investment-intelligence/pc6/selectiveHistoricalHydrationJob';
import {
  USER_NAV_FETCH_MAX_CHUNKS,
  checkUserNavFetchRateLimit,
  fetchNavForOneInstrument,
  inFlightCount,
  singleFlight,
  type UserNavFetchDeps,
} from '@/lib/services/investment-intelligence/pc6/userInstrumentNavFetch';

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');
const ID = 'ins-1';
const days = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

function ok(req: HistoricalNavRequest, opts: { provider?: string; dates?: string[] } = {}): HistoricalNavAdapterResult {
  const dates = opts.dates ?? [req.fromDate, req.toDate];
  return {
    ok: true, schemeIdentifier: req.schemeIdentifier, providerSchemeName: 'X', coverage: 'unknown',
    observations: dates.map((d, i) => ({ date: d, nav: String(100 + i) })),
    provider: { key: opts.provider ?? 'amfi', adapterVersion: 'v1', requestUrl: 'x', httpStatus: 200, retrievedAt: 'now', rawResponseChecksum: 'abcdef0123456789abcdef' },
  };
}
const fail = (req: HistoricalNavRequest, kind: 'network' | 'not_found' | 'http_error' = 'network'): HistoricalNavAdapterResult => ({
  ok: false, schemeIdentifier: req.schemeIdentifier, kind, detail: `${kind} problem`,
  provider: { key: 'amfi', adapterVersion: 'v1', requestUrl: null, httpStatus: null, retrievedAt: 'now' },
});

function fakeAdapter(handler: (req: HistoricalNavRequest, n: number) => HistoricalNavAdapterResult | Promise<HistoricalNavAdapterResult>) {
  const requests: HistoricalNavRequest[] = [];
  const adapter: HistoricalNavAdapter = {
    providerKey: 'fake', adapterVersion: 'v1',
    async fetchHistory(req) { requests.push(req); return handler(req, requests.length); },
  };
  return { adapter, requests };
}

function fakeDeps(over: Partial<UserNavFetchDeps> & { existing?: Map<string, { value: string; recordChecksum: string; quality_status: 'ok' }> } = {}) {
  const written: HydrationWriteRow[][] = [];
  const floors: Array<{ id: string; date: string }> = [];
  const traps = {
    // Any of these being touched means the new path has grown a candidate-enumeration (brute-force) step.
    fetchAcceptedDependencies: vi.fn(() => { throw new Error('enumeration is not allowed'); }),
    fetchBenchmarkDependencies: vi.fn(() => { throw new Error('enumeration is not allowed'); }),
  };
  const deps: UserNavFetchDeps & typeof traps = {
    ...traps,
    isEnabled: async () => ({ enabled: true, reason: null }),
    fetchAdapterIdentifier: async (id: string) => (id === ID ? '119551' : null),
    fetchExistingObservations: async () => (over.existing ?? new Map()) as never,
    writeRows: async (rows: HydrationWriteRow[]) => { written.push(rows); return { inserted: rows.length, error: null }; },
    recordHistoryFloor: async (id: string, date: string) => { floors.push({ id, date }); return { error: null }; },
    ...over,
  } as never;
  return { deps, written, floors, traps };
}

describe('NC-B1: bounded to one instrument and one window', () => {
  it('every request is for the ONE scheme, inside the window, in chunks no wider than NAV 1\'s proven size', async () => {
    const { adapter, requests } = fakeAdapter((r) => ok(r));
    const { deps, traps } = fakeDeps();
    const out = await fetchNavForOneInstrument({ instrumentId: ID, fromDate: '2019-01-01', toDate: '2026-09-20', adapter, deps });
    expect(out.status).toBe('fetched');
    expect(requests.length).toBeGreaterThan(1);
    for (const r of requests) {
      expect(r.schemeIdentifier).toBe('119551');
      expect(r.fromDate >= '2019-01-01').toBe(true);
      expect(r.toDate <= '2026-09-20').toBe(true);
      expect(days(r.fromDate, r.toDate) + 1).toBeLessThanOrEqual(MAX_FETCH_WINDOW_DAYS);
      expect(r.retryBudget).toEqual({ maxAttempts: 2, timeoutMs: 12_000 }); // a small retry, bounded timeout
    }
    expect(traps.fetchAcceptedDependencies).not.toHaveBeenCalled();
    expect(traps.fetchBenchmarkDependencies).not.toHaveBeenCalled();
  });

  it('a very long gap is capped per call (resumed later), never one open-ended walk', async () => {
    const { adapter, requests } = fakeAdapter((r) => ok(r));
    const { deps } = fakeDeps();
    const out = await fetchNavForOneInstrument({ instrumentId: ID, fromDate: '2006-04-01', toDate: '2026-09-20', adapter, deps });
    expect(requests).toHaveLength(USER_NAV_FETCH_MAX_CHUNKS);
    expect(out).toMatchObject({ status: 'fetched', truncated: true, chunksPlanned: USER_NAV_FETCH_MAX_CHUNKS });
  });

  it('fetches NEWEST first and commits contiguous chunks (no hole behind an older chunk)', async () => {
    const { adapter, requests } = fakeAdapter((r) => ok(r));
    const { deps, written } = fakeDeps();
    await fetchNavForOneInstrument({ instrumentId: ID, fromDate: '2022-01-01', toDate: '2026-09-20', adapter, deps });
    const tos = requests.map((r) => r.toDate);
    expect([...tos].sort().reverse()).toEqual(tos); // descending
    for (let i = 1; i < requests.length; i++) expect(days(requests[i].toDate, requests[i - 1].fromDate)).toBe(1); // each older chunk ends the day before the newer starts
    expect(written.length).toBe(requests.length);
  });

  it('an instrument with no AMFI code is not fetched at all', async () => {
    const { adapter, requests } = fakeAdapter((r) => ok(r));
    const { deps } = fakeDeps();
    expect(await fetchNavForOneInstrument({ instrumentId: 'other', fromDate: '2024-01-01', toDate: '2024-02-01', adapter, deps })).toMatchObject({ status: 'unresolvable' });
    expect(requests).toHaveLength(0);
  });

  it('honours the NAV 1 kill switch: switched off means no request and no write', async () => {
    const { adapter, requests } = fakeAdapter((r) => ok(r));
    const { deps, written } = fakeDeps({ isEnabled: async () => ({ enabled: false, reason: 'ops stop' }) });
    expect(await fetchNavForOneInstrument({ instrumentId: ID, fromDate: '2024-01-01', toDate: '2024-02-01', adapter, deps })).toMatchObject({ status: 'disabled' });
    expect(requests).toHaveLength(0);
    expect(written).toHaveLength(0);
  });
});

describe('NC-B2: failure is a value; it never loses what is committed and never throws', () => {
  it('first chunk network failure: failed, nothing written', async () => {
    const { adapter } = fakeAdapter((r) => fail(r));
    const { deps, written } = fakeDeps();
    expect(await fetchNavForOneInstrument({ instrumentId: ID, fromDate: '2024-01-01', toDate: '2024-03-01', adapter, deps })).toMatchObject({ status: 'failed', rowsInserted: 0 });
    expect(written).toHaveLength(0);
  });

  it('source has no data: no_data (not a failure), nothing written', async () => {
    const { adapter } = fakeAdapter((r) => fail(r, 'not_found'));
    const { deps, written } = fakeDeps();
    expect(await fetchNavForOneInstrument({ instrumentId: ID, fromDate: '2024-01-01', toDate: '2024-03-01', adapter, deps })).toMatchObject({ status: 'no_data' });
    expect(written).toHaveLength(0);
    const { adapter: empty } = fakeAdapter((r) => ok(r, { dates: [] }));
    expect(await fetchNavForOneInstrument({ instrumentId: ID, fromDate: '2024-01-01', toDate: '2024-03-01', adapter: empty, deps })).toMatchObject({ status: 'no_data' });
  });

  it('an OLDER chunk failing keeps the newer chunks committed and reports a truncated fetch, not a failure', async () => {
    const { adapter } = fakeAdapter((r, n) => (n === 1 ? ok(r) : fail(r)));
    const { deps, written } = fakeDeps();
    const out = await fetchNavForOneInstrument({ instrumentId: ID, fromDate: '2019-01-01', toDate: '2026-09-20', adapter, deps });
    expect(out).toMatchObject({ status: 'fetched', chunksCompleted: 1, truncated: true });
    expect(written).toHaveLength(1);
  });

  it('a thrown error anywhere (adapter, existing-read, write) becomes a failed value', async () => {
    const throwing = fakeAdapter(() => { throw new Error('boom'); });
    expect(await fetchNavForOneInstrument({ instrumentId: ID, fromDate: '2024-01-01', toDate: '2024-02-01', adapter: throwing.adapter, deps: fakeDeps().deps })).toMatchObject({ status: 'failed' });
    const okAdapter = fakeAdapter((r) => ok(r));
    expect(await fetchNavForOneInstrument({ instrumentId: ID, fromDate: '2024-01-01', toDate: '2024-02-01', adapter: okAdapter.adapter, deps: fakeDeps({ fetchExistingObservations: async () => { throw new Error('db down'); } }).deps })).toMatchObject({ status: 'failed' });
    expect(await fetchNavForOneInstrument({ instrumentId: ID, fromDate: '2024-01-01', toDate: '2024-02-01', adapter: okAdapter.adapter, deps: fakeDeps({ writeRows: async () => ({ inserted: 0, error: 'write refused' }) }).deps })).toMatchObject({ status: 'failed', detail: expect.stringContaining('write failed') });
  });

  it('a source that never answers is cut off by the deadline (bounded timeout), as a failure', async () => {
    const { adapter } = fakeAdapter(() => new Promise<HistoricalNavAdapterResult>(() => {}));
    const started = Date.now();
    const out = await fetchNavForOneInstrument({ instrumentId: ID, fromDate: '2024-01-01', toDate: '2024-02-01', adapter, deps: fakeDeps().deps, deadlineMs: 40, firstChunkTimeoutMs: 40 });
    expect(out).toMatchObject({ status: 'failed', detail: expect.stringContaining('timed out') });
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('history floor: a fund younger than the window is not asked for again', () => {
  it('records where the history starts when an older window is empty (the job\'s own rule)', async () => {
    const { adapter } = fakeAdapter((r, n) => (n === 1 ? ok(r, { dates: ['2023-05-10', '2023-05-11'] }) : fail(r, 'not_found')));
    const { deps, floors } = fakeDeps();
    const out = await fetchNavForOneInstrument({ instrumentId: ID, fromDate: '2018-01-01', toDate: '2026-09-20', adapter, deps });
    expect(out).toMatchObject({ status: 'fetched', truncated: false, historyStartsAt: '2023-05-10' });
    expect(floors).toEqual([{ id: ID, date: '2023-05-10' }]);
  });

  it('not_found with nothing known at all is "no data", never a floor', async () => {
    const { adapter } = fakeAdapter((r) => fail(r, 'not_found'));
    const { deps, floors } = fakeDeps();
    await fetchNavForOneInstrument({ instrumentId: ID, fromDate: '2024-01-01', toDate: '2024-03-01', adapter, deps });
    expect(floors).toHaveLength(0);
  });
});

describe('NC-B5: the insert rule is the hydration job\'s own', () => {
  it('stamps the provider that ACTUALLY supplied the rows', async () => {
    const { adapter } = fakeAdapter((r) => ok(r, { provider: 'tigzig' }));
    const { deps, written } = fakeDeps();
    await fetchNavForOneInstrument({ instrumentId: ID, fromDate: '2024-01-01', toDate: '2024-01-20', adapter, deps });
    expect(written[0].every((w) => w.dataVersion.startsWith('tigzig:v1:'))).toBe(true);
    expect(written[0].every((w) => w.currencyCode === 'INR')).toBe(true);
  });

  it('never overwrites a date already on file (decideUpsert): only new dates are inserted', async () => {
    const existing = new Map([[`${ID}|2024-01-01`, { value: '100', recordChecksum: 'x', quality_status: 'ok' as const }]]);
    const { adapter } = fakeAdapter((r) => ok(r, { dates: ['2024-01-01', '2024-01-02'] }));
    const { deps, written } = fakeDeps({ existing });
    await fetchNavForOneInstrument({ instrumentId: ID, fromDate: '2024-01-01', toDate: '2024-01-05', adapter, deps });
    expect(written[0].map((w) => w.priceDate)).toEqual(['2024-01-02']);
  });

  it('is literally the same function the scheduled job calls', () => {
    const job = read('lib/services/investment-intelligence/pc6/selectiveHistoricalHydrationJob.ts');
    expect(job).toContain('buildHydrationWriteRows({ instrumentId, fetchResult, existingObs })');
    expect(read('lib/services/investment-intelligence/pc6/userInstrumentNavFetch.ts')).toContain('buildHydrationWriteRows({ instrumentId, fetchResult: fetched, existingObs: existing })');
    const r = buildHydrationWriteRows({ instrumentId: ID, fetchResult: ok({ schemeIdentifier: 'x', fromDate: '2024-01-01', toDate: '2024-01-02' }) as never, existingObs: new Map() });
    expect(r.rows).toHaveLength(2);
  });
});

describe('NC-B3: concurrent requests share ONE fetch', () => {
  it('two concurrent saves for the same fund call the source once; the second shares the result', async () => {
    let calls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const run = async () => { calls++; await gate; return 'done'; };
    const a = singleFlight('k', run);
    const b = singleFlight('k', run);
    expect(a.shared).toBe(false);
    expect(b.shared).toBe(true);
    release();
    expect(await Promise.all([a.promise, b.promise])).toEqual(['done', 'done']);
    expect(calls).toBe(1);
    expect(inFlightCount()).toBe(0); // cleaned up: a later save fetches again
    const c = singleFlight('k', async () => { calls++; return 'again'; });
    expect(c.shared).toBe(false);
    await c.promise;
    expect(calls).toBe(2);
  });

  it('different funds do not share', async () => {
    const a = singleFlight('a', async () => 1);
    const b = singleFlight('b', async () => 2);
    expect(b.shared).toBe(false);
    await Promise.all([a.promise, b.promise]);
  });
});

describe('rate limit', () => {
  const now = '2026-10-03T12:00:00Z';
  it('allows below the hourly cap and refuses at it, counting only the last hour', () => {
    const recent = Array.from({ length: 29 }, () => ({ created_at: '2026-10-03T11:30:00Z' }));
    expect(checkUserNavFetchRateLimit(recent, now)).toEqual({ allowed: true, fetchesInWindow: 29 });
    expect(checkUserNavFetchRateLimit([...recent, { created_at: '2026-10-03T11:59:00Z' }], now).allowed).toBe(false);
    expect(checkUserNavFetchRateLimit(Array.from({ length: 50 }, () => ({ created_at: '2026-10-03T09:00:00Z' })), now).allowed).toBe(true); // old events do not count
  });
});

describe('NC-B4: no brute-force path is reachable from the new modules', () => {
  const files = [
    'lib/services/investment-intelligence/pc6/userInstrumentNavFetch.ts',
    'lib/services/investment-intelligence/pc6/userNavHistory.ts',
    'lib/services/investment-intelligence/pc6/userNavHistoryLive.ts',
    'lib/services/investment-intelligence/pc6/userNavHistoryKick.ts',
    'app/api/investment-intelligence/nav-history/route.ts',
    'app/api/investment-intelligence/investment-dates/route.ts',
  ];
  const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('none of them calls the job\'s candidate enumeration, the full run, the backfill script or the cron route', () => {
    for (const f of files) {
      const code = stripComments(read(f));
      expect(code, f).not.toMatch(/fetchAcceptedDependencies|fetchBenchmarkDependencies|runSelectiveHistoricalHydration|pc6_historical_nav_backfill|nav1_backfill|pc6-selective-hydration|pc6-reference-ingest|HISTORICAL_FLOOR_DATE/);
    }
  });

  it('the only inputs are a user id and (optionally) that user\'s own fund ids; there is no "all instruments" parameter', () => {
    const batch = read('lib/services/investment-intelligence/pc6/userNavHistory.ts');
    expect(batch).toContain('onlyInstrumentIds?: readonly string[]');
    expect(batch).not.toMatch(/allInstruments|fullUniverse|everyInstrument/);
    // The candidate set is read with the caller's user_id on every query.
    expect(batch.match(/\.eq\('user_id', userId\)/g)!.length).toBeGreaterThanOrEqual(3);
  });

  it('the scheduled-job route is untouched and still requires its secret', () => {
    const cron = read('app/api/investment-intelligence/cron/pc6-selective-hydration/route.ts');
    expect(cron).toContain("req.headers.get('x-cron-secret')");
    expect(cron).not.toContain('userNavHistory');
  });
});
