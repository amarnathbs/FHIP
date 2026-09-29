// Investment Intelligence — Performance tab mark-to-market fix (2026-09-29).
//
// REAL PRODUCTION BUG (PO-provided screenshot, live Performance tab):
// holdings showed "Value as of 04-09-2026" even though the daily NAV feed
// (NAV1 / pc6_selective_historical_hydration, writing ii_prices_nav) had
// gone on collecting prices every day through the 28th. loadAnalyticsDataset
// in analyticsRepository.ts already loaded that daily NAV series per
// instrument (navByInstrument / SchemeDataset.navSeries) but never used it to
// move currentValue/currentValueDate past the last certified statement
// snapshot (ii_holding_snapshots) — so the figure stayed frozen at whenever
// the investor last uploaded a CAMS/KFintech statement.
//
// The fix: when ii_prices_nav has a price point for an instrument dated
// AFTER its latest ii_holding_snapshots row, value that position at
// (units from the latest snapshot) x (that later NAV price), dated to the
// NAV point. When no such later NAV price exists, or there is no snapshot at
// all, behaviour is unchanged (falls back to the snapshot's own value/date,
// or 0/asOfDate).
//
// This test reuses the same hermetic mock Supabase query builder pattern as
// iiR4AnalyticsRepositoryPagination.test.ts (PAGE-001): a small in-memory
// table store whose builder supports select/eq/in/order/range and is
// directly awaitable, faithfully enough for loadAnalyticsDataset's own query
// shapes (it does not need >1000 rows here, so paging past the PostgREST cap
// is not re-tested — that is PAGE-001's job).

import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { loadAnalyticsDataset } from '@/lib/services/investment-intelligence/analyticsRepository';

type MockRow = Record<string, unknown>;

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
    then(resolve: (v: { data: MockRow[]; error: null }) => unknown, reject?: (e: unknown) => unknown) {
      const sorted = applyOrder(filtered, orderClauses);
      const capped = sorted.slice(0, 1000);
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

const userId = 'user-mtm-test';

function baseTables(overrides: Partial<Record<string, MockRow[]>> = {}): Record<string, MockRow[]> {
  return {
    ii_portfolio_truth_status: [],
    ii_transactions: [],
    ii_holding_snapshots: [],
    ii_instruments: [],
    ii_prices_nav: [],
    ii_instrument_benchmarks: [],
    ii_benchmark_series: [],
    ii_risk_free_rates: [],
    ...overrides,
  };
}

describe('MTM-001: a later NAV price marks the position to market', () => {
  const instrumentId = 'inst-mtm-a';

  it('current value/date come from (units at latest snapshot) x (later NAV price)', async () => {
    const tables = baseTables({
      ii_holding_snapshots: [
        {
          id: 'snap-a-1',
          user_id: userId,
          instrument_id: instrumentId,
          as_of_date: '2026-08-01',
          units: 500,
          value: 50000, // certified value as of the last upload (100/unit)
          currency_code: 'INR',
          quality_status: 'certified',
        },
      ],
      ii_instruments: [{ id: instrumentId, instrument_name: 'Test Fund A', base_currency: 'INR', country_of_domicile: 'IN' }],
      ii_prices_nav: [
        { id: 'nav-a-1', instrument_id: instrumentId, price_date: '2026-08-01', price: 100, data_version: 'nav-v1', quality_status: 'ok' },
        // The daily NAV job kept running past the statement date -- this is
        // the point that must now drive currentValue/currentValueDate.
        { id: 'nav-a-2', instrument_id: instrumentId, price_date: '2026-09-25', price: 112.5, data_version: 'nav-v1', quality_status: 'ok' },
      ],
    });
    const supabase = makeSupabaseMock(tables);
    const { dataset, empty } = await loadAnalyticsDataset(supabase, userId, { asOfDate: new Date('2026-09-29T00:00:00.000Z') });
    expect(empty).toBe(false);
    const scheme = dataset!.schemes.find((s) => s.instrumentId === instrumentId)!;
    // 500 units x 112.5 = 56250, NOT the stale certified 50000.
    expect(scheme.currentValue).toBe(56250);
    expect(scheme.currentValueDate.toISOString().slice(0, 10)).toBe('2026-09-25');
  });
});

describe('MTM-002: no NAV price newer than the latest snapshot leaves legacy behaviour unchanged', () => {
  const instrumentId = 'inst-mtm-b';

  it('falls back to the snapshot\'s own certified value and date', async () => {
    const tables = baseTables({
      ii_holding_snapshots: [
        {
          id: 'snap-b-1',
          user_id: userId,
          instrument_id: instrumentId,
          as_of_date: '2026-09-01',
          units: 200,
          value: 20000,
          currency_code: 'INR',
          quality_status: 'certified',
        },
      ],
      ii_instruments: [{ id: instrumentId, instrument_name: 'Test Fund B', base_currency: 'INR', country_of_domicile: 'IN' }],
      ii_prices_nav: [
        // Only an OLDER NAV point exists -- nothing past the snapshot date.
        { id: 'nav-b-1', instrument_id: instrumentId, price_date: '2026-08-01', price: 90, data_version: 'nav-v1', quality_status: 'ok' },
      ],
    });
    const supabase = makeSupabaseMock(tables);
    const { dataset } = await loadAnalyticsDataset(supabase, userId, { asOfDate: new Date('2026-09-29T00:00:00.000Z') });
    const scheme = dataset!.schemes.find((s) => s.instrumentId === instrumentId)!;
    // Unchanged: the certified snapshot value/date, never units x the older NAV price.
    expect(scheme.currentValue).toBe(20000);
    expect(scheme.currentValueDate.toISOString().slice(0, 10)).toBe('2026-09-01');
  });
});

describe('MTM-003: no snapshot at all leaves legacy behaviour unchanged, even with NAV data present', () => {
  const instrumentId = 'inst-mtm-c';

  it('currentValue is 0 and currentValueDate is the as-of date, never derived from NAV alone', async () => {
    const tables = baseTables({
      // No ii_holding_snapshots row for this instrument at all -- only a
      // transaction, so it still enters instrumentIds.
      ii_transactions: [
        {
          id: 'tx-c-1',
          user_id: userId,
          instrument_id: instrumentId,
          transaction_type: 'purchase',
          transaction_date: '2026-07-01',
          gross_amount: 1000,
          currency_code: 'INR',
          status: 'reconciled',
        },
      ],
      ii_instruments: [{ id: instrumentId, instrument_name: 'Test Fund C', base_currency: 'INR', country_of_domicile: 'IN' }],
      // A NAV series exists, but with no snapshot/units to multiply against,
      // the guard must refuse to fabricate a value from price alone.
      ii_prices_nav: [{ id: 'nav-c-1', instrument_id: instrumentId, price_date: '2026-09-20', price: 55, data_version: 'nav-v1', quality_status: 'ok' }],
    });
    const supabase = makeSupabaseMock(tables);
    const asOfDate = new Date('2026-09-29T00:00:00.000Z');
    const { dataset } = await loadAnalyticsDataset(supabase, userId, { asOfDate });
    const scheme = dataset!.schemes.find((s) => s.instrumentId === instrumentId)!;
    expect(scheme.currentValue).toBe(0);
    expect(scheme.currentValueDate.getTime()).toBe(asOfDate.getTime());
  });
});

describe('MTM-004: the stale-valuation disclosure compares against the mark-to-market date, not the old snapshot date', () => {
  const instrumentId = 'inst-mtm-d';

  it('no longer fires once mark-to-market moves currentValueDate past a transaction that used to post-date it', async () => {
    const tables = baseTables({
      ii_holding_snapshots: [
        {
          id: 'snap-d-1',
          user_id: userId,
          instrument_id: instrumentId,
          as_of_date: '2026-08-01',
          units: 100,
          value: 10000,
          currency_code: 'INR',
          quality_status: 'certified',
        },
      ],
      ii_transactions: [
        // Posted AFTER the snapshot date but BEFORE the later NAV point --
        // pre-fix this would have tripped the "Upload a more recent
        // statement" warning; post-fix the NAV-derived valuation date
        // already covers it.
        {
          id: 'tx-d-1',
          user_id: userId,
          instrument_id: instrumentId,
          transaction_type: 'purchase',
          transaction_date: '2026-08-15',
          gross_amount: 500,
          currency_code: 'INR',
          status: 'reconciled',
        },
      ],
      ii_instruments: [{ id: instrumentId, instrument_name: 'Test Fund D', base_currency: 'INR', country_of_domicile: 'IN' }],
      ii_prices_nav: [{ id: 'nav-d-1', instrument_id: instrumentId, price_date: '2026-09-25', price: 105, data_version: 'nav-v1', quality_status: 'ok' }],
    });
    const supabase = makeSupabaseMock(tables);
    const { dataset, warnings } = await loadAnalyticsDataset(supabase, userId, { asOfDate: new Date('2026-09-29T00:00:00.000Z') });
    const scheme = dataset!.schemes.find((s) => s.instrumentId === instrumentId)!;
    expect(scheme.currentValue).toBe(100 * 105);
    expect(scheme.currentValueDate.toISOString().slice(0, 10)).toBe('2026-09-25');
    expect(warnings.some((w) => w.scope === 'valuation' && w.detail.includes('Test Fund D'))).toBe(false);
  });
});
