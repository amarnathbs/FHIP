/**
 * A tiny in-memory Supabase client for service-level tests: select / eq / neq
 * / in / order / limit / maybeSingle / single / update / insert / delete, and
 * a thenable chain. Filters are applied for real, so a query that forgets its
 * `user_id` or `document_type` scope returns the wrong rows here too. Every
 * write is recorded, so a test can prove that nothing was written.
 *
 * Generalised from the payslip re-upload suite's inline fake (2026-09-25).
 */

import { migrationSchema } from './migrationSchema';
import { selectColumns } from './supabaseUsage';

export type Row = Record<string, unknown>;

export interface InMemoryDbOptions {
  /**
   * STRICT mode: the table and every column named in select / filter / order / insert / update / upsert must exist in the real database
   * shape derived from supabase/migrations, otherwise the call throws (as PostgREST would answer "column x.y does not exist"); an
   * explicit select list also PROJECTS the rows, so code that reads a column it did not select sees undefined here, as it does for real.
   * A fake that accepts any column let `ii_prices_nav.provider` reach DEV unnoticed. Used by every NAV2 suite.
   */
  strictSchema?: boolean;
}

export interface InMemoryDb {
  tables: Record<string, Row[]>;
  writes: Array<{ table: string; kind: 'update' | 'insert' | 'delete'; payload: unknown }>;
  reads: string[];
  client: { from: (table: string) => unknown };
  reset: (tables: Record<string, Row[]>) => void;
}

export function createInMemoryDb(options: InMemoryDbOptions = {}): InMemoryDb {
  const strict = options.strictSchema === true;
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
    const shape = strict ? migrationSchema().tables.get(table.replace(/^public\./, '')) : undefined;
    if (strict && !shape) throw new Error(`strict schema: table "${table}" is not created by any migration`);
    const need = (cols: string[], what: string) => {
      if (!strict || !shape || shape.open) return;
      for (const c of cols) if (!shape.columns.has(c.toLowerCase())) throw new Error(`strict schema: column ${table}.${c} does not exist (${what})`);
    };
    let projection: string[] | null = null;
    const filters: Array<(r: Row) => boolean> = [];
    let orderBy: { col: string; asc: boolean } | null = null;
    let limitN: number | null = null;
    let rangeFrom: number | null = null;
    let rangeTo: number | null = null;
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
      if (rangeFrom !== null && rangeTo !== null) rows = rows.slice(rangeFrom, rangeTo + 1);
      if (!patch && !deleting && projection) {
        const cols = projection;
        db.reads.push(table);
        return rows.map((r) => Object.fromEntries(cols.filter((c) => c in r).map((c) => [c, r[c]])));
      }
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
      select: (list?: string) => {
        if (strict && typeof list === 'string') {
          const cols = selectColumns(list);
          need(cols, 'select');
          if (!list.includes('*') && !list.includes('(') && cols.length > 0) projection = cols;
        }
        return chain;
      },
      update: (p: Row) => { need(Object.keys(p), 'update'); patch = p; return chain; },
      insert: (r: Row | Row[]) => { for (const x of Array.isArray(r) ? r : [r]) need(Object.keys(x), 'insert'); inserted = (Array.isArray(r) ? r : [r]).map((x) => ({ id: `ins-${Math.random().toString(36).slice(2, 10)}`, ...x })); return chain; },
      // .upsert(rows, { onConflict, ignoreDuplicates }) -- insert-if-absent on one key column (NAV2 result cache).
      upsert: (r: Row | Row[], o?: { onConflict?: string; ignoreDuplicates?: boolean }) => {
        const key = o?.onConflict;
        for (const x of Array.isArray(r) ? r : [r]) need(Object.keys(x), 'upsert');
        if (key) need(key.split(',').map((c) => c.trim()), 'onConflict');
        inserted = (Array.isArray(r) ? r : [r]).filter((x) => !key || !(db.tables[table] ?? []).some((e) => e[key] === x[key])).map((x) => ({ id: `ins-${Math.random().toString(36).slice(2, 10)}`, ...x }));
        return chain;
      },
      delete: () => { deleting = true; return chain; },
      eq: (c: string, v: unknown) => { need([c], 'eq'); filters.push((r) => r[c] === v); return chain; },
      neq: (c: string, v: unknown) => { need([c], 'neq'); filters.push((r) => r[c] !== v); return chain; },
      // .not(col, 'is', null) -- IS NOT NULL (added at the stage-3 consolidation: econ D2's
      // loadAppliedAsOfByLiability uses it; the fake threw, and the liability proposal route answered 500).
      not: (c: string, op: string, v: unknown) => { need([c], 'not'); filters.push((r) => (op === 'is' ? (v === null ? r[c] !== null && r[c] !== undefined : r[c] !== v) : r[c] !== v)); return chain; },
      in: (c: string, vs: unknown[]) => { need([c], 'in'); filters.push((r) => vs.includes(r[c])); return chain; },
      gte: (c: string, v: unknown) => { need([c], 'gte'); filters.push((r) => String(r[c]) >= String(v)); return chain; },
      // .lte / .lt -- string comparison, which is chronological for ISO dates (2026-10-03: investment-date NAV lookup).
      lte: (c: string, v: unknown) => { need([c], 'lte'); filters.push((r) => String(r[c]) <= String(v)); return chain; },
      lt: (c: string, v: unknown) => { need([c], 'lt'); filters.push((r) => String(r[c]) < String(v)); return chain; },
      // .is(col, null) -- IS NULL (2026-10-01, owner-change routes).
      is: (c: string, v: unknown) => { need([c], 'is'); filters.push((r) => (v === null ? r[c] === null || r[c] === undefined : r[c] === v)); return chain; },
      // .contains(jsonbCol, { k: v }) -- shallow jsonb containment (2026-10-01: the Resolutions amend route's "already amended" check).
      contains: (c: string, v: Record<string, unknown>) => {
        filters.push((r) => {
          const o = r[c] as Record<string, unknown> | null | undefined;
          return !!o && Object.entries(v).every(([k, val]) => o[k] === val);
        });
        return chain;
      },
      order: (col: string, o?: { ascending?: boolean }) => { need([col], 'order'); orderBy = { col, asc: o?.ascending !== false }; return chain; },
      limit: (n: number) => { limitN = n; return chain; },
      // .range(from, to) -- inclusive slice, as PostgREST (2026-10-01: lets fetchAllRows-based loaders run on this fake).
      range: (a: number, b: number) => { rangeFrom = a; rangeTo = b; return chain; },
      returns: () => chain,
      maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
      single: async () => ({ data: run()[0] ?? null, error: null }),
      then: (resolve: (v: { data: Row[]; error: null; count: number }) => unknown, reject?: (e: unknown) => unknown) => {
        try {
          const data = run();
          // `count` mirrors { count: 'exact' } (rows returned) -- added for the NAV2 loader's head counts.
          return Promise.resolve(resolve({ data, error: null, count: data.length }));
        } catch (e) {
          return reject ? reject(e) : Promise.reject(e);
        }
      },
    };
    return chain;
  }

  return db;
}
