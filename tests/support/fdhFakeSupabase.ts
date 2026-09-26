/**
 * A small in-memory stand-in for the Supabase client, for FDH route tests
 * that must prove WHICH rows an action touched (not merely that a mock was
 * called). It is deliberately strict about the three database behaviours the
 * category-totals review depends on, so a test cannot pass by accident:
 *
 *  1. RLS. A "session" client sees and writes only rows whose `user_id` is
 *     its user (master tables such as fdh_categories are readable by all).
 *     The "admin" client (service role) bypasses this, exactly as in Postgres.
 *  2. The R7/R8 authoritative-field trigger (migrations 0064/0068) for the
 *     authenticated role on fdh_transactions: economic type / category /
 *     subcategory / merchant may only change when a matching
 *     fdh_transaction_corrections row exists; review_status may only move to
 *     'resolved' alongside a correction; classification_method /
 *     classification_confidence / flags may NOT be written at all. (This is
 *     why recording a user's method needs the sanctioned service-role file.)
 *  3. The FDH-7 approval guard (0076/0085): a transaction cannot move to
 *     approval_status 'approved' while `fdh7_transaction_has_blocking_issue`
 *     is true, and a statement cannot be approved while any line blocks. The
 *     same function backs the `rpc()` the service calls.
 *
 * Zero-row updates return `data: []` with no error (the real PostgREST
 * behaviour) and `.single()` on zero rows returns an error, so a service that
 * trusts a silent zero-row write is caught.
 */

type Row = Record<string, unknown>;
type Filter = (row: Row) => boolean;

const USER_SCOPED_EXEMPT = new Set(['fdh_categories', 'fdh_subcategories', 'fdh_merchants', 'fdh_merchant_aliases', 'fdh_classification_rules']);

let idCounter = 0;
export function fakeId(): string {
  idCounter += 1;
  const hex = idCounter.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${hex}`;
}

function cmp(a: unknown, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (a !== null && a !== '' && b !== '' && !Number.isNaN(na) && !Number.isNaN(nb) && typeof a !== 'boolean') return na - nb;
  const sa = String(a);
  return sa < b ? -1 : sa > b ? 1 : 0;
}

function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

function parseTerm(term: string): Filter {
  const t = term.trim();
  if (t.startsWith('and(') && t.endsWith(')')) {
    const parts = splitTopLevel(t.slice(4, -1)).map(parseTerm);
    return (r) => parts.every((p) => p(r));
  }
  if (t.startsWith('or(') && t.endsWith(')')) {
    const parts = splitTopLevel(t.slice(3, -1)).map(parseTerm);
    return (r) => parts.some((p) => p(r));
  }
  const firstDot = t.indexOf('.');
  const col = t.slice(0, firstDot);
  const rest = t.slice(firstDot + 1);
  const secondDot = rest.indexOf('.');
  const op = rest.slice(0, secondDot);
  const val = rest.slice(secondDot + 1);
  return opFilter(col, op, val);
}

function opFilter(col: string, op: string, val: string): Filter {
  switch (op) {
    case 'eq': return (r) => String(r[col]) === val;
    case 'neq': return (r) => String(r[col]) !== val;
    case 'lt': return (r) => r[col] !== null && r[col] !== undefined && cmp(r[col], val) < 0;
    case 'lte': return (r) => r[col] !== null && r[col] !== undefined && cmp(r[col], val) <= 0;
    case 'gt': return (r) => r[col] !== null && r[col] !== undefined && cmp(r[col], val) > 0;
    case 'gte': return (r) => r[col] !== null && r[col] !== undefined && cmp(r[col], val) >= 0;
    case 'is': return (r) => (val === 'null' ? r[col] === null || r[col] === undefined : String(r[col]) === val);
    case 'in': {
      const list = val.replace(/^\(|\)$/g, '').split(',');
      return (r) => list.includes(String(r[col]));
    }
    default: throw new Error(`fake supabase: unsupported filter op ${op}`);
  }
}

export interface FakeDb {
  tables: Record<string, Row[]>;
  rows(table: string): Row[];
  insert(table: string, row: Row): Row;
  sessionClient(userId: string): FakeClient;
  adminClient(): FakeClient;
  hasBlockingIssue(userId: string, transactionId: string): boolean;
}

type FakeClient = {
  from(table: string): QueryBuilder;
  rpc(fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { message: string } | null }>;
};

class QueryBuilder implements PromiseLike<{ data: unknown; error: { message: string } | null; count?: number | null }> {
  private filters: Filter[] = [];
  private mode: 'select' | 'insert' | 'update' | 'delete' = 'select';
  private payload: Row | Row[] | null = null;
  private countMode = false;
  private head = false;
  private returning = false;
  private orders: Array<{ col: string; asc: boolean }> = [];
  private rangeFrom: number | null = null;
  private rangeTo: number | null = null;
  private limitN: number | null = null;
  private singleMode: 'single' | 'maybe' | null = null;

  constructor(
    private readonly db: FakeDbImpl,
    private readonly table: string,
    private readonly role: 'authenticated' | 'service_role',
    private readonly uid: string | null,
  ) {}

  select(_cols?: string, opts?: { count?: string; head?: boolean }) {
    if (this.mode === 'select') {
      this.countMode = opts?.count === 'exact';
      this.head = Boolean(opts?.head);
    } else this.returning = true;
    return this;
  }
  insert(row: Row | Row[]) { this.mode = 'insert'; this.payload = row; return this; }
  update(patch: Row) { this.mode = 'update'; this.payload = patch; return this; }
  delete() { this.mode = 'delete'; return this; }
  eq(col: string, val: unknown) { this.filters.push((r) => String(r[col]) === String(val)); return this; }
  neq(col: string, val: unknown) { this.filters.push((r) => String(r[col]) !== String(val)); return this; }
  in(col: string, vals: readonly unknown[]) { const s = vals.map(String); this.filters.push((r) => s.includes(String(r[col]))); return this; }
  is(col: string, val: unknown) { this.filters.push((r) => (val === null ? r[col] === null || r[col] === undefined : r[col] === val)); return this; }
  not(col: string, op: string, val: unknown) { const f = opFilter(col, op, String(val)); this.filters.push((r) => !f(r)); return this; }
  lte(col: string, val: unknown) { this.filters.push(opFilter(col, 'lte', String(val))); return this; }
  gte(col: string, val: unknown) { this.filters.push(opFilter(col, 'gte', String(val))); return this; }
  lt(col: string, val: unknown) { this.filters.push(opFilter(col, 'lt', String(val))); return this; }
  or(expr: string) { const parts = splitTopLevel(expr).map(parseTerm); this.filters.push((r) => parts.some((p) => p(r))); return this; }
  order(col: string, opts?: { ascending?: boolean }) { this.orders.push({ col, asc: opts?.ascending ?? true }); return this; }
  limit(n: number) { this.limitN = n; return this; }
  range(from: number, to: number) { this.rangeFrom = from; this.rangeTo = to; return this; }
  returns() { return this; }
  single() { this.singleMode = 'single'; return this; }
  maybeSingle() { this.singleMode = 'maybe'; return this; }

  then<A = unknown, B = never>(
    onfulfilled?: ((value: { data: unknown; error: { message: string } | null; count?: number | null }) => A | PromiseLike<A>) | null,
    onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    let result: { data: unknown; error: { message: string } | null; count?: number | null };
    try {
      result = this.execute();
    } catch (e) {
      result = { data: null, error: { message: e instanceof Error ? e.message : String(e) } };
    }
    return Promise.resolve(result).then(onfulfilled, onrejected);
  }

  private visible(row: Row): boolean {
    if (this.role === 'service_role') return true;
    if (USER_SCOPED_EXEMPT.has(this.table)) return true;
    return row.user_id === this.uid;
  }

  private matching(): Row[] {
    return this.db.rows(this.table).filter((r) => this.visible(r) && this.filters.every((f) => f(r)));
  }

  private shape(rows: Row[]) {
    if (this.singleMode === 'single') {
      if (rows.length !== 1) return { data: null, error: { message: `JSON object requested, multiple (or no) rows returned (${rows.length})` } };
      return { data: { ...rows[0] }, error: null };
    }
    if (this.singleMode === 'maybe') {
      if (rows.length > 1) return { data: null, error: { message: 'multiple rows' } };
      return { data: rows[0] ? { ...rows[0] } : null, error: null };
    }
    return { data: rows.map((r) => ({ ...r })), error: null };
  }

  private execute(): { data: unknown; error: { message: string } | null; count?: number | null } {
    if (this.mode === 'select') {
      let rows = this.matching();
      for (const o of [...this.orders].reverse()) {
        rows = [...rows].sort((a, b) => (cmp(a[o.col], String(b[o.col])) * (o.asc ? 1 : -1)));
      }
      const count = rows.length;
      if (this.rangeFrom !== null) rows = rows.slice(this.rangeFrom, (this.rangeTo ?? rows.length) + 1);
      if (this.limitN !== null) rows = rows.slice(0, this.limitN);
      if (this.head) return { data: null, error: null, count };
      const shaped = this.shape(rows);
      return this.countMode ? { ...shaped, count } : shaped;
    }
    if (this.mode === 'insert') {
      const list = Array.isArray(this.payload) ? this.payload : [this.payload as Row];
      const inserted: Row[] = [];
      for (const r of list) {
        if (this.role === 'authenticated' && !USER_SCOPED_EXEMPT.has(this.table) && r.user_id !== this.uid) {
          throw new Error(`new row violates row-level security policy for table "${this.table}"`);
        }
        this.db.beforeInsert(this.table, r, this.role);
        inserted.push(this.db.insert(this.table, r));
      }
      return this.returning || this.singleMode ? this.shape(inserted) : { data: null, error: null };
    }
    if (this.mode === 'update') {
      const targets = this.matching();
      const updated: Row[] = [];
      for (const row of targets) {
        const next = { ...row, ...(this.payload as Row) };
        this.db.beforeUpdate(this.table, row, next, this.role, this.uid);
        Object.assign(row, next);
        updated.push(row);
      }
      return this.returning || this.singleMode ? this.shape(updated) : { data: null, error: null };
    }
    const targets = new Set(this.matching());
    this.db.tables[this.table] = this.db.rows(this.table).filter((r) => !targets.has(r));
    return { data: null, error: null };
  }
}

class FakeDbImpl implements FakeDb {
  tables: Record<string, Row[]> = {};

  rows(table: string): Row[] {
    this.tables[table] ??= [];
    return this.tables[table];
  }

  insert(table: string, row: Row): Row {
    const full: Row = { id: fakeId(), created_at: new Date().toISOString(), ...row };
    this.rows(table).push(full);
    return full;
  }

  beforeInsert(table: string, row: Row, role: string) {
    if (role !== 'authenticated') return;
    if (['fdh_transaction_links', 'fdh_recurring_transactions'].includes(table)) {
      throw new Error(`${table}: rows may only be created by the server`);
    }
    if (table === 'fdh_classification_history' && row.changed_by_type !== 'user') {
      throw new Error('fdh_classification_history: only changed_by_type=user rows may be inserted directly by the authenticated role');
    }
  }

  private evidenced(uid: string | null, txnId: unknown, field: string, value: unknown): boolean {
    return this.rows('fdh_transaction_corrections').some(
      (c) => c.transaction_id === txnId && c.user_id === uid && c.field_name === field && JSON.stringify(c.corrected_value) === JSON.stringify(value) && value !== null,
    );
  }

  beforeUpdate(table: string, old: Row, next: Row, role: string, uid: string | null) {
    if (table === 'fdh_transactions') {
      if (role === 'authenticated') {
        for (const f of ['economic_transaction_type', 'category_id', 'subcategory_id', 'merchant_id']) {
          if (next[f] !== old[f] && !this.evidenced(uid, old.id, f, next[f])) {
            throw new Error(`fdh_transactions: ${f} may only be changed via a recorded correction`);
          }
        }
        if (next.review_status !== old.review_status) {
          const hasCorrection = this.rows('fdh_transaction_corrections').some((c) => c.transaction_id === old.id && c.user_id === uid);
          if (next.review_status !== 'resolved' || !hasCorrection) {
            throw new Error('fdh_transactions: review_status may only move to resolved alongside a recorded correction');
          }
        }
        for (const f of ['classification_confidence', 'classification_method', 'recurring_flag', 'subscription_flag', 'transfer_flag', 'recurring_transaction_id']) {
          if (next[f] !== old[f]) throw new Error('fdh_transactions: authoritative R8 classification fields may not be written directly by the authenticated role');
        }
      }
      if (next.approval_status === 'approved' && old.approval_status !== 'approved') {
        // Evaluate against the row as it will be.
        const saved = { ...old };
        Object.assign(old, next);
        const blocked = this.hasBlockingIssue(String(old.user_id), String(old.id));
        Object.assign(old, saved);
        if (blocked) throw new Error('fdh_transactions: cannot approve a transaction with an unresolved blocking review issue');
        if (!next.approved_by) throw new Error('fdh_transactions: an approval must name the approving user');
        next.approved_at ??= new Date().toISOString();
      }
      if (old.approval_status === 'approved' && next.approval_status === 'pending') {
        next.approved_at = null;
        next.approved_by = null;
      }
    }
    if (table === 'fdh_statement_uploads' && next.approved_by && !old.approved_by) {
      if (this.statementHasBlockingIssue(String(old.user_id), String(old.id))) {
        throw new Error('fdh_statement_uploads: cannot approve a statement with unresolved blocking review issues');
      }
      next.approval_version = Number(old.approval_version ?? 0) + 1;
      next.approved_at ??= new Date().toISOString();
    }
  }

  /** Mirror of `fdh7_transaction_has_blocking_issue` (0076 as amended by 0085). */
  hasBlockingIssue(userId: string, transactionId: string): boolean {
    const t = this.rows('fdh_transactions').find((r) => r.id === transactionId && r.user_id === userId);
    const allocs = this.rows('fdh_transaction_allocations').filter((a) => a.transaction_id === transactionId && a.user_id === userId);
    const allocSum = allocs.reduce((s, a) => s + Math.round(Number(a.amount) * 100), 0);
    const parent = t ? Math.round(Number(t.amount_original) * 100) : 0;
    const unknownUnsplit = Boolean(t && t.economic_transaction_type === 'unknown' && (allocs.length === 0 || allocSum !== parent));
    const reviewItem = this.rows('fdh_review_items').some((r) => r.user_id === userId && r.transaction_id === transactionId && r.severity === 'blocking' && ['open', 'in_progress'].includes(String(r.status)));
    const link = this.rows('fdh_transaction_links').some((l) => l.user_id === userId && l.status === 'pending' && (l.transaction_id_from === transactionId || l.transaction_id_to === transactionId));
    const dup = this.rows('fdh_duplicate_candidates').some((d) => d.user_id === userId && d.status === 'pending' && (d.transaction_id_a === transactionId || d.transaction_id_b === transactionId));
    const badSplit = allocs.length > 0 && allocSum !== parent;
    return unknownUnsplit || reviewItem || link || dup || badSplit;
  }

  statementHasBlockingIssue(userId: string, statementId: string): boolean {
    const item = this.rows('fdh_review_items').some((r) => r.user_id === userId && r.statement_upload_id === statementId && r.severity === 'blocking' && ['open', 'in_progress'].includes(String(r.status)));
    const recon = this.rows('fdh_reconciliation_results').some((r) => r.user_id === userId && r.statement_upload_id === statementId && r.status === 'failed');
    const txn = this.rows('fdh_transactions').some((t) => t.user_id === userId && t.statement_upload_id === statementId && this.hasBlockingIssue(userId, String(t.id)));
    return item || recon || txn;
  }

  private client(role: 'authenticated' | 'service_role', uid: string | null): FakeClient {
    return {
      from: (table: string) => new QueryBuilder(this, table, role, uid),
      rpc: async (fn: string, args: Record<string, unknown>) => {
        if (fn === 'fdh7_transaction_has_blocking_issue') return { data: this.hasBlockingIssue(String(args.p_user_id), String(args.p_transaction_id)), error: null };
        if (fn === 'fdh7_statement_has_blocking_issue') return { data: this.statementHasBlockingIssue(String(args.p_user_id), String(args.p_statement_id)), error: null };
        return { data: null, error: { message: `fake supabase: unknown rpc ${fn}` } };
      },
    };
  }

  sessionClient(userId: string): FakeClient {
    return this.client('authenticated', userId);
  }

  adminClient(): FakeClient {
    return this.client('service_role', null);
  }
}

export function createFakeDb(): FakeDb {
  return new FakeDbImpl();
}
