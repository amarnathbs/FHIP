// PO extension 2026-10-03: once a statement is uploaded and confirmed, fetch the
// missing NAV history for ALL of that user's own funds -- each from its own
// earliest date, gap only, bounded, rate limited, fail soft per fund, never
// inside the confirm request. Fake adapters and an in-memory database that
// APPLIES its filters; no live network.
//
// NAMED NEGATIVE CONTROLS
//   NC-D1  bounded to the user's own funds (another user's fund, a fund that
//          is not theirs, and "everything" are all unreachable);
//   NC-D2  idempotent re-run: complete funds are never fetched again, a re-run
//          fetches only the remaining gap;
//   NC-D3  failure isolation: one fund failing/throwing never blocks the others;
//   NC-D4  the confirm response does not wait on the fetch;
//   NC-D5  bounded work per call and bounded concurrency; per-user rate limit.
import fs from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryDb, type InMemoryDb, type Row } from './support/inMemorySupabase';
import type { HistoricalNavAdapter, HistoricalNavAdapterResult, HistoricalNavRequest } from '@/lib/services/investment-intelligence/pc6/adapters/historicalNavAdapter';
import type { HydrationAttemptRecord, HydrationWriteRow } from '@/lib/services/investment-intelligence/pc6/selectiveHistoricalHydrationJob';

let currentDb: InMemoryDb;
const emitted: unknown[] = [];
vi.mock('@/lib/services/investment-intelligence/audit', () => ({
  emitAuditEvent: async (e: Record<string, unknown>) => {
    emitted.push(e);
    currentDb.tables.ii_audit_events.push({ user_id: e.userId, event_type: e.eventType, metadata: e.metadata, created_at: new Date().toISOString() });
    return { error: null };
  },
}));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => { throw new Error('tests pass their own db'); } }));

import {
  NAV_BATCH_MAX_SCHEMES,
  NAV_HISTORY_LEAD_DAYS,
  classifySchemeHistory,
  getUserNavHistoryStatus,
  inFailureCooldown,
  loadUserSchemeNeeds,
  planSchemeGap,
  runUserNavHistoryBatch,
  summariseNavHistory,
  type UserNavHistoryRuntime,
} from '@/lib/services/investment-intelligence/pc6/userNavHistory';
import { kickUserNavHistory } from '@/lib/services/investment-intelligence/pc6/userNavHistoryKick';
import { NavHistoryStatusView } from '@/components/investment-intelligence/NavHistoryStatusPanel';

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');
const TODAY = '2026-10-03';
const NOW = '2026-10-03T10:00:00.000Z';
const USER = 'user-1';
const OTHER = 'user-2';

// ---------------------------------------------------------------------------
describe('planSchemeGap: the job\'s own coverage rule, gap only', () => {
  const need = { requiredFrom: '2022-01-01' };
  it('complete when the earliest stored NAV already reaches what is needed', () => {
    expect(planSchemeGap(need, { earliestNav: '2021-06-01', historyFloor: null }, TODAY)).toEqual({ state: 'complete' });
    expect(planSchemeGap(need, { earliestNav: '2022-01-01', historyFloor: null }, TODAY)).toEqual({ state: 'complete' });
  });
  it('a gap is [needed, earliest stored - 1 day]; with no NAV at all it is [needed, today]', () => {
    expect(planSchemeGap(need, { earliestNav: '2026-09-21', historyFloor: null }, TODAY)).toEqual({ state: 'gap', fromDate: '2022-01-01', toDate: '2026-09-20' });
    expect(planSchemeGap(need, { earliestNav: null, historyFloor: null }, TODAY)).toEqual({ state: 'gap', fromDate: '2022-01-01', toDate: TODAY });
  });
  it('never asks for dates before the fund\'s confirmed history floor (a fund younger than the need)', () => {
    expect(planSchemeGap(need, { earliestNav: '2023-05-10', historyFloor: '2023-05-10' }, TODAY)).toEqual({ state: 'complete' });
    expect(planSchemeGap(need, { earliestNav: '2026-09-21', historyFloor: '2024-01-01' }, TODAY)).toEqual({ state: 'gap', fromDate: '2024-01-01', toDate: '2026-09-20' });
  });
});

describe('plain words for the user', () => {
  const view = (state: 'loaded' | 'pending' | 'loading' | 'waiting', name: string) => ({ instrumentId: `id-${name}`, schemeName: name, state, loadingFrom: null });
  it('"Fetching price history for 3 of 5 funds"', () => {
    const s = summariseNavHistory([view('loaded', 'A'), view('loaded', 'B'), view('pending', 'C'), view('loading', 'D'), view('pending', 'E')]);
    expect(s.headline).toBe('Fetching price history for 3 of 5 funds');
  });
  it('"History loaded" when nothing is missing, and nothing at all when the user holds no funds', () => {
    expect(summariseNavHistory([view('loaded', 'A')]).headline).toBe('History loaded');
    expect(summariseNavHistory([]).headline).toBeNull();
  });
  it('"Waiting for data for <fund>" names the fund, never an id, and says we keep trying', () => {
    const s = summariseNavHistory([view('loaded', 'A'), view('waiting', 'Alpha Flexi Cap Fund')]);
    expect(s.waitingLines).toEqual(['Waiting for data for Alpha Flexi Cap Fund. We will keep trying.']);
    expect(JSON.stringify(s)).not.toContain('id-');
    expect(s.headline).toContain('1 of 2 funds');
  });
  it('classifies by what has happened to the fund', () => {
    const gap = { state: 'gap' as const, fromDate: '2022-01-01', toDate: '2022-12-31' };
    expect(classifySchemeHistory({ state: 'complete' }, null)).toBe('loaded');
    expect(classifySchemeHistory(gap, null)).toBe('pending');
    expect(classifySchemeHistory(gap, { lastAttemptedAt: NOW, lastOutcome: 'partially_hydrated', consecutiveFailures: 0 })).toBe('loading');
    expect(classifySchemeHistory(gap, { lastAttemptedAt: NOW, lastOutcome: 'fetch_failed', consecutiveFailures: 2 })).toBe('waiting');
  });
  it('the status view shows the words, dates day-first, and nothing when everything is loaded', () => {
    const summary = summariseNavHistory([view('pending', 'Alpha Fund'), view('waiting', 'Beta Fund')]);
    const html = renderToStaticMarkup(createElement(NavHistoryStatusView, { summary, schemes: [{ ...view('pending', 'Alpha Fund'), loadingFrom: '2022-01-01' }, view('waiting', 'Beta Fund')], busy: false, dateCurrency: 'INR', onCheckNow: () => {} }));
    expect(html).toContain('Fetching price history for 1 of 2 funds');
    expect(html).toContain('loading from 01-01-2022');
    expect(html).toContain('Waiting for data for Beta Fund. We will keep trying.');
    expect(html).toContain('history is being loaded');
    expect(html).toContain('Check now');
    expect(html).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(html).not.toContain('id-');
    const aud = renderToStaticMarkup(createElement(NavHistoryStatusView, { summary, schemes: [{ ...view('pending', 'Alpha Fund'), loadingFrom: '2022-01-01' }], busy: false, dateCurrency: 'AUD', onCheckNow: () => {} }));
    expect(aud).toContain('01/01/2022');
    const done = summariseNavHistory([view('loaded', 'A')]);
    expect(renderToStaticMarkup(createElement(NavHistoryStatusView, { summary: done, schemes: [], busy: false, dateCurrency: 'INR', onCheckNow: () => {} }))).toContain('History loaded');
    expect(renderToStaticMarkup(createElement(NavHistoryStatusView, { summary: summariseNavHistory([]), schemes: [], busy: false, dateCurrency: 'INR', onCheckNow: () => {} }))).toBe('');
  });
});

// ---------------------------------------------------------------------------
// The world: user-1 holds 5 funds (earliest transactions in 2021..2025), one
// fund is a non-mutual-fund, user-2 holds a sixth.
// ---------------------------------------------------------------------------
const FUNDS = ['f1', 'f2', 'f3', 'f4', 'f5'];

function seed(over: Record<string, Row[]> = {}) {
  currentDb = createInMemoryDb();
  const txn = (id: string, user: string, ins: string, date: string, extra: Row = {}): Row => ({ id, user_id: user, account_id: `acc-${user}`, instrument_id: ins, transaction_date: date, status: 'parsed', source_reference: 'CAMS', ...extra });
  currentDb.reset({
    ii_holding_snapshots: [...FUNDS.map((f) => ({ id: `s-${f}`, user_id: USER, instrument_id: f, as_of_date: '2026-09-04' })), { id: 's-o', user_id: OTHER, instrument_id: 'other-fund', as_of_date: '2026-09-04' }, { id: 's-eq', user_id: USER, instrument_id: 'equity-1', as_of_date: '2026-09-04' }],
    ii_transactions: [
      txn('t1', USER, 'f1', '2021-03-15'), txn('t2', USER, 'f2', '2022-06-01'), txn('t3', USER, 'f3', '2023-01-10'), txn('t4', USER, 'f4', '2024-02-20'), txn('t5', USER, 'f5', '2025-05-05'),
      txn('t5b', USER, 'f5', '2019-01-01', { status: 'reversed' }), // a reversed row never pulls a window earlier
      txn('to', OTHER, 'other-fund', '2018-01-01'),
    ],
    ii_instruments: [...FUNDS.map((f) => ({ id: f, instrument_name: `Fund ${f.toUpperCase()}`, instrument_class: 'mutual_fund' })), { id: 'other-fund', instrument_name: 'Other Fund', instrument_class: 'mutual_fund' }, { id: 'equity-1', instrument_name: 'Some Equity', instrument_class: 'equity' }],
    ii_scheme_master: [],
    ii_investment_date_inputs: [],
    // f1 and f2 already reach back far enough; f3..f5 only have recent (post-changeover) NAV; other-fund has none.
    ii_prices_nav: [
      { instrument_id: 'f1', price_date: '2021-01-01', price: 10 }, { instrument_id: 'f2', price_date: '2022-01-01', price: 10 },
      { instrument_id: 'f3', price_date: '2026-09-21', price: 10 }, { instrument_id: 'f4', price_date: '2026-09-21', price: 10 }, { instrument_id: 'f5', price_date: '2026-09-21', price: 10 },
    ],
    ii_nav_history_floors: [],
    ii_nav_hydration_attempts: [],
    ii_audit_events: [],
    ...over,
  });
  return currentDb;
}

function runtime(db: InMemoryDb, handler: (req: HistoricalNavRequest) => HistoricalNavAdapterResult | Promise<HistoricalNavAdapterResult>, opts: { concurrencyProbe?: { active: number; max: number } } = {}) {
  const requests: HistoricalNavRequest[] = [];
  const attempts: HydrationAttemptRecord[] = [];
  const idByCode: Record<string, string> = { '1': 'f1', '2': 'f2', '3': 'f3', '4': 'f4', '5': 'f5', '9': 'other-fund' };
  const adapter: HistoricalNavAdapter = {
    providerKey: 'fake', adapterVersion: 'v1',
    async fetchHistory(req) {
      requests.push(req);
      const probe = opts.concurrencyProbe;
      if (probe) { probe.active++; probe.max = Math.max(probe.max, probe.active); await new Promise((r) => setTimeout(r, 15)); probe.active--; }
      return handler(req);
    },
  };
  const rt: UserNavHistoryRuntime = {
    db: db.client as never,
    adapter,
    deps: {
      isEnabled: async () => ({ enabled: true, reason: null }),
      fetchAdapterIdentifier: async (id: string) => Object.entries(idByCode).find(([, v]) => v === id)?.[0] ?? null,
      fetchExistingObservations: async () => new Map(),
      writeRows: async (rows: HydrationWriteRow[]) => {
        for (const r of rows) db.tables.ii_prices_nav.push({ instrument_id: r.instrumentId, price_date: r.priceDate, price: Number(r.price) });
        return { inserted: rows.length, error: null };
      },
      recordHistoryFloor: async () => ({ error: null }),
      recordAttempt: async (rec: HydrationAttemptRecord) => {
        attempts.push(rec);
        const rows = db.tables.ii_nav_hydration_attempts;
        const i = rows.findIndex((r) => r.instrument_id === rec.instrumentId);
        const row = { instrument_id: rec.instrumentId, last_attempted_at: rec.lastAttemptedAt, last_outcome: rec.lastOutcome, consecutive_failures: rec.consecutiveFailures, attempts_total: rec.attemptsTotal, last_success_at: rec.lastSuccessAt };
        if (i >= 0) rows[i] = row; else rows.push(row);
        return { error: null };
      },
    },
  };
  return { rt, requests, attempts };
}

const okRows = (req: HistoricalNavRequest): HistoricalNavAdapterResult => ({
  ok: true, schemeIdentifier: req.schemeIdentifier, providerSchemeName: null, coverage: 'unknown',
  observations: [{ date: req.fromDate, nav: '10' }, { date: req.toDate, nav: '11' }],
  provider: { key: 'amfi', adapterVersion: 'v1', requestUrl: 'x', httpStatus: 200, retrievedAt: 'now', rawResponseChecksum: '0123456789abcdef' },
});
const failRows = (req: HistoricalNavRequest): HistoricalNavAdapterResult => ({
  ok: false, schemeIdentifier: req.schemeIdentifier, kind: 'network', detail: 'down',
  provider: { key: 'amfi', adapterVersion: 'v1', requestUrl: null, httpStatus: null, retrievedAt: 'now' },
});

beforeEach(() => { emitted.length = 0; });

describe('loadUserSchemeNeeds: the user\'s OWN funds and each fund\'s own earliest date', () => {
  it('NC-D1: only the caller\'s mutual funds; the other user\'s fund and a non-fund are absent', async () => {
    const db = seed();
    const needs = await loadUserSchemeNeeds(db.client as never, USER);
    expect(needs.map((n) => n.instrumentId)).toEqual(FUNDS);
    expect((await loadUserSchemeNeeds(db.client as never, OTHER)).map((n) => n.instrumentId)).toEqual(['other-fund']);
    expect(await loadUserSchemeNeeds(db.client as never, 'nobody')).toEqual([]);
  });

  it('each fund\'s window starts at ITS earliest usable transaction less the lead days; a reversed row does not pull it earlier', async () => {
    const db = seed();
    const needs = await loadUserSchemeNeeds(db.client as never, USER);
    const f5 = needs.find((n) => n.instrumentId === 'f5')!;
    expect(f5.requiredFrom).toBe('2025-04-25'); // 2025-05-05 minus 10 days, not the reversed 2019 row
    expect(f5.reason).toBe('transactions');
    expect(NAV_HISTORY_LEAD_DAYS).toBe(10);
  });

  it('a holdings-only fund with a typed investment date needs history from that date; without one, from its statement date', async () => {
    const db = seed({
      ii_transactions: [],
      ii_investment_date_inputs: [{ id: 'in', user_id: USER, instrument_id: 'f1', investment_date: '2020-02-14', status: 'awaiting_nav' }],
    });
    const needs = await loadUserSchemeNeeds(db.client as never, USER);
    expect(needs.find((n) => n.instrumentId === 'f1')).toMatchObject({ requiredFrom: '2020-02-04', reason: 'investment_date' });
    expect(needs.find((n) => n.instrumentId === 'f2')).toMatchObject({ requiredFrom: '2026-08-25', reason: 'holding_date' });
  });
});

describe('runUserNavHistoryBatch', () => {
  it('NC-D1/NC-D5: works only on the user\'s funds that HAVE a gap, a few per call, newest-first windows inside each fund\'s own range', async () => {
    const db = seed();
    const { rt, requests } = runtime(db, okRows);
    const res = await runUserNavHistoryBatch({ userId: USER, today: TODAY, nowIso: NOW, runtime: rt });
    // f1 and f2 are already complete and are never touched; the other user's fund is unreachable.
    expect(res.attempted.map((a) => a.instrumentId).sort()).toEqual(['f3', 'f4', 'f5']);
    expect(res.attempted).toHaveLength(NAV_BATCH_MAX_SCHEMES);
    for (const r of requests) expect(['3', '4', '5']).toContain(r.schemeIdentifier);
    expect(requests.some((r) => r.schemeIdentifier === '9')).toBe(false);
    // f3's window: from its own earliest (2023-01-10 - 10d) up to the day before its earliest stored NAV.
    const f3 = requests.filter((r) => r.schemeIdentifier === '3');
    expect(f3.map((r) => r.fromDate).sort()[0]).toBe('2022-12-31');
    expect(f3.map((r) => r.toDate).sort().reverse()[0]).toBe('2026-09-20');
    expect(emitted.length).toBe(3); // one audit event per fund actually fetched
  });

  it('NC-D2: idempotent. A complete fund is never fetched; a re-run finds nothing left to fetch and calls no source', async () => {
    const db = seed();
    const first = runtime(db, okRows);
    await runUserNavHistoryBatch({ userId: USER, today: TODAY, nowIso: NOW, runtime: first.rt });
    const status = await getUserNavHistoryStatus(db.client as never, USER, TODAY);
    expect(status.summary.headline).toBe('History loaded');
    expect(status.schemes.every((s) => s.state === 'loaded')).toBe(true);

    const second = runtime(db, okRows);
    const again = await runUserNavHistoryBatch({ userId: USER, today: TODAY, nowIso: NOW, runtime: second.rt });
    expect(again.attempted).toHaveLength(0);
    expect(second.requests).toHaveLength(0);
    expect(again.remaining).toBe(0);
  });

  it('NC-D2: a partial first run is resumed by the next one, which fetches ONLY the remaining gap', async () => {
    const db = seed();
    // First run: only the newest chunk of f3 succeeds (the older one fails), so history is partly in.
    const first = runtime(db, (req) => (req.toDate >= '2026-09-20' ? okRows(req) : failRows(req)));
    await runUserNavHistoryBatch({ userId: USER, today: TODAY, nowIso: NOW, runtime: first.rt, onlyInstrumentIds: ['f3'], maxSchemes: 1 });
    const earliestNow = db.tables.ii_prices_nav.filter((r) => r.instrument_id === 'f3').map((r) => String(r.price_date)).sort()[0];
    expect(earliestNow < '2026-09-21').toBe(true);

    const second = runtime(db, okRows);
    await runUserNavHistoryBatch({ userId: USER, today: TODAY, nowIso: NOW, runtime: second.rt, onlyInstrumentIds: ['f3'], maxSchemes: 1 });
    for (const r of second.requests) expect(r.toDate < earliestNow).toBe(true); // nothing already held is asked for again
  });

  it('NC-D3: one fund failing or throwing never blocks the others, and is recorded for that fund only', async () => {
    const db = seed();
    const { rt, attempts } = runtime(db, (req) => {
      if (req.schemeIdentifier === '3') return failRows(req);
      if (req.schemeIdentifier === '4') throw new Error('adapter exploded');
      return okRows(req);
    });
    const res = await runUserNavHistoryBatch({ userId: USER, today: TODAY, nowIso: NOW, runtime: rt });
    const by = Object.fromEntries(res.attempted.map((a) => [a.instrumentId, a.outcome]));
    expect(by).toEqual({ f3: 'failed', f4: 'failed', f5: 'fetched' });
    expect(attempts.find((a) => a.instrumentId === 'f5')!.lastOutcome).toMatch(/hydrated|partially_hydrated/);
    expect(attempts.find((a) => a.instrumentId === 'f3')).toMatchObject({ lastOutcome: 'fetch_failed', consecutiveFailures: 1 });
    // f5's rows are in even though f3 and f4 failed
    expect(db.tables.ii_prices_nav.some((r) => r.instrument_id === 'f5' && String(r.price_date) < '2026-09-21')).toBe(true);
    // And the user is told, in words, which funds are waiting.
    const status = await getUserNavHistoryStatus(db.client as never, USER, TODAY);
    expect(status.summary.waitingLines.join(' ')).toContain('Waiting for data for Fund F3');
  });

  it('a failing fund is left alone for a cooldown, so a polling client cannot hammer the source', async () => {
    const db = seed();
    const first = runtime(db, failRows);
    await runUserNavHistoryBatch({ userId: USER, today: TODAY, nowIso: NOW, runtime: first.rt });
    const second = runtime(db, okRows);
    const later = await runUserNavHistoryBatch({ userId: USER, today: TODAY, nowIso: '2026-10-03T10:02:00.000Z', runtime: second.rt });
    expect(later.attempted).toHaveLength(0);
    expect(second.requests).toHaveLength(0);
    // After the cooldown it tries again.
    const third = runtime(db, okRows);
    const afterCooldown = await runUserNavHistoryBatch({ userId: USER, today: TODAY, nowIso: '2026-10-03T10:30:00.000Z', runtime: third.rt });
    expect(afterCooldown.attempted.length).toBeGreaterThan(0);
    expect(inFailureCooldown({ lastAttemptedAt: NOW, lastOutcome: 'fetch_failed', consecutiveFailures: 1 }, '2026-10-03T10:05:00.000Z')).toBe(true);
    expect(inFailureCooldown({ lastAttemptedAt: NOW, lastOutcome: 'hydrated', consecutiveFailures: 0 }, NOW)).toBe(false);
  });

  it('NC-D1: asking for another user\'s fund, or a fund that is not theirs, fetches nothing', async () => {
    const db = seed();
    const { rt, requests } = runtime(db, okRows);
    const res = await runUserNavHistoryBatch({ userId: USER, today: TODAY, nowIso: NOW, runtime: rt, onlyInstrumentIds: ['other-fund', 'not-a-fund'] });
    expect(res.attempted).toHaveLength(0);
    expect(requests).toHaveLength(0);
  });

  it('NC-D5: bounded concurrency inside a call', async () => {
    const db = seed();
    const probe = { active: 0, max: 0 };
    const { rt } = runtime(db, okRows, { concurrencyProbe: probe });
    await runUserNavHistoryBatch({ userId: USER, today: TODAY, nowIso: NOW, runtime: rt, concurrency: 2 });
    expect(probe.max).toBeLessThanOrEqual(2);
    expect(probe.max).toBeGreaterThan(0);
  });

  it('NC-D5: per-user rate limit: at the hourly cap nothing is fetched and the caller is told', async () => {
    const db = seed();
    for (let i = 0; i < 30; i++) db.tables.ii_audit_events.push({ user_id: USER, event_type: 'nav_price_update', metadata: { kind: 'user_nav_history_fetch' }, created_at: '2026-10-03T09:40:00.000Z' });
    const { rt, requests } = runtime(db, okRows);
    const res = await runUserNavHistoryBatch({ userId: USER, today: TODAY, nowIso: NOW, runtime: rt });
    expect(res.rateLimited).toBe(true);
    expect(res.attempted).toHaveLength(0);
    expect(requests).toHaveLength(0);
    // Another user's budget is separate.
    const other = runtime(db, okRows);
    const o = await runUserNavHistoryBatch({ userId: OTHER, today: TODAY, nowIso: NOW, runtime: other.rt });
    expect(o.rateLimited).toBe(false);
  });

  it('NC-D5: the remaining budget caps how many funds a call may take (29 used -> at most 1)', async () => {
    const db = seed();
    for (let i = 0; i < 29; i++) db.tables.ii_audit_events.push({ user_id: USER, event_type: 'nav_price_update', metadata: { kind: 'user_nav_history_fetch' }, created_at: '2026-10-03T09:40:00.000Z' });
    const { rt } = runtime(db, okRows);
    expect((await runUserNavHistoryBatch({ userId: USER, today: TODAY, nowIso: NOW, runtime: rt })).attempted).toHaveLength(1);
  });

  it('concurrent batches for the same user share ONE run (one set of source calls)', async () => {
    const db = seed();
    const { rt, requests } = runtime(db, okRows);
    const [a, b] = await Promise.all([
      runUserNavHistoryBatch({ userId: USER, today: TODAY, nowIso: NOW, runtime: rt }),
      runUserNavHistoryBatch({ userId: USER, today: TODAY, nowIso: NOW, runtime: rt }),
    ]);
    expect([a.sharedBatch, b.sharedBatch].sort()).toEqual([false, true]);
    // A fund may need several chunks, but no chunk of any fund is requested twice.
    const keys = requests.map((r) => r.schemeIdentifier + '|' + r.fromDate + '|' + r.toDate);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('with the kill switch off nothing is fetched and no failure is recorded against any fund', async () => {
    const db = seed();
    const { rt, requests, attempts } = runtime(db, okRows);
    rt.deps.isEnabled = async () => ({ enabled: false, reason: 'ops' });
    const res = await runUserNavHistoryBatch({ userId: USER, today: TODAY, nowIso: NOW, runtime: rt });
    expect(requests).toHaveLength(0);
    expect(attempts).toHaveLength(0);
    expect(res.attempted.every((a) => a.outcome === 'disabled')).toBe(true);
  });

  it('licensing/provenance stance is unchanged: rows are stamped with the provider that supplied them via the job\'s own writer', () => {
    const src = read('lib/services/investment-intelligence/pc6/userInstrumentNavFetch.ts');
    expect(src).toContain('buildHydrationWriteRows');
    expect(src).toContain('deps.writeRows');
  });
});

// ---------------------------------------------------------------------------
describe('NC-D4: the confirm response does not wait on the fetch', () => {
  it('kickUserNavHistory schedules the work for AFTER the response and returns at once; the runner has not run when it returns', async () => {
    vi.resetModules();
    const scheduled: Array<() => Promise<void> | void> = [];
    vi.doMock('next/server', () => ({ after: (cb: () => Promise<void> | void) => { scheduled.push(cb); } }));
    const { kickUserNavHistory: kick } = await import('@/lib/services/investment-intelligence/pc6/userNavHistoryKick');
    let release: () => void = () => {};
    const runner = vi.fn(() => new Promise<void>((r) => { release = r; })); // a fetch that takes "forever"
    const started = Date.now();
    expect(kick(USER, runner as never)).toBe(true);
    expect(Date.now() - started).toBeLessThan(100);
    expect(runner).not.toHaveBeenCalled(); // nothing ran inside the confirm
    expect(scheduled).toHaveLength(1);
    const running = scheduled[0]();
    expect(runner).toHaveBeenCalledWith(USER);
    release();
    await running;
    vi.doUnmock('next/server');
  });

  it('a failing kicked run is swallowed (logged), and outside a request scope the kick reports false instead of throwing', async () => {
    vi.resetModules();
    const scheduled: Array<() => Promise<void> | void> = [];
    vi.doMock('next/server', () => ({ after: (cb: () => Promise<void> | void) => { scheduled.push(cb); } }));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { kickUserNavHistory: kick } = await import('@/lib/services/investment-intelligence/pc6/userNavHistoryKick');
    kick(USER, (async () => { throw new Error('source down'); }) as never);
    await scheduled[0]();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
    vi.doUnmock('next/server');
    vi.resetModules();
    vi.doMock('next/server', () => ({ after: () => { throw new Error('after was called outside a request scope'); } }));
    const { kickUserNavHistory: kick2 } = await import('@/lib/services/investment-intelligence/pc6/userNavHistoryKick');
    expect(kick2(USER, (async () => {}) as never)).toBe(false);
    vi.doUnmock('next/server');
  });

  it('the confirm routes only KICK (no await on any NAV work, no import of the live fetch)', () => {
    for (const f of ['app/api/investment-intelligence/source-documents/[id]/process/route.ts', 'app/api/investment-intelligence/ai-extraction-reviews/[reviewId]/accept/route.ts']) {
      const src = read(f);
      expect(src).toMatch(/\n\s*(if \(result\.ok && result\.summary\) )?kickUserNavHistory\(user\.id\);/);
      expect(src).not.toMatch(/await\s+kickUserNavHistory/);
      expect(src).not.toMatch(/userNavHistoryLive|runLiveUserNavHistoryBatch|runUserNavHistoryBatch/);
    }
  });
});

void kickUserNavHistory;
