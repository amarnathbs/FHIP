/**
 * Paged, fail-closed reads for the canonical read models.
 *
 * PostgREST caps an un-ranged select at 1000 rows (confirmed live: FDH16-DEF-
 * 001), and a large `.in()` list can exceed the URL limit. Every read-model
 * query therefore goes through `fetchAllRows` (1000-row pages until a short
 * page) and every id filter through `fetchAllByIds` (100 ids per request).
 *
 * FAIL CLOSED. Any error becomes a `ReadModelUnavailableError`, which the
 * selector turns into `{ status: 'unavailable' }` -- never `[]` (DC-14).
 */
import { ReadModelUnavailableError } from './types';

export const PAGE_SIZE = 1000;
export const ID_CHUNK_SIZE = 100;

export type PageResult<T> = PromiseLike<{ data: T[] | null; error: unknown }>;

/**
 * Minimal structural type of the Supabase client the read models use, so tests
 * can pass a fake and server code can pass either the cookie client or the
 * service-role client. Chain methods are typed loosely on purpose: the
 * read models only ever call select/eq/in/gte/lte/lt/is/not/order/range.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ReadModelClient = { from(table: string): any };

export async function fetchAllRows<T>(
  source: string,
  factory: (from: number, to: number) => PageResult<T>,
  pageSize = PAGE_SIZE,
): Promise<T[]> {
  const all: T[] = [];
  let from = 0;
  for (;;) {
    let page: { data: T[] | null; error: unknown };
    try {
      page = await factory(from, from + pageSize - 1);
    } catch {
      throw new ReadModelUnavailableError('query_failed', source);
    }
    if (page.error) throw new ReadModelUnavailableError('query_failed', source);
    const rows = page.data ?? [];
    all.push(...rows);
    if (rows.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

/** Reads rows for a (possibly large) id list: 100 ids per request, each paged. */
export async function fetchAllByIds<T>(
  source: string,
  ids: readonly string[],
  factory: (idChunk: string[], from: number, to: number) => PageResult<T>,
  chunkSize = ID_CHUNK_SIZE,
): Promise<T[]> {
  const unique = [...new Set(ids.filter((id) => typeof id === 'string' && id.length > 0))];
  const out: T[] = [];
  for (let i = 0; i < unique.length; i += chunkSize) {
    const chunk = unique.slice(i, i + chunkSize);
    out.push(...(await fetchAllRows<T>(source, (from, to) => factory(chunk, from, to))));
  }
  return out;
}

/** A single-row read (maybeSingle) that fails closed. */
export async function fetchOne<T>(source: string, run: () => PromiseLike<{ data: T | null; error: unknown }>): Promise<T | null> {
  let res: { data: T | null; error: unknown };
  try {
    res = await run();
  } catch {
    throw new ReadModelUnavailableError('query_failed', source);
  }
  if (res.error) throw new ReadModelUnavailableError('query_failed', source);
  return res.data ?? null;
}
