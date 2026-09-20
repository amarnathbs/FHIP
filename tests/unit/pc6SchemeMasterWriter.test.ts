// PC6 (M6) — regression coverage for the ii_scheme_master write path found
// missing 2026-09-20 (see schemeMasterWriter.ts's header for the real
// incident: the certification report claimed this was proven, but no code
// anywhere ever wrote to this table -- an amfi_scheme_master ingest run
// silently inserted NAV-price rows instead).
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { writeSchemeMasterRows } from '@/lib/services/investment-intelligence/pc6/schemeMasterWriter';
import type { AmfiSchemeNavRecord } from '@/lib/services/investment-intelligence/pc6/amfiParser';
import type { InstrumentResolutionIndex } from '@/lib/services/investment-intelligence/pc6/referenceImportRunner';

type Row = Record<string, unknown>;

function makeFakeDb(schemeMasterRows: Row[]) {
  const tables: Record<string, Row[]> = { ii_scheme_master: schemeMasterRows };
  const calls: { table: string; verb: string; payload?: unknown }[] = [];

  function from(table: string) {
    const rows = tables[table] ?? (tables[table] = []);
    let filtered = rows.slice();

    const builder = {
      select: () => builder,
      order: () => builder,
      eq(col: string, val: unknown) {
        filtered = filtered.filter((r) => r[col] === val);
        return builder;
      },
      is(col: string, val: null) {
        filtered = filtered.filter((r) => r[col] === val);
        return builder;
      },
      in(col: string, vals: unknown[]) {
        filtered = filtered.filter((r) => vals.includes(r[col]));
        return Object.assign(builder, {
          // update(...).in(...) resolves immediately (no further chaining needed)
          then: (resolve: (v: unknown) => unknown) => resolve(applyPendingUpdate()),
        });
      },
      // fetchAllRows() (lib/services/investment-intelligence/pagination.ts)
      // pages via .range(). Fixtures here are always far under one page, so
      // returning the whole (already-filtered) slice in one go is correct --
      // fetchAllRows terminates as soon as a page comes back shorter than
      // the page size, which this always is.
      range(from: number, to: number) {
        return Promise.resolve({ data: filtered.slice(from, to + 1), error: null });
      },
      insert(payload: Row[]) {
        calls.push({ table, verb: 'insert', payload });
        const created = payload.map((p, i) => ({ id: `gen-${rows.length + i}`, ...p }));
        rows.push(...created);
        return Promise.resolve({ data: created, error: null });
      },
      update(payload: Row) {
        pendingUpdate = payload;
        calls.push({ table, verb: 'update', payload });
        return builder;
      },
      then(resolve: (v: unknown) => unknown) {
        return resolve({ data: filtered, error: null });
      },
    };
    let pendingUpdate: Row | null = null;
    function applyPendingUpdate() {
      if (pendingUpdate) {
        for (const r of filtered) Object.assign(r, pendingUpdate);
      }
      return { data: filtered, error: null };
    }
    return builder;
  }

  return { from, tables, calls };
}

function baseRecord(overrides: Partial<AmfiSchemeNavRecord>): AmfiSchemeNavRecord {
  return {
    amfiSchemeCode: '100001',
    schemeName: 'Test Fund',
    amcName: 'Test AMC',
    schemeStructure: 'open_ended',
    categoryHeaderRaw: 'Open Ended Schemes(Equity Scheme - Large Cap Fund)',
    categoryGroup: 'Equity Scheme',
    subCategory: 'Large Cap Fund',
    planRaw: 'Direct',
    planType: 'direct',
    optionRaw: 'Growth',
    optionType: 'growth',
    isinGrowthOrPayout: 'INF000K01ABC',
    isinReinvestment: null,
    navRaw: '100.0000',
    nav: 100,
    navDate: '2026-09-19',
    sourceLine: 10,
    recordChecksum: 'irrelevant-nav-checksum',
    fieldWarnings: [],
    ...overrides,
  };
}

const OPTS = { countryCode: 'IN', currencyCode: 'INR', sourceId: null, importBatchId: 'batch-1', asOfDate: '2026-09-20' };

describe('writeSchemeMasterRows — the real ii_scheme_master write path', () => {
  it('inserts a genuinely new scheme identity row for a resolved instrument', async () => {
    const db = makeFakeDb([]);
    const index: InstrumentResolutionIndex = { byAmfiCode: new Map([['100001', 'inst-1']]), byIsin: new Map() };
    const result = await writeSchemeMasterRows(db as never, [baseRecord({})], index, OPTS, 500);

    expect(result.errors).toEqual([]);
    expect(result.counts).toEqual({ resolved: 1, unresolved: 0, inserted: 1, unchanged: 0, superseded: 0 });
    expect(db.tables.ii_scheme_master).toHaveLength(1);
    expect(db.tables.ii_scheme_master[0]).toMatchObject({ scheme_name: 'Test Fund', isin_growth_or_payout: 'INF000K01ABC', effective_from: '2026-09-20', effective_to: null });
  });

  it('resolves via ISIN when no amfi_scheme_code identifier is on file', async () => {
    const db = makeFakeDb([]);
    const index: InstrumentResolutionIndex = { byAmfiCode: new Map(), byIsin: new Map([['INF000K01ABC', 'inst-2']]) };
    const result = await writeSchemeMasterRows(db as never, [baseRecord({})], index, OPTS, 500);

    expect(result.counts.resolved).toBe(1);
    expect(result.counts.inserted).toBe(1);
    expect(db.tables.ii_scheme_master[0].instrument_id).toBe('inst-2');
  });

  it('a scheme with no matching instrument counts as unresolved and writes nothing', async () => {
    const db = makeFakeDb([]);
    const index: InstrumentResolutionIndex = { byAmfiCode: new Map(), byIsin: new Map() };
    const result = await writeSchemeMasterRows(db as never, [baseRecord({})], index, OPTS, 500);

    expect(result.counts).toEqual({ resolved: 0, unresolved: 1, inserted: 0, unchanged: 0, superseded: 0 });
    expect(db.tables.ii_scheme_master).toHaveLength(0);
  });

  it('an unchanged identity (same checksum-relevant fields) writes nothing, even with a different daily NAV', async () => {
    const existing = {
      id: 'row-1', instrument_id: 'inst-1', amfi_scheme_code: '100001', scheme_name: 'Test Fund', amc_name: 'Test AMC',
      isin_growth_or_payout: 'INF000K01ABC', isin_reinvestment: null, plan_raw: 'Direct', plan_type: 'direct',
      option_raw: 'Growth', option_type: 'growth', scheme_structure: 'open_ended',
      category_header_raw: 'Open Ended Schemes(Equity Scheme - Large Cap Fund)', category_group: 'Equity Scheme', sub_category: 'Large Cap Fund',
      country_code: 'IN', effective_to: null,
      // Precomputed to match identityChecksum()'s own algorithm for baseRecord({}) — see that function's field order.
      record_checksum: createHash('sha256').update(['Test Fund', 'Test AMC', 'open_ended', 'Open Ended Schemes(Equity Scheme - Large Cap Fund)', 'Equity Scheme', 'Large Cap Fund', 'Direct', 'direct', 'Growth', 'growth', 'INF000K01ABC', ''].join('|')).digest('hex'),
    };
    const db = makeFakeDb([existing]);
    const index: InstrumentResolutionIndex = { byAmfiCode: new Map([['100001', 'inst-1']]), byIsin: new Map() };
    // A different NAV value than yesterday -- identity is unchanged regardless.
    const result = await writeSchemeMasterRows(db as never, [baseRecord({ nav: 105, navRaw: '105.0000' })], index, OPTS, 500);

    expect(result.counts).toEqual({ resolved: 1, unresolved: 0, inserted: 0, unchanged: 1, superseded: 0 });
    expect(db.tables.ii_scheme_master).toHaveLength(1); // untouched
  });

  it('a genuine identity change (e.g. a fund rename) closes the old row and opens a new one — never mutates history in place', async () => {
    const existing = {
      id: 'row-1', instrument_id: 'inst-1', amfi_scheme_code: '100001', scheme_name: 'Old Fund Name', amc_name: 'Test AMC',
      isin_growth_or_payout: 'INF000K01ABC', isin_reinvestment: null, plan_raw: 'Direct', plan_type: 'direct',
      option_raw: 'Growth', option_type: 'growth', scheme_structure: 'open_ended',
      category_header_raw: 'Open Ended Schemes(Equity Scheme - Large Cap Fund)', category_group: 'Equity Scheme', sub_category: 'Large Cap Fund',
      country_code: 'IN', effective_to: null, record_checksum: 'a-completely-different-checksum',
    };
    const db = makeFakeDb([existing]);
    const index: InstrumentResolutionIndex = { byAmfiCode: new Map([['100001', 'inst-1']]), byIsin: new Map() };
    const result = await writeSchemeMasterRows(db as never, [baseRecord({ schemeName: 'New Fund Name (renamed)' })], index, OPTS, 500);

    expect(result.counts).toEqual({ resolved: 1, unresolved: 0, inserted: 1, unchanged: 0, superseded: 1 });
    expect(db.tables.ii_scheme_master).toHaveLength(2);
    const old = db.tables.ii_scheme_master.find((r) => r.id === 'row-1')!;
    expect(old.effective_to).toBe('2026-09-20'); // closed, not deleted
    expect(old.scheme_name).toBe('Old Fund Name'); // history preserved verbatim
    const fresh = db.tables.ii_scheme_master.find((r) => r.scheme_name === 'New Fund Name (renamed)')!;
    expect(fresh.effective_to).toBeNull();
    expect(fresh.effective_from).toBe('2026-09-20');
  });

  it('de-duplicates multiple records for the same AMFI scheme code within one run (last one wins)', async () => {
    const db = makeFakeDb([]);
    const index: InstrumentResolutionIndex = { byAmfiCode: new Map([['100001', 'inst-1']]), byIsin: new Map() };
    const result = await writeSchemeMasterRows(
      db as never,
      [baseRecord({ schemeName: 'First' }), baseRecord({ schemeName: 'Second (should win)' })],
      index,
      OPTS,
      500
    );
    expect(result.counts.inserted).toBe(1);
    expect(db.tables.ii_scheme_master[0].scheme_name).toBe('Second (should win)');
  });
});
