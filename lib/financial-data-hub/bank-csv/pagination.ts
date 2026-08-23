/**
 * R7 — Bank CSV Engine: the FDH module's own PostgREST pagination helper
 * (spec section 76).
 *
 * DELIBERATELY DUPLICATED, NOT IMPORTED, from
 * `lib/services/investment-intelligence/pagination.ts`. `tests/unit/
 * fdh1Isolation.test.ts` (FDH-1, Product Owner Decision 2) asserts that no
 * file under `lib/financial-data-hub/**` imports from
 * `lib/services/investment-intelligence/**` or `lib/engines/investment-
 * intelligence/**` at all — the Financial Data Hub and Investment
 * Intelligence modules stay import-graph-isolated from each other even when
 * one module's internal utility would be perfectly reusable, precisely so
 * neither module's canonical-ownership boundary can ever be blurred by a
 * shared-code dependency edge. This file is therefore a verbatim behavioural
 * copy of the SAME contract II's R4/R5/R6 converged on (PostgREST caps an
 * unbounded select at `db-max-rows`, reports truncation only via the
 * `Content-Range` header, and the Supabase JS client surfaces no error for
 * it) — see that file's own header comment for the full defect history this
 * guards against. Any future change to one MUST be mirrored in the other;
 * `tests/unit/r7Pagination.test.ts` checks the two stay behaviourally
 * identical.
 */

/** PostgREST's configured `db-max-rows` on this project. */
export const POSTGREST_PAGE_SIZE = 1000;

/** Hard ceiling on a single logical read — well above any realistic
 * household bank-transaction history, low enough to stop a pathological
 * query. Throws rather than silently truncating. */
export const FETCH_ALL_ROWS_CEILING = 500_000;

/** The narrow slice of the Supabase query builder this helper needs. */
export interface RangeableQuery<T> {
  range: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>;
}

export class FdhPaginationCeilingExceededError extends Error {
  constructor(rows: number) {
    super(
      `Financial Data Hub pagination ceiling exceeded: a single read returned more than ${rows} rows. ` +
        'Refusing to continue rather than silently returning a truncated financial dataset.',
    );
    this.name = 'FdhPaginationCeilingExceededError';
  }
}

/**
 * Reads EVERY row a query matches, paging past PostgREST's silent row cap.
 * `build` must return a FRESH query builder each call. The caller supplies
 * deterministic, unique ordering (e.g. `.order('transaction_date').order('id')`
 * — never a bare non-unique column, spec 76).
 */
export async function fetchAllRows<T>(build: () => RangeableQuery<T>, pageSize: number = POSTGREST_PAGE_SIZE): Promise<T[]> {
  if (!Number.isInteger(pageSize) || pageSize <= 0) {
    throw new Error(`fetchAllRows: pageSize must be a positive integer, received ${pageSize}`);
  }

  const out: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await build().range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);

    const page = data ?? [];
    out.push(...page);

    if (page.length < pageSize) break;
    if (out.length >= FETCH_ALL_ROWS_CEILING) throw new FdhPaginationCeilingExceededError(FETCH_ALL_ROWS_CEILING);
  }
  return out;
}
