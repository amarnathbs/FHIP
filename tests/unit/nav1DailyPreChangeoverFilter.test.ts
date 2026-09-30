// NAV 1 -- the daily NAVAll job must not write pre-changeover rows
// (2026-10-01).
//
// THE DEFECT. NAVAll.txt carries each scheme's LATEST NAV, so a dormant
// scheme's final, years-old NAV sits in the file. The daily job wrote every
// parsed record, so after Stage E deleted the orphaned history it re-created
// 1,276 pre-changeover rows (all failing pc6_nav_row_is_candidate) on
// 2026-09-30. These tests drive the REAL runReferenceIngest() against the
// in-memory PostgREST stand-in and pin the fix: resolved, unprotected records
// dated before the changeover date C (read from ii_nav_retention_policy) are
// skipped and COUNTED; protected instruments keep their row; everything
// fails open when the policy cannot be determined; the amfi_navhistory_txt
// path is untouched.
//
// NEGATIVE CONTROLS are explicit below ("NEGATIVE CONTROL"), and the commit
// that adds this file records the mutation run (filter line removed ->
// named failures).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FakeDb, amfiDate, seedUniverse, seedJobControl, type NavFixture } from './support/pc6IngestFakeDb';

let current: FakeDb;
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => current }));

import { runReferenceIngest } from '@/lib/services/investment-intelligence/pc6/referenceIngestJob';
import {
  expandMergeFamily,
  loadPreChangeoverFilterContext,
  partitionPreChangeover,
  appliesToSource,
} from '@/lib/services/investment-intelligence/pc6/dailyPreChangeoverFilter';
import { parseNavAll } from '@/lib/services/investment-intelligence/pc6/amfiParser';
import type { SupabaseClient } from '@supabase/supabase-js';

const C = '2026-09-21';
const AS_OF = '2026-09-24';
const JOB = 'pc6_amfi_daily_nav';
const HIST_JOB = 'pc6_amfi_nav_history';
let fileBytes: Uint8Array;

beforeEach(() => {
  vi.stubGlobal('fetch', async () => new Response(fileBytes as unknown as BodyInit, { status: 200 }));
});
afterEach(() => vi.unstubAllGlobals());

interface Entry { code: string; date: string }

/** The job treats a body under 200,000 bytes as an outage (classifyFetch), so fixtures are padded with blank lines, which the parser skips. */
const pad = (text: string) => text + ' \n'.repeat(110_000);

/** A NAVAll.txt (real column layout) with an arbitrary date per scheme. */
function navAllFile(entries: Entry[], navOf: (e: Entry, i: number) => string = (_e, i) => (10 + i / 100).toFixed(4)): NavFixture {
  const schemes: NavFixture['schemes'] = [];
  const lines = [
    'Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;Scheme Name;Plan;Option;Net Asset Value;Date',
    ' ',
    'Open Ended Schemes(Equity Scheme - Large Cap Fund)',
    ' ',
    'Synthetic Mutual Fund',
    ' ',
  ];
  entries.forEach((e, i) => {
    const nav = navOf(e, i);
    schemes.push({ code: e.code, navDate: e.date, nav });
    lines.push(`${e.code};-;-;Synthetic Fund ${e.code} - Descriptive Name;Direct Plan;Growth Option;${nav};${amfiDate(e.date)}`);
  });
  const text = pad(lines.join('\n') + '\n');
  return { text, bytes: new TextEncoder().encode(text), schemes };
}

/** The same schemes in AMFI's NAV-history column order (amfi_navhistory_txt). */
function navHistoryFile(entries: Entry[]): Uint8Array {
  const lines = [
    'Scheme Code;NAV Name;Plan;Option;ISIN Growth;ISIN Reinvestment;NAV;Date',
    '',
    'Open Ended Schemes ( Growth )',
    '',
    'Synthetic Mutual Fund',
    ...entries.map((e, i) => `${e.code};Synthetic Fund ${e.code} - Descriptive Name;Direct Plan;Growth Option;-;-;${(10 + i / 100).toFixed(4)};${amfiDate(e.date)}`),
  ];
  return new TextEncoder().encode(pad(lines.join('\n') + '\n'));
}

const CODES = {
  held: '400300', bench: '400301', holdOpen: '400302', holdReleased: '400303', holdExpired: '400304',
  mergedIntoHeld: '400305', reportDep: '400306', unresolved: '400400', onC: '400100', dayBefore: '400101', sept: '400102',
};

function entries(): Entry[] {
  const out: Entry[] = [];
  for (let i = 0; i < 20; i++) out.push({ code: String(400000 + i), date: AS_OF }); // 20 current
  out.push({ code: CODES.onC, date: C });          // exactly on C: kept by the policy (date >= C)
  out.push({ code: CODES.dayBefore, date: '2026-09-20' }); // C - 1
  out.push({ code: CODES.sept, date: '2026-09-05' });
  for (let i = 0; i < 10; i++) out.push({ code: String(400200 + i), date: `201${i % 6 + 4}-0${i % 9 + 1}-1${i % 9}` }); // 10 dormant, 2014..2019
  for (const c of [CODES.held, CODES.bench, CODES.holdOpen, CODES.holdReleased, CODES.holdExpired, CODES.mergedIntoHeld, CODES.reportDep]) {
    out.push({ code: c, date: '2015-06-01' });
  }
  out.push({ code: CODES.unresolved, date: '2015-06-01' }); // last: seedUniverse leaves it unresolvable
  return out;
}

interface World { db: FakeDb; fx: NavFixture; idOf: Map<string, string> }

function world(opts: { policy?: boolean | Record<string, unknown>; protection?: boolean; file?: Entry[] } = {}): World {
  const db = new FakeDb();
  const fx = navAllFile(opts.file ?? entries());
  fileBytes = fx.bytes;
  const idOf = seedUniverse(db, fx, fx.schemes.length - 1);
  seedJobControl(db, JOB);
  seedJobControl(db, HIST_JOB);
  if (opts.policy !== false) {
    db.table('ii_nav_retention_policy').push({
      policy_version: 'nav1-0189-user-held', changeover_date: C, environment: 'production',
      activated_at: '2026-09-24T08:58:05.346Z', ...(typeof opts.policy === 'object' ? opts.policy : {}),
    });
  }
  if (opts.protection !== false) {
    const id = (code: string) => idOf.get(code)!;
    db.table('rpc:pc6_user_held_instrument_ids').push({ instrument_id: id(CODES.held) });
    db.table('ii_instrument_benchmarks').push({ id: 'bm-1', instrument_id: id(CODES.bench), benchmark_id: 'b', relationship_type: 'tracks' });
    db.table('ii_report_nav_dependencies').push({ id: 'rd-1', instrument_id: id(CODES.reportDep), nav_date_from: null, nav_date_to: '2026-09-01' });
    db.table('ii_nav_retention_holds').push({ id: 'h-open', instrument_id: id(CODES.holdOpen), released_at: null, expires_at: '2999-01-01T00:00:00Z' });
    db.table('ii_nav_retention_holds').push({ id: 'h-rel', instrument_id: id(CODES.holdReleased), released_at: '2026-09-22T00:00:00Z', expires_at: null });
    db.table('ii_nav_retention_holds').push({ id: 'h-exp', instrument_id: id(CODES.holdExpired), released_at: null, expires_at: '2020-01-01T00:00:00Z' });
    // A merger: the 'mergedIntoHeld' scheme was merged into the held scheme.
    db.table('ii_instruments').find((r) => r.id === id(CODES.mergedIntoHeld))!.merged_into_instrument_id = id(CODES.held);
  }
  return { db, fx, idOf };
}

async function run(db: FakeDb, extra: Record<string, unknown> = {}) {
  current = db;
  return runReferenceIngest({ jobKey: JOB, sourceConfigId: 'amfi_nav_daily', asOfDate: AS_OF, now: db.now, budgetMs: Infinity, ...extra });
}

const navRows = (db: FakeDb) => db.table('ii_prices_nav');
const writtenCodes = (w: World) => {
  const codeOf = new Map([...w.idOf].map(([code, id]) => [id, code]));
  return new Set(navRows(w.db).map((r) => codeOf.get(r.instrument_id)!));
};
const lastBatch = (db: FakeDb) => db.table('ii_reference_import_batches').at(-1)!;

const SKIPPED = [CODES.dayBefore, CODES.sept, ...Array.from({ length: 10 }, (_, i) => String(400200 + i)), CODES.holdReleased, CODES.holdExpired];
const KEPT_PROTECTED = [CODES.held, CODES.bench, CODES.holdOpen, CODES.mergedIntoHeld, CODES.reportDep];

describe('daily NAVAll: pre-changeover records are skipped and counted', () => {
  it('(a) skips resolved, unprotected records dated before C; counts them; never looks them up or writes them', async () => {
    const w = world();
    const r = await run(w.db);

    expect(r.status).toBe('succeeded');
    expect(r.counts.skippedPreChangeover).toBe(SKIPPED.length); // 14
    const written = writtenCodes(w);
    for (const code of SKIPPED) expect(written.has(code), `${code} must not be written`).toBe(false);
    expect(written.has(CODES.unresolved)).toBe(false); // never resolvable, never written

    // Not looked up: the exact-pair RPC was asked only about the planned pairs.
    const pairsAsked = w.db.log.filter((l) => l.table === 'rpc:ii_prices_nav_existing_pairs').flatMap((l) => l.filters).map((f) => Number(f.replace('pairs=', '')));
    const resolvedTotal = w.fx.schemes.length - 1; // all but the unresolvable one
    expect(pairsAsked.reduce((a, b) => a + b, 0)).toBe(resolvedTotal - SKIPPED.length);
    // Not sent for insert either.
    const sent = new Set(w.db.navUpsertPayloadKeys);
    for (const code of SKIPPED) expect(sent.has(`${w.idOf.get(code)}|${w.fx.schemes.find((s) => s.code === code)!.navDate}`)).toBe(false);

    // Visible in the run record, not silently dropped.
    const b = lastBatch(w.db);
    expect(b.notes.skipped_pre_changeover).toBe(SKIPPED.length);
    expect(b.notes.pre_changeover_filter).toMatchObject({
      applied: true, changeover_date: C, policy_version: 'nav1-0189-user-held',
      skipped: SKIPPED.length, kept_protected: KEPT_PROTECTED.length, kept_unresolved: 1,
    });
    expect(r.detail).toContain(`${SKIPPED.length} pre-changeover record(s) not written`);
    // The parsed counts still describe the FILE, not the plan.
    expect(r.counts.parsedAccepted).toBe(w.fx.schemes.length);
    expect(b.rows_accepted).toBe(w.fx.schemes.length);
  });

  it('(b) records dated on or after C are inserted exactly as before (C itself included)', async () => {
    const w = world();
    const r = await run(w.db);
    const written = writtenCodes(w);
    for (let i = 0; i < 20; i++) expect(written.has(String(400000 + i))).toBe(true);
    expect(written.has(CODES.onC)).toBe(true);
    expect(navRows(w.db).find((x) => x.instrument_id === w.idOf.get(CODES.onC))!.price_date).toBe(C);
    // 20 current + 1 on C + 5 protected pre-C rows.
    expect(r.counts.inserted).toBe(20 + 1 + KEPT_PROTECTED.length);
    expect(navRows(w.db)).toHaveLength(20 + 1 + KEPT_PROTECTED.length);
  });

  it('(f) an instrument the retention rules protect keeps its stale pre-C row: held, benchmark, report-dependent, open hold, merge family of a held scheme', async () => {
    const w = world();
    await run(w.db);
    const written = writtenCodes(w);
    for (const code of KEPT_PROTECTED) expect(written.has(code), `${code} is protected and must keep its row`).toBe(true);
    // ...while an UNprotected twin of each shape is skipped: a released hold, an expired hold, a plain dormant scheme.
    for (const code of [CODES.holdReleased, CODES.holdExpired, '400200']) expect(written.has(code)).toBe(false);
  });

  it('the unresolved count stays truthful: a pre-C record that resolves to no instrument is not hidden by the filter', async () => {
    const w = world();
    const r = await run(w.db);
    expect(r.counts.unresolved).toBe(1);
    const without = world({ policy: false });
    const r2 = await run(without.db);
    expect(r2.counts.unresolved).toBe(1);
  });

  it('a dry run reports the skip count and writes nothing', async () => {
    const w = world();
    const r = await run(w.db, { dryRun: true });
    expect(r.status).toBe('succeeded');
    expect(r.counts.skippedPreChangeover).toBe(SKIPPED.length);
    expect(navRows(w.db)).toHaveLength(0);
  });

  it('NEGATIVE CONTROL: with the policy changeover moved before every record, nothing is skipped -- so the skip above is the filter, nothing else', async () => {
    const w = world({ policy: { changeover_date: '2000-01-01' } });
    const r = await run(w.db);
    expect(r.counts.skippedPreChangeover).toBe(0);
    for (const code of SKIPPED) expect(writtenCodes(w).has(code)).toBe(true);
    expect(r.counts.inserted).toBe(w.fx.schemes.length - 1);
  });
});

describe('daily NAVAll: fails OPEN when the changeover cannot be determined', () => {
  it('(c) no policy row: behaviour is exactly the pre-fix behaviour, and the run record says the filter did not apply', async () => {
    const w = world({ policy: false });
    const r = await run(w.db);
    expect(r.status).toBe('succeeded');
    expect(r.counts.skippedPreChangeover).toBe(0);
    expect(r.counts.inserted).toBe(w.fx.schemes.length - 1); // every resolvable record, dormant ones included
    for (const code of SKIPPED) expect(writtenCodes(w).has(code)).toBe(true);
    const b = lastBatch(w.db);
    expect(b.notes.pre_changeover_filter).toMatchObject({ applied: false, reason: 'no_policy' });
    expect(b.notes.skipped_pre_changeover).toBe(0);
  });

  it('(c) a malformed changeover date also fails open', async () => {
    const w = world({ policy: { changeover_date: 'not-a-date' } });
    const r = await run(w.db);
    expect(r.status).toBe('succeeded');
    expect(r.counts.skippedPreChangeover).toBe(0);
    expect(r.counts.inserted).toBe(w.fx.schemes.length - 1);
    expect(lastBatch(w.db).notes.pre_changeover_filter).toMatchObject({ applied: false, reason: 'invalid_policy' });
  });

  it('(c) an unreadable protected set fails open (nothing skipped -- a protected row must never be dropped on a guess)', async () => {
    const failing = {
      from: (table: string) => (table === 'ii_nav_retention_policy'
        ? { select: () => ({ order: () => ({ limit: () => ({ maybeSingle: async () => ({ data: { policy_version: 'p', changeover_date: C }, error: null }) }) }) }) }
        : { select: () => { throw new Error('boom: read failed'); } }),
      rpc: () => { throw new Error('boom: rpc failed'); },
    } as unknown as SupabaseClient;
    const load = await loadPreChangeoverFilterContext(failing);
    expect(load.ok).toBe(false);
    if (!load.ok) expect(load.reason).toBe('protection_read_failed');
  });

  it('a policy read error fails open', async () => {
    const erroring = {
      from: () => ({ select: () => ({ order: () => ({ limit: () => ({ maybeSingle: async () => ({ data: null, error: { message: 'permission denied' } }) }) }) }) }),
    } as unknown as SupabaseClient;
    const load = await loadPreChangeoverFilterContext(erroring);
    expect(load).toMatchObject({ ok: false, reason: 'policy_read_failed' });
  });
});

describe('the amfi_navhistory_txt (selective / historical) path is untouched', () => {
  it('(d) pre-changeover rows are inserted exactly as before: no filter, no policy read, no notes', async () => {
    const w = world();
    const hist: Entry[] = [
      { code: '400200', date: '2014-03-07' }, { code: '400200', date: '2014-03-10' }, // unprotected instrument, pre-C
      { code: '400000', date: '2026-09-18' },
    ];
    fileBytes = navHistoryFile(hist);
    current = w.db;
    const r = await runReferenceIngest({
      jobKey: HIST_JOB, sourceConfigId: 'amfi_nav_history', asOfDate: AS_OF, fromDate: '2014-03-01', toDate: '2026-09-20',
      now: w.db.now, budgetMs: Infinity,
    });
    expect(r.status).toBe('succeeded');
    expect(r.counts.inserted).toBe(3);
    expect(r.counts.skippedPreChangeover).toBe(0);
    expect(navRows(w.db).map((x) => x.price_date).sort()).toEqual(['2014-03-07', '2014-03-10', '2026-09-18']);
    expect(w.db.count((l) => l.table === 'ii_nav_retention_policy')).toBe(0); // never even consulted
    expect(lastBatch(w.db).notes.pre_changeover_filter).toBeUndefined();
  });

  it('the scheme_master path (NAVAll.txt read as scheme identity) is not filtered either', () => {
    expect(appliesToSource({ kind: 'scheme_master', format: 'amfi_navall_txt' })).toBe(false);
    expect(appliesToSource({ kind: 'nav_history', format: 'amfi_navhistory_txt' })).toBe(false);
    expect(appliesToSource({ kind: 'daily_nav', format: 'amfi_navall_txt' })).toBe(true);
  });
});

describe('idempotence', () => {
  it('(e) re-running the same day is a no-op; the next day re-skips the same dormant rows and adds only the new current rows', async () => {
    const w = world();
    const first = await run(w.db);
    expect(first.status).toBe('succeeded');
    const afterFirst = navRows(w.db).map((r) => `${r.instrument_id}|${r.price_date}`).sort();

    w.db.advance(120_000);
    const again = await run(w.db);
    expect(again.status).toBe('skipped_unchanged_source'); // nothing written, nothing to skip-count
    expect(navRows(w.db).map((r) => `${r.instrument_id}|${r.price_date}`).sort()).toEqual(afterFirst);

    // Next business day: current schemes move to a new date; dormant schemes are still in the file with their old dates.
    const next = entries().map((e) => (e.date === AS_OF ? { ...e, date: '2026-09-25' } : e));
    fileBytes = navAllFile(next).bytes;
    w.db.advance(86_400_000);
    const second = await run(w.db, { asOfDate: '2026-09-25' });
    expect(second.status).toBe('succeeded');
    expect(second.counts.skippedPreChangeover).toBe(SKIPPED.length);
    expect(second.counts.inserted).toBe(20); // only the 20 new current rows; every protected pre-C row already stored
    const keys = navRows(w.db).map((r) => `${r.instrument_id}|${r.price_date}`);
    expect(new Set(keys).size).toBe(keys.length); // no duplicates
    // Still no unprotected pre-C row, ever.
    for (const code of SKIPPED) expect(writtenCodes(w).has(code)).toBe(false);
  });

  it('a partial (budgeted) run followed by a continuation still never writes a skipped row', async () => {
    const w = world();
    w.db.costs['ii_prices_nav:upsert'] = 9_000;
    const a = await run(w.db, { budgetMs: undefined, chunkSize: 10 }); // default 18 s budget, 10-row chunks: several invocations
    let last = a;
    for (let i = 0; i < 10 && last.status !== 'succeeded'; i++) { w.db.advance(120_000); last = await run(w.db, { budgetMs: undefined, chunkSize: 10 }); }
    expect(last.status).toBe('succeeded');
    for (const code of SKIPPED) expect(writtenCodes(w).has(code)).toBe(false);
    expect(navRows(w.db)).toHaveLength(20 + 1 + KEPT_PROTECTED.length);
  });
});

describe('pure pieces', () => {
  it('partitionPreChangeover: C-1 skipped, C kept, protected kept, unresolved kept', () => {
    const fx = navAllFile([
      { code: '1', date: '2026-09-20' }, { code: '2', date: '2026-09-21' }, { code: '3', date: '2010-01-01' }, { code: '4', date: '2010-01-01' },
    ]);
    const parsed = parseNavAll(fx.bytes, { asOfDate: AS_OF });
    const index = { byAmfiCode: new Map([['1', 'i1'], ['2', 'i2'], ['3', 'i3']]), byIsin: new Map<string, string>() };
    const part = partitionPreChangeover(parsed.records, index, { changeoverDate: C, policyVersion: null, protectedInstrumentIds: new Set(['i3']) });
    expect(part.records.map((r) => r.amfiSchemeCode)).toEqual(['2', '3', '4']);
    expect(part).toMatchObject({ skipped: 1, keptProtected: 1, keptUnresolved: 1 });
  });

  it('expandMergeFamily follows links both ways, transitively, and stops at the depth bound', () => {
    expect([...expandMergeFamily(new Set(['b']), [['a', 'b'], ['b', 'c'], ['c', 'd']])].sort()).toEqual(['a', 'b', 'c', 'd']);
    const chain: Array<readonly [string, string]> = Array.from({ length: 12 }, (_, i) => [`n${i}`, `n${i + 1}`] as const);
    const reach = expandMergeFamily(new Set(['n0']), chain);
    expect(reach.has('n8')).toBe(true);
    expect(reach.has('n9')).toBe(false); // depth 8, as pc6_nav_row_is_candidate
  });
});
