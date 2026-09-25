// PC6 daily NAV ingest -- the exact-pair existing-state lookup (2026-09-25).
//
// The old lookup (instrument IN 100 ids x price_date IN every date in the
// file) is reproduced here VERBATIM from origin/main 8b6692c
// (referenceIngestJob.ts lines 345-367) and run against the same fixture as
// the new exact-pair lookup. The two must produce the SAME `existing` map, and
// planImport() must produce the SAME plan from either -- that is the
// "semantics identical" requirement. Negative controls prove the comparison
// can fail: a lookup that ignores the date, and one that ignores the 1000-row
// cap, each produce a detectably different map.

import { describe, it, expect } from 'vitest';
import { fetchAllRows } from '@/lib/services/investment-intelligence/pagination';
import { loadExistingObservations, ExistingStateLookupError, EXACT_PAIR_MAX_PER_CALL, type NavPair } from '@/lib/services/investment-intelligence/pc6/exactPairLookup';
import { parseNavAll } from '@/lib/services/investment-intelligence/pc6/amfiParser';
import { createWriteBudget, resolveBudgetMs, PC6_INGEST_DEFAULT_BUDGET_MS } from '@/lib/services/investment-intelligence/pc6/ingestBudget';
import { planImport, type InstrumentResolutionIndex } from '@/lib/services/investment-intelligence/pc6/referenceImportRunner';
import type { ExistingObservation, NavQualityStatus } from '@/lib/services/investment-intelligence/pc6/referenceDataQuality';
import { FakeDb, buildNavAll, seedUniverse, addDaysIso, PG_MAX_ROWS, type Row } from './support/pc6IngestFakeDb';

/** VERBATIM (modulo the `db` parameter) from origin/main 8b6692c referenceIngestJob.ts. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the verbatim legacy code took the untyped supabase client
async function legacyLookup(db: any, candidateIds: string[], candidateDates: string[]) {
  const existing = new Map<string, ExistingObservation>();
  const RESOLUTION_BATCH = 100;
  for (let i = 0; i < candidateIds.length; i += RESOLUTION_BATCH) {
    const idSlice = candidateIds.slice(i, i + RESOLUTION_BATCH);
    const rows = await fetchAllRows<{ instrument_id: string; price_date: string; price: number; record_checksum: string | null; quality_status: NavQualityStatus }>(() =>
      db
        .from('ii_prices_nav')
        .select('instrument_id, price_date, price, record_checksum, quality_status')
        .in('instrument_id', idSlice)
        .in('price_date', candidateDates)
        .order('instrument_id')
        .order('price_date')
    );
    for (const r of rows) {
      existing.set(`${r.instrument_id}|${r.price_date}`, {
        value: String(r.price),
        recordChecksum: r.record_checksum ?? '',
        quality_status: r.quality_status,
      });
    }
  }
  return existing;
}

const CURRENT = '2026-09-24';

/**
 * 2,600 schemes (2,400 on the current date, 200 dormant across 40 old dates),
 * every one resolvable, and a NAV table holding: 60 days of history for every
 * current scheme on dates that ALSO appear as dormant dates in the file (the
 * shape that made the old query explode), today's row for 2 in 3 current
 * schemes (some with a different checksum = a correction, one flagged), and
 * the old row for half of the dormant schemes.
 */
function buildFixture() {
  const db = new FakeDb();
  const fx = buildNavAll({ currentSchemes: 2400, dormantSchemes: 200, currentDate: CURRENT, dormantDates: 40 });
  const byCode = seedUniverse(db, fx);
  const parsed = parseNavAll(fx.bytes, { asOfDate: CURRENT });
  const recByCode = new Map(parsed.records.map((r) => [r.amfiSchemeCode, r]));
  const dormantDates = [...new Set(fx.schemes.filter((s) => s.navDate !== CURRENT).map((s) => s.navDate))];
  const nav = db.table('ii_prices_nav');
  fx.schemes.forEach((s, i) => {
    const id = byCode.get(s.code)!;
    const rec = recByCode.get(s.code)!;
    if (s.navDate === CURRENT) {
      for (const d of dormantDates.slice(0, 3)) nav.push({ id: `h-${i}-${d}`, instrument_id: id, price_date: d, price: 9.5, record_checksum: `hist-${i}-${d}`, quality_status: 'ok' });
      for (let k = 1; k <= 20; k++) nav.push({ id: `r-${i}-${k}`, instrument_id: id, price_date: addDaysIso(CURRENT, -k), price: 11, record_checksum: `recent-${i}-${k}`, quality_status: 'ok' });
      if (i % 3 !== 2) {
        const corrected = i % 30 === 0;
        nav.push({ id: `t-${i}`, instrument_id: id, price_date: CURRENT, price: corrected ? 1.2345 : rec.navRaw, record_checksum: corrected ? 'stale-checksum' : rec.recordChecksum, quality_status: i % 300 === 0 ? 'suspicious_jump' : 'ok' });
      }
    } else if (i % 2 === 0) {
      nav.push({ id: `d-${i}`, instrument_id: id, price_date: s.navDate, price: rec.navRaw, record_checksum: rec.recordChecksum, quality_status: 'ok' });
    }
  });
  const index: InstrumentResolutionIndex = { byAmfiCode: byCode, byIsin: new Map() };
  const pairs: NavPair[] = parsed.records.map((r) => ({ instrumentId: byCode.get(r.amfiSchemeCode)!, priceDate: r.navDate }));
  const candidateIds = [...new Set(pairs.map((p) => p.instrumentId))];
  const candidateDates = [...new Set(parsed.records.map((r) => r.navDate))];
  return { db, fx, parsed, index, pairs, candidateIds, candidateDates };
}

describe('PC6 write budget (ingestBudget.ts)', () => {
  it('starts a unit only if its projected end fits; the grace applies to the FIRST unit only; estimates learn the slowest unit', () => {
    let now = 0;
    const b = createWriteBudget({ startedAtMs: 0, budgetMs: 18_000, clock: () => now });
    now = 15_000;
    expect(b.canStart('insert_chunk')).toBe(true); // 15 + 2 (initial estimate) <= 18
    now = 16_500;
    expect(b.canStart('insert_chunk')).toBe(true); // 18.5 > 18 but first unit: <= 18 + 3
    now = 19_500;
    expect(b.canStart('insert_chunk')).toBe(false); // 21.5 > 21: not even the first unit
    b.record('insert_chunk', 4_000); // a unit done, and it took 4 s
    now = 14_500;
    expect(b.canStart('insert_chunk')).toBe(false); // 14.5 + 4 (learned) > 18, and no grace any more
    now = 13_900;
    expect(b.canStart('insert_chunk')).toBe(true);
    expect(b.canStart('correction')).toBe(true); // per-kind estimates
    expect(createWriteBudget({ startedAtMs: 0, budgetMs: Infinity, clock: () => 1e12 }).canStart('insert_chunk')).toBe(true);
  });

  it('resolves the budget: explicit, then PC6_INGEST_BUDGET_MS, then 18 s; nonsense is ignored', () => {
    expect(resolveBudgetMs(12_000, '9000')).toBe(12_000);
    expect(resolveBudgetMs(undefined, '9000')).toBe(9_000);
    expect(resolveBudgetMs(undefined, undefined)).toBe(PC6_INGEST_DEFAULT_BUDGET_MS);
    expect(resolveBudgetMs(-5, 'abc')).toBe(PC6_INGEST_DEFAULT_BUDGET_MS);
    expect(resolveBudgetMs(Infinity, '9000')).toBe(Infinity);
    expect(PC6_INGEST_DEFAULT_BUDGET_MS).toBe(18_000);
  });
});

describe('PC6 exact-pair lookup vs the old cross-product lookup (same fixture)', () => {
  it('ANTI-VACUITY: the fixture reproduces the defect -- the old query reads far more rows than the file has pairs', async () => {
    const f = buildFixture();
    await legacyLookup(f.db, f.candidateIds, f.candidateDates);
    const legacyRowsRead = f.db.log.filter((l) => l.table === 'ii_prices_nav' && l.verb === 'select').reduce((n, l) => n + (l.rows ?? 0), 0);
    expect(f.candidateDates.length).toBeGreaterThan(40);
    expect(legacyRowsRead).toBeGreaterThan(3 * f.pairs.length);
  });

  it('returns the SAME existing map as the old lookup on every key planImport reads, in chunks of <= 1000 pairs', async () => {
    const f = buildFixture();
    const oldMap = await legacyLookup(f.db, f.candidateIds, f.candidateDates);
    const before = f.db.log.length;
    const newMap = await loadExistingObservations(f.db, f.pairs);
    const rpcCalls = f.db.log.slice(before).filter((l) => l.table === 'rpc:ii_prices_nav_existing_pairs');

    // planImport() reads existing.get(`${instrumentId}|${navDate}`) for the
    // file's own pairs and nothing else. On exactly those keys the maps agree.
    const asked = new Set(f.pairs.map((p) => `${p.instrumentId}|${p.priceDate}`));
    const oldOnAsked = [...oldMap.entries()].filter(([k]) => asked.has(k)).sort();
    expect(oldOnAsked.length).toBeGreaterThan(PG_MAX_ROWS); // the 1000-row cap is really in play
    expect([...newMap.entries()].sort()).toEqual(oldOnAsked);
    // The old map's ONLY extra entries are cross-product rows for pairs the
    // file never asked about -- the waste this change removes.
    const extra = [...oldMap.keys()].filter((k) => !asked.has(k));
    expect(extra.length).toBeGreaterThan(0);
    expect(extra.every((k) => !newMap.has(k))).toBe(true);
    expect(rpcCalls.length).toBe(Math.ceil(f.pairs.length / EXACT_PAIR_MAX_PER_CALL));
    expect(rpcCalls.every((c) => Number(c.filters[0].split('=')[1]) <= EXACT_PAIR_MAX_PER_CALL)).toBe(true);
    // No read of ii_prices_nav by filter at all -- only the RPC.
    expect(f.db.log.slice(before).some((l) => l.table === 'ii_prices_nav')).toBe(false);
  });

  it('planImport() produces the identical plan from either map', async () => {
    const f = buildFixture();
    const oldMap = await legacyLookup(f.db, f.candidateIds, f.candidateDates);
    const newMap = await loadExistingObservations(f.db, f.pairs);
    const oldPlan = planImport({ parsed: f.parsed, index: f.index, existing: oldMap, currencyCode: 'INR' });
    const newPlan = planImport({ parsed: f.parsed, index: f.index, existing: newMap, currencyCode: 'INR' });
    expect(newPlan).toEqual(oldPlan);
    // ...and the plan is non-trivial in every branch.
    expect(oldPlan.counts.toInsert).toBeGreaterThan(0);
    expect(oldPlan.counts.unchanged).toBeGreaterThan(0);
    expect(oldPlan.counts.toSupersede).toBeGreaterThan(0);
  });

  it('NEGATIVE CONTROL: a lookup that ignores the date produces a DIFFERENT map (the comparison can fail)', async () => {
    const f = buildFixture();
    const oldMap = await legacyLookup(f.db, f.candidateIds, f.candidateDates);
    // Pair every instrument with its most recent stored date instead of the asked one.
    const wrong = new Map<string, ExistingObservation>();
    const latest = new Map<string, Row>();
    for (const r of f.db.table('ii_prices_nav')) if (!latest.has(r.instrument_id) || r.price_date > latest.get(r.instrument_id)!.price_date) latest.set(r.instrument_id, r);
    for (const p of f.pairs) {
      const r = latest.get(p.instrumentId);
      if (r) wrong.set(`${p.instrumentId}|${p.priceDate}`, { value: String(r.price), recordChecksum: r.record_checksum ?? '', quality_status: r.quality_status });
    }
    const asked = new Set(f.pairs.map((p) => `${p.instrumentId}|${p.priceDate}`));
    const oldOnAsked = [...oldMap.entries()].filter(([k]) => asked.has(k)).sort();
    expect([...wrong.entries()].sort()).not.toEqual(oldOnAsked);
    // ...while the real lookup matches it (same assertion, opposite result).
    expect([...(await loadExistingObservations(f.db, f.pairs)).entries()].sort()).toEqual(oldOnAsked);
  });

  it('NEGATIVE CONTROL: one un-chunked call is silently truncated at 1000 rows (so the chunking is what makes it complete)', async () => {
    const f = buildFixture();
    const oldMap = await legacyLookup(f.db, f.candidateIds, f.candidateDates);
    const { data } = await f.db.rpc('ii_prices_nav_existing_pairs', {
      p_instrument_ids: f.pairs.map((p) => p.instrumentId),
      p_price_dates: f.pairs.map((p) => p.priceDate),
    }) as { data: unknown[] };
    const asked = new Set(f.pairs.map((p) => `${p.instrumentId}|${p.priceDate}`));
    const complete = [...oldMap.keys()].filter((k) => asked.has(k)).length;
    expect(data.length).toBe(PG_MAX_ROWS);
    expect(data.length).toBeLessThan(complete);
    // and asking for more than 1000 per call is clamped by the lookup itself
    const clamped = await loadExistingObservations(f.db, f.pairs, { chunkSize: 5000 });
    expect(clamped.size).toBe(complete);
  });

  it('duplicate pairs are asked about once', async () => {
    const f = buildFixture();
    const before = f.db.log.length;
    const once = await loadExistingObservations(f.db, f.pairs.slice(0, 600));
    const twice = await loadExistingObservations(f.db, [...f.pairs.slice(0, 600), ...f.pairs.slice(0, 600)]);
    expect(twice).toEqual(once);
    const sent = f.db.log.slice(before).filter((l) => l.table.startsWith('rpc:')).map((l) => Number(l.filters[0].split('=')[1]));
    expect(sent).toEqual([600, 600]);
  });

  it('a missing function is reported as EXACT_PAIR_LOOKUP_UNAVAILABLE (apply 0204), never as "nothing exists"', async () => {
    const f = buildFixture();
    f.db.rpcError = { message: 'Could not find the function public.ii_prices_nav_existing_pairs(p_instrument_ids, p_price_dates) in the schema cache', code: 'PGRST202' };
    const err = await loadExistingObservations(f.db, f.pairs).catch((e) => e);
    expect(err).toBeInstanceOf(ExistingStateLookupError);
    expect(err.code).toBe('EXACT_PAIR_LOOKUP_UNAVAILABLE');
    f.db.rpcError = { message: 'canceling statement due to statement timeout', code: '57014' };
    const err2 = await loadExistingObservations(f.db, f.pairs).catch((e) => e);
    expect(err2.code).toBe('EXISTING_STATE_LOOKUP_FAILED');
  });
});
