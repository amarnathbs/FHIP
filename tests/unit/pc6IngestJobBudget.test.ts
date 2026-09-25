// PC6 daily NAV ingest -- time-budgeted, resumable runs (2026-09-25).
//
// Production kills every request at 28 s. These tests drive the REAL
// runReferenceIngest() against an in-memory PostgREST stand-in with a virtual
// clock (tests/unit/support/pc6IngestFakeDb.ts), so budget behaviour is
// deterministic. Only runReferenceIngest is imported from the job, so on the
// pre-fix code (origin/main 8b6692c) every test here loads and FAILS BY NAME:
// that code has no budget (writes everything, 'succeeded'), no exact-pair
// lookup (reads ii_prices_nav by instrument x date filter), and no
// unchanged-source skip (opens a batch and re-advances last_success_at).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FakeDb, buildNavAll, seedUniverse, seedJobControl, type NavFixture } from './support/pc6IngestFakeDb';
import { parseNavAll } from '@/lib/services/investment-intelligence/pc6/amfiParser';

let current: FakeDb;
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => current }));

import { runReferenceIngest } from '@/lib/services/investment-intelligence/pc6/referenceIngestJob';

const CURRENT = '2026-09-24';
const JOB = 'pc6_amfi_daily_nav';
let fileBytes: Uint8Array;

beforeEach(() => {
  vi.stubGlobal('fetch', async () => {
    current.advance(2_600); // the measured production fetch of NAVAll.txt
    return new Response(fileBytes as unknown as BodyInit, { status: 200 });
  });
});
afterEach(() => vi.unstubAllGlobals());

/** Production-like request costs, in virtual ms. */
const COSTS = {
  '*': 60, // small reads/writes (control row, batch row, rejections)
  'ii_instrument_identifiers:select': 700,
  'ii_instruments:select': 700,
  'rpc:ii_prices_nav_existing_pairs': 350,
  'ii_prices_nav:upsert': 5_000, // one 500-row insert chunk, deliberately slow so the budget bites
  'ii_prices_nav:select': 200,
  'ii_prices_nav:update': 200,
  'ii_reference_corrections:insert': 200,
};

interface Setup { db: FakeDb; fx: NavFixture; expectedRows: number; corrections: number; newRows: number }

/**
 * 2,600 schemes (2,400 current + 200 dormant over 40 old dates). 400 of
 * today's rows already stored identically, 5 stored with a different value
 * (source corrections), everything else new.
 */
function setup(opts: { correctionsOnly?: number } = {}): Setup {
  const db = new FakeDb();
  Object.assign(db.costs, COSTS);
  const fx = buildNavAll({ currentSchemes: 2400, dormantSchemes: 200, currentDate: CURRENT, dormantDates: 40 });
  fileBytes = fx.bytes;
  const byCode = seedUniverse(db, fx);
  seedJobControl(db, JOB);
  const parsed = parseNavAll(fx.bytes, { asOfDate: CURRENT });
  let corrections = 0;
  let stored = 0;
  parsed.records.forEach((r, i) => {
    const id = byCode.get(r.amfiSchemeCode)!;
    const storeAll = opts.correctionsOnly !== undefined;
    const correct = storeAll ? i < opts.correctionsOnly! : i >= 400 && i < 405;
    if (storeAll || i < 405) {
      db.table('ii_prices_nav').push({
        id: `pre-${i}`, instrument_id: id, price_date: r.navDate,
        price: correct ? '0.0001' : r.navRaw, record_checksum: correct ? 'republished-before' : r.recordChecksum, quality_status: 'ok',
      });
      stored++;
      if (correct) corrections++;
    }
  });
  return { db, fx, expectedRows: parsed.records.length, corrections, newRows: parsed.records.length - stored };
}

async function run(db: FakeDb, extra: Record<string, unknown> = {}) {
  current = db;
  return runReferenceIngest({ jobKey: JOB, sourceConfigId: 'amfi_nav_daily', asOfDate: CURRENT, now: db.now, ...extra });
}
const batches = (db: FakeDb) => db.table('ii_reference_import_batches');
const control = (db: FakeDb) => db.table('ii_reference_job_control').find((r) => r.job_key === JOB)!;
const navKeys = (db: FakeDb) => db.table('ii_prices_nav').map((r) => `${r.instrument_id}|${r.price_date}`);

describe('PC6 ingest: budget exhaustion yields an honest partial run', () => {
  it('stops at the 18 s budget with correct remaining counts and never advances last_success_at', async () => {
    const s = setup();
    const before = { ...control(s.db) };
    const r = await run(s.db);

    expect(r.status).toBe('partial');
    expect(r.counts.inserted).toBe(1000); // two 500-row chunks fit; a third would not
    expect(r.counts.remainingInserts).toBe(s.newRows - 1000);
    expect(r.counts.remainingCorrections).toBe(s.corrections);
    expect(r.counts.superseded).toBe(0);
    expect(r.timings.totalMs).toBeLessThanOrEqual(18_000);

    const b = batches(s.db);
    expect(b).toHaveLength(1);
    expect(b[0].status).toBe('failed'); // the ledger's existing domain -- never 'succeeded'
    expect(b[0].error_code).toBe('PARTIAL_BATCH_CONTINUING');
    expect(b[0].finished_at).toBeTruthy();
    expect(b[0].rows_inserted).toBe(1000);
    expect(b[0].notes.continuing).toBe(true);
    expect(b[0].notes.remaining).toEqual({ inserts: s.newRows - 1000, corrections: s.corrections });

    const c = control(s.db);
    expect(c.last_success_at).toBe(before.last_success_at);
    expect(c.last_success_batch_id).toBe(before.last_success_batch_id);
    expect(c.consecutive_failures).toBe(0); // no backoff: the next tick must be able to continue
    expect(c.next_attempt_not_before).toBeNull();
    expect(c.last_failure_at).toBe(before.last_failure_at);
    expect(r.alerts.map((a) => a.code)).toContain('CONTINUING_NEXT_INVOCATION');
  });

  it('NEGATIVE CONTROL: the same run with no budget writes everything in one go -- the partial above is the budget, nothing else', async () => {
    const s = setup();
    const r = await run(s.db, { budgetMs: Infinity });
    expect(r.status).toBe('succeeded');
    expect(r.counts.inserted).toBe(s.newRows);
    expect(r.timings.totalMs).toBeGreaterThan(28_000); // what production kills
  });

  it('uses the exact-pair lookup and never the instrument x date filter on ii_prices_nav', async () => {
    const s = setup();
    await run(s.db);
    expect(s.db.count((l) => l.table === 'rpc:ii_prices_nav_existing_pairs')).toBe(Math.ceil(s.expectedRows / 1000));
    expect(s.db.count((l) => l.table === 'ii_prices_nav' && l.verb === 'select' && l.filters.some((f) => f.startsWith('price_date=in')))).toBe(0);
  });

  it('a read phase that eats the whole budget is a FAILURE with backoff, not an endless zero-progress partial', async () => {
    const s = setup();
    s.db.costs['rpc:ii_prices_nav_existing_pairs'] = 9_000; // 3 calls -> ~27 s of reads
    const r = await run(s.db);
    expect(r.status).toBe('failed');
    expect(batches(s.db)[0].error_code).toBe('BUDGET_EXHAUSTED_NO_PROGRESS');
    expect(r.counts.inserted).toBe(0);
    expect(control(s.db).consecutive_failures).toBe(1);
    expect(control(s.db).last_success_at).toBe('2026-09-20T11:24:15.010Z');
  });

  it('a missing lookup function closes the batch as failed (EXACT_PAIR_LOOKUP_UNAVAILABLE) instead of leaving it running', async () => {
    const s = setup();
    s.db.rpcError = { message: 'Could not find the function public.ii_prices_nav_existing_pairs', code: 'PGRST202' };
    const r = await run(s.db);
    expect(r.status).toBe('failed');
    expect(batches(s.db)[0].status).toBe('failed');
    expect(batches(s.db)[0].error_code).toBe('EXACT_PAIR_LOOKUP_UNAVAILABLE');
    expect(s.db.table('ii_prices_nav').length).toBe(405); // nothing written
  });
});

describe('PC6 ingest: reruns complete the remainder without duplicates', () => {
  it('partial -> partial -> succeeded; every row exactly once; last_success_at advances only at the end', async () => {
    const s = setup();
    const statuses: string[] = [];
    const successAtEach: (string | null)[] = [];
    for (let i = 0; i < 10; i++) {
      s.db.advance(120_000); // the next 2-minute tick
      const r = await run(s.db);
      statuses.push(r.status);
      successAtEach.push(control(s.db).last_success_at);
      expect(r.timings.totalMs).toBeLessThanOrEqual(18_000);
      if (r.status === 'succeeded') break;
    }
    expect(statuses).toEqual(['partial', 'partial', 'succeeded']);

    // Every file pair is stored exactly once; nothing extra.
    const keys = navKeys(s.db);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.length).toBe(s.expectedRows);
    // No row was ever SENT twice: each invocation re-planned and continued.
    expect(s.db.navUpsertPayloadKeys.length).toBe(s.newRows);
    expect(new Set(s.db.navUpsertPayloadKeys).size).toBe(s.newRows);
    // Corrections applied once each, each with one audit record.
    expect(s.db.table('ii_reference_corrections')).toHaveLength(s.corrections);
    expect(s.db.table('ii_prices_nav').filter((r) => r.record_checksum === 'republished-before')).toHaveLength(0);

    // Ledger: two continuing partials, then one success that is the recorded last success.
    const b = batches(s.db);
    expect(b.map((x) => [x.status, x.error_code])).toEqual([
      ['failed', 'PARTIAL_BATCH_CONTINUING'],
      ['failed', 'PARTIAL_BATCH_CONTINUING'],
      ['succeeded', null],
    ]);
    expect(b.reduce((n, x) => n + x.rows_inserted, 0)).toBe(s.newRows);
    expect(successAtEach[0]).toBe('2026-09-20T11:24:15.010Z');
    expect(successAtEach[1]).toBe('2026-09-20T11:24:15.010Z');
    expect(successAtEach[2]).not.toBe('2026-09-20T11:24:15.010Z');
    expect(control(s.db).last_success_batch_id).toBe(b[2].id);
    expect(control(s.db).consecutive_failures).toBe(0);
  });

  it('corrections count against the budget and resume on the next call, audited exactly once each', async () => {
    const s = setup({ correctionsOnly: 40 }); // every row stored; 40 republished with new values
    s.db.costs['ii_prices_nav:select'] = 400; // ~800 ms per correction (read + update + audit)
    const first = await run(s.db);
    expect(first.status).toBe('partial');
    expect(first.counts.inserted).toBe(0);
    expect(first.counts.superseded).toBeGreaterThan(0);
    expect(first.counts.superseded).toBeLessThan(40);
    expect(first.counts.remainingCorrections).toBe(40 - first.counts.superseded);
    expect(first.timings.totalMs).toBeLessThanOrEqual(18_000);

    let last = first;
    for (let i = 0; i < 5 && last.status !== 'succeeded'; i++) last = await run(s.db);
    expect(last.status).toBe('succeeded');
    const audits = s.db.table('ii_reference_corrections');
    expect(audits).toHaveLength(40);
    expect(new Set(audits.map((a) => a.target_row_id)).size).toBe(40);
  });
});

describe('PC6 ingest: a run with nothing to do is cheap and changes nothing', () => {
  async function completed() {
    const s = setup();
    for (let i = 0; i < 10; i++) if ((await run(s.db)).status === 'succeeded') break;
    return s;
  }

  it('after a complete run, the next call on the same file skips: no batch, no job-control write, a handful of small reads', async () => {
    const s = await completed();
    const batchCount = batches(s.db).length;
    const controlBefore = JSON.stringify(control(s.db));
    const logBefore = s.db.log.length;
    const clockBefore = s.db.clockMs;

    const r = await run(s.db);

    expect(r.status).toBe('skipped_unchanged_source');
    expect(batches(s.db)).toHaveLength(batchCount);
    expect(JSON.stringify(control(s.db))).toBe(controlBefore);
    const reqs = s.db.log.slice(logBefore);
    expect(reqs.length).toBeLessThanOrEqual(6);
    expect(reqs.some((l) => l.verb !== 'select')).toBe(false); // read-only
    expect(reqs.some((l) => l.table.startsWith('rpc:') || l.table === 'ii_prices_nav')).toBe(false);
    expect(s.db.clockMs - clockBefore).toBeLessThan(4_000); // the fetch plus small reads
  });

  it('NEGATIVE CONTROL: a changed file is NOT skipped', async () => {
    const s = await completed();
    const fx2 = buildNavAll({ currentSchemes: 2400, dormantSchemes: 200, currentDate: CURRENT, dormantDates: 40, navOverride: new Map([['300007', '99.9999']]) });
    fileBytes = fx2.bytes;
    const r = await run(s.db);
    expect(r.status).toBe('succeeded');
    expect(r.counts.superseded).toBe(1);
  });

  it('NEGATIVE CONTROL: a newly resolvable scheme (identifier created after the last success) is NOT skipped', async () => {
    const s = await completed();
    s.db.table('ii_instrument_identifiers').push({ id: 'new-ident', instrument_id: 'x', identifier_scheme: 'amfi_scheme_code', identifier_value: '999999', country_code: 'IN', is_active: true, created_at: new Date(Date.now() + 1000).toISOString() });
    const r = await run(s.db);
    expect(r.status).not.toBe('skipped_unchanged_source');
    expect(batches(s.db).at(-1)!.status).toBe('succeeded');
  });

  it('NEGATIVE CONTROL: a continuing (partial) run is never treated as complete', async () => {
    const s = setup();
    const first = await run(s.db);
    expect(first.status).toBe('partial');
    const second = await run(s.db);
    expect(second.status).not.toBe('skipped_unchanged_source');
    expect(second.counts.inserted).toBeGreaterThan(0);
  });

  it('the kill switch still wins before any fetch', async () => {
    const s = setup();
    control(s.db).enabled = false;
    control(s.db).disabled_reason = 'test';
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const r = await run(s.db);
    expect(r.status).toBe('skipped_kill_switch');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(batches(s.db)).toHaveLength(0);
  });
});

describe('PC6 ingest: the weekly scheme master gets the same budgeted treatment', () => {
  it('a mass-change week is written across calls, then the next call skips', async () => {
    const db = new FakeDb();
    Object.assign(db.costs, COSTS, { 'ii_scheme_master:insert': 4_000, 'ii_scheme_master:select': 150 });
    const fx = buildNavAll({ currentSchemes: 2400, dormantSchemes: 200, currentDate: CURRENT, dormantDates: 40 });
    fileBytes = fx.bytes;
    seedUniverse(db, fx);
    seedJobControl(db, 'pc6_amfi_scheme_master');
    current = db;
    const call = () => runReferenceIngest({ jobKey: 'pc6_amfi_scheme_master', sourceConfigId: 'amfi_scheme_master', asOfDate: CURRENT, now: db.now });

    const statuses: string[] = [];
    for (let i = 0; i < 10; i++) {
      const r = await call();
      statuses.push(r.status);
      expect(r.timings.totalMs).toBeLessThanOrEqual(18_000);
      if (r.status === 'succeeded') break;
    }
    expect(statuses[0]).toBe('partial');
    expect(statuses.at(-1)).toBe('succeeded');
    const rows = db.table('ii_scheme_master');
    expect(rows).toHaveLength(2600);
    expect(new Set(rows.map((r) => r.amfi_scheme_code)).size).toBe(2600);
    expect(db.table('ii_reference_job_control')[0].last_success_batch_id).toBe(db.table('ii_reference_import_batches').at(-1)!.id);
    expect((await call()).status).toBe('skipped_unchanged_source');
  });
});
