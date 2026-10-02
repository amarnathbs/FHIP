// Minimal in-memory Supabase query-builder double for loader tests. It honours
// the filters the India MF loader uses (eq, neq, lte, in, is, order, range,
// limit, maybeSingle) so a test can prove the loader's own user_id scoping:
// the double returns rows ONLY when the loader asked for them.
type Row = Record<string, unknown>;

export function fakeSupabase(
  tables: Record<string, Row[]>,
  opts: { failTable?: string; rpc?: (name: string, args: Record<string, unknown>) => { data?: unknown; error?: { code?: string; message?: string } | null } } = {}
) {
  const calls: Array<{ table: string; eq: Array<[string, unknown]> }> = [];
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const updates: Array<{ table: string; values: Row; eq: Array<[string, unknown]> }> = [];
  function from(table: string) {
    const state = { filters: [] as Array<(r: Row) => boolean>, order: [] as Array<[string, boolean]>, limit: Infinity, from: 0, to: Infinity, single: false, eq: [] as Array<[string, unknown]> };
    const run = () => {
      if (opts.failTable === table) return { data: null, error: { message: `boom ${table}` } };
      let rows = (tables[table] ?? []).filter((r) => state.filters.every((f) => f(r)));
      for (const [col, asc] of [...state.order].reverse()) {
        rows = [...rows].sort((a, b) => ((a[col] as string | number) < (b[col] as string | number) ? -1 : (a[col] as string | number) > (b[col] as string | number) ? 1 : 0) * (asc ? 1 : -1));
      }
      rows = rows.slice(state.from, Math.min(state.to + 1, state.from + state.limit));
      if (state.single) return { data: rows[0] ?? null, error: null };
      return { data: rows, error: null };
    };
    const b: Record<string, unknown> = {
      select: () => b,
      eq: (c: string, v: unknown) => {
        state.eq.push([c, v]);
        state.filters.push((r) => r[c] === v);
        return b;
      },
      neq: (c: string, v: unknown) => (state.filters.push((r) => r[c] !== v), b),
      gte: (c: string, v: string) => (state.filters.push((r) => (r[c] as string) >= v), b),
      update: (values: Row) => {
        updates.push({ table, values, eq: state.eq });
        return b;
      },
      lte: (c: string, v: string) => (state.filters.push((r) => (r[c] as string) <= v), b),
      in: (c: string, vs: unknown[]) => (state.filters.push((r) => vs.includes(r[c])), b),
      is: (c: string, v: unknown) => (state.filters.push((r) => (r[c] ?? null) === v), b),
      order: (c: string, o?: { ascending?: boolean }) => (state.order.push([c, o?.ascending !== false]), b),
      limit: (n: number) => ((state.limit = n), b),
      range: (f: number, t: number) => ((state.from = f), (state.to = t), b),
      maybeSingle: () => ((state.single = true), (calls.push({ table, eq: state.eq }), Promise.resolve(run()))),
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
        calls.push({ table, eq: state.eq });
        return Promise.resolve(run()).then(res, rej);
      },
    };
    return b;
  }
  const rpc = (name: string, args: Record<string, unknown>) => {
    rpcCalls.push({ name, args });
    const r = opts.rpc ? opts.rpc(name, args) : { data: null, error: null };
    return Promise.resolve({ data: r.data ?? null, error: r.error ?? null });
  };
  return { client: { from, rpc } as unknown as import('@supabase/supabase-js').SupabaseClient, calls, rpcCalls, updates };
}
