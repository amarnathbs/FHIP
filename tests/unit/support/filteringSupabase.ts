// A filtering in-memory Supabase double: eq / neq / in / is / gt / gte / lt /
// lte / order / range / limit / head-count are really applied (the shared
// fakeSupabaseClient treats gt/gte/lt/lte as no-ops and so cannot prove a date
// bound or a per-user filter). Copied verbatim from the Finding #5 cross-consumer
// suite so that suite stays untouched; used by the multi-folio suite.
import type { SupabaseClient } from '@supabase/supabase-js';

export type Row = Record<string, unknown>;

export function makeFilteringClient(tables: Record<string, Row[]>): SupabaseClient {
  function builderFor(table: string) {
    let rows = [...(tables[table] ?? [])];
    const order: Array<{ col: string; asc: boolean }> = [];
    let head = false;
    let limitN: number | null = null;
    const sorted = () => {
      const out = [...rows];
      for (let i = order.length - 1; i >= 0; i--) {
        const { col, asc } = order[i];
        out.sort((a, b) => {
          const av = a[col] as string | number;
          const bv = b[col] as string | number;
          if (av < bv) return asc ? -1 : 1;
          if (av > bv) return asc ? 1 : -1;
          return 0;
        });
      }
      return out;
    };
    const b: Record<string, unknown> = {
      select(_cols?: string, opts?: { head?: boolean }) {
        if (opts?.head) head = true;
        return b;
      },
      eq(col: string, val: unknown) {
        rows = rows.filter((r) => r[col] === val);
        return b;
      },
      neq(col: string, val: unknown) {
        rows = rows.filter((r) => r[col] !== val);
        return b;
      },
      in(col: string, vals: unknown[]) {
        const set = new Set(vals);
        rows = rows.filter((r) => set.has(r[col]));
        return b;
      },
      is(col: string, val: unknown) {
        rows = rows.filter((r) => (val === null ? r[col] === null || r[col] === undefined : r[col] === val));
        return b;
      },
      gte(col: string, val: string) {
        rows = rows.filter((r) => (r[col] as string) >= val);
        return b;
      },
      lte(col: string, val: string) {
        rows = rows.filter((r) => (r[col] as string) <= val);
        return b;
      },
      gt(col: string, val: string) {
        rows = rows.filter((r) => (r[col] as string) > val);
        return b;
      },
      lt(col: string, val: string) {
        rows = rows.filter((r) => (r[col] as string) < val);
        return b;
      },
      not() {
        return b;
      },
      or() {
        return b;
      },
      order(col: string, opts?: { ascending?: boolean }) {
        order.push({ col, asc: opts?.ascending !== false });
        return b;
      },
      limit(n: number) {
        limitN = n;
        return b;
      },
      range(from: number, to: number) {
        return Promise.resolve({ data: sorted().slice(from, to + 1), error: null });
      },
      maybeSingle() {
        return Promise.resolve({ data: sorted()[0] ?? null, error: null });
      },
      single() {
        const r = sorted()[0];
        return Promise.resolve({ data: r ?? null, error: r ? null : { message: 'no row' } });
      },
      then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
        const out = sorted();
        const result = head ? { data: null, count: out.length, error: null } : { data: limitN === null ? out.slice(0, 1000) : out.slice(0, limitN), error: null };
        return Promise.resolve(result).then(resolve, reject);
      },
    };
    return b;
  }
  return { from: (t: string) => builderFor(t) } as unknown as SupabaseClient;
}

