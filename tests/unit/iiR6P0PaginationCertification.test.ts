// R6-P0 — Pagination boundary certification (R6 spec sections 6, 7, 8, 10).
//
// Context: PostgREST silently caps an unbounded select at 1000 rows, reporting
// the truncation ONLY in the Content-Range header. The response body is a
// well-formed array and the Supabase JS client raises no error. The same
// defect class was found independently in R4 (analyticsRepository.ts) and R5
// (r5Repository.ts), so R6-P0 consolidates one shared `fetchAllRows` helper
// and certifies it against the boundary matrix the spec mandates.
//
// This suite is hermetic — no live DB. The mock reproduces PostgREST's real,
// observed behaviour: an unbounded select silently truncates at exactly 1000
// rows; an explicit .range(from, to) returns exactly that slice.
//
// Sections covered:
//   * §7  boundary matrix: 0, 1, 999, 1000, 1001, 1999, 2000, 2500, 5001 rows,
//         each asserting expected count, returned count, first row, last row,
//         no duplicate IDs, no missing IDs, deterministic sequence.
//   * §8  negative control: the ORIGINAL unpaged implementation is reproduced
//         locally and PROVEN to truncate (RED), then the corrected helper is
//         proven to retrieve completely on the identical fixture (GREEN).
//   * §6  helper contract: deterministic ordering with a unique tie-breaker,
//         page-order independence, explicit termination, failure propagation,
//         no infinite loop, no silent truncation at the safety ceiling.

import { describe, it, expect } from 'vitest';
import {
  fetchAllRows,
  POSTGREST_PAGE_SIZE,
  PaginationCeilingExceededError,
  FETCH_ALL_ROWS_CEILING,
} from '@/lib/services/investment-intelligence/pagination';

type MockRow = Record<string, unknown>;

/** PostgREST's `db-max-rows` on this project — the silent cap being defended against. */
const POSTGREST_CAP = 1000;

function applyOrder(rows: MockRow[], clauses: Array<{ col: string; ascending: boolean }>): MockRow[] {
  const result = [...rows];
  // Reverse order so the FIRST .order() call is the primary key (stable sort).
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

interface BuilderOpts {
  /** Simulate a PostgREST error on the Nth range request (0-based). */
  errorOnRequest?: number;
  /**
   * Simulate a NON-DETERMINISTIC server: rows tied on the ordering key are
   * shuffled differently on every request. This is what a non-unique ORDER BY
   * genuinely permits Postgres to do, and it is how a page boundary silently
   * drops/duplicates rows.
   */
  shuffleTies?: string[];
  /** Counter shared across the builder thunk's repeated invocations. */
  counter?: { n: number };
}

function makeQueryBuilder(rows: MockRow[], opts: BuilderOpts = {}) {
  let filtered = rows;
  const orderClauses: Array<{ col: string; ascending: boolean }> = [];
  const builder = {
    select: () => builder,
    eq(col: string, val: unknown) {
      filtered = filtered.filter((r) => r[col] === val);
      return builder;
    },
    order(col: string, o?: { ascending?: boolean }) {
      orderClauses.push({ col, ascending: o?.ascending !== false });
      return builder;
    },
    range(from: number, to: number) {
      const requestIndex = opts.counter ? opts.counter.n++ : 0;
      if (opts.errorOnRequest !== undefined && requestIndex === opts.errorOnRequest) {
        return Promise.resolve({ data: null, error: { message: 'simulated PostgREST failure' } });
      }
      let sorted = applyOrder(filtered, orderClauses);
      if (opts.shuffleTies) {
        // Group by the ordering key actually used, then permute within group.
        const keyOf = (r: MockRow) => opts.shuffleTies!.map((c) => String(r[c])).join('|');
        const groups = new Map<string, MockRow[]>();
        for (const r of sorted) {
          const k = keyOf(r);
          if (!groups.has(k)) groups.set(k, []);
          groups.get(k)!.push(r);
        }
        sorted = [...groups.values()].flatMap((g) => {
          // Deterministic-but-different permutation per request: rotate.
          const shift = requestIndex % Math.max(1, g.length);
          return [...g.slice(shift), ...g.slice(0, shift)];
        });
      }
      // Real PostgREST also caps a range wider than db-max-rows.
      const width = Math.min(to - from + 1, POSTGREST_CAP);
      return Promise.resolve({ data: sorted.slice(from, from + width), error: null });
    },
    /** Unbounded await -> PostgREST's silent cap. This IS the defect. */
    then(resolve: (v: { data: MockRow[]; error: null }) => unknown, reject?: (e: unknown) => unknown) {
      const sorted = applyOrder(filtered, orderClauses);
      return Promise.resolve({ data: sorted.slice(0, POSTGREST_CAP), error: null }).then(resolve, reject);
    },
  };
  return builder;
}

/** A deterministic table: unique `id`, plus a deliberately duplicated `event_date`. */
function seriesRows(n: number): MockRow[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `id-${String(i).padStart(7, '0')}`,
    seq: i,
    // Dates repeat every 7 rows so ties straddle page boundaries at 1000/2000.
    event_date: `2020-01-${String((i % 7) + 1).padStart(2, '0')}`,
  }));
}

// ---------------------------------------------------------------------------
// §7 — BOUNDARY MATRIX
// ---------------------------------------------------------------------------

const BOUNDARY_SIZES = [0, 1, 999, 1000, 1001, 1999, 2000, 2500, 5001];

describe('R6P0-PAGE-001: boundary matrix — exact retrieval at every mandated row count', () => {
  for (const size of BOUNDARY_SIZES) {
    it(`retrieves exactly ${size} row(s) with no gaps, no duplicates and a deterministic sequence`, async () => {
      const table = seriesRows(size);
      const got = await fetchAllRows<MockRow>(() =>
        makeQueryBuilder(table).select().order('id', { ascending: true })
      );

      // expected count vs returned count
      expect(got).toHaveLength(size);

      if (size > 0) {
        // first row / last row
        expect(got[0].id).toBe(`id-${String(0).padStart(7, '0')}`);
        expect(got[got.length - 1].id).toBe(`id-${String(size - 1).padStart(7, '0')}`);
      }

      // no duplicate IDs
      const ids = got.map((r) => r.id as string);
      expect(new Set(ids).size).toBe(size);

      // no missing IDs — compare against the full expected id set
      const expectedIds = new Set(table.map((r) => r.id as string));
      for (const id of ids) expectedIds.delete(id);
      expect([...expectedIds]).toEqual([]);

      // deterministic sequence — strictly ascending seq, 0..size-1 in order
      expect(got.map((r) => r.seq)).toEqual(Array.from({ length: size }, (_, i) => i));
    });
  }
});

describe('R6P0-PAGE-002: page-count sanity — the helper really does issue multiple requests', () => {
  it('issues ceil(n/1000)+1 requests for an exact multiple, and does not stop one page early', async () => {
    const counter = { n: 0 };
    const table = seriesRows(2000);
    const got = await fetchAllRows<MockRow>(() =>
      makeQueryBuilder(table, { counter }).select().order('id', { ascending: true })
    );
    expect(got).toHaveLength(2000);
    // 2000 rows = two FULL pages, so a third (empty) request is required to
    // learn the data has ended. Stopping at two would be correct by luck here
    // but wrong for 2001; this asserts the explicit-termination rule.
    expect(counter.n).toBe(3);
  });

  it('issues exactly 2 requests for 1001 rows', async () => {
    const counter = { n: 0 };
    const got = await fetchAllRows<MockRow>(() =>
      makeQueryBuilder(seriesRows(1001), { counter }).select().order('id', { ascending: true })
    );
    expect(got).toHaveLength(1001);
    expect(counter.n).toBe(2);
  });

  it('issues exactly 1 request for 999 rows (a short first page terminates immediately)', async () => {
    const counter = { n: 0 };
    const got = await fetchAllRows<MockRow>(() =>
      makeQueryBuilder(seriesRows(999), { counter }).select().order('id', { ascending: true })
    );
    expect(got).toHaveLength(999);
    expect(counter.n).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// §8 — NEGATIVE CONTROL (RED -> GREEN)
// ---------------------------------------------------------------------------

describe('R6P0-PAGE-003: negative control — the original unpaged implementation is proven broken', () => {
  /**
   * The ORIGINAL (defective) implementation, reproduced here in an isolated
   * temporary form ONLY. This is deliberately never exported and never used by
   * production code — it exists to prove the defect is real and that the
   * corrected helper actually fixes it, on the identical fixture.
   */
  async function originalUnpagedRead(
    build: () => { then: (resolve: (v: { data: MockRow[]; error: null }) => unknown) => Promise<unknown> }
  ): Promise<MockRow[]> {
    // Awaiting the builder directly is exactly what the old code did.
    const { data } = (await build()) as unknown as { data: MockRow[] | null };
    return data ?? [];
  }

  for (const size of [1001, 2500, 5001]) {
    it(`RED: unpaged read of a ${size}-row table silently returns 1000 rows and NO error`, async () => {
      const table = seriesRows(size);
      const red = await originalUnpagedRead(() => makeQueryBuilder(table).select().order('id', { ascending: true }));

      // Truncated...
      expect(red).toHaveLength(POSTGREST_CAP);
      expect(red).not.toHaveLength(size);
      // ...and the loss is REAL data, not padding: the true last row is absent.
      const redIds = new Set(red.map((r) => r.id as string));
      expect(redIds.has(`id-${String(size - 1).padStart(7, '0')}`)).toBe(false);
      expect(size - red.length).toBeGreaterThan(0);
    });

    it(`GREEN: the corrected helper retrieves all ${size} rows from the identical fixture`, async () => {
      const table = seriesRows(size);
      const green = await fetchAllRows<MockRow>(() =>
        makeQueryBuilder(table).select().order('id', { ascending: true })
      );
      expect(green).toHaveLength(size);
      expect(green[green.length - 1].id).toBe(`id-${String(size - 1).padStart(7, '0')}`);
      // Every row the RED path lost is present in GREEN.
      expect(new Set(green.map((r) => r.id)).size).toBe(size);
    });
  }
});

// ---------------------------------------------------------------------------
// §6 — HELPER CONTRACT
// ---------------------------------------------------------------------------

describe('R6P0-PAGE-004: deterministic ordering and the unique tie-breaker', () => {
  it('NEGATIVE CONTROL: a NON-unique ordering key genuinely drops/duplicates rows at a page boundary', async () => {
    // `event_date` alone repeats ~715 times per value across 5001 rows, so
    // ties straddle every page boundary. A server free to reorder ties per
    // request corrupts the paged result. This proves the tie-breaker rule in
    // the helper's contract is load-bearing, not decorative.
    const counter = { n: 0 };
    const table = seriesRows(5001);
    const got = await fetchAllRows<MockRow>(() =>
      makeQueryBuilder(table, { shuffleTies: ['event_date'], counter })
        .select()
        .order('event_date', { ascending: true })
    );
    const ids = got.map((r) => r.id as string);
    const distinct = new Set(ids).size;
    // The paged read is corrupted: either duplicates appear or rows go missing.
    expect(distinct === table.length && ids.length === table.length).toBe(false);
  });

  it('GREEN: adding the unique `id` tie-breaker makes the same shuffled server safe', async () => {
    const counter = { n: 0 };
    const table = seriesRows(5001);
    const got = await fetchAllRows<MockRow>(() =>
      makeQueryBuilder(table, { shuffleTies: ['event_date', 'id'], counter })
        .select()
        .order('event_date', { ascending: true })
        .order('id', { ascending: true })
    );
    // With (event_date, id) the ordering is total, so no group has >1 member
    // to permute and every row is returned exactly once.
    expect(got).toHaveLength(table.length);
    expect(new Set(got.map((r) => r.id)).size).toBe(table.length);
  });
});

describe('R6P0-PAGE-005: failure propagation, termination and the safety ceiling', () => {
  it('propagates a PostgREST error on the FIRST page instead of returning an empty result', async () => {
    // The counter MUST live outside the thunk: the thunk builds a fresh query
    // per page (as the real single-use Supabase builder requires), so a
    // counter created inside it would reset every page and never advance.
    const counter = { n: 0 };
    await expect(
      fetchAllRows<MockRow>(() =>
        makeQueryBuilder(seriesRows(2500), { errorOnRequest: 0, counter })
          .select()
          .order('id', { ascending: true })
      )
    ).rejects.toThrow('simulated PostgREST failure');
    expect(counter.n).toBe(1);
  });

  it('propagates a mid-pagination error instead of silently returning a short result', async () => {
    // Failing on the SECOND request is the dangerous case: a naive helper that
    // treated an error as "no more rows" would return a truncated 1000-row
    // dataset with no error — reintroducing the exact bug being fixed.
    const counter = { n: 0 };
    await expect(
      fetchAllRows<MockRow>(() =>
        makeQueryBuilder(seriesRows(2500), { errorOnRequest: 1, counter })
          .select()
          .order('id', { ascending: true })
      )
    ).rejects.toThrow('simulated PostgREST failure');
    // Proves the failure happened on the SECOND page, i.e. mid-pagination,
    // after a full first page had already been accumulated.
    expect(counter.n).toBe(2);
  });

  it('THROWS at the safety ceiling rather than silently returning a truncated dataset', async () => {
    // A never-ending server: every page comes back full.
    const endless = () => ({
      range: (from: number, to: number) =>
        Promise.resolve({
          data: Array.from({ length: to - from + 1 }, (_, i) => ({ id: `x-${from + i}` })),
          error: null,
        }),
    });
    await expect(fetchAllRows<MockRow>(endless)).rejects.toBeInstanceOf(PaginationCeilingExceededError);
    // and it terminates rather than looping forever
    expect(FETCH_ALL_ROWS_CEILING).toBeGreaterThan(POSTGREST_PAGE_SIZE);
  });

  it('rejects a non-positive page size rather than looping forever', async () => {
    await expect(fetchAllRows<MockRow>(() => makeQueryBuilder(seriesRows(10)).select(), 0)).rejects.toThrow(
      /positive integer/
    );
  });

  it('honours a configurable page size and still returns the complete set', async () => {
    const counter = { n: 0 };
    const got = await fetchAllRows<MockRow>(
      () => makeQueryBuilder(seriesRows(250), { counter }).select().order('id', { ascending: true }),
      100
    );
    expect(got).toHaveLength(250);
    expect(counter.n).toBe(3); // 100 + 100 + 50 (short page terminates)
    expect(got.map((r) => r.seq)).toEqual(Array.from({ length: 250 }, (_, i) => i));
  });
});
