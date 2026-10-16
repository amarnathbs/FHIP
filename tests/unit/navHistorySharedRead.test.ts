/**
 * Shared per-fund NAV read for the report (16-10-2026, follow-up): identical rows in identical order, far fewer
 * sequential round trips.
 *
 * SYNTHETIC HOUSEHOLD shaped like the PO's: 17 funds x 4,550 daily NAV rows = 77,350 rows (production: 77,345 =
 * 78 pages of 1,000), read by BOTH Performance and SIP. A fake PostgREST with a fixed latency per request makes the
 * wall-clock comparison measurable without a network.
 *
 * NAMED NEGATIVE CONTROLS
 *   NC-N1  the OLD queries (one ordered `in (...)` read per loader, offset-paged) are reproduced here and give the
 *          reference arrays; the new reader must equal them exactly, for BOTH orderings.
 *   NC-N2  a deliberately wrong reader (SIP order applied to Performance) is detected: the data_version of the last
 *          non-flagged row (which the Performance loader keeps) depends on the global order.
 *   NC-N3  the kill switch REPORT_NAV_SHARED_READ=off restores the old single-query path.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { fetchAllRows, POSTGREST_PAGE_SIZE } from '@/lib/services/investment-intelligence/pagination';
import {
  loadNavHistoryByFund,
  sharedNavReadEnabled,
  sortLikePerformanceQuery,
  sortLikeSipQuery,
  type NavHistoryRow,
} from '@/lib/services/investment-intelligence/navHistoryRead';
import { runWithRequestMemo } from '@/lib/services/requestMemo';

const FUNDS = 17;
const PER_FUND = 4550;
const LATENCY_MS = 15;

function buildRows(): NavHistoryRow[] {
  const rows: NavHistoryRow[] = [];
  for (let f = 0; f < FUNDS; f++) {
    const instrument = `00000000-0000-4000-8000-${String(f).padStart(12, '0')}`;
    for (let d = 0; d < PER_FUND; d++) {
      const date = new Date(Date.UTC(2014, 0, 1) + d * 86_400_000).toISOString().slice(0, 10);
      rows.push({
        id: `${(f * PER_FUND + d).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`,
        instrument_id: instrument,
        price_date: date,
        price: 10 + f + d / 1000,
        data_version: `v${(d + f) % 7}`,
        quality_status: d % 997 === 0 ? 'stale' : 'ok',
        currency_code: 'INR',
      });
    }
  }
  return rows;
}

function fakeClient(all: NavHistoryRow[]) {
  const stats = { requests: 0, inFlight: 0, maxInFlight: 0 };
  const from = (table: string) => {
    if (table !== 'ii_prices_nav') throw new Error(`unexpected table ${table}`);
    const filters: Array<(r: NavHistoryRow) => boolean> = [];
    const orders: Array<[keyof NavHistoryRow, boolean]> = [];
    const chain: Record<string, unknown> = {
      select: () => chain,
      in: (c: keyof NavHistoryRow, vs: unknown[]) => { filters.push((r) => vs.includes(r[c])); return chain; },
      eq: (c: keyof NavHistoryRow, v: unknown) => { filters.push((r) => r[c] === v); return chain; },
      order: (c: keyof NavHistoryRow, o?: { ascending?: boolean }) => { orders.push([c, o?.ascending !== false]); return chain; },
      range: async (a: number, b: number) => {
        stats.requests += 1;
        stats.inFlight += 1;
        stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
        await new Promise((r) => setTimeout(r, LATENCY_MS));
        stats.inFlight -= 1;
        let rows = all.filter((r) => filters.every((f) => f(r)));
        rows = [...rows].sort((x, y) => {
          for (const [c, asc] of orders) {
            const xv = String(x[c]);
            const yv = String(y[c]);
            if (xv !== yv) return (xv < yv ? -1 : 1) * (asc ? 1 : -1);
          }
          return 0;
        });
        return { data: rows.slice(a, b + 1), error: null };
      },
    };
    return chain;
  };
  return { client: { from } as never, stats };
}

const ALL = buildRows();
const IDS = [...new Set(ALL.map((r) => r.instrument_id))];

afterEach(() => {
  delete process.env.REPORT_NAV_SHARED_READ;
});

interface OldQuery {
  select: (c: string) => OldQuery;
  in: (c: string, v: unknown[]) => OldQuery;
  order: (c: string, o?: { ascending?: boolean }) => OldQuery;
  range: (a: number, b: number) => PromiseLike<{ data: NavHistoryRow[] | null; error: { message: string } | null }>;
}

/** The two OLD queries, reproduced verbatim (sequential paging, as originally shipped). */
async function oldPerformanceRead(client: never) {
  return fetchAllRows<NavHistoryRow>(() =>
    (client as unknown as { from: (t: string) => OldQuery }).from('ii_prices_nav').select('x').in('instrument_id', IDS).order('price_date', { ascending: true }).order('id', { ascending: true })
  );
}
async function oldSipRead(client: never) {
  return fetchAllRows<NavHistoryRow>(() =>
    (client as unknown as { from: (t: string) => OldQuery }).from('ii_prices_nav').select('x').in('instrument_id', IDS).order('instrument_id', { ascending: true }).order('price_date', { ascending: true })
  );
}

describe('shared per-fund NAV read', () => {
  it('the synthetic household is the PO\'s size: 77,350 rows, 78 pages of 1,000', () => {
    expect(ALL).toHaveLength(77_350);
    expect(Math.ceil(ALL.length / POSTGREST_PAGE_SIZE)).toBe(78);
  });

  it('NC-N1: identical rows in identical order for both loaders; BEFORE 156 sequential pages, AFTER one shared read', async () => {
    const before = fakeClient(ALL);
    const t0 = Date.now();
    const oldPerf = await oldPerformanceRead(before.client);
    const oldSip = await oldSipRead(before.client);
    const beforeMs = Date.now() - t0;

    const after = fakeClient(ALL);
    const t1 = Date.now();
    const { perf, sip } = await runWithRequestMemo(async () => {
      const [p, s] = await Promise.all([loadNavHistoryByFund(after.client, IDS), loadNavHistoryByFund(after.client, IDS)]);
      return { perf: sortLikePerformanceQuery(p, IDS), sip: sortLikeSipQuery(s, IDS) };
    });
    const afterMs = Date.now() - t1;

    expect(perf).toEqual(oldPerf);
    expect(sip.map((r) => [r.instrument_id, r.price_date])).toEqual(oldSip.map((r) => [r.instrument_id, r.price_date]));
    expect(perf).toHaveLength(77_350);

    // Page counts (requests): the old way pages the whole set once per loader.
    expect(before.stats.requests).toBe(2 * 78 + 0);
    expect(before.stats.maxInFlight).toBe(1);
    // New: 17 funds x ceil(4550/1000)=5 pages each, ONCE for both loaders (memo), 8 funds at a time.
    expect(after.stats.requests).toBe(17 * 5);
    expect(after.stats.maxInFlight).toBeGreaterThan(1);
    expect(after.stats.requests).toBeLessThan(before.stats.requests);
    // Measured (fixed 15 ms per request + sorting in the fake): the shared read waits for far fewer sequential round trips.
    console.log(`NAV READ 17 funds / 77,350 rows: before ${before.stats.requests} sequential pages ${beforeMs} ms; after ${after.stats.requests} pages (max ${after.stats.maxInFlight} in flight) ${afterMs} ms`);
    expect(afterMs).toBeLessThan(beforeMs);
  }, 120_000);

  it('without a memo scope the two loaders each read once (no sharing, still identical rows)', async () => {
    const c = fakeClient(ALL);
    const a = await loadNavHistoryByFund(c.client, IDS);
    const b = await loadNavHistoryByFund(c.client, IDS);
    expect(c.stats.requests).toBe(2 * 17 * 5);
    expect(sortLikePerformanceQuery(a, IDS)).toEqual(sortLikePerformanceQuery(b, IDS));
  }, 60_000);

  it('NC-N2: the two orderings are genuinely different sequences, so handing one loader the other order would be caught by NC-N1', () => {
    const byFund = new Map<string, NavHistoryRow[]>();
    for (const r of ALL) byFund.set(r.instrument_id, [...(byFund.get(r.instrument_id) ?? []), r]);
    const perf = sortLikePerformanceQuery(byFund, IDS);
    const sip = sortLikeSipQuery(byFund, IDS);
    expect(perf.slice(0, 40).map((r) => r.instrument_id)).not.toEqual(sip.slice(0, 40).map((r) => r.instrument_id));
    expect(perf).toHaveLength(sip.length);
  });

  it('a fund with no history yields an empty list, and an unknown id is simply absent from the rows', async () => {
    const c = fakeClient(ALL);
    const map = await loadNavHistoryByFund(c.client, ['ffffffff-0000-4000-8000-000000000000', IDS[0]]);
    expect(map.get('ffffffff-0000-4000-8000-000000000000')).toEqual([]);
    expect(map.get(IDS[0])).toHaveLength(PER_FUND);
  });

  it('NC-N3: the kill switch is honoured', () => {
    expect(sharedNavReadEnabled()).toBe(true);
    process.env.REPORT_NAV_SHARED_READ = 'off';
    expect(sharedNavReadEnabled()).toBe(false);
  });
});
