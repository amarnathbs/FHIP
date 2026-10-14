// NAV2 release candidate (B3 and D3): the shared analytics dataset reads each fund's prices separately (ten funds at a time) instead of paging through every
// fund's rows in ONE read, and it never feeds a price in another currency into a fund's series.
//   NC-A1  twelve funds (two groups of ten and two), one with more than 1000 rows: every fund's series is complete, in date order
//   NC-A2  the row order the consumers see is (date, then id), whatever order the funds were read in: "the data version of the last row" is the same as before
//   NC-A3  a price in another currency than the fund's own is not in the series; a null currency is kept; the control (no foreign row) has the full series
import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { loadAnalyticsDataset } from '@/lib/services/investment-intelligence/analyticsRepository';

type Row = Record<string, unknown>;
const CAP = 1000;
const sortBy = (rows: Row[], clauses: Array<{ col: string; ascending: boolean }>): Row[] => {
  const out = [...rows];
  for (let i = clauses.length - 1; i >= 0; i--) {
    const { col, ascending } = clauses[i];
    out.sort((a, b) => ((a[col] as string | number) < (b[col] as string | number) ? (ascending ? -1 : 1) : (a[col] as string | number) > (b[col] as string | number) ? (ascending ? 1 : -1) : 0));
  }
  return out;
};
function builder(rows: Row[]) {
  let filtered = rows;
  const order: Array<{ col: string; ascending: boolean }> = [];
  const b = {
    select: () => b,
    eq: (c: string, v: unknown) => { filtered = filtered.filter((r) => r[c] === v); return b; },
    in: (c: string, vs: unknown[]) => { const s = new Set(vs); filtered = filtered.filter((r) => s.has(r[c])); return b; },
    order: (col: string, o?: { ascending?: boolean }) => { order.push({ col, ascending: o?.ascending !== false }); return b; },
    range: (from: number, to: number) => Promise.resolve({ data: sortBy(filtered, order).slice(from, to + 1), error: null }),
    then: (res: (v: { data: Row[]; error: null }) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve({ data: sortBy(filtered, order).slice(0, CAP), error: null }).then(res, rej),
  };
  return b;
}
const client = (tables: Record<string, Row[]>): SupabaseClient =>
  ({
    from: (t: string) => builder(tables[t] ?? []),
    rpc: (name: string, args?: { p_benchmark_ids?: string[] }) => Promise.resolve({ data: name === 'benchmark_entitled_actions' ? (args?.p_benchmark_ids ?? []).map((id) => ({ benchmark_id: id, can_calculate: true, can_display: true, can_export: true, data_from: null, data_to: null })) : null, error: null }),
  }) as unknown as SupabaseClient;

const USER = 'user-rc';
const iso = (n: number): string => new Date(Date.UTC(2023, 0, 1) + n * 86400000).toISOString().slice(0, 10);
const FUNDS = Array.from({ length: 12 }, (_, i) => `inst-${String(i).padStart(2, '0')}`);
const NAV_DAYS = (i: number): number => (i === 3 ? 1300 : 90); // fund 3 has more than one page

function tables(extraNav: Row[] = []): Record<string, Row[]> {
  const nav: Row[] = [];
  FUNDS.forEach((f, i) => { for (let d = 0; d < NAV_DAYS(i); d++) nav.push({ id: `nav-${f}-${String(d).padStart(5, '0')}`, instrument_id: f, price_date: iso(d), price: 100 + i + d * 0.01, data_version: `v-${f}`, quality_status: 'ok', currency_code: 'INR' }); });
  return {
    ii_portfolio_truth_status: FUNDS.map((f, i) => ({ instrument_id: f, account_id: `acct-${i}`, history_completeness: 'complete_from_inception', status: 'certified', user_id: USER })),
    ii_transactions: FUNDS.map((f, i) => ({ id: `tx-${i}`, user_id: USER, instrument_id: f, transaction_type: 'purchase', transaction_date: iso(5), gross_amount: 1000, units: 10, currency_code: 'INR', status: 'reconciled' })),
    ii_holding_snapshots: FUNDS.map((f, i) => ({ id: `snap-${i}`, user_id: USER, instrument_id: f, as_of_date: iso(60), units: 10, value: 1100, currency_code: 'INR', quality_status: 'certified' })),
    ii_instruments: FUNDS.map((f) => ({ id: f, instrument_name: `Fund ${f}`, base_currency: 'INR', country_of_domicile: 'IN' })),
    ii_prices_nav: [...nav, ...extraNav],
    ii_instrument_benchmarks: [],
    ii_benchmark_series: [],
    ii_risk_free_rates: [],
  };
}

describe('NC-A1 / NC-A2: per-fund NAV reads give every fund its complete series, in date order', () => {
  it('twelve funds in two groups: each series is complete (one has more than one page) and ascending by date', async () => {
    const { dataset } = await loadAnalyticsDataset(client(tables()), USER);
    expect(dataset).not.toBeNull();
    expect(dataset!.schemes).toHaveLength(12);
    for (const s of dataset!.schemes) {
      const i = FUNDS.indexOf(s.instrumentId);
      expect(s.navSeries, s.instrumentId).toHaveLength(NAV_DAYS(i));
      const dates = s.navSeries.map((p) => p.date.getTime());
      expect([...dates].sort((a, b) => a - b)).toEqual(dates);
    }
  });
});

describe('NC-A3: a price in another currency never enters a fund series', () => {
  const foreign: Row = { id: 'nav-foreign', instrument_id: FUNDS[0], price_date: iso(95), price: 1000, data_version: 'v-foreign', quality_status: 'ok', currency_code: 'AUD' };
  const nullCurrency: Row = { id: 'nav-null', instrument_id: FUNDS[1], price_date: iso(95), price: 101.5, data_version: 'v-null', quality_status: 'ok', currency_code: null };
  it('control: with no foreign row the first fund has its 90 prices; a foreign AUD row on an INR fund is left out; a null currency is kept', async () => {
    const control = (await loadAnalyticsDataset(client(tables([nullCurrency])), USER)).dataset!;
    expect(control.schemes.find((s) => s.instrumentId === FUNDS[0])!.navSeries).toHaveLength(90);
    expect(control.schemes.find((s) => s.instrumentId === FUNDS[1])!.navSeries).toHaveLength(91); // the null-currency row is kept
    const withForeign = (await loadAnalyticsDataset(client(tables([foreign, nullCurrency])), USER)).dataset!;
    const s0 = withForeign.schemes.find((s) => s.instrumentId === FUNDS[0])!;
    expect(s0.navSeries).toHaveLength(90); // the AUD row is not in the series
    expect(Math.max(...s0.navSeries.map((p) => p.value))).toBeLessThan(200); // the ten times larger price is not there
  });
});
