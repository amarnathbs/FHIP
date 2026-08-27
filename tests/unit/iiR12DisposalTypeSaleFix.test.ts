// R12 live-DEV certification (2026-08-27) found a real, live defect: R12's
// migration 0092 added 'sale' to ii_transactions.transaction_type (a direct
// listed equity/ETF market disposal, distinct from mutual-fund 'redemption')
// but taxRepository.ts's DISPOSAL_TYPES set was never extended to include
// it. Effect: GET /api/investment-intelligence/tax/summary silently reports
// "no disposals found" for every real R12 equity/ETF sale — R6's FIFO/
// capital-gains engine never sees the disposal at all, so no capital-gains
// tax is ever computed for a direct-equity sale. No error, no warning — a
// silent zero, exactly the class of defect this project treats as P0.
//
// Fixed in taxRepository.ts by adding 'sale' to DISPOSAL_TYPES. This suite
// is hermetic (mocked Supabase), mirroring iiR6FinalTaxPaginationAudit.test.
// ts's own mocking pattern.

import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { loadTaxDataset } from '@/lib/services/investment-intelligence/taxRepository';

type MockRow = Record<string, unknown>;

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
      const sorted = [...filtered];
      for (let i = orderClauses.length - 1; i >= 0; i--) {
        const { col, ascending } = orderClauses[i];
        sorted.sort((a, b) => {
          const av = a[col] as string | number;
          const bv = b[col] as string | number;
          if (av < bv) return ascending ? -1 : 1;
          if (av > bv) return ascending ? 1 : -1;
          return 0;
        });
      }
      return Promise.resolve({ data: sorted.slice(from, to + 1), error: null });
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

const USER_ID = 'user-r12-sale-disposal';

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

describe('R12 fix: taxRepository DISPOSAL_TYPES recognizes \'sale\' (direct equity/ETF disposal)', () => {
  it('a purchase + sale pair on a direct-equity instrument is loaded as one acquisition and one disposal', async () => {
    const instrumentId = 'inst-r12-direct-equity';
    const tables: Record<string, MockRow[]> = {
      ii_transactions: [
        txnRow('acq-1', instrumentId, 'purchase', '2024-01-10', 100, 500),
        txnRow('disp-1', instrumentId, 'sale', '2025-06-15', 40, 900),
      ],
      ii_instruments: [{ id: instrumentId, instrument_name: 'R12 Direct Equity Co.', country_of_domicile: 'IN' }],
      ii_scheme_tax_classification: [],
      ii_prices_nav: [],
      ii_exit_load_schedules: [],
    };
    const supabase = makeSupabaseMock(tables);
    const { dataset, empty } = await loadTaxDataset(supabase, USER_ID);
    expect(empty).toBe(false);

    const acquisitions = dataset!.acquisitionsByInstrument.get(instrumentId) ?? [];
    const disposals = dataset!.disposalsByInstrument.get(instrumentId) ?? [];

    // The bug: before the fix, 'sale' was not in DISPOSAL_TYPES, so this
    // would be an empty array — the disposal silently vanishes.
    expect(disposals).toHaveLength(1);
    expect(disposals[0].sourceEventId).toBe('disp-1');
    expect(disposals[0].units).toBe(40);
    expect(disposals[0].saleValue).toBe(40 * 900);
    expect(acquisitions).toHaveLength(1);
  });

  it('FIFO cost basis computes correctly for a \'sale\' disposal, identical treatment to \'redemption\'', async () => {
    const instrumentId = 'inst-r12-fifo-check';
    const tables: Record<string, MockRow[]> = {
      ii_transactions: [
        txnRow('acq-1', instrumentId, 'purchase', '2024-01-01', 50, 100),
        txnRow('acq-2', instrumentId, 'purchase', '2024-06-01', 50, 200),
        txnRow('disp-1', instrumentId, 'sale', '2025-01-01', 60, 300),
      ],
      ii_instruments: [{ id: instrumentId, instrument_name: 'R12 FIFO Check Co.', country_of_domicile: 'IN' }],
      ii_scheme_tax_classification: [],
      ii_prices_nav: [],
      ii_exit_load_schedules: [],
    };
    const supabase = makeSupabaseMock(tables);
    const { dataset } = await loadTaxDataset(supabase, USER_ID);
    const acquisitions = dataset!.acquisitionsByInstrument.get(instrumentId) ?? [];
    const disposals = dataset!.disposalsByInstrument.get(instrumentId) ?? [];

    const { replayFifo } = await import('@/lib/engines/investment-intelligence/tax/taxLotEngine');
    const { consumptions } = replayFifo(acquisitions, disposals);

    // 60 units consumed FIFO: all 50 units @ 100 (acq-1) + 10 units @ 200 (acq-2).
    const totalCostBasis = consumptions.reduce((s, c) => s + c.costBasis, 0);
    expect(totalCostBasis).toBeCloseTo(50 * 100 + 10 * 200, 2);
  });

  it('a direct-equity instrument with no ii_exit_load_schedules rows correctly resolves to zero applicable exit-load schedules (no special-casing needed for \'sale\')', async () => {
    const instrumentId = 'inst-r12-no-exit-load';
    const tables: Record<string, MockRow[]> = {
      ii_transactions: [
        txnRow('acq-1', instrumentId, 'purchase', '2024-01-01', 10, 1000),
        txnRow('disp-1', instrumentId, 'sale', '2025-01-01', 10, 1200),
      ],
      ii_instruments: [{ id: instrumentId, instrument_name: 'R12 No Exit Load Co.', country_of_domicile: 'IN' }],
      ii_scheme_tax_classification: [],
      ii_prices_nav: [],
      ii_exit_load_schedules: [], // never populated for direct-equity instruments
    };
    const supabase = makeSupabaseMock(tables);
    const { dataset } = await loadTaxDataset(supabase, USER_ID);
    expect(dataset!.exitLoadSchedules.filter((s) => s.instrumentKey === instrumentId)).toHaveLength(0);
  });

  it('mixed portfolio: \'redemption\' (mutual fund) and \'sale\' (direct equity) disposals are both recognized independently', async () => {
    const mfInstrument = 'inst-mf';
    const equityInstrument = 'inst-equity';
    const tables: Record<string, MockRow[]> = {
      ii_transactions: [
        txnRow('acq-mf', mfInstrument, 'purchase', '2024-01-01', 100, 50),
        txnRow('disp-mf', mfInstrument, 'redemption', '2025-01-01', 20, 60),
        txnRow('acq-eq', equityInstrument, 'purchase', '2024-01-01', 30, 400),
        txnRow('disp-eq', equityInstrument, 'sale', '2025-01-01', 15, 500),
      ],
      ii_instruments: [
        { id: mfInstrument, instrument_name: 'Some Mutual Fund', country_of_domicile: 'IN' },
        { id: equityInstrument, instrument_name: 'Some Listed Co.', country_of_domicile: 'IN' },
      ],
      ii_scheme_tax_classification: [],
      ii_prices_nav: [],
      ii_exit_load_schedules: [],
    };
    const supabase = makeSupabaseMock(tables);
    const { dataset } = await loadTaxDataset(supabase, USER_ID);
    expect(dataset!.disposalsByInstrument.get(mfInstrument)).toHaveLength(1);
    expect(dataset!.disposalsByInstrument.get(equityInstrument)).toHaveLength(1);
  });
});
