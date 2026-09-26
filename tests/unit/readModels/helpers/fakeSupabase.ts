/**
 * An in-memory, PostgREST-shaped fake Supabase client for the read-model tests.
 *
 * It evaluates the filters the read models (and the legacy loadDashboard, used
 * as the negative control) actually call -- select / eq / neq / in / gte / lte
 * / lt / gt / is / not(col,'is',null) / order / limit / range / single /
 * maybeSingle / upsert -- against plain row arrays, and it enforces the
 * PostgREST 1000-row cap on any un-ranged select, so a reader that forgets to
 * page is caught exactly as it would be live (FDH16-DEF-001).
 *
 * Failure injection: `failOn` names tables whose next select returns an error.
 * `requests` records every (table, range) request for pagination assertions.
 */

export type Row = Record<string, unknown>;

export interface FakeSupabaseOptions {
  failOn?: Set<string>;
  /** Tables that reject any select naming one of these columns (simulates a pre-0207 DB). */
  missingColumns?: Record<string, string[]>;
  /** Tables whose upsert / insert / update returns an error (WP-03: snapshot write failure). */
  failWritesOn?: Set<string>;
}

export interface FakeRequest {
  table: string;
  from: number | null;
  to: number | null;
  inSizes: number[];
}

const CAP = 1000;

/** The chainable query surface the fake supports (loosely typed on purpose, like the real builder). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface FakeQuery extends PromiseLike<{ data: any; error: unknown }> {
  select(cols?: string): FakeQuery;
  eq(col: string, val: unknown): FakeQuery;
  neq(col: string, val: unknown): FakeQuery;
  in(col: string, vals: unknown[]): FakeQuery;
  gte(col: string, val: string): FakeQuery;
  lte(col: string, val: string): FakeQuery;
  gt(col: string, val: string): FakeQuery;
  lt(col: string, val: string): FakeQuery;
  is(col: string, val: null): FakeQuery;
  not(col: string, op: string, val: unknown): FakeQuery;
  order(col: string, o?: { ascending?: boolean }): FakeQuery;
  limit(n: number): FakeQuery;
  range(a: number, b: number): FakeQuery;
  single(): FakeQuery;
  maybeSingle(): FakeQuery;
  upsert(row: Row, opts?: unknown): FakeWrite;
  insert(row: Row | Row[]): FakeWrite;
  delete(): FakeWrite;
  /** WP-03: update(patch).eq(...) -- applied to the stored rows matching every eq. */
  update(patch: Row): FakeUpdate;
}

/** A write result that can be awaited directly or chained (.select().single() / .eq()),
 * like the real builder -- the Score / DNA / Resilience loaders chain their persistence. */
export interface FakeWrite extends PromiseLike<{ data: null; error: unknown }> {
  select(cols?: string): FakeWrite;
  single(): FakeWrite;
  maybeSingle(): FakeWrite;
  eq(col: string, val: unknown): FakeWrite;
}

export interface FakeUpdate extends PromiseLike<{ data: null; error: unknown; count: number }> {
  eq(col: string, val: unknown): FakeUpdate;
}

export function makeFakeSupabase(tables: Record<string, Row[]>, options: FakeSupabaseOptions = {}) {
  const requests: FakeRequest[] = [];
  const upserts: { table: string; row: Row }[] = [];
  const updates: { table: string; patch: Row; filters: Record<string, unknown>; matched: number }[] = [];
  const writeError = (table: string) => (options.failWritesOn?.has(table) ? { message: `injected write failure on ${table}`, code: 'XX000' } : null);

  function fakeWrite(error: unknown): FakeWrite {
    const w: FakeWrite = {
      select() { return w; },
      single() { return w; },
      maybeSingle() { return w; },
      eq() { return w; },
      then(onFulfilled, onRejected) {
        return Promise.resolve({ data: null, error }).then(onFulfilled, onRejected);
      },
    };
    return w;
  }

  function from(table: string): FakeQuery {
    let rows = [...(tables[table] ?? [])];
    let columns: string[] | null = null;
    let rangeFrom: number | null = null;
    let rangeTo: number | null = null;
    let limitN: number | null = null;
    let single: 'single' | 'maybe' | null = null;
    const inSizes: number[] = [];
    let orderCol: string | null = null;
    let orderAsc = true;

    const execute = () => {
      requests.push({ table, from: rangeFrom, to: rangeTo, inSizes });
      if (options.failOn?.has(table)) return { data: null, error: { message: `injected failure on ${table}`, code: 'XX000' } };
      const missing = options.missingColumns?.[table] ?? [];
      if (columns && columns.some((c) => missing.includes(c))) return { data: null, error: { message: 'column does not exist', code: '42703' } };
      let out = rows;
      if (orderCol) {
        const c = orderCol;
        out = [...out].sort((a, b) => {
          const av = String(a[c] ?? '');
          const bv = String(b[c] ?? '');
          return (av < bv ? -1 : av > bv ? 1 : 0) * (orderAsc ? 1 : -1);
        });
      }
      if (rangeFrom !== null && rangeTo !== null) out = out.slice(rangeFrom, Math.min(rangeTo + 1, rangeFrom + CAP));
      else out = out.slice(0, CAP);
      if (limitN !== null) out = out.slice(0, limitN);
      const projected = columns ? out.map((r) => Object.fromEntries(columns!.map((c) => [c, r[c] ?? null]))) : out;
      if (single) {
        if (projected.length === 0) return single === 'single' ? { data: null, error: { message: 'no rows', code: 'PGRST116' } } : { data: null, error: null };
        return { data: projected[0], error: null };
      }
      return { data: projected, error: null };
    };

    const builder: FakeQuery = {
      select(cols?: string) {
        if (cols && cols !== '*') columns = cols.split(',').map((c) => c.trim()).filter(Boolean);
        return builder;
      },
      eq(col: string, val: unknown) { rows = rows.filter((r) => r[col] === val); return builder; },
      neq(col: string, val: unknown) { rows = rows.filter((r) => r[col] !== val); return builder; },
      in(col: string, vals: unknown[]) { inSizes.push(vals.length); const s = new Set(vals); rows = rows.filter((r) => s.has(r[col])); return builder; },
      gte(col: string, val: string) { rows = rows.filter((r) => String(r[col]) >= val); return builder; },
      lte(col: string, val: string) { rows = rows.filter((r) => String(r[col]) <= val); return builder; },
      gt(col: string, val: string) { rows = rows.filter((r) => String(r[col]) > val); return builder; },
      lt(col: string, val: string) { rows = rows.filter((r) => String(r[col]) < val); return builder; },
      is(col: string, val: null) { rows = rows.filter((r) => (r[col] ?? null) === val); return builder; },
      not(col: string, op: string, val: unknown) {
        if (op === 'is' && val === null) rows = rows.filter((r) => r[col] !== null && r[col] !== undefined);
        return builder;
      },
      order(col: string, o?: { ascending?: boolean }) { orderCol = col; orderAsc = o?.ascending !== false; return builder; },
      limit(n: number) { limitN = n; return builder; },
      range(a: number, b: number) { rangeFrom = a; rangeTo = b; return builder; },
      single() { single = 'single'; return builder; },
      maybeSingle() { single = 'maybe'; return builder; },
      upsert(row: Row) {
        const error = writeError(table);
        if (!error) upserts.push({ table, row });
        return fakeWrite(error);
      },
      insert(row: Row | Row[]) {
        const error = writeError(table);
        if (!error) for (const r of Array.isArray(row) ? row : [row]) upserts.push({ table, row: r });
        return fakeWrite(error);
      },
      delete() {
        return fakeWrite(writeError(table));
      },
      update(patch: Row) {
        const filters: Record<string, unknown> = {};
        const upd: FakeUpdate = {
          eq(col: string, val: unknown) { filters[col] = val; return upd; },
          then(onFulfilled, onRejected) {
            const error = writeError(table);
            let matched = 0;
            if (!error) {
              for (const r of tables[table] ?? []) {
                if (Object.entries(filters).every(([k, v]) => r[k] === v)) { Object.assign(r, patch); matched += 1; }
              }
              updates.push({ table, patch, filters, matched });
            }
            return Promise.resolve({ data: null, error, count: matched }).then(onFulfilled, onRejected);
          },
        };
        return upd;
      },
      then(onFulfilled, onRejected) {
        return Promise.resolve(execute()).then(onFulfilled, onRejected);
      },
    };
    return builder;
  }

  return { client: { from }, requests, upserts, updates };
}
