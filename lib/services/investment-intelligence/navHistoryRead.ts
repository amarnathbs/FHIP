// One shared, per-fund read of the NAV (ii_prices_nav) history for the report (16-10-2026).
//
// WHY
// ---
// A monthly report reads every NAV row of every held fund TWICE: once for Performance (analyticsRepository) and once
// for SIP (r5Repository). For the PO's 17 funds that is 77,345 rows = 78 pages of 1,000, read sequentially, twice.
//
// WHAT IS (AND IS NOT) CHANGED
// ----------------------------
// The VALUES do not change, and neither does the amount of history. Performance's per-fund point-to-point returns
// ("SINCE_INCEPTION", 7Y, 10Y) and its input fingerprint read the fund's whole series, so a "last 1/3/5 years" window
// would change reported figures; it is deliberately NOT applied. What changes is how the same rows are fetched:
//   * one read per fund, shared by both loaders through the request memo (half the rows and pages),
//   * per-fund queries on the (instrument_id, price_date) index instead of one ordered `in (...)` query paged by
//     offset across all funds, run several funds at a time.
// The union of the columns either loader selects is read once; each caller gets the rows in the order its old query
// produced (see sortLikePerformanceQuery / sortLikeSipQuery), so downstream arrays are identical.
//
// Kill switch: REPORT_NAV_SHARED_READ=off restores the previous single ordered query in both loaders.
import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAllRows, POSTGREST_PAGE_SIZE } from './pagination';
import { memoClientId, memoInRequest } from '@/lib/services/requestMemo';

export interface NavHistoryRow {
  id?: string;
  instrument_id: string;
  price_date: string;
  price: number;
  data_version: string | null;
  quality_status: string | null;
  currency_code: string | null;
}

/** How many funds are read at the same time. */
export const NAV_FUND_CONCURRENCY = 8;

export function sharedNavReadEnabled(): boolean {
  return process.env.REPORT_NAV_SHARED_READ !== 'off';
}

async function loadFundNavHistory(supabase: SupabaseClient, instrumentId: string): Promise<NavHistoryRow[]> {
  return memoInRequest(`nav:${memoClientId(supabase)}:${instrumentId}`, () =>
    fetchAllRows<NavHistoryRow>(
      () =>
        supabase
          .from('ii_prices_nav')
          .select('id, instrument_id, price_date, price, data_version, quality_status, currency_code')
          .eq('instrument_id', instrumentId)
          .order('price_date', { ascending: true })
          .order('id', { ascending: true }),
      POSTGREST_PAGE_SIZE
    )
  );
}

/** Reads the full NAV history of each fund (several funds at a time) and returns the rows grouped by fund. */
export async function loadNavHistoryByFund(supabase: SupabaseClient, instrumentIds: readonly string[]): Promise<Map<string, NavHistoryRow[]>> {
  const unique = [...new Set(instrumentIds)];
  const out = new Map<string, NavHistoryRow[]>();
  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= unique.length) return;
      out.set(unique[index], await loadFundNavHistory(supabase, unique[index]));
    }
  };
  await Promise.all(Array.from({ length: Math.min(NAV_FUND_CONCURRENCY, unique.length) }, worker));
  return out;
}

const byDateThenId = (a: NavHistoryRow, b: NavHistoryRow) =>
  a.price_date < b.price_date ? -1 : a.price_date > b.price_date ? 1 : (a.id ?? '') < (b.id ?? '') ? -1 : (a.id ?? '') > (b.id ?? '') ? 1 : 0;

/**
 * The rows exactly as Performance's old query returned them: ONE list over all funds ordered by price_date then id.
 * (It matters: the loader keeps the data_version of the LAST non-flagged row in that order.)
 */
export function sortLikePerformanceQuery(byFund: Map<string, NavHistoryRow[]>, instrumentIds: readonly string[]): NavHistoryRow[] {
  const rows: NavHistoryRow[] = [];
  for (const id of new Set(instrumentIds)) rows.push(...(byFund.get(id) ?? []));
  return rows.sort(byDateThenId);
}

/** The rows as SIP's old query returned them: ordered by fund, then price_date. */
export function sortLikeSipQuery(byFund: Map<string, NavHistoryRow[]>, instrumentIds: readonly string[]): NavHistoryRow[] {
  const rows: NavHistoryRow[] = [];
  for (const id of [...new Set(instrumentIds)].sort()) rows.push(...[...(byFund.get(id) ?? [])].sort(byDateThenId));
  return rows;
}
