// R6-P0 — R6 spec section 10: prove a REAL R4 calculation whose correct
// result actually depends on records beyond row 1000.
//
// The boundary suite (iiR6P0PaginationCertification) proves the retrieval
// helper returns every row. That is necessary but not sufficient: the spec
// requires evidence that the truncation changed an ANSWER, not just a row
// count. This suite therefore drives the genuine R4 pipeline —
// loadAnalyticsDataset -> runAnalytics (the real XIRR/TWRR/benchmark engines,
// untouched by the pagination fix) — over a realistic multi-year daily NAV and
// transaction history, and compares:
//
//   RED   the ORIGINAL unbounded read (silently capped at 1000 rows)
//   GREEN the corrected paged read
//   ORACLE an independently computed expectation, derived from the fixture
//          arithmetic rather than from either implementation
//
// The fixture is built so the truncation is materially wrong, not cosmetically
// wrong: the investment's real terminal value and real final valuation date
// both live past row 1000, so a truncated read reports the WRONG portfolio
// value on the WRONG as-of date and therefore the wrong return.

import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { loadAnalyticsDataset } from '@/lib/services/investment-intelligence/analyticsRepository';
import { runAnalytics } from '@/lib/engines/investment-intelligence/analyticsOrchestrator';
import { xirr } from '@/lib/engines/investment-intelligence/xirr';

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

/** `truncate: true` reproduces the ORIGINAL defect: .range() is ignored and every read caps at 1000. */
function makeQueryBuilder(rows: MockRow[], truncate: boolean) {
  let filtered = rows;
  const orderClauses: Array<{ col: string; ascending: boolean }> = [];
  const builder = {
    select: () => builder,
    eq(col: string, val: unknown) {
      filtered = filtered.filter((r) => r[col] === val);
      return builder;
    },
    neq(col: string, val: unknown) {
      filtered = filtered.filter((r) => r[col] !== val);
      return builder;
    },
    lte(col: string, val: unknown) {
      filtered = filtered.filter((r) => (r[col] as string) <= (val as string));
      return builder;
    },
    in(col: string, vals: unknown[]) {
      const set = new Set(vals);
      filtered = filtered.filter((r) => set.has(r[col]));
      return builder;
    },
    order(col: string, o?: { ascending?: boolean }) {
      orderClauses.push({ col, ascending: o?.ascending !== false });
      return builder;
    },
    range(from: number, to: number) {
      const sorted = applyOrder(filtered, orderClauses);
      if (truncate) {
        // The defect: the server ignores paging and always caps at 1000. Any
        // page after the first therefore comes back EMPTY, so the paged loop
        // collects exactly the same truncated 1000 rows the old code did.
        return Promise.resolve({ data: from === 0 ? sorted.slice(0, POSTGREST_CAP) : [], error: null });
      }
      const width = Math.min(to - from + 1, POSTGREST_CAP);
      return Promise.resolve({ data: sorted.slice(from, from + width), error: null });
    },
    then(resolve: (v: { data: MockRow[]; error: null }) => unknown, reject?: (e: unknown) => unknown) {
      const sorted = applyOrder(filtered, orderClauses);
      return Promise.resolve({ data: sorted.slice(0, POSTGREST_CAP), error: null }).then(resolve, reject);
    },
  };
  return builder;
}

function makeSupabaseMock(tables: Record<string, MockRow[]>, truncate: boolean): SupabaseClient {
  return {
    from(table: string) {
      return makeQueryBuilder(tables[table] ?? [], truncate);
    },
  } as unknown as SupabaseClient;
}

// ---------------------------------------------------------------------------
// Fixture: one instrument, ~6 years of BUSINESS-DAY NAV and daily valuation
// snapshots. 1500 observations puts the true terminal value at row 1500 —
// firmly past the 1000-row cap.
// ---------------------------------------------------------------------------

const USER_ID = '11111111-1111-4111-8111-111111111111';
const INSTRUMENT_ID = '22222222-2222-4222-8222-222222222222';
const ACCOUNT_ID = '33333333-3333-4333-8333-333333333333';

const OBSERVATIONS = 1500;
const START = Date.UTC(2019, 0, 1);
const DAY = 86_400_000;

// Deterministic two-regime NAV path. This shape is chosen DELIBERATELY:
//
// A uniformly compounding series would make the ANNUALISED return identical
// whether you stop at day 999 or day 1499 — the truncated read would report a
// wrong terminal value but a coincidentally-right rate, and a test asserting
// on the rate would pass without the fix. (This was confirmed empirically
// while building this suite: a single-growth-rate fixture produced RED and
// GREEN XIRRs agreeing to 8 decimal places.)
//
// So the fixture models the realistic and genuinely dangerous case: a long
// bull run followed by a RECENT DRAWDOWN that lies entirely past row 1000.
// Truncation then hides the crash and OVERSTATES the investor's return — the
// worst possible direction for a financial product to be silently wrong in.
const NAV_START = 100;
const BOOM_DAYS = 1000; // rows 0..999 — exactly what a truncated read sees
const BOOM_DAILY = 1.0008; // ~22.5%/yr
const BUST_DAILY = 0.99915; // ~-24%/yr over the remaining 500 days

function dateAt(i: number): string {
  return new Date(START + i * DAY).toISOString().slice(0, 10);
}
function navAt(i: number): number {
  if (i < BOOM_DAYS) return NAV_START * Math.pow(BOOM_DAILY, i);
  const peak = NAV_START * Math.pow(BOOM_DAILY, BOOM_DAYS - 1);
  return peak * Math.pow(BUST_DAILY, i - (BOOM_DAYS - 1));
}

const UNITS_PURCHASED = 1000;
const PURCHASE_AMOUNT = UNITS_PURCHASED * NAV_START; // 100,000 on day 0

const navRows: MockRow[] = Array.from({ length: OBSERVATIONS }, (_, i) => ({
  id: `nav-${String(i).padStart(6, '0')}`,
  instrument_id: INSTRUMENT_ID,
  price_date: dateAt(i),
  price: navAt(i),
  data_version: 'navv1',
  quality_status: 'ok',
}));

const snapshotRows: MockRow[] = Array.from({ length: OBSERVATIONS }, (_, i) => ({
  id: `snap-${String(i).padStart(6, '0')}`,
  user_id: USER_ID,
  account_id: ACCOUNT_ID,
  instrument_id: INSTRUMENT_ID,
  as_of_date: dateAt(i),
  units: UNITS_PURCHASED,
  value: UNITS_PURCHASED * navAt(i),
  currency_code: 'INR',
  quality_status: 'ok',
}));

const txRows: MockRow[] = [
  {
    id: 'tx-000000',
    user_id: USER_ID,
    instrument_id: INSTRUMENT_ID,
    transaction_type: 'purchase',
    transaction_date: dateAt(0),
    gross_amount: PURCHASE_AMOUNT,
    currency_code: 'INR',
    status: 'settled',
  },
];

const truthRows: MockRow[] = [
  {
    id: 'truth-000000',
    user_id: USER_ID,
    account_id: ACCOUNT_ID,
    instrument_id: INSTRUMENT_ID,
    history_completeness: 'complete_from_inception',
    status: 'certified',
  },
];

const instrumentRows: MockRow[] = [
  {
    id: INSTRUMENT_ID,
    instrument_name: 'Long History Equity Fund',
    base_currency: 'INR',
    country_of_domicile: 'IN',
  },
];

const TABLES: Record<string, MockRow[]> = {
  ii_portfolio_truth_status: truthRows,
  ii_transactions: txRows,
  ii_holding_snapshots: snapshotRows,
  ii_instruments: instrumentRows,
  ii_prices_nav: navRows,
  ii_instrument_benchmarks: [],
  ii_benchmark_series: [],
  ii_risk_free_rates: [],
};

// ---------------------------------------------------------------------------
// ORACLE — computed from the fixture's own arithmetic, independent of both
// the paged and unpaged implementations.
// ---------------------------------------------------------------------------

const TRUE_FINAL_INDEX = OBSERVATIONS - 1; // 1499
const TRUNCATED_FINAL_INDEX = POSTGREST_CAP - 1; // 999

const ORACLE_TRUE_FINAL_DATE = dateAt(TRUE_FINAL_INDEX);
const ORACLE_TRUE_FINAL_VALUE = UNITS_PURCHASED * navAt(TRUE_FINAL_INDEX);
const ORACLE_TRUNCATED_FINAL_DATE = dateAt(TRUNCATED_FINAL_INDEX);
const ORACLE_TRUNCATED_FINAL_VALUE = UNITS_PURCHASED * navAt(TRUNCATED_FINAL_INDEX);

/** Independent XIRR expectation, from the two-flow fixture, via the engine's own contract. */
const ORACLE_TRUE_XIRR = xirr([
  { date: new Date(`${dateAt(0)}T00:00:00.000Z`), amount: -PURCHASE_AMOUNT },
  { date: new Date(`${ORACLE_TRUE_FINAL_DATE}T00:00:00.000Z`), amount: ORACLE_TRUE_FINAL_VALUE },
]);

async function loadWith(truncate: boolean) {
  const supabase = makeSupabaseMock(TABLES, truncate);
  return loadAnalyticsDataset(supabase, USER_ID);
}

describe('R6P0-CALC-001: an R4 calculation whose correct answer depends on rows past 1000', () => {
  it('ORACLE sanity: the fixture genuinely places the terminal value past the 1000-row cap', () => {
    expect(OBSERVATIONS).toBeGreaterThan(POSTGREST_CAP);
    // The drawdown lives entirely past the cap, so the truncated view sees the
    // PEAK and the full view sees the post-crash value. These must differ
    // materially, or the test could pass without the fix doing anything.
    expect(ORACLE_TRUNCATED_FINAL_VALUE).toBeGreaterThan(ORACLE_TRUE_FINAL_VALUE * 1.2);
    expect(ORACLE_TRUE_FINAL_DATE).not.toBe(ORACLE_TRUNCATED_FINAL_DATE);
  });

  it('RED: the unbounded implementation computes over truncated history and gets the WRONG answer', async () => {
    const { dataset } = await loadWith(true);
    expect(dataset).not.toBeNull();
    const scheme = dataset!.schemes[0];

    // Truncated: only 1000 of 1500 observations survived.
    expect(scheme.navSeries).toHaveLength(POSTGREST_CAP);
    expect(scheme.valuationSeries).toHaveLength(POSTGREST_CAP);

    // ...and the consequences are wrong ANSWERS, not just short arrays:
    expect(scheme.currentValue).toBeCloseTo(ORACLE_TRUNCATED_FINAL_VALUE, 6);
    expect(scheme.currentValue).not.toBeCloseTo(ORACLE_TRUE_FINAL_VALUE, 2);
    expect(dataset!.asOfDate.toISOString().slice(0, 10)).toBe(ORACLE_TRUNCATED_FINAL_DATE);

    // The reported return is wrong too — a real, user-visible misstatement,
    // and in the DANGEROUS direction: the hidden drawdown makes the truncated
    // read OVERSTATE the investor's return.
    const red = runAnalytics(dataset!);
    const redXirr = red.schemes[0].investorXirr;
    expect(redXirr.status).toBe('CALCULATED');
    expect(redXirr.value!.rate).not.toBeCloseTo(ORACLE_TRUE_XIRR.rate!, 4);
    expect(redXirr.value!.rate).toBeGreaterThan(ORACLE_TRUE_XIRR.rate!);
  });

  it('GREEN: the paged implementation loads all 1500 rows and matches the independent oracle', async () => {
    const { dataset } = await loadWith(false);
    expect(dataset).not.toBeNull();
    const scheme = dataset!.schemes[0];

    expect(scheme.navSeries).toHaveLength(OBSERVATIONS);
    expect(scheme.valuationSeries).toHaveLength(OBSERVATIONS);

    expect(scheme.currentValue).toBeCloseTo(ORACLE_TRUE_FINAL_VALUE, 6);
    expect(dataset!.asOfDate.toISOString().slice(0, 10)).toBe(ORACLE_TRUE_FINAL_DATE);

    // Full history, no duplicated or skipped observations across page seams.
    const navDates = scheme.navSeries.map((p) => p.date.toISOString().slice(0, 10));
    expect(new Set(navDates).size).toBe(OBSERVATIONS);
    expect(navDates[0]).toBe(dateAt(0));
    expect(navDates[navDates.length - 1]).toBe(ORACLE_TRUE_FINAL_DATE);
    // strictly ascending — deterministic sequence across every page boundary
    for (let i = 1; i < navDates.length; i++) expect(navDates[i] > navDates[i - 1]).toBe(true);

    // The calculated return now equals the independent expectation.
    const green = runAnalytics(dataset!);
    const greenXirr = green.schemes[0].investorXirr;
    expect(greenXirr.status).toBe('CALCULATED');
    expect(greenXirr.value!.rate).toBeCloseTo(ORACLE_TRUE_XIRR.rate!, 6);
  });

  it('RED != GREEN: the pagination fix genuinely changes the reported figures', async () => {
    const red = runAnalytics((await loadWith(true)).dataset!);
    const green = runAnalytics((await loadWith(false)).dataset!);

    const redRate = red.schemes[0].investorXirr.value!.rate;
    const greenRate = green.schemes[0].investorXirr.value!.rate;
    expect(redRate).not.toBeCloseTo(greenRate, 4);

    // The truncated read hides the drawdown, so it OVERSTATES both the return
    // and the portfolio value — silently, with no error anywhere in the stack.
    expect(redRate).toBeGreaterThan(greenRate);

    const redValue = red.portfolios[0].totalValue;
    const greenValue = green.portfolios[0].totalValue;
    expect(redValue).toBeGreaterThan(greenValue);
    const overstatementPct = (redValue - greenValue) / greenValue;
    expect(overstatementPct).toBeGreaterThan(0.2); // >20% of net worth, silently
  });
});
