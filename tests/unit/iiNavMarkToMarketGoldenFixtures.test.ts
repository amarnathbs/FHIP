// Investment Intelligence — PO-mandated golden-fixture regression proof for
// the mark-to-market fix (commits 4072260, c632533, both live on main), built
// 2026-09-30. The PO asked for a much more thorough regression proof than
// tests/unit/iiNavMarkToMarket.test.ts (MTM-001..004, scenarios 1/2 of the
// PO's list) and tests/unit/iiPortfolioTwrrValuationReconstruction.test.ts
// (TWRR-RECON-001..003) already give, covering specific additional scenarios
// with EXACT, independently hand-computed expected values:
//
//   3. Fully redeemed holding (0 units)              -> GOLD-003
//   4. Historical point-in-time valuation             -> GOLD-004
//   6. NAV correction                                 -> GOLD-006
//   7. Missing / stale / gapped NAV disclosure         -> GOLD-007
//   8. Future-dated NAV defense-in-depth               -> GOLD-008
//   9. Multi-currency holdings                         -> GOLD-009
//  10. TWRR/XIRR exact dated cash flows/endpoints       -> GOLD-010
//
// Scenarios 1 and 2 (a newer NAV vs. only a statement-date NAV) are already
// covered with exact values by MTM-001/MTM-002 and are not duplicated here.
// Scenario 5 (finalized reports must never be recalculated) is covered
// separately in tests/unit/iiReportImmutabilityMarkToMarket.test.ts, because
// it exercises reportsData.ts rather than analyticsRepository.ts.
//
// REAL DEFECT FOUND AND FIXED as part of building GOLD-008 (see
// analyticsRepository.ts's comment above `latestNav` in loadAnalyticsDataset,
// 2026-09-30): the NAV query has no date filter at all, and the mark-to-market
// logic picked "the chronologically last NAV row" completely unconditionally
// -- with NO check against `asOfDate` ("now" for the caller). The only thing
// preventing a future-dated row from ever being used was the DB trigger
// trg_ii_prices_nav_no_future_date (migration 0155), which is defense at the
// storage layer only. GOLD-008 below reproduces the exact failure this would
// cause (using the hermetic mock, which -- unlike a real Postgres connection
// -- has no trigger to stop a bad fixture row), and the fix (bounding
// `latestNav` to `date <= asOfDate`) is now in place. Confidence: HIGH -- the
// fix is a 6-line, purely-restrictive change (it can only turn an
// already-firing mark-to-market into a no-op or an earlier NAV point, never
// the reverse), it does not touch any other consumer of navByInstrument /
// navSeriesForInstrument, and the full existing MTM-00x / TWRR-RECON-00x
// suites (whose fixtures never contain a future-dated row) are unaffected --
// verified by running them alongside this file.
//
// Same hermetic mock Supabase query builder pattern as
// iiNavMarkToMarket.test.ts / iiPortfolioTwrrValuationReconstruction.test.ts.

import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { loadAnalyticsDataset } from '@/lib/services/investment-intelligence/analyticsRepository';
import { runAnalytics } from '@/lib/engines/investment-intelligence/analyticsOrchestrator';
import { xirr } from '@/lib/engines/investment-intelligence/xirr';

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

const userId = 'user-golden-test';

// ===========================================================================
// GOLD-003 — a fully redeemed holding (0 units) must value at exactly zero,
// never a stale non-zero figure, and must never contribute a phantom
// terminal cash flow.
// ===========================================================================
describe('GOLD-003: a fully redeemed holding (0 units) stays exactly zero', () => {
  const instrumentId = 'inst-redeemed';

  it('currentValue is exactly 0 even though a later NAV price exists and is nonzero', async () => {
    const tables = baseTables({
      ii_transactions: [
        { id: 'tx-r-1', user_id: userId, instrument_id: instrumentId, transaction_type: 'purchase', transaction_date: '2026-06-01', gross_amount: 10000, currency_code: 'INR', status: 'reconciled', units: 1000 },
        { id: 'tx-r-2', user_id: userId, instrument_id: instrumentId, transaction_type: 'redemption', transaction_date: '2026-07-20', gross_amount: 13000, currency_code: 'INR', status: 'reconciled', units: 1000 },
      ],
      ii_holding_snapshots: [
        // The certified statement itself shows 0 units / 0 value after the
        // full redemption -- this is what a real "closing balance" line reads.
        { id: 'snap-r-1', user_id: userId, instrument_id: instrumentId, as_of_date: '2026-07-20', units: 0, value: 0, currency_code: 'INR', quality_status: 'certified' },
      ],
      ii_instruments: [{ id: instrumentId, instrument_name: 'Redeemed Fund', base_currency: 'INR', country_of_domicile: 'IN' }],
      ii_prices_nav: [
        { id: 'nav-r-1', instrument_id: instrumentId, price_date: '2026-06-01', price: 10, data_version: 'nav-v1', quality_status: 'ok' },
        { id: 'nav-r-2', instrument_id: instrumentId, price_date: '2026-07-20', price: 13, data_version: 'nav-v1', quality_status: 'ok' },
        // The fund keeps being priced for OTHER investors long after this
        // household fully exited it -- this must never resurrect a value.
        { id: 'nav-r-3', instrument_id: instrumentId, price_date: '2026-08-29', price: 15, data_version: 'nav-v1', quality_status: 'ok' },
      ],
    });
    const supabase = makeSupabaseMock(tables);
    const { dataset } = await loadAnalyticsDataset(supabase, userId, { asOfDate: new Date('2026-09-29T00:00:00.000Z') });
    const scheme = dataset!.schemes.find((s) => s.instrumentId === instrumentId)!;

    // 0 units x any price is exactly 0 -- never a stale 13000 or a bogus
    // 0 x 15 rounding artefact.
    expect(scheme.currentValue).toBe(0);
    // The mark-to-market condition still fires (0 units is not itself a
    // reason to skip it) and correctly dates the (zero) value to the later
    // NAV point, honestly reflecting when that zero was last confirmed true.
    expect(scheme.currentValueDate.toISOString().slice(0, 10)).toBe('2026-08-29');

    // No phantom terminal flow: only the two REAL transactions appear.
    expect(scheme.cashFlows).toHaveLength(2);
    expect(scheme.externalCashFlows).toHaveLength(2);
    expect(scheme.cashFlows.map((f) => f.amount).sort((a, b) => a - b)).toEqual([-10000, 13000]);
  });
});

// ===========================================================================
// GOLD-004 — a historical point-in-time valuation must NOT be affected by the
// mark-to-market fix, which only ever writes to currentValue/currentValueDate.
// ===========================================================================
describe('GOLD-004: historical point-in-time valuation is untouched by the mark-to-market fix', () => {
  const instrumentId = 'inst-hist';

  it('valuationSeries keeps the certified 2024-06-30 figure unchanged while currentValue moves on', async () => {
    const tables = baseTables({
      ii_holding_snapshots: [
        { id: 'snap-h-1', user_id: userId, instrument_id: instrumentId, as_of_date: '2024-06-30', units: 200, value: 20000, currency_code: 'INR', quality_status: 'certified' },
      ],
      ii_instruments: [{ id: instrumentId, instrument_name: 'Historical Fund', base_currency: 'INR', country_of_domicile: 'IN' }],
      ii_prices_nav: [
        { id: 'nav-h-1', instrument_id: instrumentId, price_date: '2024-06-30', price: 100, data_version: 'nav-v1', quality_status: 'ok' },
        { id: 'nav-h-2', instrument_id: instrumentId, price_date: '2026-09-25', price: 150, data_version: 'nav-v1', quality_status: 'ok' },
      ],
    });
    const supabase = makeSupabaseMock(tables);
    const { dataset } = await loadAnalyticsDataset(supabase, userId, { asOfDate: new Date('2026-09-29T00:00:00.000Z') });
    const scheme = dataset!.schemes.find((s) => s.instrumentId === instrumentId)!;

    // "What was this portfolio worth on 2024-06-30?" reads valuationSeries,
    // which is built exclusively from ii_holding_snapshots (analyticsRepository.ts
    // line ~337) and is never written to by the mark-to-market enrichment --
    // it must be byte-for-byte the certified figure, exactly as before the fix.
    expect(scheme.valuationSeries).toEqual([{ date: new Date('2024-06-30T00:00:00.000Z'), value: 20000 }]);

    // Meanwhile "current value" (a DIFFERENT question -- "what is it worth
    // right now") correctly reflects the fix: 200 units x the later 150 NAV.
    expect(scheme.currentValue).toBe(30000);
    expect(scheme.currentValueDate.toISOString().slice(0, 10)).toBe('2026-09-25');
  });

  it('a genuinely historical asOfDate bounds currentValue to that date too (see GOLD-008 for the defense-in-depth fix that makes this true)', async () => {
    const tables = baseTables({
      ii_holding_snapshots: [
        { id: 'snap-h-2', user_id: userId, instrument_id: instrumentId, as_of_date: '2024-06-30', units: 200, value: 20000, currency_code: 'INR', quality_status: 'certified' },
      ],
      ii_instruments: [{ id: instrumentId, instrument_name: 'Historical Fund', base_currency: 'INR', country_of_domicile: 'IN' }],
      ii_prices_nav: [
        { id: 'nav-h-3', instrument_id: instrumentId, price_date: '2024-06-30', price: 100, data_version: 'nav-v1', quality_status: 'ok' },
        // Real NAV history that exists TODAY but is chronologically AFTER
        // the point-in-time question being asked.
        { id: 'nav-h-4', instrument_id: instrumentId, price_date: '2024-07-15', price: 105, data_version: 'nav-v1', quality_status: 'ok' },
        { id: 'nav-h-5', instrument_id: instrumentId, price_date: '2026-09-25', price: 150, data_version: 'nav-v1', quality_status: 'ok' },
      ],
    });
    const supabase = makeSupabaseMock(tables);
    // A caller genuinely asking "as of 2024-07-10" -- between the two early
    // NAV points, before the 2024-07-15 one and long before the 2026 one.
    const { dataset } = await loadAnalyticsDataset(supabase, userId, { asOfDate: new Date('2024-07-10T00:00:00.000Z') });
    const scheme = dataset!.schemes.find((s) => s.instrumentId === instrumentId)!;
    // No NAV point at or before 2024-07-10 is later than the 2024-06-30
    // snapshot's own date other than none -- so mark-to-market correctly
    // does not fire, and currentValue stays the certified 20000, never
    // leaking the 2024-07-15 or 2026-09-25 figures into an "as of 2024-07-10" view.
    expect(scheme.currentValue).toBe(20000);
    expect(scheme.currentValueDate.toISOString().slice(0, 10)).toBe('2024-06-30');
  });
});

// ===========================================================================
// GOLD-006 — a NAV correction must use the corrected value, not the
// pre-correction one.
// ===========================================================================
describe('GOLD-006: a NAV correction is reflected correctly', () => {
  // Schema finding (confirmed by reading
  // lib/services/investment-intelligence/pc6/referenceIngestJob.ts, the ONLY
  // writer of ii_prices_nav corrections): ii_prices_nav has a table-wide
  // UNIQUE(instrument_id, price_date) constraint (migration 0033) with no
  // partial index excluding superseded rows, so a genuine two-physical-row
  // "old superseded + new corrected, same date" design is not just unused --
  // it is IMPOSSIBLE for this table (a second insert for the same key 23505s).
  // referenceIngestJob.ts's own comment documents that the original two-row
  // design was abandoned for exactly this reason (confirmed live against DEV,
  // 2026-09-21) and replaced with an in-place UPDATE of the single existing
  // row, with the full audit trail written to ii_reference_corrections
  // instead. So "the corrected value is used" is definitional here: there is
  // only ever ONE row per (instrument, price_date), and analyticsRepository.ts
  // reads whatever is currently in it -- this test pins that down with exact
  // numbers rather than asserting it by construction alone.
  const instrumentId = 'inst-corr';

  it('the value currently stored (post-correction) drives the mark-to-market figure, not any prior value', async () => {
    const tables = baseTables({
      ii_holding_snapshots: [
        { id: 'snap-c-1', user_id: userId, instrument_id: instrumentId, as_of_date: '2026-08-01', units: 100, value: 10000, currency_code: 'INR', quality_status: 'certified' },
      ],
      ii_instruments: [{ id: instrumentId, instrument_name: 'Corrected Fund', base_currency: 'INR', country_of_domicile: 'IN' }],
      ii_prices_nav: [
        { id: 'nav-c-1', instrument_id: instrumentId, price_date: '2026-08-01', price: 100, data_version: 'nav-v1', quality_status: 'ok' },
        // This row models the state of ii_prices_nav AFTER
        // referenceIngestJob.ts's correction branch ran an in-place UPDATE:
        // the source originally published 98 for 2026-09-20, then
        // republished a corrected 105 for the same date. Because the update
        // is in place, this fixture (correctly) never contains a 98 row at
        // all -- ii_reference_corrections (a separate table, not read by
        // analyticsRepository.ts at all) is where the superseded 98 value is
        // preserved for audit, by design.
        { id: 'nav-c-2', instrument_id: instrumentId, price_date: '2026-09-20', price: 105, data_version: 'nav-v1', quality_status: 'ok' },
      ],
    });
    const supabase = makeSupabaseMock(tables);
    const { dataset } = await loadAnalyticsDataset(supabase, userId, { asOfDate: new Date('2026-09-29T00:00:00.000Z') });
    const scheme = dataset!.schemes.find((s) => s.instrumentId === instrumentId)!;
    // 100 units x the CORRECTED 105 = 10500 -- not 100 x a pre-correction 98
    // (9800), which this fixture does not even make available, matching the
    // real system's in-place-update invariant.
    expect(scheme.currentValue).toBe(10500);
    expect(scheme.currentValueDate.toISOString().slice(0, 10)).toBe('2026-09-20');
  });

  it('a NAV row flagged quality_status other than "ok" (any reason, on any date) is excluded from the calculation and disclosed', async () => {
    const tables = baseTables({
      ii_holding_snapshots: [
        { id: 'snap-c-2', user_id: userId, instrument_id: instrumentId, as_of_date: '2026-08-01', units: 50, value: 4500, currency_code: 'INR', quality_status: 'certified' },
      ],
      ii_instruments: [{ id: instrumentId, instrument_name: 'Corrected Fund', base_currency: 'INR', country_of_domicile: 'IN' }],
      ii_prices_nav: [
        { id: 'nav-c-3', instrument_id: instrumentId, price_date: '2026-08-01', price: 90, data_version: 'nav-v1', quality_status: 'ok' },
        // A distinct, later date's row flagged 'superseded' for some other
        // data-quality reason (never a same-date correction pair -- see the
        // constraint note above). It must be excluded from the figure used,
        // not silently averaged in or picked as "latest by date".
        { id: 'nav-c-4', instrument_id: instrumentId, price_date: '2026-09-15', price: 999, data_version: 'nav-v1', quality_status: 'superseded' },
      ],
    });
    const supabase = makeSupabaseMock(tables);
    const { dataset, warnings } = await loadAnalyticsDataset(supabase, userId, { asOfDate: new Date('2026-09-29T00:00:00.000Z') });
    const scheme = dataset!.schemes.find((s) => s.instrumentId === instrumentId)!;
    // The flagged 999 row is invisible to the calculation entirely -- with it
    // excluded, there is no NAV point later than the 2026-08-01 snapshot, so
    // mark-to-market correctly does not fire at all.
    expect(scheme.currentValue).toBe(4500);
    expect(scheme.currentValueDate.toISOString().slice(0, 10)).toBe('2026-08-01');
    expect(warnings.some((w) => w.scope === 'nav')).toBe(true);
  });
});

// ===========================================================================
// GOLD-007 — missing or stale NAV must be disclosed, never silently presented
// as a current figure.
// ===========================================================================
describe('GOLD-007: missing or gapped NAV data never silently masquerades as current', () => {
  const instrumentId = 'inst-nonav';

  it('no NAV data at all for the instrument leaves the certified snapshot exactly as-is (no crash, no fabricated value)', async () => {
    const tables = baseTables({
      ii_holding_snapshots: [
        { id: 'snap-n-1', user_id: userId, instrument_id: instrumentId, as_of_date: '2026-08-15', units: 300, value: 33000, currency_code: 'INR', quality_status: 'certified' },
      ],
      ii_instruments: [{ id: instrumentId, instrument_name: 'No-NAV Fund', base_currency: 'INR', country_of_domicile: 'IN' }],
      ii_prices_nav: [], // no NAV rows at all for this instrument
    });
    const supabase = makeSupabaseMock(tables);
    const { dataset } = await loadAnalyticsDataset(supabase, userId, { asOfDate: new Date('2026-09-29T00:00:00.000Z') });
    const scheme = dataset!.schemes.find((s) => s.instrumentId === instrumentId)!;
    expect(scheme.currentValue).toBe(33000);
    expect(scheme.currentValueDate.toISOString().slice(0, 10)).toBe('2026-08-15');
  });

  it('a stale NAV gap (last NAV point far older than the snapshot) is disclosed via the honest currentValueDate and the data_currency warning, never silently treated as current', async () => {
    const instrumentGapId = 'inst-navgap';
    const tables = baseTables({
      ii_holding_snapshots: [
        // The snapshot itself is what's actually most recent -- but it too
        // is old relative to "today" (2026-09-29), because NEITHER the
        // household's statement upload NOR the daily NAV feed have moved on
        // in months. This is the genuine "gap" case: not just "no newer NAV
        // than the snapshot" (MTM-002) but "everything is stale together".
        { id: 'snap-g-1', user_id: userId, instrument_id: instrumentGapId, as_of_date: '2026-05-01', units: 400, value: 40000, currency_code: 'INR', quality_status: 'certified' },
      ],
      ii_instruments: [{ id: instrumentGapId, instrument_name: 'Gapped Fund', base_currency: 'INR', country_of_domicile: 'IN' }],
      ii_prices_nav: [
        // The daily NAV feed's own last point predates the statement --
        // the feed itself has a gap, not just "no NEWER point than the snapshot".
        { id: 'nav-g-1', instrument_id: instrumentGapId, price_date: '2026-04-01', price: 95, data_version: 'nav-v1', quality_status: 'ok' },
      ],
    });
    const supabase = makeSupabaseMock(tables);
    const { dataset, warnings } = await loadAnalyticsDataset(supabase, userId, { asOfDate: new Date('2026-09-29T00:00:00.000Z') });
    const scheme = dataset!.schemes.find((s) => s.instrumentId === instrumentGapId)!;
    // Never fabricated as "current": the date shown is honestly 2026-05-01,
    // 151 days before the requested asOfDate -- nothing here claims this
    // figure is live.
    expect(scheme.currentValue).toBe(40000);
    expect(scheme.currentValueDate.toISOString().slice(0, 10)).toBe('2026-05-01');
    // The existing, dataset-level staleness disclosure (>45 days between the
    // requested asOfDate and the latest certified valuation) fires -- this
    // IS the disclosure mechanism this codebase has for "the platform's data
    // is stale", and it correctly engages for this gap.
    expect(warnings.some((w) => w.scope === 'data_currency')).toBe(true);
  });
});

// ===========================================================================
// GOLD-008 — a future-dated NAV must never be used, even as defense in depth
// against a DB-trigger bypass. See the file header for the real defect this
// scenario found and the fix now in analyticsRepository.ts.
// ===========================================================================
describe('GOLD-008: the mark-to-market logic never looks ahead of "now" (defense in depth)', () => {
  const instrumentId = 'inst-future';

  it('a NAV row dated after asOfDate is ignored entirely when it is the only candidate', async () => {
    const tables = baseTables({
      ii_holding_snapshots: [
        { id: 'snap-f-1', user_id: userId, instrument_id: instrumentId, as_of_date: '2026-08-01', units: 100, value: 10000, currency_code: 'INR', quality_status: 'certified' },
      ],
      ii_instruments: [{ id: instrumentId, instrument_name: 'Future-NAV Fund', base_currency: 'INR', country_of_domicile: 'IN' }],
      ii_prices_nav: [
        { id: 'nav-f-1', instrument_id: instrumentId, price_date: '2026-08-01', price: 100, data_version: 'nav-v1', quality_status: 'ok' },
        // A stray row dated AFTER the requested asOfDate -- the DB trigger
        // trg_ii_prices_nav_no_future_date would refuse this against a real
        // Postgres connection, but the hermetic mock (correctly, for this
        // test's purpose) has no such trigger, so this exercises the
        // application-layer guard directly.
        { id: 'nav-f-2', instrument_id: instrumentId, price_date: '2026-10-15', price: 999, data_version: 'nav-v1', quality_status: 'ok' },
      ],
    });
    const supabase = makeSupabaseMock(tables);
    const { dataset } = await loadAnalyticsDataset(supabase, userId, { asOfDate: new Date('2026-09-29T00:00:00.000Z') });
    const scheme = dataset!.schemes.find((s) => s.instrumentId === instrumentId)!;
    // Before the fix this was 100 x 999 = 99900. With the future row excluded
    // and no other candidate <= asOfDate later than the snapshot's own date,
    // mark-to-market correctly does not fire at all.
    expect(scheme.currentValue).toBe(10000);
    expect(scheme.currentValueDate.toISOString().slice(0, 10)).toBe('2026-08-01');
  });

  it('with a valid intermediate NAV present, the future row is skipped and the true latest-at-or-before-asOfDate point is used', async () => {
    const tables = baseTables({
      ii_holding_snapshots: [
        { id: 'snap-f-2', user_id: userId, instrument_id: instrumentId, as_of_date: '2026-08-01', units: 100, value: 10000, currency_code: 'INR', quality_status: 'certified' },
      ],
      ii_instruments: [{ id: instrumentId, instrument_name: 'Future-NAV Fund', base_currency: 'INR', country_of_domicile: 'IN' }],
      ii_prices_nav: [
        { id: 'nav-f-3', instrument_id: instrumentId, price_date: '2026-08-01', price: 100, data_version: 'nav-v1', quality_status: 'ok' },
        { id: 'nav-f-4', instrument_id: instrumentId, price_date: '2026-09-01', price: 110, data_version: 'nav-v1', quality_status: 'ok' },
        { id: 'nav-f-5', instrument_id: instrumentId, price_date: '2026-10-15', price: 999, data_version: 'nav-v1', quality_status: 'ok' },
      ],
    });
    const supabase = makeSupabaseMock(tables);
    const { dataset } = await loadAnalyticsDataset(supabase, userId, { asOfDate: new Date('2026-09-29T00:00:00.000Z') });
    const scheme = dataset!.schemes.find((s) => s.instrumentId === instrumentId)!;
    // 100 x 110 = 11000, dated 2026-09-01 -- never the future 999.
    expect(scheme.currentValue).toBe(11000);
    expect(scheme.currentValueDate.toISOString().slice(0, 10)).toBe('2026-09-01');
  });

  it('NEGATIVE CONTROL — proves the guard is real: with the asOfDate bound removed by hand (calling with asOfDate AFTER the stray row), the same stray row IS legitimately picked up', async () => {
    // This is not a defect -- it demonstrates the guard is `<= asOfDate`, not
    // an unconditional "never use the last row", by moving asOfDate past the
    // stray row's own date, at which point it is no longer "future" at all.
    const tables = baseTables({
      ii_holding_snapshots: [
        { id: 'snap-f-3', user_id: userId, instrument_id: instrumentId, as_of_date: '2026-08-01', units: 100, value: 10000, currency_code: 'INR', quality_status: 'certified' },
      ],
      ii_instruments: [{ id: instrumentId, instrument_name: 'Future-NAV Fund', base_currency: 'INR', country_of_domicile: 'IN' }],
      ii_prices_nav: [
        { id: 'nav-f-6', instrument_id: instrumentId, price_date: '2026-08-01', price: 100, data_version: 'nav-v1', quality_status: 'ok' },
        { id: 'nav-f-7', instrument_id: instrumentId, price_date: '2026-10-15', price: 999, data_version: 'nav-v1', quality_status: 'ok' },
      ],
    });
    const supabase = makeSupabaseMock(tables);
    const { dataset } = await loadAnalyticsDataset(supabase, userId, { asOfDate: new Date('2026-11-01T00:00:00.000Z') });
    const scheme = dataset!.schemes.find((s) => s.instrumentId === instrumentId)!;
    expect(scheme.currentValue).toBe(99900);
    expect(scheme.currentValueDate.toISOString().slice(0, 10)).toBe('2026-10-15');
  });
});

// ===========================================================================
// GOLD-009 — a multi-currency holding: the mark-to-market fix must never mix
// currencies, and each currency's portfolio-level figures must stay strictly
// separate (spec section 59, "strict local-currency treatment" -- confirmed
// by reading lib/engines/money.ts, which is a display FORMATTER only and
// performs no conversion at all; analyticsOrchestrator.ts groups schemes by
// currencyCode with byCurrency.get(s.currencyCode), never converts between
// groups).
// ===========================================================================
describe('GOLD-009: a multi-currency household — no FX mixing through the mark-to-market fix', () => {
  const inrInstrument = 'inst-mc-inr';
  const audInstrument = 'inst-mc-aud';

  it('each currency is marked to market independently and portfolios never mix INR and AUD totals', async () => {
    const tables = baseTables({
      // Unit-ledger-eligible for both instruments so each currency's
      // PORTFOLIO-level totalValue (which reads reconstructedValuationSeries/
      // valuationSeries, NOT scheme.currentValue directly -- see
      // analyticsOrchestrator.ts's `totalValue: valuations[last].value`) also
      // reflects the mark-to-market NAV feed, not just each scheme's own
      // currentValue field.
      ii_portfolio_truth_status: [
        { instrument_id: inrInstrument, account_id: 'acct-mc-inr', history_completeness: 'complete_from_inception', status: 'certified', user_id: userId, unit_variance_within_tolerance: true },
        { instrument_id: audInstrument, account_id: 'acct-mc-aud', history_completeness: 'complete_from_inception', status: 'certified', user_id: userId, unit_variance_within_tolerance: true },
      ],
      ii_holding_snapshots: [
        { id: 'snap-mc-1', user_id: userId, instrument_id: inrInstrument, as_of_date: '2026-08-01', units: 100, value: 10000, currency_code: 'INR', quality_status: 'certified' },
        { id: 'snap-mc-2', user_id: userId, instrument_id: audInstrument, as_of_date: '2026-08-01', units: 50, value: 5000, currency_code: 'AUD', quality_status: 'certified' },
      ],
      ii_transactions: [
        { id: 'tx-mc-1', user_id: userId, instrument_id: inrInstrument, transaction_type: 'purchase', transaction_date: '2026-08-01', gross_amount: 10000, currency_code: 'INR', status: 'reconciled', units: 100 },
        { id: 'tx-mc-2', user_id: userId, instrument_id: audInstrument, transaction_type: 'purchase', transaction_date: '2026-08-01', gross_amount: 5000, currency_code: 'AUD', status: 'reconciled', units: 50 },
      ],
      ii_instruments: [
        { id: inrInstrument, instrument_name: 'INR Fund', base_currency: 'INR', country_of_domicile: 'IN' },
        { id: audInstrument, instrument_name: 'AUD Fund', base_currency: 'AUD', country_of_domicile: 'AU' },
      ],
      ii_prices_nav: [
        { id: 'nav-mc-1', instrument_id: inrInstrument, price_date: '2026-08-01', price: 100, data_version: 'nav-v1', quality_status: 'ok' },
        { id: 'nav-mc-2', instrument_id: inrInstrument, price_date: '2026-09-20', price: 120, data_version: 'nav-v1', quality_status: 'ok' },
        { id: 'nav-mc-3', instrument_id: audInstrument, price_date: '2026-08-01', price: 100, data_version: 'nav-v1', quality_status: 'ok' },
        { id: 'nav-mc-4', instrument_id: audInstrument, price_date: '2026-09-20', price: 110, data_version: 'nav-v1', quality_status: 'ok' },
      ],
    });
    const supabase = makeSupabaseMock(tables);
    const { dataset } = await loadAnalyticsDataset(supabase, userId, { asOfDate: new Date('2026-09-29T00:00:00.000Z') });

    const inrScheme = dataset!.schemes.find((s) => s.instrumentId === inrInstrument)!;
    const audScheme = dataset!.schemes.find((s) => s.instrumentId === audInstrument)!;
    // Each scheme's own currencyCode is preserved, and its mark-to-market
    // value is computed purely in that currency: 100 x 120 = 12000 INR;
    // 50 x 110 = 5500 AUD. Neither figure is converted or blended.
    expect(inrScheme.currencyCode).toBe('INR');
    expect(inrScheme.currentValue).toBe(12000);
    expect(audScheme.currencyCode).toBe('AUD');
    expect(audScheme.currentValue).toBe(5500);

    const result = runAnalytics(dataset!);
    expect(result.portfolios).toHaveLength(2);
    const inrPortfolio = result.portfolios.find((p) => p.currencyCode === 'INR')!;
    const audPortfolio = result.portfolios.find((p) => p.currencyCode === 'AUD')!;
    expect(inrPortfolio.totalValue).toBe(12000);
    expect(inrPortfolio.schemeCount).toBe(1);
    expect(audPortfolio.totalValue).toBe(5500);
    expect(audPortfolio.schemeCount).toBe(1);
    // Neither group's total leaks the other currency's figure in.
    expect(inrPortfolio.totalValue).not.toBe(12000 + 5500);
    expect(audPortfolio.totalValue).not.toBe(12000 + 5500);
  });
});

// ===========================================================================
// GOLD-010 — TWRR and XIRR must use the CORRECT dated cash flows and
// valuation endpoints post-fix: exact hand-computed values, not just "some"
// number and not just ">0" (unlike TWRR-RECON-001, which only asserts the
// sign). All arithmetic below is worked out independently of the
// implementation, spreadsheet-style, per this module's own convention (see
// tests/unit/iiXirrPortfolioTerminalValue.test.ts).
// ===========================================================================
describe('GOLD-010: TWRR and XIRR use the exact post-fix dated cash flows and valuation endpoints', () => {
  const instrumentId = 'inst-twrr-xirr';
  const accountId = 'acct-twrr-xirr';
  const day0 = '2026-01-01';
  const day100 = '2026-04-11'; // exactly 100 days after 2026-01-01

  it('day100 is genuinely 100 days after day0 (fixture sanity check)', () => {
    const diffDays = (new Date(`${day100}T00:00:00.000Z`).getTime() - new Date(`${day0}T00:00:00.000Z`).getTime()) / 86_400_000;
    expect(diffDays).toBe(100);
  });

  function tables(): Record<string, MockRow[]> {
    return baseTables({
      ii_portfolio_truth_status: [
        { instrument_id: instrumentId, account_id: accountId, history_completeness: 'complete_from_inception', status: 'certified', user_id: userId, unit_variance_within_tolerance: true },
      ],
      ii_transactions: [
        // ONE purchase, 1000 units at NAV 10 = 10000 INR, on day0.
        { id: 'tx-tx-1', user_id: userId, instrument_id: instrumentId, transaction_type: 'purchase', transaction_date: day0, gross_amount: 10000, currency_code: 'INR', status: 'reconciled', units: 1000 },
      ],
      ii_holding_snapshots: [
        { id: 'snap-tx-1', user_id: userId, instrument_id: instrumentId, as_of_date: day0, units: 1000, value: 10000, currency_code: 'INR', quality_status: 'certified' },
      ],
      ii_instruments: [{ id: instrumentId, instrument_name: 'TWRR/XIRR Fund', base_currency: 'INR', country_of_domicile: 'IN' }],
      ii_prices_nav: [
        { id: 'nav-tx-1', instrument_id: instrumentId, price_date: day0, price: 10, data_version: 'nav-v1', quality_status: 'ok' },
        // NAV rises 20% over the 100 days: 10 -> 12.
        { id: 'nav-tx-2', instrument_id: instrumentId, price_date: day100, price: 12, data_version: 'nav-v1', quality_status: 'ok' },
      ],
    });
  }

  it('scheme-level: reconstructedValuationSeries has exactly the two hand-predicted points', async () => {
    const supabase = makeSupabaseMock(tables());
    const { dataset } = await loadAnalyticsDataset(supabase, userId, { asOfDate: new Date(`${day100}T00:00:00.000Z`) });
    const scheme = dataset!.schemes.find((s) => s.instrumentId === instrumentId)!;
    // 1000 units held throughout x each NAV price:
    //   day0:   1000 x 10 = 10000
    //   day100: 1000 x 12 = 12000
    expect(scheme.reconstructedValuationSeries).toEqual([
      { date: new Date(`${day0}T00:00:00.000Z`), value: 10000 },
      { date: new Date(`${day100}T00:00:00.000Z`), value: 12000 },
    ]);
    // Mark-to-market also correctly lands on the same 12000/day100 figure
    // (same units, same later NAV) -- the two independent code paths (single
    // terminal mark-to-market vs. the unit-ledger-x-NAV series reconstruction)
    // agree, as they must for a position with no intervening transactions.
    expect(scheme.currentValue).toBe(12000);
    expect(scheme.currentValueDate.toISOString().slice(0, 10)).toBe(day100);
  });

  it('portfolio TWRR = exactly 20.00% -- hand-computed: (12000 - 0) / 10000 - 1 = 0.20, single sub-period, no external flow at the end boundary', async () => {
    const supabase = makeSupabaseMock(tables());
    const { dataset } = await loadAnalyticsDataset(supabase, userId, { asOfDate: new Date(`${day100}T00:00:00.000Z`) });
    const result = runAnalytics(dataset!);
    expect(result.portfolios).toHaveLength(1);
    const p = result.portfolios[0];
    expect(p.portfolioTwrr.status).toBe('CALCULATED');
    // Exact, not approximate: the only external flow (the day0 purchase)
    // coincides with the period's own start boundary, so there is exactly
    // ONE sub-period (day0 -> day100) with no flow at its END boundary:
    //   subPeriodReturn = (endValue - flowAtEnd) / startValue - 1
    //                   = (12000 - 0) / 10000 - 1 = 0.20
    //   TWRR = product of (1 + subPeriodReturn) - 1 = 0.20
    expect(p.portfolioTwrr.value!.twrr).toBeCloseTo(0.2, 12);
  });

  it('portfolio XIRR ~= 94.541% annualised -- hand-computed via -10000 + 12000/(1+r)^(100/365) = 0, cross-checked against the certified xirr() solver called directly on the same hand-derived flows', async () => {
    const supabase = makeSupabaseMock(tables());
    const { dataset } = await loadAnalyticsDataset(supabase, userId, { asOfDate: new Date(`${day100}T00:00:00.000Z`) });
    const result = runAnalytics(dataset!);
    const p = result.portfolios[0];
    expect(p.portfolioXirr.status).toBe('CALCULATED');

    // Independent hand computation (spreadsheet-style, worked out without
    // running any code): solve (1+r)^(100/365) = 12000/10000 = 1.2 for r.
    //   1 + r = 1.2^(365/100) = 1.2^3.65
    //   ln(1.2) = 0.1823215568
    //   3.65 x ln(1.2) = 0.6654736823
    //   e^0.6654736823 = 2 x e^(-0.0276735) [since ln(2) = 0.6931471806]
    //                  ~= 2 x 0.9727059 ~= 1.9454118
    //   r ~= 0.9454118 (94.54118% annualised)
    const handComputedRate = Math.pow(1.2, 365 / 100) - 1;
    expect(handComputedRate).toBeCloseTo(0.945412, 5);
    expect(p.portfolioXirr.value!.rate).toBeCloseTo(handComputedRate, 6);
    expect(p.portfolioXirr.value!.rate).toBeCloseTo(0.945412, 5);

    // Cross-check against the certified solver called directly on the exact
    // cash-flow shape the fix is supposed to produce for this fixture: a
    // day0 purchase outflow and a day100 terminal inflow at the post-fix
    // mark-to-market value (1000 units x the later NAV 12 = 12000) -- proves
    // the orchestrator's own cash-flow construction matches this
    // independently-built list exactly, not merely "some" value with the
    // right sign.
    const directSolve = xirr([
      { date: new Date(`${day0}T00:00:00.000Z`), amount: -10000 },
      { date: new Date(`${day100}T00:00:00.000Z`), amount: 12000 },
    ]);
    expect(directSolve.status).toBe('ok');
    expect(p.portfolioXirr.value!.rate).toBeCloseTo(directSolve.rate!, 9);
  });
});
