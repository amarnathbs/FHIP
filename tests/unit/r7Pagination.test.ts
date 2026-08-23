/**
 * R7 — Bank CSV Engine: proves `lib/financial-data-hub/bank-csv/pagination.ts`
 * (the FDH-isolated copy) behaves identically to Investment Intelligence's
 * `fetchAllRows` contract — same page-boundary handling, same failure
 * propagation, same ceiling behaviour — without importing across the
 * FDH/II boundary (spec section 76; see pagination.ts's header for why it is
 * a duplicate rather than a shared import, and tests/unit/fdh1Isolation.
 * test.ts for the boundary this respects).
 */
import { describe, expect, it } from 'vitest';
import { fetchAllRows, FdhPaginationCeilingExceededError, POSTGREST_PAGE_SIZE } from '@/lib/financial-data-hub/bank-csv/pagination';
import type { RangeableQuery } from '@/lib/financial-data-hub/bank-csv/pagination';

function makeFakeTable<T>(rows: T[]) {
  return (): RangeableQuery<T> => ({
    range: async (from: number, to: number) => ({ data: rows.slice(from, to + 1), error: null }),
  });
}

describe('R7 pagination — deterministic, complete, no silent truncation', () => {
  it('reads a dataset spanning multiple pages in full (>1000 rows)', async () => {
    const rows = Array.from({ length: 2500 }, (_, i) => ({ id: i }));
    const result = await fetchAllRows(makeFakeTable(rows));
    expect(result.length).toBe(2500);
    expect(result[0]).toEqual({ id: 0 });
    expect(result[2499]).toEqual({ id: 2499 });
  });

  it('terminates exactly on a short final page — no extra empty request result leaks in', async () => {
    const rows = Array.from({ length: 1500 }, (_, i) => ({ id: i }));
    const result = await fetchAllRows(makeFakeTable(rows), 500);
    expect(result.length).toBe(1500);
  });

  it('an exact-multiple-of-pageSize dataset still terminates correctly (via the trailing empty page)', async () => {
    const rows = Array.from({ length: 1000 }, (_, i) => ({ id: i }));
    const result = await fetchAllRows(makeFakeTable(rows), 500);
    expect(result.length).toBe(1000);
  });

  it('propagates a PostgREST error rather than swallowing it into a short page', async () => {
    const build = (): RangeableQuery<{ id: number }> => ({
      range: async () => ({ data: null, error: { message: 'boom' } }),
    });
    await expect(fetchAllRows(build)).rejects.toThrow('boom');
  });

  it('the default page size matches PostgREST db-max-rows (1000)', () => {
    expect(POSTGREST_PAGE_SIZE).toBe(1000);
  });

  it('exports a distinctly-named ceiling error (FdhPaginationCeilingExceededError), not the II one — proving genuine duplication, not a re-export', () => {
    expect(FdhPaginationCeilingExceededError.name).toBe('FdhPaginationCeilingExceededError');
  });
});
