// Investment Intelligence — regression test for a real production defect
// found 2026-09-29: the Performance tab's portfolio TWRR (and everything
// gated on it -- blended benchmark comparison, portfolio active return,
// drawdown/comparison charts) showed "not enough history" for every
// household in production, regardless of how many years of daily NAV price
// history NAV1 (pc6_selective_historical_hydration) had actually hydrated
// for the instruments held.
//
// ROOT CAUSE, confirmed live against production (twwpnltizhtjxhamyoxt):
// SchemeDataset.valuationSeries was built exclusively from
// ii_holding_snapshots, and EVERY row of that table in production carries
// exactly ONE as_of_date per (user, instrument) -- the date of the
// investor's most recently uploaded statement. twrr() correctly (and by
// design -- see docs/investment-intelligence/R4_TWRR_CERTIFICATION.md)
// refuses to compute from fewer than 2 valuation points and never
// interpolates a missing one, so with a single point it always returned
// INSUFFICIENT_HISTORY, no matter how deep the instrument's own NAV history
// went. The task pointer in the original bug report (computeSchemeActive's
// NAV_HISTORY_INCOMPLETE gate) turned out NOT to be the culprit when
// checked against real data: SINCE_INCEPTION CAGR computed fine for every
// scheme with real NAV history in every production household inspected.
//
// This test proves the fix end-to-end through loadAnalyticsDataset +
// runAnalytics, using a hermetic mock Supabase client (same pattern as
// tests/unit/iiR4AnalyticsRepositoryPagination.test.ts): a household with
// the exact production shape (ONE holding-snapshot row, but rich
// ii_transactions.units and rich ii_prices_nav history) now gets a real
// portfolioTwrr, because analyticsRepository.ts reconstructs a derived
// valuation series from the certified unit ledger x the daily NAV feed --
// but ONLY when the position's own reconciliation actually supports it
// (negative control below proves the gate is real, not a no-op).

import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { loadAnalyticsDataset } from '@/lib/services/investment-intelligence/analyticsRepository';
import { runAnalytics } from '@/lib/engines/investment-intelligence/analyticsOrchestrator';

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
      return Promise.resolve({ data: sorted, error: null }).then(resolve, reject);
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

const userId = 'user-twrr-test';
const instrumentId = 'inst-1';
const accountId = 'acct-1';

function isoDate(dayOffset: number): string {
  const base = new Date(Date.UTC(2020, 0, 1));
  base.setUTCDate(base.getUTCDate() + dayOffset);
  return base.toISOString().slice(0, 10);
}

const NAV_DAYS = 400;

function navRows(): MockRow[] {
  return Array.from({ length: NAV_DAYS }, (_, i) => ({
    id: `nav-${String(i).padStart(6, '0')}`,
    instrument_id: instrumentId,
    price_date: isoDate(i),
    price: 10 + i * 0.01,
    data_version: 'nav-v1',
    quality_status: 'ok',
  }));
}

// The production shape: exactly ONE certified snapshot for this position,
// dated at the very end of the NAV history -- everything this fix is about.
function singleSnapshotRow(): MockRow[] {
  const lastDay = NAV_DAYS - 1;
  return [
    {
      id: 'snap-1',
      user_id: userId,
      instrument_id: instrumentId,
      as_of_date: isoDate(lastDay),
      units: 100,
      value: 100 * (10 + lastDay * 0.01),
      currency_code: 'INR',
      quality_status: 'certified',
    },
  ];
}

function purchaseTxRow(): MockRow[] {
  return [
    {
      id: 'tx-1',
      user_id: userId,
      instrument_id: instrumentId,
      transaction_type: 'purchase',
      transaction_date: isoDate(0),
      gross_amount: 1000,
      currency_code: 'INR',
      status: 'parsed',
      units: 100,
    },
  ];
}

function truthRow(unitVarianceWithinTolerance: boolean | null): MockRow[] {
  return [
    {
      instrument_id: instrumentId,
      account_id: accountId,
      history_completeness: 'complete_from_inception',
      status: 'certified',
      user_id: userId,
      unit_variance_within_tolerance: unitVarianceWithinTolerance,
    },
  ];
}

function baseTables(unitVarianceWithinTolerance: boolean | null): Record<string, MockRow[]> {
  return {
    ii_portfolio_truth_status: truthRow(unitVarianceWithinTolerance),
    ii_transactions: purchaseTxRow(),
    ii_holding_snapshots: singleSnapshotRow(),
    ii_instruments: [{ id: instrumentId, instrument_name: 'Test Fund', base_currency: 'INR', country_of_domicile: 'IN' }],
    ii_prices_nav: navRows(),
    ii_instrument_benchmarks: [],
    ii_benchmark_series: [],
    ii_risk_free_rates: [],
  };
}

describe('TWRR-RECON-001: production shape (one snapshot, rich NAV+unit history) now yields a real portfolio TWRR', () => {
  it('reconstructedValuationSeries is populated with one point per NAV date from the purchase onward', async () => {
    const supabase = makeSupabaseMock(baseTables(true));
    const { dataset } = await loadAnalyticsDataset(supabase, userId);
    expect(dataset!.schemes).toHaveLength(1);
    expect(dataset!.schemes[0].valuationSeries).toHaveLength(1); // certified snapshot unchanged
    expect(dataset!.schemes[0].reconstructedValuationSeries).toHaveLength(NAV_DAYS);
  });

  it('portfolioTwrr is CALCULATED, not INSUFFICIENT_HISTORY -- the actual production symptom being fixed', async () => {
    const supabase = makeSupabaseMock(baseTables(true));
    const { dataset } = await loadAnalyticsDataset(supabase, userId);
    const result = runAnalytics(dataset!);
    expect(result.portfolios).toHaveLength(1);
    expect(result.portfolios[0].portfolioTwrr.status).toBe('CALCULATED');
    expect(result.portfolios[0].portfolioTwrr.value!.twrr).toBeGreaterThan(0); // NAV rose monotonically over the period
  });
});

describe('TWRR-RECON-002: negative control -- an unreconciled unit ledger must NOT get a fabricated valuation series', () => {
  it('unit_variance_within_tolerance = false disqualifies the reconstruction; valuationSeries/TWRR behave exactly as before this fix', async () => {
    const supabase = makeSupabaseMock(baseTables(false));
    const { dataset } = await loadAnalyticsDataset(supabase, userId);
    expect(dataset!.schemes[0].reconstructedValuationSeries).toEqual([]);
    const result = runAnalytics(dataset!);
    expect(result.portfolios[0].portfolioTwrr.status).toBe('INSUFFICIENT_HISTORY');
  });

  it('unit_variance_within_tolerance = null (not yet evaluated) is treated as NOT reliable -- never assumed fine', async () => {
    const supabase = makeSupabaseMock(baseTables(null));
    const { dataset } = await loadAnalyticsDataset(supabase, userId);
    expect(dataset!.schemes[0].reconstructedValuationSeries).toEqual([]);
    const result = runAnalytics(dataset!);
    expect(result.portfolios[0].portfolioTwrr.status).toBe('INSUFFICIENT_HISTORY');
  });
});

describe('TWRR-RECON-003: negative control -- history_completeness short of complete_from_inception also disqualifies reconstruction', () => {
  it('partial_history never gets a reconstructed series even with a perfectly reconciled unit ledger', async () => {
    const tables = baseTables(true);
    tables.ii_portfolio_truth_status = [{ ...truthRow(true)[0], history_completeness: 'partial_history' }];
    const supabase = makeSupabaseMock(tables);
    const { dataset } = await loadAnalyticsDataset(supabase, userId);
    expect(dataset!.schemes[0].reconstructedValuationSeries).toEqual([]);
    const result = runAnalytics(dataset!);
    expect(result.portfolios[0].portfolioTwrr.status).toBe('INSUFFICIENT_HISTORY');
  });
});
