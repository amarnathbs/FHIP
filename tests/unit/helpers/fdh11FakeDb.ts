/**
 * A small, MUTABLE, PostgREST-shaped in-memory Supabase fake for the WP-12
 * (FDH-11 -> Investment Intelligence) journey tests. Rows are snake_case,
 * exactly as PostgREST returns them.
 *
 * Supports what the FDH-11 service, the investment bridge and Investment
 * Intelligence's publication service call: select / eq / neq / in / gte / lte
 * / lt / gt / is / not(col,'is',null) / or('a.eq.x,b.eq.y') / order / limit /
 * range / single / maybeSingle, insert(row|rows)[.select().single()],
 * update(patch)[.select()], upsert(row, { onConflict })[.select().single()],
 * delete(), and rpc(name, args) through a pluggable handler.
 *
 * It enforces the PostgREST 1000-row cap on any un-ranged select, and applies
 * per-table column defaults and unique keys given at construction, so a test
 * sees the same default ('not_applicable' vs 'pending') and the same 23505
 * the real database would produce.
 */
import { randomUUID } from 'node:crypto';

export type Row = Record<string, unknown>;

export interface FakeDbOptions {
  /** Column defaults applied on insert when the column is absent. */
  defaults?: Record<string, Row>;
  /** Unique keys per table: an insert colliding on one returns error 23505. */
  unique?: Record<string, string[][]>;
  /** numeric columns: a decimal string written to one is read back as a JSON number (PostgREST's numeric behaviour). */
  numeric?: Record<string, string[]>;
  /** rpc(name, args) handler. */
  rpc?: (name: string, args: Row, db: FakeDb) => { data: unknown; error: { message: string } | null };
  /** Called before each insert; return an error message to refuse it (simulates a trigger). */
  beforeInsert?: (table: string, row: Row, db: FakeDb) => string | null;
}

const CAP = 1000;

export class FakeDb {
  tables: Record<string, Row[]>;
  inserts: { table: string; rows: Row[] }[] = [];
  updates: { table: string; patch: Row; count: number }[] = [];
  rpcCalls: { name: string; args: Row }[] = [];
  constructor(seed: Record<string, Row[]> = {}, readonly options: FakeDbOptions = {}) {
    this.tables = Object.fromEntries(Object.entries(seed).map(([k, v]) => [k, v.map((r) => ({ ...r }))]));
  }
  rows(table: string): Row[] {
    if (!this.tables[table]) this.tables[table] = [];
    return this.tables[table];
  }

  get client() {
    return {
      from: (table: string) => new Query(this, table),
      rpc: async (name: string, args: Row) => {
        this.rpcCalls.push({ name, args });
        return this.options.rpc ? this.options.rpc(name, args, this) : { data: null, error: { message: `no rpc ${name}` } };
      },
    };
  }
}

type Filter = (r: Row) => boolean;
const eqv = (a: unknown, b: unknown) => (a === null || a === undefined ? b === null || b === undefined : String(a) === String(b));

class Query implements PromiseLike<{ data: unknown; error: unknown }> {
  private filters: Filter[] = [];
  private cols: string[] | null = null;
  private orders: { col: string; asc: boolean }[] = [];
  private lim: number | null = null;
  private rng: [number, number] | null = null;
  private mode: 'select' | 'insert' | 'update' | 'upsert' | 'delete' = 'select';
  private payload: Row[] = [];
  private patch: Row = {};
  private conflict: string[] = [];
  private singleMode: 'single' | 'maybe' | null = null;
  private returning = false;

  constructor(private db: FakeDb, private table: string) {}

  select(cols?: string) {
    if (this.mode !== 'select') this.returning = true;
    if (cols && cols.trim() !== '*') this.cols = cols.split(',').map((c) => c.trim()).filter(Boolean);
    return this;
  }
  eq(c: string, v: unknown) { this.filters.push((r) => eqv(r[c], v)); return this; }
  neq(c: string, v: unknown) { this.filters.push((r) => !eqv(r[c], v)); return this; }
  in(c: string, vs: unknown[]) { const s = new Set(vs.map(String)); this.filters.push((r) => r[c] !== null && r[c] !== undefined && s.has(String(r[c]))); return this; }
  gte(c: string, v: unknown) { this.filters.push((r) => String(r[c]) >= String(v)); return this; }
  lte(c: string, v: unknown) { this.filters.push((r) => String(r[c]) <= String(v)); return this; }
  gt(c: string, v: unknown) { this.filters.push((r) => String(r[c]) > String(v)); return this; }
  lt(c: string, v: unknown) { this.filters.push((r) => String(r[c]) < String(v)); return this; }
  is(c: string, v: null) { this.filters.push((r) => (r[c] ?? null) === v); return this; }
  not(c: string, op: string, v: unknown) {
    if (op === 'is' && v === null) this.filters.push((r) => r[c] !== null && r[c] !== undefined);
    return this;
  }
  or(expr: string) {
    const parts = expr.split(',').map((p) => p.split('.'));
    this.filters.push((r) => parts.some(([c, op, ...rest]) => op === 'eq' && eqv(r[c], rest.join('.'))));
    return this;
  }
  order(c: string, o?: { ascending?: boolean }) { this.orders.push({ col: c, asc: o?.ascending !== false }); return this; }
  limit(n: number) { this.lim = n; return this; }
  range(a: number, b: number) { this.rng = [a, b]; return this; }
  maybeSingle() { this.singleMode = 'maybe'; return this; }
  single() { this.singleMode = 'single'; return this; }
  insert(rows: Row | Row[]) { this.mode = 'insert'; this.payload = Array.isArray(rows) ? rows : [rows]; return this; }
  update(patch: Row) { this.mode = 'update'; this.patch = patch; return this; }
  upsert(row: Row | Row[], opts?: { onConflict?: string }) {
    this.mode = 'upsert';
    this.payload = Array.isArray(row) ? row : [row];
    this.conflict = (opts?.onConflict ?? 'id').split(',').map((s) => s.trim());
    return this;
  }
  delete() { this.mode = 'delete'; return this; }

  then<T1 = { data: unknown; error: unknown }, T2 = never>(ok?: ((v: { data: unknown; error: unknown }) => T1 | PromiseLike<T1>) | null, bad?: ((e: unknown) => T2 | PromiseLike<T2>) | null) {
    return Promise.resolve(this.execute()).then(ok, bad);
  }

  private project(rows: Row[]) {
    return this.cols ? rows.map((r) => Object.fromEntries(this.cols!.map((c) => [c, r[c] ?? null]))) : rows.map((r) => ({ ...r }));
  }
  private finish(rows: Row[]) {
    const out = this.project(rows);
    if (this.singleMode) {
      if (out.length === 0) return this.singleMode === 'single' ? { data: null, error: { message: 'no rows', code: 'PGRST116' } } : { data: null, error: null };
      if (out.length > 1) return { data: null, error: { message: 'multiple rows', code: 'PGRST116' } };
      return { data: out[0], error: null };
    }
    return { data: out, error: null };
  }
  private matches() {
    return this.db.rows(this.table).filter((r) => this.filters.every((f) => f(r)));
  }
  private coerce(row: Row): Row {
    const numeric = this.db.options.numeric?.[this.table];
    if (!numeric) return row;
    const out: Row = { ...row };
    for (const c of numeric) if (typeof out[c] === 'string' && out[c] !== '' && Number.isFinite(Number(out[c]))) out[c] = Number(out[c]);
    return out;
  }
  private withDefaults(row: Row): Row {
    const d = this.db.options.defaults?.[this.table] ?? {};
    const out: Row = { id: randomUUID(), created_at: new Date().toISOString(), ...d };
    for (const [k, v] of Object.entries(this.coerce(row))) if (v !== undefined) out[k] = v;
    return out;
  }
  private uniqueViolation(row: Row, ignore?: Row): boolean {
    for (const key of this.db.options.unique?.[this.table] ?? []) {
      if (key.some((k) => row[k] === null || row[k] === undefined)) continue;
      if (this.db.rows(this.table).some((r) => r !== ignore && key.every((k) => eqv(r[k], row[k])))) return true;
    }
    return false;
  }

  private execute(): { data: unknown; error: unknown } {
    if (this.mode === 'select') {
      let rows = this.matches();
      for (const o of [...this.orders].reverse()) {
        rows = [...rows].sort((a, b) => {
          const av = a[o.col], bv = b[o.col];
          const cmp = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av ?? '').localeCompare(String(bv ?? ''));
          return o.asc ? cmp : -cmp;
        });
      }
      if (this.rng) rows = rows.slice(this.rng[0], Math.min(this.rng[1] + 1, this.rng[0] + CAP));
      else rows = rows.slice(0, CAP);
      if (this.lim !== null) rows = rows.slice(0, this.lim);
      return this.finish(rows);
    }
    if (this.mode === 'insert') {
      const created: Row[] = [];
      for (const raw of this.payload) {
        const row = this.withDefaults(raw);
        const refused = this.db.options.beforeInsert?.(this.table, row, this.db);
        if (refused) return { data: null, error: { message: refused, code: 'P0001' } };
        if (this.uniqueViolation(row)) return { data: null, error: { message: 'duplicate key value violates unique constraint', code: '23505' } };
        created.push(row);
      }
      this.db.rows(this.table).push(...created);
      this.db.inserts.push({ table: this.table, rows: created });
      return this.returning || this.singleMode ? this.finish(created) : { data: null, error: null };
    }
    if (this.mode === 'upsert') {
      const out: Row[] = [];
      for (const raw of this.payload) {
        const existing = this.db.rows(this.table).find((r) => this.conflict.every((k) => eqv(r[k], raw[k])));
        if (existing) {
          Object.assign(existing, this.coerce(raw));
          out.push(existing);
        } else {
          const row = this.withDefaults(raw);
          const refused = this.db.options.beforeInsert?.(this.table, row, this.db);
          if (refused) return { data: null, error: { message: refused, code: 'P0001' } };
          this.db.rows(this.table).push(row);
          out.push(row);
        }
      }
      this.db.inserts.push({ table: this.table, rows: out });
      return this.returning || this.singleMode ? this.finish(out) : { data: null, error: null };
    }
    if (this.mode === 'update') {
      const rows = this.matches();
      for (const r of rows) Object.assign(r, this.coerce(this.patch));
      this.db.updates.push({ table: this.table, patch: this.patch, count: rows.length });
      return this.returning || this.singleMode ? this.finish(rows) : { data: null, error: null };
    }
    const doomed = new Set(this.matches());
    this.db.tables[this.table] = this.db.rows(this.table).filter((r) => !doomed.has(r));
    return { data: null, error: null };
  }
}

