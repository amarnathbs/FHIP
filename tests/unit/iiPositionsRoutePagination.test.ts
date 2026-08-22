// R4 follow-up — Regression test for the same PostgREST silent 1000-row cap
// defect (see iiR4AnalyticsRepositoryPagination.test.ts) found, unfixed, in
// app/api/investment-intelligence/positions/route.ts during the analyticsRepository
// fix's codebase-wide sweep for other unbounded selects.
//
// This route reads ii_holding_snapshots for a user and collapses to the
// latest row per (account_id, instrument_id) to list "current" positions.
// It ordered by as_of_date descending with no .range()/.limit(), so
// PostgREST would silently cap the read at the 1000 most recent snapshot
// rows across ALL of a user's positions. A position whose own most recent
// snapshot happens to fall outside that global top-1000 window (e.g. it
// hasn't been re-valued as often as other positions) would then be missing
// from `latestByPosition` entirely — not merely stale, but silently absent
// from the user's own position list.
//
// Hermetic (no live DB): mocks @/lib/supabase/server's createClient with a
// small query builder that reproduces PostgREST's real behaviour — no
// .range() -> silently capped at 1000 rows, explicit .range(from, to) ->
// pages correctly.

import { describe, it, expect, vi } from 'vitest';

type MockRow = Record<string, unknown>;

const POSTGREST_CAP = 1000;

function applyOrder(rows: MockRow[], clauses: Array<{ col: string; ascending: boolean }>): MockRow[] {
  let result = [...rows];
  for (let i = clauses.length - 1; i >= 0; i--) {
    const { col, ascending } = clauses[i];
    result.sort((a, b) => {
      const av = a[col] as string | number;
      const bv = b[col] as string | number;
      if (av < bv) return ascending ? -1 : 1;
      if (av > bv) return ascending ? 1 : -1;
      return 0;
    });
  }
  return result;
}

function makeQueryBuilder(rows: MockRow[]) {
  let filtered = rows;
  const orderClauses: Array<{ col: string; ascending: boolean }> = [];
  const builder = {
    select() {
      return builder;
    },
    eq(col: string, val: unknown) {
      filtered = filtered.filter((r) => r[col] === val);
      return builder;
    },
    order(col: string, opts?: { ascending?: boolean }) {
      orderClauses.push({ col, ascending: opts?.ascending !== false });
      return builder;
    },
    range(from: number, to: number) {
      const sorted = applyOrder(filtered, orderClauses);
      const page = sorted.slice(from, to + 1);
      return Promise.resolve({ data: page, error: null });
    },
    then(resolve: (v: { data: MockRow[]; error: null }) => unknown, reject?: (e: unknown) => unknown) {
      const sorted = applyOrder(filtered, orderClauses);
      // THE CRITICAL LINE: reproduces PostgREST's silent 1000-row cap when no
      // .range() is used.
      const capped = sorted.slice(0, POSTGREST_CAP);
      return Promise.resolve({ data: capped, error: null }).then(resolve, reject);
    },
  };
  return builder;
}

const userId = 'user-positions-page-test';

function isoDate(dayOffset: number): string {
  const base = new Date(Date.UTC(2015, 0, 1));
  base.setUTCDate(base.getUTCDate() + dayOffset);
  return base.toISOString().slice(0, 10);
}

// 1200 snapshots spread across 1200 distinct (account, instrument) pairs,
// each with a different as_of_date, so every position's latest — and only —
// snapshot is a distinct row. Position 0's snapshot is the OLDEST
// (as_of_date day 0), so under descending order + a 1000-row cap it is the
// first one to fall outside the window and vanish.
const SNAPSHOT_ROWS = 1200;
function buildSnapshotRows(): MockRow[] {
  return Array.from({ length: SNAPSHOT_ROWS }, (_, i) => ({
    id: `snap-${String(i).padStart(6, '0')}`,
    user_id: userId,
    account_id: `acct-${i}`,
    instrument_id: `inst-${i}`,
    as_of_date: isoDate(i),
    units: 1000,
    value: 100000 + i * 10,
    currency_code: 'INR',
    quality_status: 'certified',
    created_at: `${isoDate(i)}T00:00:00.000Z`,
  }));
}

function mockSupabase() {
  const rows = buildSnapshotRows();
  return {
    auth: {
      getUser: () => Promise.resolve({ data: { user: { id: userId } } }),
    },
    from(table: string) {
      expect(table).toBe('ii_holding_snapshots');
      return makeQueryBuilder(rows);
    },
  };
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase()),
}));

describe('PAGE-002: positions route loads all snapshot rows, not just the newest 1000', () => {
  it('returns one position per (account_id, instrument_id), including the oldest one that a 1000-row cap would have dropped', async () => {
    const { GET } = await import('@/app/api/investment-intelligence/positions/route');
    const res = await GET();
    const body = (await res.json()) as { data?: Array<{ account_id: string; instrument_id: string }> };
    expect(body.data).toHaveLength(SNAPSHOT_ROWS);
    // The oldest snapshot (day 0) belongs to acct-0/inst-0 — under the
    // pre-fix unbounded descending-order select, this is exactly the
    // position that would have fallen outside the newest-1000 window and
    // gone missing.
    expect(body.data).toContainEqual(expect.objectContaining({ account_id: 'acct-0', instrument_id: 'inst-0' }));
  });
});
