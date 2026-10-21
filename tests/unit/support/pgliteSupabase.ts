/**
 * A Supabase-client-shaped query builder over PGlite (real Postgres), for service-level tests that must run the REAL
 * application code against the REAL migration chain: unique indexes, CHECK constraints, triggers and foreign keys all apply, which
 * the in-memory fake (inMemorySupabase.ts) cannot do (it cannot enforce a unique fingerprint, match on a constraint, or reject an
 * orphan row). Written for the Document2 (4) WP-H "no duplicate economics" oracle.
 *
 * Mirrors PostgREST/supabase-js behaviour where the code under test relies on it:
 *   * an error is RETURNED ({ data: null, error }), never thrown, for a database error;
 *   * `.single()` with 0 or many rows is an error, `.maybeSingle()` with many rows is an error;
 *   * `insert/update/delete/upsert` return rows only when `.select()` is chained;
 *   * numeric / int8 columns come back as JSON numbers, timestamps as ISO strings, dates as 'YYYY-MM-DD' (see `pgliteOptions`).
 * Embedded resources (`select('a, b(c)')`) are NOT supported and throw, so a test never silently reads fewer columns than the code asks for.
 */
import { PGlite } from '@electric-sql/pglite';

export const pgliteOptions = {
  parsers: {
    1700: (v: string) => Number(v), // numeric
    20: (v: string) => Number(v), // int8
    1082: (v: string) => v, // date -> 'YYYY-MM-DD'
    1184: (v: string) => new Date(v).toISOString(), // timestamptz
    1114: (v: string) => new Date(`${v.replace(' ', 'T')}Z`).toISOString(), // timestamp (treated as UTC)
  },
};

type Row = Record<string, unknown>;
type Err = { message: string; code?: string; details?: string | null; hint?: string | null };
type Result = { data: unknown; error: Err | null; count?: number | null; status?: number; statusText?: string };

const IDENT = /^[a-z_][a-z0-9_]*$/i;
const q = (name: string): string => {
  if (!IDENT.test(name)) throw new Error(`pglite supabase shim: unsupported identifier "${name}"`);
  return `"${name}"`;
};
/** `col` or `col->>key` / `col->key` */
function columnExpr(c: string): string {
  const m = /^([a-z_][a-z0-9_]*)(->>?)([a-z_][a-z0-9_]*)$/i.exec(c);
  if (m) return `${q(m[1])}${m[2]}'${m[3]}'`;
  return q(c);
}

interface Filter {
  build: (nextParam: (v: unknown) => string) => string;
}

function opSql(op: string, col: string, value: unknown, next: (v: unknown) => string): string {
  const c = columnExpr(col);
  switch (op) {
    case 'eq': return `${c} = ${next(value)}`;
    case 'neq': return `${c} <> ${next(value)}`;
    case 'gt': return `${c} > ${next(value)}`;
    case 'gte': return `${c} >= ${next(value)}`;
    case 'lt': return `${c} < ${next(value)}`;
    case 'lte': return `${c} <= ${next(value)}`;
    case 'like': return `${c} like ${next(value)}`;
    case 'ilike': return `${c} ilike ${next(value)}`;
    case 'is':
      if (value === null || value === 'null') return `${c} is null`;
      return `${c} is ${value === true || value === 'true' ? 'true' : 'false'}`;
    case 'in': {
      const list = Array.isArray(value) ? value : String(value).replace(/^\(|\)$/g, '').split(',');
      if (list.length === 0) return 'false';
      return `${c} in (${list.map((v) => next(v)).join(', ')})`;
    }
    case 'cs': return `${c} @> ${next(typeof value === 'string' ? value : JSON.stringify(value))}`;
    default: throw new Error(`pglite supabase shim: unsupported filter operator "${op}"`);
  }
}

/** Parses a PostgREST `.or()` expression: `a.eq.1,b.is.null`. Nested and()/or() are not supported (they throw). */
function parseOr(expr: string): Filter {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of expr) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += ch;
  }
  if (cur) parts.push(cur);
  return {
    build: (next) =>
      '(' + parts.map((p) => {
        const m = /^([a-z_][a-z0-9_>-]*)\.(not\.)?([a-z]+)\.(.*)$/i.exec(p.trim());
        if (!m) throw new Error(`pglite supabase shim: unsupported .or() part "${p}"`);
        const sql = opSql(m[3], m[1], m[3] === 'in' ? m[4] : m[4], next);
        return m[2] ? `not (${sql})` : sql;
      }).join(' or ') + ')',
  };
}

class Builder implements PromiseLike<Result> {
  private mode: 'select' | 'insert' | 'update' | 'delete' | 'upsert' = 'select';
  private columns = '*';
  private countMode: 'exact' | null = null;
  private head = false;
  private filters: Filter[] = [];
  private orders: string[] = [];
  private limitN: number | null = null;
  private offsetN: number | null = null;
  private payload: Row[] = [];
  private patch: Row = {};
  private onConflict: string | null = null;
  private ignoreDuplicates = false;
  private returning = false;
  private singleMode: 'single' | 'maybe' | null = null;

  constructor(private readonly db: PGlite, private readonly table: string, private readonly log: string[]) {}

  select(columns = '*', opts?: { count?: 'exact' | 'planned' | 'estimated'; head?: boolean }) {
    if (columns.includes('(')) throw new Error(`pglite supabase shim: embedded resources are not supported ("${columns}")`);
    if (this.mode !== 'select') this.returning = true;
    this.columns = columns;
    if (opts?.count) this.countMode = 'exact';
    if (opts?.head) this.head = true;
    return this;
  }
  insert(rows: Row | Row[]) { this.mode = 'insert'; this.payload = Array.isArray(rows) ? rows : [rows]; return this; }
  upsert(rows: Row | Row[], opts?: { onConflict?: string; ignoreDuplicates?: boolean }) {
    this.mode = 'upsert';
    this.payload = Array.isArray(rows) ? rows : [rows];
    this.onConflict = opts?.onConflict ?? null;
    this.ignoreDuplicates = opts?.ignoreDuplicates === true;
    return this;
  }
  update(patch: Row) { this.mode = 'update'; this.patch = patch; return this; }
  delete() { this.mode = 'delete'; return this; }

  private add(op: string, col: string, value: unknown) { this.filters.push({ build: (n) => opSql(op, col, value, n) }); return this; }
  eq(c: string, v: unknown) { return this.add('eq', c, v); }
  neq(c: string, v: unknown) { return this.add('neq', c, v); }
  gt(c: string, v: unknown) { return this.add('gt', c, v); }
  gte(c: string, v: unknown) { return this.add('gte', c, v); }
  lt(c: string, v: unknown) { return this.add('lt', c, v); }
  lte(c: string, v: unknown) { return this.add('lte', c, v); }
  like(c: string, v: unknown) { return this.add('like', c, v); }
  ilike(c: string, v: unknown) { return this.add('ilike', c, v); }
  is(c: string, v: unknown) { return this.add('is', c, v); }
  in(c: string, v: unknown[]) { return this.add('in', c, v); }
  not(c: string, op: string, v: unknown) {
    this.filters.push({ build: (n) => `not (${opSql(op, c, v, n)})` });
    return this;
  }
  or(expr: string) { this.filters.push(parseOr(expr)); return this; }
  contains(c: string, v: unknown) {
    this.filters.push({ build: (n) => `${q(c)} @> ${n(JSON.stringify(v))}::jsonb` });
    return this;
  }
  match(o: Row) { for (const [k, v] of Object.entries(o)) this.eq(k, v); return this; }
  order(col: string, o?: { ascending?: boolean; nullsFirst?: boolean }) {
    this.orders.push(`${columnExpr(col)} ${o?.ascending === false ? 'desc' : 'asc'}${o?.nullsFirst === true ? ' nulls first' : o?.nullsFirst === false ? ' nulls last' : ''}`);
    return this;
  }
  limit(n: number) { this.limitN = n; return this; }
  range(from: number, to: number) { this.offsetN = from; this.limitN = to - from + 1; return this; }
  returns() { return this; }
  single(): PromiseLike<Result> { this.singleMode = 'single'; return this; }
  maybeSingle(): PromiseLike<Result> { this.singleMode = 'maybe'; return this; }

  private async run(): Promise<Result> {
    try {
      const params: unknown[] = [];
      const next = (v: unknown) => { params.push(v); return `$${params.length}`; };
      const where = () => (this.filters.length ? ` where ${this.filters.map((f) => f.build(next)).join(' and ')}` : '');
      const t = q(this.table);
      let sql: string;
      const ret = this.returning ? ` returning ${this.columns === '*' ? '*' : this.columns.split(',').map((c) => columnExpr(c.trim())).join(', ')}` : '';

      if (this.mode === 'select') {
        const cols = this.columns === '*' ? '*' : this.columns.split(',').map((c) => columnExpr(c.trim())).join(', ');
        let tail = '';
        if (this.orders.length) tail += ` order by ${this.orders.join(', ')}`;
        if (this.limitN !== null) tail += ` limit ${this.limitN}`;
        if (this.offsetN !== null) tail += ` offset ${this.offsetN}`;
        let count: number | null = null;
        if (this.countMode) {
          const cparams: unknown[] = [];
          const cnext = (v: unknown) => { cparams.push(v); return `$${cparams.length}`; };
          const cwhere = this.filters.length ? ` where ${this.filters.map((f) => f.build(cnext)).join(' and ')}` : '';
          count = Number((await this.db.query<{ n: string }>(`select count(*)::text as n from ${t}${cwhere}`, cparams)).rows[0].n);
          if (this.head) return { data: null, error: null, count };
        }
        sql = `select ${cols} from ${t}${where()}${tail}`;
        this.log.push(sql);
        const rows = (await this.db.query<Row>(sql, params)).rows;
        return this.shape(rows, count);
      }

      if (this.mode === 'insert' || this.mode === 'upsert') {
        if (this.payload.length === 0) return { data: this.returning ? [] : null, error: null };
        const colSet = [...new Set(this.payload.flatMap((r) => Object.keys(r).filter((k) => r[k] !== undefined)))];
        const values = this.payload.map((r) => '(' + colSet.map((c) => (r[c] === undefined ? 'default' : next(r[c]))).join(', ') + ')').join(', ');
        let conflict = '';
        if (this.mode === 'upsert') {
          const target = (this.onConflict ?? 'id').split(',').map((c) => q(c.trim())).join(', ');
          const sets = colSet.filter((c) => !(this.onConflict ?? 'id').split(',').map((x) => x.trim()).includes(c));
          conflict = this.ignoreDuplicates || sets.length === 0 ? ` on conflict (${target}) do nothing` : ` on conflict (${target}) do update set ${sets.map((c) => `${q(c)} = excluded.${q(c)}`).join(', ')}`;
        }
        sql = `insert into ${t} (${colSet.map(q).join(', ')}) values ${values}${conflict}${ret}`;
      } else if (this.mode === 'update') {
        const keys = Object.keys(this.patch).filter((k) => this.patch[k] !== undefined);
        if (keys.length === 0) return { data: null, error: null };
        const sets = keys.map((k) => `${q(k)} = ${next(this.patch[k])}`).join(', ');
        sql = `update ${t} set ${sets}${where()}${ret}`;
      } else {
        sql = `delete from ${t}${where()}${ret}`;
      }
      this.log.push(sql);
      const res = await this.db.query<Row>(sql, params);
      return this.returning ? this.shape(res.rows, null) : { data: null, error: null };
    } catch (e) {
      const err = e as { message?: string; code?: string; detail?: string; hint?: string };
      return { data: null, error: { message: err.message ?? String(e), code: err.code, details: err.detail ?? null, hint: err.hint ?? null } };
    }
  }

  private shape(rows: Row[], count: number | null): Result {
    if (this.singleMode === 'single') {
      if (rows.length !== 1) return { data: null, error: { message: 'JSON object requested, multiple (or no) rows returned', code: 'PGRST116', details: `The result contains ${rows.length} rows` }, count };
      return { data: rows[0], error: null, count };
    }
    if (this.singleMode === 'maybe') {
      if (rows.length > 1) return { data: null, error: { message: 'JSON object requested, multiple (or no) rows returned', code: 'PGRST116', details: `The result contains ${rows.length} rows` }, count };
      return { data: rows[0] ?? null, error: null, count };
    }
    return { data: rows, error: null, count };
  }

  then<R1 = Result, R2 = never>(onfulfilled?: ((value: Result) => R1 | PromiseLike<R1>) | null, onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null): PromiseLike<R1 | R2> {
    return this.run().then(onfulfilled, onrejected);
  }
}

export interface PgliteSupabase {
  from: (table: string) => Builder;
  rpc: (fn: string, args?: Row) => PromiseLike<Result>;
  /** Every SQL statement the code under test issued (for assertions about what was NOT written). */
  log: string[];
}

export function createPgliteSupabase(db: PGlite): PgliteSupabase {
  const log: string[] = [];
  return {
    log,
    from: (table: string) => new Builder(db, table, log),
    rpc: (fn: string, args: Row = {}) => {
      const run = async (): Promise<Result> => {
        try {
          const names = Object.keys(args);
          const sql = `select * from ${q(fn)}(${names.map((n, i) => `${q(n)} => $${i + 1}`).join(', ')})`;
          log.push(sql);
          const rows = (await db.query<Row>(sql, names.map((n) => args[n]))).rows;
          const unwrapped = rows.length === 1 && Object.keys(rows[0]).length === 1 && fn in rows[0] ? rows[0][fn] : rows;
          return { data: unwrapped, error: null };
        } catch (e) {
          return { data: null, error: { message: (e as Error).message } };
        }
      };
      return { then: (a, b) => run().then(a, b) } as PromiseLike<Result>;
    },
  };
}
