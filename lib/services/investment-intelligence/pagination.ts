// Investment Intelligence — the module's single PostgREST pagination helper.
//
// WHY THIS EXISTS
// ---------------
// PostgREST caps an unbounded select at `db-max-rows` (1000 on this project)
// and reports the truncation ONLY in the Content-Range response header. The
// response body is a perfectly well-formed array and the Supabase JS client
// surfaces NO error. Confirmed live against DEV during R5: seeding 1500
// ii_prices_nav rows and issuing a plain select returned exactly 1000 rows
// with `Content-Range: 0-999/1500`.
//
// For financial data that silent truncation is not "incomplete data", it is
// WRONG ANSWERS with no error anywhere: truncated NAV/transaction history
// yields wrong XIRR/TWRR/benchmark figures, truncated tax lots yield a wrong
// cost basis, and a truncated instrument universe makes scheme resolution
// mint duplicate canonical instruments.
//
// The same defect class was found independently in R4 and in R5, which is why
// R6-P0 consolidates ONE helper here instead of a per-file copy.
//
// CONTRACT (R6 spec section 6)
// ----------------------------
//   * deterministic ordering — the CALLER must supply an ordering whose key
//     is UNIQUE. A non-unique ORDER BY lets Postgres return tied rows in any
//     order per page request, which at a page boundary silently drops or
//     duplicates rows. Order by a natural key plus a unique tie-breaker (the
//     `id` primary key), e.g. `.order('event_date').order('id')` — never
//     `.order('event_date')` alone where dates can repeat.
//   * no skipped rows / no duplicate rows / no page-order dependence
//   * configurable safe page size
//   * explicit termination on a short page
//   * failure propagation — a PostgREST error throws, it is never swallowed
//   * no infinite loop, and NO SILENT TRUNCATION at the safety ceiling: the
//     ceiling THROWS, because quietly returning 500k rows would reintroduce
//     exactly the silent-truncation bug this helper exists to remove.
//   * RLS-compatible — paging is applied to whatever client is passed in, so
//     a request-scoped RLS client stays RLS-scoped.

/** PostgREST's configured `db-max-rows` on this project. */
export const POSTGREST_PAGE_SIZE = 1000;

/**
 * Hard ceiling on a single logical read. Chosen well above any realistic
 * household dataset (a 50-fund portfolio of daily 20-year NAV history is
 * ~260k rows) but low enough to stop a pathological/looping query.
 */
export const FETCH_ALL_ROWS_CEILING = 500_000;

/** The narrow slice of the Supabase query builder this helper needs. */
export interface RangeableQuery<T> {
  range: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>;
}

export class PaginationCeilingExceededError extends Error {
  constructor(rows: number) {
    super(
      `Investment Intelligence pagination ceiling exceeded: a single read returned more than ${rows} rows. ` +
        'Refusing to continue rather than silently returning a truncated financial dataset.'
    );
    this.name = 'PaginationCeilingExceededError';
  }
}

/**
 * Read EVERY row a query matches, paging past PostgREST's silent row cap.
 *
 * `build` must return a FRESH query builder on each call — the Supabase
 * builder is single-use, so the caller passes a thunk rather than a built
 * query.
 *
 * The caller is responsible for deterministic, unique ordering (see contract
 * above). This helper deliberately does not inject an ordering of its own,
 * because the correct tie-breaker column is table-specific.
 */
export async function fetchAllRows<T>(
  build: () => RangeableQuery<T>,
  pageSize: number = POSTGREST_PAGE_SIZE
): Promise<T[]> {
  if (!Number.isInteger(pageSize) || pageSize <= 0) {
    throw new Error(`fetchAllRows: pageSize must be a positive integer, received ${pageSize}`);
  }

  const out: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await build().range(from, from + pageSize - 1);
    // Failure propagation: never swallow a PostgREST error into a short page,
    // which would be indistinguishable from "end of data".
    if (error) throw new Error(error.message);

    const page = data ?? [];
    out.push(...page);

    // Explicit termination: a page shorter than the requested size is the
    // last page. A full page always triggers one more request, so a dataset
    // that is an exact multiple of pageSize terminates on the following
    // empty page rather than stopping one page early.
    if (page.length < pageSize) break;

    if (out.length >= FETCH_ALL_ROWS_CEILING) throw new PaginationCeilingExceededError(FETCH_ALL_ROWS_CEILING);
  }
  return out;
}
