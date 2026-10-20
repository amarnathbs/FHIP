// A small in-memory PostgREST-shaped double for the retirement contribution service tests. It supports exactly what the service
// calls (select with optional head/count, eq / in / order, maybeSingle / single, insert (+select), update (+eq)) and it EMULATES
// the one database guarantee the service relies on: the unique index on (user_id, source_payroll_event_id, contribution_type).
// Row level security is emulated by the service's own user_id filters; the real policy is proven in the PGlite test.
type Row = Record<string, unknown>;

export function contributionFakeDb(initial: Record<string, Row[]>) {
  const t: Record<string, Row[]> = {};
  for (const [k, v] of Object.entries(initial)) t[k] = v.map((r) => ({ ...r }));
  let seq = 0;
  const writes: Array<{ table: string; op: string; rows: Row[] }> = [];

  function from(table: string) {
    t[table] ??= [];
    const st = { op: 'select' as 'select' | 'insert' | 'update', filters: [] as Array<(r: Row) => boolean>, patch: {} as Row, ins: [] as Row[], head: false, count: false, single: false, maybe: false, afterInsertSelect: false, order: null as null | [string, boolean] };
    const exec = (): { data: unknown; error: unknown; count?: number } => {
      if (st.op === 'insert') {
        const out: Row[] = [];
        for (const r of st.ins) {
          const row: Row = { id: r.id ?? `${table}-${++seq}`, created_at: new Date(Date.UTC(2026, 9, 20, 0, 0, seq)).toISOString(), status: 'active', metadata: {}, ...r };
          if (table === 'retirement_contributions' && row.source_payroll_event_id) {
            const dup = t[table].some((x) => x.user_id === row.user_id && x.source_payroll_event_id === row.source_payroll_event_id && x.contribution_type === row.contribution_type);
            if (dup) return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "uq_retirement_contributions_payslip"' } };
          }
          t[table].push(row);
          out.push(row);
        }
        writes.push({ table, op: 'insert', rows: out.map((r) => ({ ...r })) });
        const data = st.single || st.maybe ? out[0] ?? null : out;
        return { data: st.afterInsertSelect ? data : null, error: null };
      }
      const matched = t[table].filter((r) => st.filters.every((f) => f(r)));
      if (st.op === 'update') {
        for (const r of matched) Object.assign(r, st.patch);
        writes.push({ table, op: 'update', rows: matched.map((r) => ({ ...r })) });
        return { data: null, error: null };
      }
      let rows = matched;
      if (st.order) { const [c, asc] = st.order; rows = [...rows].sort((a, b) => ((a[c] as string) < (b[c] as string) ? -1 : (a[c] as string) > (b[c] as string) ? 1 : 0) * (asc ? 1 : -1)); }
      if (st.head) return { data: null, error: null, count: rows.length };
      if (st.single || st.maybe) return { data: rows[0] ?? null, error: null };
      return { data: rows, error: null };
    };
    const b: Record<string, unknown> = {
      select: (_cols?: string, opts?: { count?: string; head?: boolean }) => { if (st.op === 'insert') st.afterInsertSelect = true; if (opts?.head) st.head = true; if (opts?.count) st.count = true; return b; },
      eq: (c: string, v: unknown) => (st.filters.push((r) => r[c] === v), b),
      in: (c: string, vs: unknown[]) => (st.filters.push((r) => vs.includes(r[c])), b),
      order: (c: string, o?: { ascending?: boolean }) => ((st.order = [c, o?.ascending !== false]), b),
      insert: (rows: Row | Row[]) => ((st.op = 'insert'), (st.ins = Array.isArray(rows) ? rows : [rows]), b),
      update: (patch: Row) => ((st.op = 'update'), (st.patch = patch), b),
      maybeSingle: () => ((st.maybe = true), Promise.resolve(exec())),
      single: () => ((st.single = true), Promise.resolve(exec())),
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(exec()).then(res, rej),
    };
    return b;
  }
  return { client: { from } as never, tables: t, writes };
}
