/**
 * A tiny in-memory Supabase client for service-level tests: select / eq / neq
 * / in / order / limit / maybeSingle / single / update / insert / delete, and
 * a thenable chain. Filters are applied for real, so a query that forgets its
 * `user_id` or `document_type` scope returns the wrong rows here too. Every
 * write is recorded, so a test can prove that nothing was written.
 *
 * Generalised from the payslip re-upload suite's inline fake (2026-09-25).
 */

export type Row = Record<string, unknown>;

export interface InMemoryDb {
  tables: Record<string, Row[]>;
  writes: Array<{ table: string; kind: 'update' | 'insert' | 'delete'; payload: unknown }>;
  reads: string[];
  client: { from: (table: string) => unknown };
  reset: (tables: Record<string, Row[]>) => void;
}

export function createInMemoryDb(): InMemoryDb {
  const db: InMemoryDb = {
    tables: {},
    writes: [],
    reads: [],
    client: { from: (t: string) => query(t) },
    reset(tables) {
      db.tables = tables;
      db.writes.length = 0;
      db.reads.length = 0;
    },
  };

  function query(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let orderBy: { col: string; asc: boolean } | null = null;
    let limitN: number | null = null;
    let patch: Row | null = null;
    let inserted: Row[] | null = null;
    let deleting = false;
    const run = (): Row[] => {
      if (inserted) {
        db.tables[table] = [...(db.tables[table] ?? []), ...inserted];
        db.writes.push({ table, kind: 'insert', payload: inserted });
        return inserted;
      }
      let rows = (db.tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
      if (orderBy) {
        const { col, asc } = orderBy;
        rows = [...rows].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : String(a[col]) > String(b[col]) ? 1 : 0) * (asc ? 1 : -1));
      }
      if (limitN !== null) rows = rows.slice(0, limitN);
      if (patch) {
        db.writes.push({ table, kind: 'update', payload: patch });
        for (const r of rows) Object.assign(r, patch);
      } else if (deleting) {
        db.writes.push({ table, kind: 'delete', payload: null });
        db.tables[table] = (db.tables[table] ?? []).filter((r) => !rows.includes(r));
      } else {
        db.reads.push(table);
      }
      return rows;
    };
    const chain: Record<string, unknown> = {
      select: () => chain,
      update: (p: Row) => { patch = p; return chain; },
      insert: (r: Row | Row[]) => { inserted = (Array.isArray(r) ? r : [r]).map((x) => ({ id: `ins-${Math.random().toString(36).slice(2, 10)}`, ...x })); return chain; },
      delete: () => { deleting = true; return chain; },
      eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return chain; },
      neq: (c: string, v: unknown) => { filters.push((r) => r[c] !== v); return chain; },
      in: (c: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[c])); return chain; },
      gte: (c: string, v: unknown) => { filters.push((r) => String(r[c]) >= String(v)); return chain; },
      order: (col: string, o?: { ascending?: boolean }) => { orderBy = { col, asc: o?.ascending !== false }; return chain; },
      limit: (n: number) => { limitN = n; return chain; },
      returns: () => chain,
      maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
      single: async () => ({ data: run()[0] ?? null, error: null }),
      then: (resolve: (v: { data: Row[]; error: null }) => unknown, reject?: (e: unknown) => unknown) => {
        try {
          return Promise.resolve(resolve({ data: run(), error: null }));
        } catch (e) {
          return reject ? reject(e) : Promise.reject(e);
        }
      },
    };
    return chain;
  }

  return db;
}
