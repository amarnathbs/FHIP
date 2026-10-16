/**
 * fetchAllRows with page concurrency (16-10-2026): the NAV history reads (about 50 sequential 1,000-row pages for 17
 * funds, read by both Performance and SIP) request several pages together. The rows and their ORDER must be exactly
 * those of the sequential walk, for every dataset size, including the exact-multiple edge cases.
 *
 * NAMED NEGATIVE CONTROLS
 *   NC-C1  concurrency 1 (the default) is the original strictly sequential walk: one request in flight at a time.
 *   NC-C2  the concurrent walk is really concurrent (several requests in flight), and a failed page still throws.
 *   NC-C3  a page-order scramble (later pages answering first) does not reorder rows.
 */
import { describe, expect, it } from 'vitest';
import { FETCH_ALL_ROWS_CEILING, fetchAllRows, NAV_PAGE_CONCURRENCY, PaginationCeilingExceededError } from '@/lib/services/investment-intelligence/pagination';

function source(total: number, opts: { delay?: (from: number) => number; failAt?: number } = {}) {
  const state = { calls: 0, inFlight: 0, maxInFlight: 0, ranges: [] as Array<[number, number]> };
  const build = () => ({
    range: async (from: number, to: number) => {
      state.calls += 1;
      state.inFlight += 1;
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      state.ranges.push([from, to]);
      await new Promise((r) => setTimeout(r, opts.delay?.(from) ?? 0));
      state.inFlight -= 1;
      if (opts.failAt !== undefined && from === opts.failAt) return { data: null, error: { message: 'page failed' } };
      const rows = Array.from({ length: Math.max(0, Math.min(to + 1, total) - from) }, (_, i) => from + i);
      return { data: rows, error: null };
    },
  });
  return { build, state };
}

describe('fetchAllRows concurrency', () => {
  const sizes = [0, 1, 999, 1000, 1001, 1999, 2000, 2001, 3999, 4000, 4001, 4003, 8000, 8001, 12345];

  it.each(sizes)('size %i: concurrent rows and order are identical to the sequential walk', async (total) => {
    const sequential = await fetchAllRows<number>(source(total).build);
    const concurrent = await fetchAllRows<number>(source(total).build, 1000, { concurrency: NAV_PAGE_CONCURRENCY });
    expect(concurrent).toEqual(sequential);
    expect(concurrent).toHaveLength(total);
    expect(concurrent).toEqual(Array.from({ length: total }, (_, i) => i));
  });

  it('NC-C1: the default is strictly sequential (one request in flight, no read-ahead past the end)', async () => {
    const s = source(2500);
    await fetchAllRows<number>(s.build);
    expect(s.state.maxInFlight).toBe(1);
    expect(s.state.calls).toBe(3);
  });

  it('NC-C2: with concurrency N several pages are requested together, and fewer round trips are waited for', async () => {
    const s = source(10_000, { delay: () => 5 });
    const rows = await fetchAllRows<number>(s.build, 1000, { concurrency: 4 });
    expect(rows).toHaveLength(10_000);
    expect(s.state.maxInFlight).toBe(4);
  });

  it('NC-C2: a failed page still throws (never a short, silently truncated result)', async () => {
    await expect(fetchAllRows<number>(source(10_000, { failAt: 2000 }).build, 1000, { concurrency: 4 })).rejects.toThrow('page failed');
  });

  it('NC-C3: pages answering out of order do not reorder rows', async () => {
    const s = source(5500, { delay: (from) => Math.max(0, 40 - (from / 1000) * 8) });
    const rows = await fetchAllRows<number>(s.build, 1000, { concurrency: 4 });
    expect(rows).toEqual(Array.from({ length: 5500 }, (_, i) => i));
  });

  it('the safety ceiling still throws instead of silently truncating', async () => {
    const huge = { range: async (from: number, to: number) => ({ data: Array.from({ length: to - from + 1 }, () => 1), error: null }) };
    await expect(fetchAllRows<number>(() => huge, 100_000, { concurrency: 4 })).rejects.toBeInstanceOf(PaginationCeilingExceededError);
    expect(FETCH_ALL_ROWS_CEILING).toBe(500_000);
  });

  it('rejects an invalid concurrency', async () => {
    await expect(fetchAllRows<number>(source(1).build, 1000, { concurrency: 0 })).rejects.toThrow('concurrency');
  });
});
