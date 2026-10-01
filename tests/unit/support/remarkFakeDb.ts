// A filtering, call-counting Supabase double for the Net Worth NAV re-mark
// tests. Unlike the shared fakeSupabaseClient (whose gte/lte are no-ops), every
// filter the re-mark service uses is honoured: eq / neq / in / is / gte / lte /
// not(col,'is',null) / order / range, plus update-then-select(returning rows).
//
// It records every table read and every write so tests can prove "no N+1" and
// "never inserts into investments", and it can be told to IGNORE specific
// filters (`ignoreFilters`) so a test can build a deliberately broken
// environment and show the assertion that guards the rule really fails.

export type Row = Record<string, unknown>;

export interface FakeDbOptions {
  /** Columns whose eq/is/in/neq filters are silently dropped (models a missing guard in the code under test). */
  ignoreFilters?: readonly string[];
  /** Tables whose read fails with this error. */
  failRead?: Record<string, { message: string; code?: string }>;
  /** Fail every UPDATE on `investments` with this error (e.g. the read-only AI-context client). */
  failUpdate?: { message: string; code?: string };
  /** Runs just before an update is applied: lets a test simulate a concurrent writer. */
  onBeforeUpdate?: (table: string, rows: Row[]) => void;
}

export interface FakeDb {
  client: { from(table: string): unknown };
  tables: Record<string, Row[]>;
  /** One entry per `from(table)` call, in order. */
  reads: string[];
  updates: Array<{ table: string; id: unknown; payload: Row }>;
  inserts: Array<{ table: string; row: Row }>;
}

export function makeFakeDb(tables: Record<string, Row[]>, opts: FakeDbOptions = {}): FakeDb {
  const db: FakeDb = { client: { from: () => null }, tables, reads: [], updates: [], inserts: [] };
  const ignored = new Set(opts.ignoreFilters ?? []);

  function builderFor(table: string) {
    db.reads.push(table);
    // Filters are recorded and evaluated LAZILY against the live table, so a
    // concurrent writer (onBeforeUpdate) is visible to an UPDATE's guard.
    const filters: Array<{ col: string; fn: (r: Row) => boolean }> = [];
    const order: Array<{ col: string; asc: boolean }> = [];
    let pendingUpdate: Row | null = null;
    let returning = false;
    const fail = opts.failRead?.[table];

    const live = () => (tables[table] ?? []).filter((r) => filters.every((f) => ignored.has(f.col) || f.fn(r)));
    const sorted = () => {
      const out = [...live()];
      for (let i = order.length - 1; i >= 0; i--) {
        const { col, asc } = order[i];
        out.sort((a, b) => {
          const av = a[col] as string | number;
          const bv = b[col] as string | number;
          if (av < bv) return asc ? -1 : 1;
          if (av > bv) return asc ? 1 : -1;
          return 0;
        });
      }
      return out;
    };
    const add = (col: string, fn: (r: Row) => boolean) => {
      filters.push({ col, fn });
    };

    const b: Record<string, unknown> = {
      select() {
        returning = true;
        return b;
      },
      eq(col: string, val: unknown) {
        add(col, (r) => r[col] === val);
        return b;
      },
      neq(col: string, val: unknown) {
        add(col, (r) => r[col] !== val);
        return b;
      },
      in(col: string, vals: unknown[]) {
        const set = new Set(vals);
        add(col, (r) => set.has(r[col]));
        return b;
      },
      is(col: string, val: unknown) {
        add(col, (r) => (val === null ? r[col] === null || r[col] === undefined : r[col] === val));
        return b;
      },
      not(col: string, op: string, val: unknown) {
        if (op === 'is' && val === null) add(col, (r) => r[col] !== null && r[col] !== undefined);
        return b;
      },
      gte(col: string, val: string) {
        add(col, (r) => (r[col] as string) >= val);
        return b;
      },
      lte(col: string, val: string) {
        add(col, (r) => (r[col] as string) <= val);
        return b;
      },
      order(col: string, o?: { ascending?: boolean }) {
        order.push({ col, asc: o?.ascending !== false });
        return b;
      },
      range(from: number, to: number) {
        if (fail) return Promise.resolve({ data: null, error: fail });
        return Promise.resolve({ data: sorted().slice(from, to + 1), error: null });
      },
      update(payload: Row) {
        pendingUpdate = payload;
        returning = false;
        return b;
      },
      insert(row: Row) {
        db.inserts.push({ table, row });
        (tables[table] ??= []).push(row);
        return Promise.resolve({ data: null, error: null });
      },
      then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
        if (pendingUpdate) {
          if (opts.failUpdate && table === 'investments') return Promise.resolve({ data: null, error: opts.failUpdate }).then(resolve, reject);
          opts.onBeforeUpdate?.(table, tables[table] ?? []);
          const target = live();
          for (const r of target) {
            Object.assign(r, pendingUpdate);
            db.updates.push({ table, id: r.id, payload: pendingUpdate });
          }
          return Promise.resolve({ data: returning ? target.map((r) => ({ id: r.id })) : null, error: null }).then(resolve, reject);
        }
        if (fail) return Promise.resolve({ data: null, error: fail }).then(resolve, reject);
        return Promise.resolve({ data: sorted(), error: null }).then(resolve, reject);
      },
    };
    return b;
  }

  db.client = { from: (t: string) => builderFor(t) };
  return db;
}
