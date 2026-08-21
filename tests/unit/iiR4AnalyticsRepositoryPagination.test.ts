// R4 — Regression test for a real production defect found during R5 live-DEV
// testing and confirmed to also exist, unfixed, in R4's analyticsRepository.ts:
//
//   PostgREST silently caps an unbounded `select` at 1000 rows. It reports
//   the truncation ONLY in the `Content-Range` response header — the
//   response body is a well-formed array with no error, and the Supabase JS
//   client surfaces no error either. Proven live against DEV (project
//   vqycarelcoijzwlpkpcz): seeding 1500 ii_prices_nav rows for one instrument
//   and issuing a plain select returned exactly 1000 rows with
//   `Content-Range: 0-999/1500`.
//
// analyticsRepository.ts had four unbounded time-series reads (ii_transactions,
// ii_holding_snapshots, ii_prices_nav, ii_benchmark_series) with no
// .range()/.limit(). A few years of daily NAV for even one fund exceeds 1000
// rows, so the performance/benchmark engine could silently compute over
// truncated history — understated coverage, wrong as-of dates, wrong
// XIRR/TWRR/benchmark figures — with no error anywhere in the stack.
//
// This test is hermetic (no live DB): it uses a small mock Supabase query
// builder that faithfully reproduces PostgREST's behaviour — an unbounded
// select silently caps at 1000 rows, while an explicit `.range(from, to)`
// call pages correctly. The fix (fetchAllRows helper, mirrored from R5's
// r5Repository.ts) must page every one of the four reads past 1000 rows.

import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { loadAnalyticsDataset } from '@/lib/services/investment-intelligence/analyticsRepository';

// ---------------------------------------------------------------------------
// Hermetic mock query builder — mirrors PostgREST's real, observed behaviour:
//   * No .range() call  -> silently capped at 1000 rows, data still well-formed.
//   * Explicit .range(from, to) -> returns exactly that slice, so paging in a
//     loop until a short page comes back reconstructs the full table.
// ---------------------------------------------------------------------------

type MockRow = Record<string, unknown>;

const POSTGREST_CAP = 1000;

function applyOrder(rows: MockRow[], clauses: Array<{ col: string; ascending: boolean }>): MockRow[] {
  const result = [...rows];
  // Apply clauses in reverse so the FIRST .order() call is the primary sort
  // key, relying on Array.sort's stability — the same trick the real fix
  // depends on for deterministic multi-key ordering.
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

function makeQueryBuilder(rows: MockRow[]) {
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
    order(col: string, opts?: { ascending?: boolean }) {
      orderClauses.push({ col, ascending: opts?.ascending !== false });
      return builder;
    },
    range(from: number, to: number) {
      const sorted = applyOrder(filtered, orderClauses);
      const page = sorted.slice(from, to + 1);
      return Promise.resolve({ data: page, error: null });
    },
    // Making the builder itself thenable lets `await supabase.from(...).select(...)`
    // resolve directly, exactly like the real Supabase client, for call sites
    // that never call .range() (e.g. small reference-data reads).
    then(resolve: (v: { data: MockRow[]; error: null }) => unknown, reject?: (e: unknown) => unknown) {
      const sorted = applyOrder(filtered, orderClauses);
      // THE CRITICAL LINE: reproduces PostgREST's silent 1000-row cap when no
      // .range() is used. This is the behaviour that caused the real defect.
      const capped = sorted.slice(0, POSTGREST_CAP);
      return Promise.resolve({ data: capped, error: null }).then(resolve, reject);
    },
  };
  return builder;
}

function makeSupabaseMock(tables: Record<string, MockRow[]>): SupabaseClient {
  return {
    from(table: string) {
      return makeQueryBuilder(tables[table] ?? []);
    },
  } as unknown as SupabaseClient;
}

function manyRows(n: number): MockRow[] {
  return Array.from({ length: n }, (_, i) => ({ id: `row-${String(i).padStart(6, '0')}`, seq: i }));
}

// ---------------------------------------------------------------------------

describe('PAGE-000: the mock harness faithfully reproduces PostgREST\'s silent 1000-row cap', () => {
  it('an unbounded select on a 1500-row table silently returns only 1000 rows, no error', async () => {
    const supabase = makeSupabaseMock({ big_table: manyRows(1500) });
    const res = await supabase.from('big_table').select('*');
    expect(res.error).toBeNull();
    expect(res.data).toHaveLength(POSTGREST_CAP);
  });

  it('explicit .range() paging past 1000 recovers every row', async () => {
    const supabase = makeSupabaseMock({ big_table: manyRows(1500) });
    const page1 = await supabase.from('big_table').select('*').range(0, 999);
    const page2 = await supabase.from('big_table').select('*').range(1000, 1999);
    expect(page1.data).toHaveLength(1000);
    expect(page2.data).toHaveLength(500);
  });
});

describe('PAGE-001: loadAnalyticsDataset loads >1000-row time series in full, not silently truncated at 1000', () => {
  const userId = 'user-page-test';
  const instrumentId = 'inst-1';
  const benchmarkId = 'bench-1';
  const accountId = 'acct-1';

  const NAV_ROWS = 1500;
  const SNAPSHOT_ROWS = 1200;
  const TX_ROWS = 1500;
  const BENCHMARK_ROWS = 1300;

  function isoDate(dayOffset: number): string {
    const base = new Date(Date.UTC(2015, 0, 1));
    base.setUTCDate(base.getUTCDate() + dayOffset);
    return base.toISOString().slice(0, 10);
  }

  function buildTables(): Record<string, MockRow[]> {
    const navRows: MockRow[] = Array.from({ length: NAV_ROWS }, (_, i) => ({
      id: `nav-${String(i).padStart(6, '0')}`,
      instrument_id: instrumentId,
      price_date: isoDate(i),
      price: 100 + i * 0.01,
      data_version: 'nav-v1',
      quality_status: 'ok',
    }));

    const snapshotRows: MockRow[] = Array.from({ length: SNAPSHOT_ROWS }, (_, i) => ({
      id: `snap-${String(i).padStart(6, '0')}`,
      user_id: userId,
      instrument_id: instrumentId,
      as_of_date: isoDate(i),
      units: 1000,
      value: 100000 + i * 10,
      currency_code: 'INR',
      quality_status: 'certified',
    }));

    // Deliberate date ties: two transactions per date, so the paging logic
    // must survive rows that are NOT unique on the primary order column
    // (transaction_date alone) — exactly the scenario the secondary `.order(
    // 'id')` tie-break exists to protect against at page boundaries.
    const txRows: MockRow[] = Array.from({ length: TX_ROWS }, (_, i) => ({
      id: `tx-${String(i).padStart(6, '0')}`,
      user_id: userId,
      instrument_id: instrumentId,
      transaction_type: 'purchase',
      transaction_date: isoDate(Math.floor(i / 2)),
      gross_amount: 1000 + i,
      currency_code: 'INR',
      status: 'reconciled',
    }));

    const benchmarkSeriesRows: MockRow[] = Array.from({ length: BENCHMARK_ROWS }, (_, i) => ({
      id: `bs-${String(i).padStart(6, '0')}`,
      benchmark_id: benchmarkId,
      series_date: isoDate(i),
      value: 100 + i * 0.02,
      data_version: 'bench-v1',
      quality_status: 'ok',
    }));

    return {
      ii_portfolio_truth_status: [
        { instrument_id: instrumentId, account_id: accountId, history_completeness: 'complete_from_inception', status: 'certified', user_id: userId },
      ],
      ii_transactions: txRows,
      ii_holding_snapshots: snapshotRows,
      ii_instruments: [{ id: instrumentId, instrument_name: 'Test Fund', base_currency: 'INR', country_of_domicile: 'IN' }],
      ii_prices_nav: navRows,
      ii_instrument_benchmarks: [
        {
          instrument_id: instrumentId,
          benchmark_id: benchmarkId,
          relationship_type: 'primary',
          effective_from: '1900-01-01',
          effective_to: null,
          mapping_version: 'map-v1',
          quality_status: 'ok',
          // PostgREST embeds the joined row directly; the mock pre-embeds it too.
          ii_benchmarks: { benchmark_key: 'NIFTY', return_type: 'TRI' },
        },
      ],
      ii_benchmark_series: benchmarkSeriesRows,
      ii_risk_free_rates: [],
    };
  }

  it('loads all 1500 NAV rows, not the 1000-row PostgREST cap', async () => {
    const supabase = makeSupabaseMock(buildTables());
    const { dataset, empty } = await loadAnalyticsDataset(supabase, userId);
    expect(empty).toBe(false);
    expect(dataset).not.toBeNull();
    expect(dataset!.schemes).toHaveLength(1);
    expect(dataset!.schemes[0].navSeries).toHaveLength(NAV_ROWS);
  });

  it('loads all 1200 holding-snapshot rows', async () => {
    const supabase = makeSupabaseMock(buildTables());
    const { dataset } = await loadAnalyticsDataset(supabase, userId);
    expect(dataset!.schemes[0].valuationSeries).toHaveLength(SNAPSHOT_ROWS);
  });

  it('loads all 1500 transaction rows (including a page boundary that falls mid-tie) and derives every cash flow', async () => {
    const supabase = makeSupabaseMock(buildTables());
    const { dataset } = await loadAnalyticsDataset(supabase, userId);
    // Every 'purchase' transaction becomes exactly one outflow cash flow,
    // plus one synthetic terminal inflow for the current value. If the read
    // were truncated at 1000, or a row were dropped/duplicated at the
    // range() page boundary, this count would not land exactly here.
    expect(dataset!.schemes[0].cashFlows).toHaveLength(TX_ROWS + 1);
  });

  it('loads all 1300 benchmark-series rows', async () => {
    const supabase = makeSupabaseMock(buildTables());
    const { dataset } = await loadAnalyticsDataset(supabase, userId);
    expect(dataset!.benchmarkSeriesById[benchmarkId]).toHaveLength(BENCHMARK_ROWS);
  });

  it('sanity: with the ORIGINAL (unpaged) query pattern, the same fixtures would have been silently truncated at 1000', async () => {
    // Directly exercises the mock the same way the pre-fix code did — a
    // plain select with no .range() — to prove the fixture itself is capable
    // of exposing the bug, and that the counts above are genuinely testing
    // the paging fix rather than trivially passing.
    const supabase = makeSupabaseMock(buildTables());
    const rawNav = await supabase.from('ii_prices_nav').select('instrument_id, price_date, price').in('instrument_id', [instrumentId]).order('price_date', { ascending: true });
    expect(rawNav.data).toHaveLength(POSTGREST_CAP);
    expect(rawNav.data).not.toHaveLength(NAV_ROWS);
  });
});
