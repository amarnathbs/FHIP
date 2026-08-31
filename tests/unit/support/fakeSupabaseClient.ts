// Module 11.0 residual closure — a controllable, in-memory Supabase test
// double used to exercise the REAL production certification/context path
// above a deliberately-failing database dependency.
//
// This is the "controlled certification-store failure stub" option of the
// residual-closure brief's section A: shared DEV infrastructure is never
// disabled or damaged; instead the dependency BELOW
// buildFinancialContextObject() (and below every certified Module 1-10
// loader it calls) is swapped for this double, while every line of the
// certification, context-assembly, allowlist, and gateway code above it is
// the real, unmodified production implementation.
//
// It also records every write verb issued against every table, which is how
// the "canonical financial writes: 0" requirement (brief sections C, D) is
// proven empirically rather than asserted from a code reading.

export type FakeMode =
  | 'healthy' // reads return fixture rows, writes succeed
  | 'fail_all' // every operation returns a PostgREST-shaped error (total outage)
  | 'fail_reads_allow_writes'; // reads error, writes still succeed (partial outage / read-replica loss)

export interface WriteLogEntry {
  table: string;
  verb: 'insert' | 'update' | 'upsert' | 'delete';
  payload: unknown;
}

export type Row = Record<string, unknown>;

export interface FakeClientHandle {
  client: unknown;
  writes: WriteLogEntry[];
  reads: string[];
  mode: FakeMode;
  setMode(m: FakeMode): void;
}

const DB_ERROR = {
  message: 'terminating connection due to administrator command',
  code: '57P01',
  details: null,
  hint: null,
};

/**
 * Builds a fake `SupabaseServerClient`.
 *
 * `tables` is the fixture dataset. Reads are filtered by the `.eq()`/`.neq()`/
 * `.in()` calls the real services actually issue; every other PostgREST
 * builder method is accepted and treated as a no-op filter, which is
 * sufficient because the fixture rows are already scoped to one synthetic
 * user.
 */
export function makeFakeSupabase(
  tables: Record<string, Row[]>,
  initialMode: FakeMode = 'healthy',
  /** Tables that keep succeeding even in a failure mode — models a REALISTIC
   *  partial outage (a statement timeout or a dropped policy on the heavy
   *  aggregation tables while small probe reads still return). */
  succeedTables: string[] = []
): FakeClientHandle {
  const alwaysOk = new Set(succeedTables);
  const handle: FakeClientHandle = {
    client: null,
    writes: [],
    reads: [],
    mode: initialMode,
    setMode(m: FakeMode) {
      handle.mode = m;
    },
  };

  const readsFail = (table: string) =>
    (handle.mode === 'fail_all' || handle.mode === 'fail_reads_allow_writes') && !alwaysOk.has(table);
  const writesFail = () => handle.mode === 'fail_all';

  function from(table: string) {
    const rows = tables[table] ?? (tables[table] = []);
    let filtered: Row[] = rows.slice();
    let write: WriteLogEntry | null = null;

    const noop = () => builder;

    const builder: Record<string, unknown> = {
      select: noop,
      order: noop,
      limit(n: number) {
        filtered = filtered.slice(0, n);
        return builder;
      },
      range: noop,
      or: noop,
      not: noop,
      is: noop,
      gt: noop,
      gte: noop,
      lt: noop,
      lte: noop,
      like: noop,
      ilike: noop,
      contains: noop,
      overlaps: noop,
      filter: noop,
      match: noop,
      eq(col: string, val: unknown) {
        filtered = filtered.filter((r) => r[col] === val);
        return builder;
      },
      neq(col: string, val: unknown) {
        filtered = filtered.filter((r) => r[col] !== val);
        return builder;
      },
      in(col: string, vals: unknown[]) {
        filtered = filtered.filter((r) => vals.includes(r[col]));
        return builder;
      },
      insert(payload: unknown) {
        write = { table, verb: 'insert', payload };
        return builder;
      },
      update(payload: unknown) {
        write = { table, verb: 'update', payload };
        return builder;
      },
      upsert(payload: unknown) {
        write = { table, verb: 'upsert', payload };
        return builder;
      },
      delete() {
        write = { table, verb: 'delete', payload: null };
        return builder;
      },
      single() {
        return settle('single');
      },
      maybeSingle() {
        return settle('maybeSingle');
      },
      then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
        return settle('many').then(resolve, reject);
      },
    };

    function settle(shape: 'single' | 'maybeSingle' | 'many') {
      if (write) {
        // A write is ALWAYS logged, whether or not the backend accepts it —
        // the log is the record of what the code under test *attempted*,
        // which is exactly what "canonical financial writes: 0" is about.
        handle.writes.push(write);
        if (writesFail()) return Promise.resolve({ data: null, error: DB_ERROR });
        const items = Array.isArray(write.payload) ? write.payload : write.payload === null ? [] : [write.payload];
        if (write.verb === 'insert' || write.verb === 'upsert') {
          for (const item of items as Row[]) rows.push({ id: `gen-${rows.length}`, ...item });
        }
        return Promise.resolve({ data: items, error: null });
      }
      handle.reads.push(table);
      if (readsFail(table)) return Promise.resolve({ data: null, error: DB_ERROR });
      if (shape === 'many') return Promise.resolve({ data: filtered, error: null });
      const first = filtered[0] ?? null;
      if (shape === 'single' && !first) return Promise.resolve({ data: null, error: { ...DB_ERROR, code: 'PGRST116', message: 'no rows returned' } });
      return Promise.resolve({ data: first, error: null });
    }

    return builder;
  }

  handle.client = {
    from,
    rpc(name: string) {
      return Promise.resolve({ data: null, error: readsFail(name) ? DB_ERROR : null });
    },
    auth: {
      getUser() {
        return Promise.resolve({ data: { user: null }, error: null });
      },
    },
  };

  return handle;
}

/** Canonical Module 1-10 financial tables — a write to any of these from the
 *  AI read path is a violation of Module 11.0's own "no AI writes to canonical
 *  financial data" invariant. */
export const CANONICAL_FINANCIAL_TABLES = [
  'income_sources',
  'expense_items',
  'assets',
  'liabilities',
  'investments',
  'retirement_accounts',
  'insurance_policies',
  'user_goals',
  'financial_snapshots',
  'financial_health_scores',
  'financial_health_component_scores',
  'financial_health_recommendations',
  'financial_dna_profiles',
  'financial_dna_profile_scores',
  'financial_dna_drivers',
  'financial_dna_actions',
  'resilience_scores',
  'resilience_component_scores',
  'resilience_risks',
  'resilience_actions',
  'goal_forecasts',
  'goal_snapshots',
  'goal_allocations',
  'financial_twin_runs',
  'financial_twin_metric_results',
  'financial_twin_insights',
  'forecast_runs',
  'forecast_results',
  'reports',
  'report_sections',
  'report_snapshots',
  'user_profiles',
  'households',
];
