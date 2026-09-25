// A small in-memory PostgREST stand-in for the PC6 ingest job tests.
//
// What it models, because the tests depend on it:
//   * PostgREST's db-max-rows: any read without an explicit range, and any
//     RPC result, is silently capped at 1000 rows (as in production);
//   * .range() paging for fetchAllRows();
//   * ii_prices_nav's UNIQUE (instrument_id, price_date), with upsert
//     ignoreDuplicates skipping existing keys;
//   * ii_reference_import_batches' CHECK constraints (status domain,
//     failed => error_code, terminal => finished_at) -- a violating write is
//     REJECTED, exactly as Postgres would, so a job that writes an invalid
//     terminal state is caught by the batch staying 'running';
//   * public.ii_prices_nav_existing_pairs (migration 0204): unequal arrays
//     raise, a join on the exact pairs, and the 1000-row cap;
//   * a virtual clock: every request advances it by a configurable cost, so
//     time-budget behaviour is deterministic.
//
// It is NOT a general Supabase fake: only the builder methods the ingest job,
// fetchAllRows() and the scheme-master writer use are implemented.

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- rows are free-form fixtures, as in a real PostgREST response
export type Row = Record<string, any>;

export const PG_MAX_ROWS = 1000;

const BATCH_STATUSES = new Set(['running', 'succeeded', 'failed', 'rolled_back', 'skipped_kill_switch', 'skipped_source_outage']);

export interface RequestLog {
  table: string;
  verb: string;
  filters: string[];
  rows?: number;
}

let idSeq = 0;
export const fakeUuid = () => {
  idSeq++;
  const h = idSeq.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${h}`;
};

export class FakeDb {
  tables: Record<string, Row[]> = {};
  clockMs = 1_000_000;
  /** Cost in virtual ms per request, keyed `${table}:${verb}`, `rpc:${fn}`, or '*' as the default. */
  costs: Record<string, number> = {};
  log: RequestLog[] = [];
  /** Every row payload ever sent to ii_prices_nav via upsert (to prove nothing is sent twice). */
  navUpsertPayloadKeys: string[] = [];
  /** Force an RPC error (e.g. the function missing). */
  rpcError: { message: string; code?: string } | null = null;

  now = () => this.clockMs;
  advance(ms: number) { this.clockMs += ms; }
  cost(key: string) { return this.costs[key] ?? this.costs['*'] ?? 0; }

  table(name: string): Row[] {
    return (this.tables[name] ??= []);
  }

  from(table: string) {
    return new FakeQuery(this, table);
  }

  rpc(fn: string, args: Record<string, unknown>) {
    const exec = () => {
      this.advance(this.cost(`rpc:${fn}`));
      if (this.rpcError) return { data: null, error: this.rpcError };
      if (fn !== 'ii_prices_nav_existing_pairs') return { data: null, error: { message: `Could not find the function public.${fn}`, code: 'PGRST202' } };
      const ids = (args.p_instrument_ids as string[]) ?? [];
      const dates = (args.p_price_dates as string[]) ?? [];
      if (ids.length !== dates.length) return { data: null, error: { message: 'must have the same length', code: '22023' } };
      const byKey = new Map(this.table('ii_prices_nav').map((r) => [`${r.instrument_id}|${r.price_date}`, r]));
      const out: Row[] = [];
      for (let i = 0; i < ids.length; i++) {
        const r = byKey.get(`${ids[i]}|${dates[i]}`);
        if (r) out.push({ instrument_id: r.instrument_id, price_date: r.price_date, price: r.price, record_checksum: r.record_checksum, quality_status: r.quality_status });
      }
      this.log.push({ table: `rpc:${fn}`, verb: 'rpc', filters: [`pairs=${ids.length}`], rows: Math.min(out.length, PG_MAX_ROWS) });
      return { data: out.slice(0, PG_MAX_ROWS), error: null };
    };
    return Promise.resolve().then(exec);
  }

  /** Requests matching a predicate. */
  count(pred: (l: RequestLog) => boolean) {
    return this.log.filter(pred).length;
  }
}

function getPath(r: Row, col: string): unknown {
  if (col.includes('->>')) {
    const [c, k] = col.split('->>');
    const v = r[c];
    return v && typeof v === 'object' ? (v[k] ?? null) : null;
  }
  return r[col] ?? null;
}

class FakeQuery {
  private verb: 'select' | 'insert' | 'update' | 'upsert' | 'delete' = 'select';
  private filters: ((r: Row) => boolean)[] = [];
  private filterText: string[] = [];
  private orders: { col: string; asc: boolean }[] = [];
  private limitN: number | null = null;
  private rangeFT: [number, number] | null = null;
  private mode: 'many' | 'single' | 'maybeSingle' = 'many';
  private payload: Row | Row[] | null = null;
  private upsertOpts: { onConflict?: string; ignoreDuplicates?: boolean } = {};
  private returning = false;

  constructor(private db: FakeDb, private tableName: string) {}

  select() {
    if (this.verb === 'insert' || this.verb === 'update' || this.verb === 'upsert') this.returning = true;
    else this.verb = 'select';
    return this;
  }
  insert(p: Row | Row[]) { this.verb = 'insert'; this.payload = p; return this; }
  update(p: Row) { this.verb = 'update'; this.payload = p; return this; }
  upsert(p: Row[], opts: { onConflict?: string; ignoreDuplicates?: boolean } = {}) { this.verb = 'upsert'; this.payload = p; this.upsertOpts = opts; return this; }
  eq(col: string, v: unknown) { this.filters.push((r) => getPath(r, col) === v); this.filterText.push(`${col}=eq`); return this; }
  neq(col: string, v: unknown) { this.filters.push((r) => getPath(r, col) !== v); this.filterText.push(`${col}=neq`); return this; }
  in(col: string, vs: unknown[]) { const s = new Set(vs); this.filters.push((r) => s.has(getPath(r, col))); this.filterText.push(`${col}=in(${vs.length})`); return this; }
  is(col: string, v: null | boolean) { this.filters.push((r) => getPath(r, col) === v); this.filterText.push(`${col}=is.${v}`); return this; }
  not(col: string, op: string, v: unknown) {
    if (op !== 'is') throw new Error(`fake: not.${op} unsupported`);
    this.filters.push((r) => getPath(r, col) !== v); this.filterText.push(`${col}=not.is.${v}`); return this;
  }
  order(col: string, opts: { ascending?: boolean } = {}) { this.orders.push({ col, asc: opts.ascending !== false }); return this; }
  limit(n: number) { this.limitN = n; return this; }
  range(a: number, b: number) { this.rangeFT = [a, b]; return this; }
  maybeSingle() { this.mode = 'maybeSingle'; return this; }
  single() { this.mode = 'single'; return this; }

  then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) {
    return Promise.resolve().then(() => this.exec()).then(res, rej);
  }

  private matches(): Row[] {
    return this.db.table(this.tableName).filter((r) => this.filters.every((f) => f(r)));
  }

  private shape(rows: Row[], err: { message: string; code?: string } | null = null) {
    if (err) return { data: null, error: err };
    if (this.mode === 'single') return rows.length === 1 ? { data: rows[0], error: null } : { data: null, error: { message: `expected 1 row, got ${rows.length}`, code: 'PGRST116' } };
    if (this.mode === 'maybeSingle') return rows.length <= 1 ? { data: rows[0] ?? null, error: null } : { data: null, error: { message: `expected at most 1 row, got ${rows.length}`, code: 'PGRST116' } };
    return { data: rows, error: null };
  }

  private exec() {
    const db = this.db;
    // A single-row lookup (limit 1 / maybeSingle on a select) is a small
    // read whatever the table; table-level costs model PAGE reads.
    const small = this.verb === 'select' && (this.limitN === 1 || (this.mode !== 'many' && this.tableName !== 'ii_prices_nav'));
    db.advance(small ? db.cost('*') : db.cost(`${this.tableName}:${this.verb}`));
    const entry: RequestLog = { table: this.tableName, verb: this.verb, filters: this.filterText.slice() };
    db.log.push(entry);
    const t = db.table(this.tableName);

    if (this.verb === 'select') {
      let rows = this.matches();
      for (const o of [...this.orders].reverse()) {
        rows = [...rows].sort((x, y) => {
          const a = getPath(x, o.col) as string | number | null, b = getPath(y, o.col) as string | number | null;
          if (a === b) return 0;
          if (a === null) return 1;
          if (b === null) return -1;
          return (a < b ? -1 : 1) * (o.asc ? 1 : -1);
        });
      }
      if (this.rangeFT) rows = rows.slice(this.rangeFT[0], this.rangeFT[1] + 1);
      if (this.limitN !== null) rows = rows.slice(0, this.limitN);
      rows = rows.slice(0, PG_MAX_ROWS); // db-max-rows, silently
      entry.rows = rows.length;
      return this.shape(rows.map((r) => ({ ...r })));
    }

    if (this.verb === 'insert') {
      const list = Array.isArray(this.payload) ? this.payload : [this.payload as Row];
      const created = list.map((p) => this.withDefaults(p));
      for (const c of created) {
        const bad = this.violation(c);
        if (bad) return this.shape([], { message: bad, code: '23514' });
      }
      t.push(...created);
      entry.rows = created.length;
      return this.shape(this.returning ? created : []);
    }

    if (this.verb === 'upsert') {
      const list = this.payload as Row[];
      const keyOf = (r: Row) => (this.upsertOpts.onConflict ?? 'id').split(',').map((c) => r[c.trim()]).join('|');
      const existing = new Set(t.map(keyOf));
      let written = 0;
      for (const p of list) {
        if (this.tableName === 'ii_prices_nav') db.navUpsertPayloadKeys.push(`${p.instrument_id}|${p.price_date}`);
        const k = keyOf(p);
        if (existing.has(k)) {
          if (this.upsertOpts.ignoreDuplicates) continue;
          return this.shape([], { message: 'duplicate key value violates unique constraint', code: '23505' });
        }
        t.push(this.withDefaults(p));
        existing.add(k);
        written++;
      }
      entry.rows = written;
      return this.shape([]);
    }

    if (this.verb === 'update') {
      const rows = this.matches();
      for (const r of rows) {
        const bad = this.violation({ ...r, ...(this.payload as Row) });
        if (bad) return this.shape([], { message: bad, code: '23514' });
      }
      for (const r of rows) Object.assign(r, this.payload);
      entry.rows = rows.length;
      return this.shape(this.returning ? rows : []);
    }
    throw new Error(`fake: verb ${this.verb}`);
  }

  private withDefaults(p: Row): Row {
    const r: Row = { id: fakeUuid(), created_at: new Date().toISOString(), ...p };
    if (this.tableName === 'ii_reference_import_batches') {
      r.started_at ??= new Date().toISOString();
      r.finished_at ??= null;
      r.error_code ??= null;
      r.notes ??= null;
      for (const c of ['rows_read', 'rows_accepted', 'rows_rejected', 'rows_inserted', 'rows_unchanged', 'rows_superseded']) r[c] ??= 0;
    }
    if (this.tableName === 'ii_prices_nav') r.quality_status ??= 'ok';
    return r;
  }

  /** ii_reference_import_batches CHECK constraints (migration 0155). */
  private violation(r: Row): string | null {
    if (this.tableName !== 'ii_reference_import_batches') return null;
    if (!BATCH_STATUSES.has(r.status)) return `new row violates check constraint "ii_reference_import_batches_status_check" (status=${r.status})`;
    if (r.status !== 'running' && !r.finished_at) return 'new row violates check constraint "ii_reference_import_batches_terminal_has_finish"';
    if (r.status === 'failed' && !r.error_code) return 'new row violates check constraint "ii_reference_import_batches_failed_has_error"';
    return null;
  }
}

// ---------------------------------------------------------------------------
// Fixture: a synthetic NAVAll.txt (real column layout) plus the instrument
// universe and optional pre-existing NAV rows.
// ---------------------------------------------------------------------------

export interface NavFixtureOptions {
  currentSchemes: number;
  dormantSchemes: number;
  currentDate: string; // ISO
  /** Distinct old dates the dormant schemes are spread over. */
  dormantDates: number;
  /** NAV value override per scheme code (to simulate a republished correction). */
  navOverride?: Map<string, string>;
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const amfiDate = (iso: string) => `${iso.slice(8, 10)}-${MON[Number(iso.slice(5, 7)) - 1]}-${iso.slice(0, 4)}`;
export const addDaysIso = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export interface NavFixture {
  text: string;
  bytes: Uint8Array;
  schemes: { code: string; navDate: string; nav: string }[];
}

export function buildNavAll(o: NavFixtureOptions): NavFixture {
  const schemes: NavFixture['schemes'] = [];
  const lines = [
    'Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;Scheme Name;Plan;Option;Net Asset Value;Date',
    ' ',
    'Open Ended Schemes(Equity Scheme - Large Cap Fund)',
    ' ',
    'Synthetic Mutual Fund',
    ' ',
  ];
  const total = o.currentSchemes + o.dormantSchemes;
  for (let i = 0; i < total; i++) {
    const code = String(300000 + i);
    const dormant = i >= o.currentSchemes;
    const navDate = dormant ? addDaysIso('2016-01-04', ((i - o.currentSchemes) % o.dormantDates) * 17) : o.currentDate;
    const nav = o.navOverride?.get(code) ?? `${(10 + (i % 900) + i / 10000).toFixed(4)}`;
    schemes.push({ code, navDate, nav });
    lines.push(`${code};-;-;PC6 Synthetic Large Cap Fund Number ${i} - A Long Descriptive Scheme Name;Direct Plan;Growth Option;${nav};${amfiDate(navDate)}`);
  }
  const text = lines.join('\n') + '\n';
  return { text, bytes: new TextEncoder().encode(text), schemes };
}

/** Instruments + active AMFI-code identifiers for the first `resolvable` schemes. */
export function seedUniverse(db: FakeDb, fx: NavFixture, resolvable = fx.schemes.length): Map<string, string> {
  const byCode = new Map<string, string>();
  fx.schemes.slice(0, resolvable).forEach((s) => {
    const id = fakeUuid();
    byCode.set(s.code, id);
    db.table('ii_instruments').push({ id, isin: null, instrument_class: 'mutual_fund', created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-01T00:00:00.000Z' });
    db.table('ii_instrument_identifiers').push({ id: fakeUuid(), instrument_id: id, identifier_scheme: 'amfi_scheme_code', identifier_value: s.code, country_code: 'IN', is_active: true, created_at: '2026-09-01T00:00:00.000Z' });
  });
  return byCode;
}

export function seedJobControl(db: FakeDb, jobKey: string, over: Row = {}) {
  db.table('ii_reference_job_control').push({
    job_key: jobKey, enabled: true, disabled_reason: null, consecutive_failures: 0,
    next_attempt_not_before: null, last_success_at: '2026-09-20T11:24:15.010Z', last_success_batch_id: null,
    last_failure_at: null, updated_at: '2026-09-20T11:24:15.010Z', ...over,
  });
}
