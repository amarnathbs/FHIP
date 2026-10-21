/**
 * A supabase-js-shaped client over a REAL Postgres (PGlite) that has this repository's whole migration chain applied.
 *
 * Why: the in-memory fake proves the job's LOGIC; this proves it against the real schema: CHECK constraints, NOT NULL columns, the
 * unique index of migration 0311, the lease functions of 0310 (called through `rpc`), foreign keys and every trigger the importers
 * hit (country gate, R7 authoritative-column blocks, cross-tenant guards). It implements only the PostgREST subset the importer
 * uses (select / insert / upsert / update / delete with eq, neq, lt, lte, gt, gte, is, not-is, in, order, range, limit, single,
 * maybeSingle, head counts, and rpc) and THROWS on anything else, so an unsupported call can never pass silently.
 *
 * Rows come back as `to_jsonb` objects (ISO strings, JSON numbers), exactly the shape PostgREST returns.
 * Everything runs as the superuser with `service_role` claims, i.e. as the service-role client the worker is.
 */
import type { PGlite } from '@electric-sql/pglite';

type Json = Record<string, unknown>;
type Filter = { col: string; op: string; val?: unknown };

const IDENT = /^[a-z_][a-z0-9_]*$/;
const id = (s: string) => {
  if (!IDENT.test(s)) throw new Error(`pglite client: unsafe identifier ${s}`);
  return `"${s}"`;
};

class Builder implements PromiseLike<{ data: unknown; error: { message: string; code?: string } | null; count?: number | null }> {
  private op: 'select' | 'insert' | 'update' | 'delete' | 'upsert' = 'select';
  private cols = '*';
  private filters: Filter[] = [];
  private orders: Array<{ col: string; asc: boolean }> = [];
  private limitN: number | null = null;
  private rangeFrom: number | null = null;
  private rangeTo: number | null = null;
  private payload: Json | Json[] | null = null;
  private conflict: string[] = [];
  private ignoreDup = false;
  private returning = false;
  private mode: 'single' | 'maybe' | null = null;
  private head = false;
  private wantCount = false;

  constructor(private readonly db: PGlite, private readonly table: string) {}

  select(cols = '*', opts?: { count?: string; head?: boolean }) {
    if (this.op === 'select') this.cols = cols;
    else this.returning = true;
    if (opts?.count) this.wantCount = true;
    if (opts?.head) this.head = true;
    if (this.op !== 'select') this.cols = cols;
    return this;
  }
  insert(rows: Json | Json[]) { this.op = 'insert'; this.payload = rows; return this; }
  upsert(rows: Json | Json[], o?: { onConflict?: string; ignoreDuplicates?: boolean }) { this.op = 'upsert'; this.payload = rows; this.conflict = (o?.onConflict ?? '').split(',').map((s) => s.trim()).filter(Boolean); this.ignoreDup = o?.ignoreDuplicates === true; return this; }
  update(patch: Json) { this.op = 'update'; this.payload = patch; return this; }
  delete() { this.op = 'delete'; return this; }
  eq(col: string, val: unknown) { this.filters.push({ col, op: '=', val }); return this; }
  neq(col: string, val: unknown) { this.filters.push({ col, op: '<>', val }); return this; }
  lt(col: string, val: unknown) { this.filters.push({ col, op: '<', val }); return this; }
  lte(col: string, val: unknown) { this.filters.push({ col, op: '<=', val }); return this; }
  gt(col: string, val: unknown) { this.filters.push({ col, op: '>', val }); return this; }
  gte(col: string, val: unknown) { this.filters.push({ col, op: '>=', val }); return this; }
  is(col: string, val: null | boolean) { this.filters.push({ col, op: val === null ? 'is null' : val ? 'is true' : 'is false' }); return this; }
  not(col: string, op: string, val: unknown) {
    if (op === 'is' && val === null) this.filters.push({ col, op: 'is not null' });
    else if (op === 'in') throw new Error('pglite client: not(in) is not supported');
    else throw new Error(`pglite client: unsupported not(${op})`);
    return this;
  }
  in(col: string, vals: unknown[]) { this.filters.push({ col, op: 'in', val: vals }); return this; }
  order(col: string, o?: { ascending?: boolean; nullsFirst?: boolean }) { this.orders.push({ col, asc: o?.ascending !== false }); return this; }
  limit(n: number) { this.limitN = n; return this; }
  range(a: number, b: number) { this.rangeFrom = a; this.rangeTo = b; return this; }
  returns() { return this; }
  maybeSingle() { this.mode = 'maybe'; return this; }
  // supabase-js: `.single()` on zero rows is an error.
  single() { this.mode = 'single'; return this; }

  private where(params: unknown[]): string {
    if (this.filters.length === 0) return '';
    const parts = this.filters.map((f) => {
      const c = `${id(this.table)}.${id(f.col)}`;
      if (f.op === 'in') {
        params.push(f.val);
        return `${c} = any($${params.length})`;
      }
      if (f.op.startsWith('is')) return `${c} ${f.op}`;
      params.push(f.val);
      return `${c} ${f.op} $${params.length}`;
    });
    return ` where ${parts.join(' and ')}`;
  }

  private projection(): string {
    if (this.cols === '*') return '*';
    return this.cols.split(',').map((c) => id(c.trim())).join(', ');
  }

  private async run(): Promise<{ data: unknown; error: { message: string; code?: string } | null; count?: number | null }> {
    const params: unknown[] = [];
    let sql: string;
    const rowsOf = Array.isArray(this.payload) ? this.payload : this.payload ? [this.payload] : [];
    const t = id(this.table);
    switch (this.op) {
      case 'select': {
        const order = this.orders.length ? ` order by ${this.orders.map((o) => `${id(o.col)} ${o.asc ? 'asc' : 'desc'}`).join(', ')}` : '';
        let lim = '';
        if (this.rangeFrom !== null && this.rangeTo !== null) lim = ` limit ${this.rangeTo - this.rangeFrom + 1} offset ${this.rangeFrom}`;
        else if (this.limitN !== null) lim = ` limit ${this.limitN}`;
        const where = this.where(params);
        if (this.head) sql = `select count(*)::int as c from ${t}${where}`;
        else sql = `select to_jsonb(q) as j from (select ${this.projection()} from ${t}${where}${order}${lim}) q`;
        break;
      }
      case 'insert':
      case 'upsert': {
        if (rowsOf.length === 0) return { data: this.returning ? [] : null, error: null };
        const cols = [...new Set(rowsOf.flatMap((r) => Object.keys(r)))];
        const colList = cols.map(id).join(', ');
        params.push(JSON.stringify(rowsOf));
        let tail = '';
        if (this.op === 'upsert') {
          const conflictCols = this.conflict.map(id).join(', ');
          const upd = cols.filter((c) => !this.conflict.includes(c)).map((c) => `${id(c)} = excluded.${id(c)}`).join(', ');
          tail = this.ignoreDup || !upd ? ` on conflict (${conflictCols}) do nothing` : ` on conflict (${conflictCols}) do update set ${upd}`;
        }
        // jsonb_populate_recordset types every value by the column it lands in (uuid, numeric, date, jsonb ...).
        sql = `insert into ${t} (${colList}) select ${colList} from jsonb_populate_recordset(null::${t}, $1::jsonb)${tail} returning to_jsonb(${t}.*) as j`;
        break;
      }
      case 'update': {
        const patch = (this.payload ?? {}) as Json;
        const cols = Object.keys(patch);
        if (cols.length === 0) return { data: [], error: null };
        params.push(JSON.stringify(patch));
        const sets = cols.map((c) => `${id(c)} = r.${id(c)}`).join(', ');
        const where = this.where(params);
        sql = `update ${t} set ${sets} from jsonb_populate_record(null::${t}, $1::jsonb) r${where} returning to_jsonb(${t}.*) as j`;
        break;
      }
      case 'delete': {
        const where = this.where(params);
        sql = `delete from ${t}${where} returning to_jsonb(${t}.*) as j`;
        break;
      }
    }
    try {
      const res = await this.db.query<{ j?: unknown; c?: number }>(sql, params);
      if (this.head) return { data: null, error: null, count: res.rows[0]?.c ?? 0 };
      const rows = res.rows.map((r) => r.j as Json);
      const count = this.wantCount ? rows.length : undefined;
      if (this.op !== 'select' && !this.returning) return { data: null, error: null, count };
      if (this.mode === 'maybe') return { data: rows[0] ?? null, error: null, count };
      if (this.mode === 'single') {
        return rows.length === 1 ? { data: rows[0], error: null, count } : { data: null, error: { message: `expected one row, got ${rows.length}` }, count };
      }
      return { data: rows, error: null, count };
    } catch (e) {
      const err = e as Error & { code?: string };
      return { data: null, error: { message: err.message, code: err.code } };
    }
  }

  then<T1 = unknown, T2 = never>(
    resolve?: ((v: { data: unknown; error: { message: string; code?: string } | null; count?: number | null }) => T1 | PromiseLike<T1>) | null,
    reject?: ((e: unknown) => T2 | PromiseLike<T2>) | null,
  ): PromiseLike<T1 | T2> {
    return this.run().then(resolve, reject);
  }
}

export interface PgliteSupabase {
  from(table: string): Builder;
  rpc(name: string, args?: Json): Promise<{ data: unknown; error: { message: string; code?: string } | null }>;
  storage: never;
}

export function pgliteSupabase(db: PGlite): PgliteSupabase {
  const client = {
    from(table: string) {
      return new Builder(db, table);
    },
    async rpc(name: string, args: Json = {}) {
      if (!IDENT.test(name)) throw new Error(`pglite client: unsafe function name ${name}`);
      const keys = Object.keys(args);
      const sql = `select to_jsonb(r) as j from ${name}(${keys.map((k, i) => `${id(k)} := $${i + 1}`).join(', ')}) r`;
      try {
        const res = await db.query<{ j: Json }>(sql, keys.map((k) => args[k]));
        const rows = res.rows.map((r) => r.j);
        // A scalar function (e.g. the heartbeat) comes back as {"<name>": value}.
        if (rows.length === 1 && (rows[0] === null || typeof rows[0] !== 'object')) return { data: rows[0], error: null };
        if (rows.length === 1 && Object.keys(rows[0]).length === 1 && name in rows[0]) return { data: rows[0][name], error: null };
        return { data: rows, error: null };
      } catch (e) {
        const err = e as Error & { code?: string };
        return { data: null, error: { message: err.message, code: err.code } };
      }
    },
  };
  return client as unknown as PgliteSupabase;
}
