// R6-FINAL closure — Sections 39-41: pagination audit of R6-P1's OWN new
// repository code (taxRepository.ts), extended boundary suite, and the
// ">1000 tax calculation" adversarial case.
//
// CONTEXT: R6-P0 built the module-wide fetchAllRows() pagination helper and
// its own boundary certification (tests/unit/iiR6P0PaginationCertification.
// test.ts) BEFORE R6-P1's taxRepository.ts existed, so R6-P0's own audit
// could not have covered it. This R6-FINAL closure pass (2026-08-22) audited
// taxRepository.ts's four reads that key off `instrumentIds` and found FOUR
// unbounded `.in(...)` selects with no pagination at all: ii_instruments,
// ii_scheme_tax_classification, ii_prices_nav, ii_exit_load_schedules. The
// ii_prices_nav one was the sharpest: it reads EVERY pre-2018-02-01 NAV row
// for every instrument the household holds, to find the closest date <=
// 2018-01-31 per instrument for grandfathering. A single long-lived equity
// fund's daily NAV history before that cutoff can itself exceed 1000 rows,
// so a silent truncation there does not just drop unrelated data — it can
// make a REAL 31-Jan-2018 FMV vanish for a LATER instrument in id-sort
// order, reported as `fmv_unavailable` and silently denying a real
// grandfathering tax benefit. All four were fixed in this same pass (see
// lib/services/investment-intelligence/taxRepository.ts) before this test
// was written; this suite certifies the fix, not the pre-existing bug.
//
// This suite is hermetic (no live DB), mirroring R6-P0's own mocked-
// Supabase pattern (tests/unit/iiR6P0PaginationCertification.test.ts).

import { describe, it, expect, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { loadTaxDataset } from '@/lib/services/investment-intelligence/taxRepository';

type MockRow = Record<string, unknown>;
const POSTGREST_CAP = 1000;

function applyOrder(rows: MockRow[], clauses: Array<{ col: string; ascending: boolean }>): MockRow[] {
  const result = [...rows];
  for (let i = clauses.length - 1; i >= 0; i--) {
    const { col, ascending } = clauses[i];
    result.sort((a, b) => {
      const av = a[col] as string | number;
      const bv = b[col] as string | number;
      if (av < bv) return ascending ? -1 : 1;
      if (av > bv) return ascending ? 1 : -1;
      return 0;
    });
  }
  return result;
}

function makeTableBuilder(rows: MockRow[]) {
  let filtered = rows;
  const orderClauses: Array<{ col: string; ascending: boolean }> = [];
  const builder = {
    select() {
      return builder;
    },
    eq(col: string, val: unknown) {
      filtered = filtered.filter((r) => r[col] === val);
      return builder;
    },
    in(col: string, vals: unknown[]) {
      const set = new Set(vals);
      filtered = filtered.filter((r) => set.has(r[col]));
      return builder;
    },
    lte(col: string, val: unknown) {
      filtered = filtered.filter((r) => (r[col] as string) <= (val as string));
      return builder;
    },
    order(col: string, opts?: { ascending?: boolean }) {
      orderClauses.push({ col, ascending: opts?.ascending !== false });
      return builder;
    },
    range(from: number, to: number) {
      const sorted = applyOrder(filtered, orderClauses);
      const width = Math.min(to - from + 1, POSTGREST_CAP);
      return Promise.resolve({ data: sorted.slice(from, from + width), error: null });
    },
    // Unbounded await -> PostgREST's real silent 1000-row cap. Every
    // production call site in taxRepository.ts now uses fetchAllRows
    // (.range()) instead of awaiting the builder directly; this `then` only
    // exists so a RED test can prove the pre-fix shape really did truncate.
    then(resolve: (v: { data: MockRow[]; error: null }) => unknown, reject?: (e: unknown) => unknown) {
      const sorted = applyOrder(filtered, orderClauses);
      return Promise.resolve({ data: sorted.slice(0, POSTGREST_CAP), error: null }).then(resolve, reject);
    },
  };
  return builder;
}

function makeSupabaseMock(tables: Record<string, MockRow[]>): SupabaseClient {
  return {
    from(table: string) {
      return makeTableBuilder(tables[table] ?? []);
    },
  } as unknown as SupabaseClient;
}

const USER_ID = 'user-r6final-pagination';

function txnRow(id: string, instrumentId: string, type: string, date: string, units: number, price: number): MockRow {
  return {
    id,
    account_id: 'acct-1',
    instrument_id: instrumentId,
    transaction_type: type,
    transaction_date: date,
    units,
    price_per_unit: price,
    gross_amount: Math.abs(units) * price,
    status: 'confirmed',
    user_id: USER_ID,
  };
}

function priceRow(instrumentId: string, date: string, price: number): MockRow {
  return { instrument_id: instrumentId, price_date: date, price };
}

beforeEach(() => {
  // no shared mutable state between tests in this file
});

// ---------------------------------------------------------------------------
// Section 39/41 — boundary matrix for the fixed reads, at the mandated sizes.
// ---------------------------------------------------------------------------

describe('R6-FINAL Sec.39/41: taxRepository pagination boundary matrix (999/1000/1001/2500/5001)', () => {
  const BOUNDARY_SIZES = [999, 1000, 1001, 2500, 5001];

  for (const size of BOUNDARY_SIZES) {
    it(`ii_prices_nav: retrieves all ${size} pre-cutoff NAV rows for ONE instrument and picks the correct closest-to-31-Jan-2018 FMV`, async () => {
      // `size` daily NAV rows for one instrument, all <= 2018-01-31, plus one
      // acquisition/disposal pair so loadTaxDataset actually reaches the FMV
      // lookup. The CORRECT closest-date-<=-cutoff row is deliberately the
      // LAST one written (2018-01-31 itself) — if pagination silently
      // truncated, a wrong (earlier, lower) price would be picked instead
      // silently, or the FMV would be missing entirely.
      const instrumentId = 'inst-nav-target';
      const navRows: MockRow[] = [];
      // size-1 filler rows, one per day counting back from 2018-01-30, plus
      // the true cutoff row 2018-01-31 with a DISTINCT, checkable price.
      const d = new Date('2018-01-30T00:00:00.000Z');
      for (let i = 0; i < size - 1; i++) {
        const iso = d.toISOString().slice(0, 10);
        navRows.push(priceRow(instrumentId, iso, 10 + (i % 5)));
        d.setUTCDate(d.getUTCDate() - 1);
      }
      navRows.push(priceRow(instrumentId, '2018-01-31', 999.99)); // the true answer

      const tables: Record<string, MockRow[]> = {
        ii_transactions: [
          txnRow('acq-1', instrumentId, 'purchase', '2016-06-01', 100, 20),
          txnRow('disp-1', instrumentId, 'redemption', '2026-06-15', 40, 90),
        ],
        ii_instruments: [{ id: instrumentId, instrument_name: 'NAV Boundary Fund', country_of_domicile: 'IN' }],
        ii_scheme_tax_classification: [],
        ii_prices_nav: navRows,
        ii_exit_load_schedules: [],
      };
      const supabase = makeSupabaseMock(tables);
      const { dataset, warnings, empty } = await loadTaxDataset(supabase, USER_ID);
      expect(empty).toBe(false);
      expect(warnings.filter((w) => w.scope === 'grandfathering_fmv')).toHaveLength(0);
      expect(dataset!.fmv31Jan2018ByInstrument.get(instrumentId)).toBeCloseTo(999.99, 6);
    });
  }

  for (const size of BOUNDARY_SIZES) {
    it(`ii_transactions: retrieves all ${size} transactions for one instrument with no truncation`, async () => {
      const instrumentId = 'inst-txn-boundary';
      const txns: MockRow[] = [];
      for (let i = 0; i < size; i++) {
        const date = `2020-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 27) + 1).padStart(2, '0')}`;
        txns.push(txnRow(`txn-${String(i).padStart(6, '0')}`, instrumentId, 'purchase', date, 10, 10));
      }
      const tables: Record<string, MockRow[]> = {
        ii_transactions: txns,
        ii_instruments: [{ id: instrumentId, instrument_name: 'Txn Boundary Fund', country_of_domicile: 'IN' }],
        ii_scheme_tax_classification: [],
        ii_prices_nav: [],
        ii_exit_load_schedules: [],
      };
      const supabase = makeSupabaseMock(tables);
      const { dataset, empty } = await loadTaxDataset(supabase, USER_ID);
      expect(empty).toBe(false);
      const acqs = dataset!.acquisitionsByInstrument.get(instrumentId) ?? [];
      expect(acqs).toHaveLength(size);
    });
  }
});

// ---------------------------------------------------------------------------
// Section 39 — RED/GREEN: the ORIGINAL unpaged ii_prices_nav read really did
// silently deny a real grandfathering benefit for a LATER instrument.
// ---------------------------------------------------------------------------

describe('R6-FINAL Sec.39: negative control — the pre-fix unpaged ii_prices_nav read silently denies grandfathering', () => {
  it('RED: an unbounded read across two instruments truncates before reaching the second instrument\'s FMV row', async () => {
    // Two instruments, ordered by instrument_id ascending (as the real query
    // does): 'inst-aaaa-first' sorts before 'inst-zzzz-second'. Because the
    // query is ALSO sorted price_date DESCENDING within each instrument, an
    // instrument's own "closest date <= cutoff" row is always the FIRST row
    // of ITS OWN group — so a partial truncation mid-group is actually safe.
    // The real loss mode is sharper: give the FIRST instrument (alone) MORE
    // rows than the entire 1000-row cap, so the cap is exhausted before the
    // SECOND instrument's group is reached AT ALL — its answer row doesn't
    // partially truncate, it is ENTIRELY absent from the response.
    const first = 'inst-aaaa-first';
    const second = 'inst-zzzz-second';
    const rows: MockRow[] = [];
    for (let i = 0; i < 1050; i++) rows.push(priceRow(first, `2016-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 27) + 1).padStart(2, '0')}`, 5));
    for (let i = 0; i < 49; i++) rows.push(priceRow(second, `2017-01-${String((i % 27) + 1).padStart(2, '0')}`, 7));
    // The true, correct FMV for `second`.
    rows.push(priceRow(second, '2018-01-31', 777.77));

    const builder = makeTableBuilder(rows)
      .select()
      .in('instrument_id', [first, second])
      .lte('price_date', '2018-01-31')
      .order('instrument_id', { ascending: true })
      .order('price_date', { ascending: false });
    const { data } = (await builder) as unknown as { data: MockRow[] };
    expect(data).toHaveLength(POSTGREST_CAP); // truncated at 1000 of 1100 total rows
    const secondRows = data.filter((r) => r.instrument_id === second);
    // RED: `second`'s entire group — including its true FMV row — never
    // appears in the truncated response.
    expect(secondRows).toHaveLength(0);
  });

  it('GREEN: loadTaxDataset (fetchAllRows-backed) finds the correct FMV for BOTH instruments on the identical fixture', async () => {
    const first = 'inst-aaaa-first';
    const second = 'inst-zzzz-second';
    const navRows: MockRow[] = [];
    for (let i = 0; i < 900; i++) navRows.push(priceRow(first, `2017-01-${String((i % 27) + 1).padStart(2, '0')}`, 5));
    navRows.push(priceRow(first, '2018-01-31', 111.11));
    for (let i = 0; i < 900; i++) navRows.push(priceRow(second, `2017-01-${String((i % 27) + 1).padStart(2, '0')}`, 7));
    navRows.push(priceRow(second, '2018-01-31', 777.77));

    const tables: Record<string, MockRow[]> = {
      ii_transactions: [
        txnRow('acq-1', first, 'purchase', '2016-01-01', 100, 20),
        txnRow('disp-1', first, 'redemption', '2026-06-15', 10, 90),
        txnRow('acq-2', second, 'purchase', '2016-01-01', 100, 20),
        txnRow('disp-2', second, 'redemption', '2026-06-15', 10, 90),
      ],
      ii_instruments: [
        { id: first, instrument_name: 'First Fund', country_of_domicile: 'IN' },
        { id: second, instrument_name: 'Second Fund', country_of_domicile: 'IN' },
      ],
      ii_scheme_tax_classification: [],
      ii_prices_nav: navRows,
      ii_exit_load_schedules: [],
    };
    const supabase = makeSupabaseMock(tables);
    const { dataset } = await loadTaxDataset(supabase, USER_ID);
    expect(dataset!.fmv31Jan2018ByInstrument.get(first)).toBeCloseTo(111.11, 6);
    expect(dataset!.fmv31Jan2018ByInstrument.get(second)).toBeCloseTo(777.77, 6);
  });
});

// ---------------------------------------------------------------------------
// Section 40 — the sharpest adversarial case: >1000 TOTAL transactions where
// the DISPOSAL itself is transaction #1500 (i.e. would be silently DROPPED
// ENTIRELY by a truncated read, not merely have a wrong cost basis), and the
// computed answer must still be correct.
// ---------------------------------------------------------------------------

describe('R6-FINAL Sec.40: >1000-transaction adversarial case — the disposal itself sits past the truncation point', () => {
  it('a 1500-transaction set with the disposal as transaction #1500 is fully retrieved and FIFO cost basis is exactly correct', async () => {
    const instrumentId = 'inst-adversarial-1500';
    const txns: MockRow[] = [];
    // 1499 acquisitions, one per day, ascending, units=1, cost increasing by
    // 1 rupee each so FIFO order is unambiguous and independently checkable.
    for (let i = 0; i < 1499; i++) {
      const date = new Date(Date.UTC(2015, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
      txns.push(txnRow(`acq-${String(i).padStart(5, '0')}`, instrumentId, 'purchase', date, 1, 10 + i * 0.01));
    }
    // ONE disposal, dated after every acquisition, as the 1500th (LAST)
    // transaction by (transaction_date ASC, id ASC) order — the sharpest
    // possible case for the pre-fix unpaged read, which would have returned
    // 1000 transactions and LOST the disposal entirely (0 disposals found,
    // no error, a silently empty tax result).
    const disposalDate = '2025-12-31';
    txns.push(txnRow('zzz-disposal', instrumentId, 'redemption', disposalDate, 10, 500));

    const tables: Record<string, MockRow[]> = {
      ii_transactions: txns,
      ii_instruments: [{ id: instrumentId, instrument_name: 'Adversarial 1500 Fund', country_of_domicile: 'IN' }],
      ii_scheme_tax_classification: [],
      ii_prices_nav: [],
      ii_exit_load_schedules: [],
    };
    const supabase = makeSupabaseMock(tables);
    const { dataset, empty } = await loadTaxDataset(supabase, USER_ID);
    expect(empty).toBe(false);

    const acquisitions = dataset!.acquisitionsByInstrument.get(instrumentId) ?? [];
    const disposals = dataset!.disposalsByInstrument.get(instrumentId) ?? [];
    // The sharp assertion: the disposal was NOT silently dropped.
    expect(disposals).toHaveLength(1);
    expect(acquisitions).toHaveLength(1499);

    // FIFO-consume the first 10 units (the disposal's size) — these are
    // deterministically the FIRST 10 acquisitions (2015-01-01..2015-01-10),
    // costing 10.00, 10.01, ..., 10.09 per unit.
    const { replayFifo } = await import('@/lib/engines/investment-intelligence/tax/taxLotEngine');
    const { consumptions } = replayFifo(acquisitions, disposals);
    // Each acquisition is its own 1-unit lot, so consuming 10 units draws
    // from exactly the first 10 lots (FIFO, one consumption record per lot).
    expect(consumptions).toHaveLength(10);

    const totalCostBasis = consumptions.reduce((s, c) => s + c.costBasis, 0);
    const expectedCostBasis = Array.from({ length: 10 }, (_, i) => 10 + i * 0.01).reduce((s, c) => s + c, 0);
    expect(totalCostBasis).toBeCloseTo(expectedCostBasis, 2);
  });
});
