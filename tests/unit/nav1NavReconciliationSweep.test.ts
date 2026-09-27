// NAV 1 -- PO decision #1 (27 Sep 2026): the reconciliation sweep's real
// orchestration, driven against the same in-memory PostgREST stand-in the
// daily-NAV budget tests use (tests/unit/support/pc6IngestFakeDb.ts), so the
// exact-pair lookup, upsert/ignoreDuplicates semantics and the
// ii_reference_import_batches CHECK constraints are all genuinely exercised,
// not merely mocked away.
//
// Proves, by name, the two things the PO explicitly asked for:
//   - IDEMPOTENCY: re-running the sweep with unchanged source data does
//     nothing (no new batch, no new rows, coverage stays 'complete_no_gap').
//   - CORRECTION HANDLING: a later, different NAV for an already-recorded
//     date updates the existing row in place (with an audit trail) -- never
//     a duplicate-key failure.
// Plus the coverage/complete-flag semantics and the coverage_alert
// fire/resolve lifecycle.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FakeDb, buildNavAll, seedUniverse, seedJobControl, fakeUuid } from './support/pc6IngestFakeDb';
import { parseNavAll } from '@/lib/services/investment-intelligence/pc6/amfiParser';

let current: FakeDb;
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => current }));

import { runNavReconciliationSweep } from '@/lib/services/investment-intelligence/pc6/navReconciliationSweep';

const DATE = '2026-09-27';
const JOB = 'pc6_amfi_daily_nav_reconciliation';
let fileBytes: Uint8Array;

const COSTS = {
  '*': 20,
  'ii_instrument_identifiers:select': 100,
  'ii_instruments:select': 100,
  'rpc:ii_prices_nav_existing_pairs': 150,
  'ii_prices_nav:upsert': 200,
  'ii_prices_nav:select': 50,
  'ii_prices_nav:update': 50,
  'ii_reference_corrections:insert': 50,
};

beforeEach(() => {
  vi.stubGlobal('fetch', async () => {
    current.advance(400);
    return new Response(fileBytes as unknown as BodyInit, { status: 200 });
  });
});
afterEach(() => vi.unstubAllGlobals());

// AMFI's real NAVAll.txt is always north of the 200,000-byte plausibility
// floor (classifyFetch/MIN_PLAUSIBLE_FULL_UNIVERSE_BYTES) because it lists
// every scheme's LATEST nav, not just today's -- a genuinely small file is an
// outage, not a quiet day. DORMANT_PADDING reproduces that shape: schemes
// carrying an OLD date, present in every fixture below, so the byte count
// stays realistic while `currentSchemes` controls exactly how many records
// carry the publication date under test (the number the sweep's "expected"
// set is actually built from).
const DORMANT_PADDING = { dormantSchemes: 2200, dormantDates: 5 };

function setup(schemeCount: number) {
  const db = new FakeDb();
  Object.assign(db.costs, COSTS);
  const fx = buildNavAll({ currentSchemes: schemeCount, currentDate: DATE, ...DORMANT_PADDING });
  fileBytes = fx.bytes;
  const byCode = seedUniverse(db, fx);
  seedJobControl(db, JOB);
  return { db, fx, byCode };
}

const batches = (db: FakeDb) => db.table('ii_reference_import_batches');
const control = (db: FakeDb) => db.table('ii_reference_job_control').find((r) => r.job_key === JOB)!;
const coverage = (db: FakeDb) => db.table('ii_reference_publication_coverage').find((r) => r.publication_date === DATE);
const alerts = (db: FakeDb) => db.table('ii_reference_coverage_alerts');
const navRows = (db: FakeDb) => db.table('ii_prices_nav');

async function run(db: FakeDb, extra: Record<string, unknown> = {}) {
  current = db;
  return runNavReconciliationSweep({ jobKey: JOB, sourceConfigId: 'amfi_nav_daily', publicationDate: DATE, now: db.now, ...extra });
}

describe('NAV1 reconciliation sweep: no gap', () => {
  it('everything already present and correct -> complete_no_gap, no batch, coverage marked complete', async () => {
    const { db, fx, byCode } = setup(30);
    const parsed = parseNavAll(fx.bytes, { asOfDate: DATE });
    for (const r of parsed.records) {
      db.table('ii_prices_nav').push({ id: fakeUuid(), instrument_id: byCode.get(r.amfiSchemeCode), price_date: r.navDate, price: r.navRaw, record_checksum: r.recordChecksum, quality_status: 'ok' });
    }
    const before = { ...control(db) };
    const res = await run(db);

    expect(res.status).toBe('complete_no_gap');
    expect(res.batchId).toBeNull();
    expect(batches(db)).toHaveLength(0);
    expect(res.coverage).toEqual({ expectedCount: 30, presentCountBefore: 30, presentCountAfter: 30, missingCountAfter: 0, complete: true });
    expect(coverage(db)).toMatchObject({ expected_count: 30, present_count: 30, missing_count: 0, complete: true });
    // A genuine success: last_success_at moves forward, no failure recorded.
    expect(control(db).last_success_at).not.toBe(before.last_success_at);
    expect(control(db).consecutive_failures).toBe(0);
  });

  it('the kill switch wins before any fetch', async () => {
    const { db } = setup(10);
    control(db).enabled = false;
    control(db).disabled_reason = 'test';
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const res = await run(db);
    expect(res.status).toBe('skipped_kill_switch');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(batches(db)).toHaveLength(0);
  });
});

describe('NAV1 reconciliation sweep: fills a real gap, then is idempotent', () => {
  it('missing rows are inserted; a rerun with the same source does nothing further', async () => {
    const { db, fx, byCode } = setup(20);
    const parsed = parseNavAll(fx.bytes, { asOfDate: DATE });
    // Only the first 12 of 20 are already stored; 8 are genuinely missing.
    parsed.records.slice(0, 12).forEach((r) => {
      db.table('ii_prices_nav').push({ id: fakeUuid(), instrument_id: byCode.get(r.amfiSchemeCode), price_date: r.navDate, price: r.navRaw, record_checksum: r.recordChecksum, quality_status: 'ok' });
    });

    const first = await run(db);
    expect(first.status).toBe('succeeded');
    expect(first.batchId).not.toBeNull();
    expect(first.counts.inserted).toBe(8);
    expect(first.counts.superseded).toBe(0);
    expect(first.coverage).toEqual({ expectedCount: 20, presentCountBefore: 12, presentCountAfter: 20, missingCountAfter: 0, complete: true });
    expect(batches(db)).toHaveLength(1);
    expect(batches(db)[0].batch_kind).toBe('nav_reconciliation');
    expect(batches(db)[0].status).toBe('succeeded');
    expect(navRows(db)).toHaveLength(20);

    // IDEMPOTENCY: rerun with the exact same fixture -- nothing missing now,
    // so the sweep must not even open a batch or write anything.
    const rowsBefore = JSON.stringify(navRows(db));
    const batchCountBefore = batches(db).length;
    const second = await run(db);
    expect(second.status).toBe('complete_no_gap');
    expect(second.batchId).toBeNull();
    expect(batches(db)).toHaveLength(batchCountBefore);
    expect(JSON.stringify(navRows(db))).toBe(rowsBefore);
    expect(navRows(db)).toHaveLength(20); // no duplicate-key failure, no double insert
  });

  it('a partial run (budget exhausted) is resumable and never duplicates a write', async () => {
    const EXPECTED = 40;
    const { db, fx, byCode } = setup(EXPECTED);
    Object.assign(db.costs, { 'ii_prices_nav:upsert': 6_000 }); // one chunk fits comfortably inside 18s, a few do not
    void byCode; // nothing pre-stored -- every record is missing
    void fx;
    const statuses: string[] = [];
    for (let i = 0; i < 8; i++) {
      const r = await run(db, { chunkSize: 5 }); // small chunks so the budget genuinely bites
      statuses.push(r.status);
      if (r.status === 'succeeded') break;
    }
    expect(statuses[0]).toBe('partial');
    expect(statuses.at(-1)).toBe('succeeded');
    expect(navRows(db)).toHaveLength(EXPECTED); // only the schemes carrying DATE -- the dormant padding is never written
    expect(new Set(navRows(db).map((r) => `${r.instrument_id}|${r.price_date}`)).size).toBe(EXPECTED);
    expect(coverage(db)?.complete).toBe(true);
  });
});

describe('NAV1 reconciliation sweep: correction handling', () => {
  it('a later, different NAV for an already-recorded date is updated in place, audited, never a duplicate-key failure', async () => {
    const { db, fx, byCode } = setup(15);
    const parsed = parseNavAll(fx.bytes, { asOfDate: DATE });
    parsed.records.forEach((r) => {
      db.table('ii_prices_nav').push({ id: fakeUuid(), instrument_id: byCode.get(r.amfiSchemeCode), price_date: r.navDate, price: r.navRaw, record_checksum: r.recordChecksum, quality_status: 'ok' });
    });
    // Confirm complete first (nothing to fix yet).
    expect((await run(db)).status).toBe('complete_no_gap');

    // AMFI republishes scheme 300000 with a genuinely different NAV for the SAME date.
    const corrected = buildNavAll({ currentSchemes: 15, currentDate: DATE, ...DORMANT_PADDING, navOverride: new Map([['300000', '999.9999']]) });
    fileBytes = corrected.bytes;

    const res = await run(db);
    expect(res.status).toBe('succeeded');
    expect(res.counts.inserted).toBe(0);
    expect(res.counts.superseded).toBe(1);
    expect(res.coverage?.complete).toBe(true);

    const row = navRows(db).find((r) => r.instrument_id === byCode.get('300000'))!;
    expect(row.price).toBe('999.9999');
    expect(navRows(db).filter((r) => r.instrument_id === byCode.get('300000'))).toHaveLength(1); // in-place update, not a second physical row
    const audits = db.table('ii_reference_corrections');
    expect(audits).toHaveLength(1);
    expect(audits[0].correction_kind).toBe('source_correction');
    expect(audits[0].previous_value).toBeTruthy();
    expect(audits[0].new_value).toBeTruthy();

    // Re-running again with the SAME corrected file is a genuine no-op.
    const rowsBefore = JSON.stringify(navRows(db));
    const third = await run(db);
    expect(third.status).toBe('complete_no_gap');
    expect(JSON.stringify(navRows(db))).toBe(rowsBefore);
    expect(db.table('ii_reference_corrections')).toHaveLength(1); // not audited twice
  });
});

describe('NAV1 reconciliation sweep: coverage_alert', () => {
  it('fires when confirmed coverage is materially below the recent baseline, and resolves once a later publication of the same date recovers', async () => {
    const db = new FakeDb();
    Object.assign(db.costs, COSTS);
    seedJobControl(db, JOB);
    // Seed baseline history: 5 prior days, each with 100 present.
    for (let i = 1; i <= 5; i++) {
      db.table('ii_reference_publication_coverage').push({
        id: `hist-${i}`, source_config_id: 'amfi_nav_daily', publication_date: `2026-09-${20 + i}`,
        expected_count: 100, present_count: 100, missing_count: 0, complete: true, last_checked_at: new Date().toISOString(),
      });
    }

    // The full universe (100 schemes carrying DATE once AMFI finishes, plus
    // realistic dormant padding so both fixtures clear the 200,000-byte
    // plausibility floor -- see DORMANT_PADDING) is registered up front:
    // resolvability never changes through the day, only which schemes'
    // rows already carry today's date.
    const full = buildNavAll({ currentSchemes: 100, currentDate: DATE, ...DORMANT_PADDING });
    seedUniverse(db, full);

    // EARLY same-day file: only 10 of the 100 schemes carry DATE so far; the
    // other 90 still show their PRIOR date (this is F-18's real shape: AMFI's
    // file always lists every scheme, but a scheme's OWN row keeps yesterday's
    // date until AMFI updates it later the same day -- the file's total size
    // does not shrink through the day).
    const early = buildNavAll({ currentSchemes: 10, currentDate: DATE, dormantSchemes: 90 + DORMANT_PADDING.dormantSchemes, dormantDates: DORMANT_PADDING.dormantDates });
    fileBytes = early.bytes;

    const first = await run(db);
    expect(first.status).toBe('succeeded');
    expect(first.coverage?.expectedCount).toBe(10);
    expect(first.coverage?.complete).toBe(true); // complete relative to what the source published so far
    expect(first.alert?.fired).toBe(true); // but 10/baseline(100) is materially below
    expect(alerts(db)).toHaveLength(1);
    expect(alerts(db)[0].resolved_at).toBeNull();

    // AMFI later republishes the SAME date with all 100 schemes now carrying
    // DATE (F-18: a late, fuller publication for the same publication date).
    fileBytes = full.bytes;
    const second = await run(db);
    expect(second.status).toBe('succeeded');
    expect(second.counts.inserted).toBe(90); // the 10 already stored are unchanged, 90 are new
    expect(second.coverage?.expectedCount).toBe(100);
    expect(second.coverage?.complete).toBe(true);
    expect(second.alert?.fired).toBe(false);

    const openAlerts = alerts(db).filter((a) => a.resolved_at === null);
    expect(openAlerts).toHaveLength(0);
    expect(alerts(db)).toHaveLength(1); // updated in place, never duplicated
    expect(alerts(db)[0].resolved_at).not.toBeNull();
  });

  it('does not alert without enough baseline history (cold start)', async () => {
    const { db, byCode } = setup(5);
    void byCode;
    // Nothing pre-stored, so the sweep genuinely fills the gap (status
    // 'succeeded') -- the point of this test is that with zero prior coverage
    // history it must not fabricate a baseline and alert anyway.
    const res = await run(db);
    expect(res.status).toBe('succeeded');
    expect(res.alert?.fired).toBe(false);
    expect(res.alert?.detail).toMatch(/need 3/);
    expect(alerts(db)).toHaveLength(0);
  });
});
