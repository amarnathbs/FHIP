// Investment Intelligence R11 — professional-access proxy pagination fix.
//
// app/api/professional-access/proxy/investments-summary/route.ts reads
// ii_holding_snapshots for a client user with a plain unbounded
// `.select()...order('as_of_date', {ascending:false})`, NOT through the
// module's own fetchAllRows() helper
// (lib/services/investment-intelligence/pagination.ts). PostgREST silently
// caps an unbounded select at db-max-rows (1000 on this project) with no
// error surfaced anywhere — the exact defect class already fixed in
// R6-P0, R9, R10, and app/api/investment-intelligence/positions/route.ts
// (see that file's own header comment). For a client with a dense
// holdings-snapshot history, a dormant position whose only snapshot sorts
// past row 1000 silently disappears from a professional's view of that
// client's portfolio.
//
// This is hermetic (fake Supabase query-builder, no live DB) but the fake
// faithfully reproduces PostgREST's actual documented behaviour: a plain
// `.select()` resolved via `.then()`/await with no explicit `.range()`
// call returns at most POSTGREST_CAP rows; an explicit `.range(from, to)`
// call (what fetchAllRows() issues) returns the exact requested slice.
// That is precisely the axis the real bug lives on, so a naive "just mock
// the whole query away" fake would not actually exercise the defect.
//
//   RED:   with the route's ORIGINAL unbounded select, seeding 1049
//          ii_holding_snapshots rows for one client (1048 recent "noise"
//          rows for one position, plus one position whose ONLY snapshot is
//          dated far in the past, so it sorts last under
//          `order('as_of_date', {ascending:false})` — past the 1000-row
//          cap) makes that dormant position vanish from the proxy's
//          response with no error anywhere.
//   GREEN: after switching the route to fetchAllRows() (with `id` as a
//          unique tie-breaker, matching positions/route.ts), the same
//          dormant position is present.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const POSTGREST_CAP = 1000;

type Row = Record<string, unknown>;

/**
 * A deliberately narrow fake of the Supabase query-builder chain — the
 * same "hermetic fake, not a general mock" convention this codebase
 * already uses (tests/unit/iiR9GoalAllocationLifecycle.test.ts,
 * tests/unit/iiR11PaginationNegativeControl.test.ts). It reproduces the
 * ONE behaviour this test needs to be faithful about: PostgREST's silent
 * db-max-rows cap on an unbounded select, vs. exact-slice `.range()`.
 */
interface FakeQueryResult {
  data: Row[];
  error: null;
}

interface FakeBuilder extends PromiseLike<FakeQueryResult> {
  select(columns?: string): FakeBuilder;
  eq(col: string, val: unknown): FakeBuilder;
  order(col: string, opts?: { ascending?: boolean }): FakeBuilder;
  range(from: number, to: number): Promise<FakeQueryResult>;
}

function makeFakeAdminClient(tables: Record<string, Row[]>) {
  function from(table: string): FakeBuilder {
    const rows = tables[table] ?? [];
    let filtered = rows;
    const order: Array<{ col: string; ascending: boolean }> = [];

    const builder: FakeBuilder = {
      select() {
        return builder;
      },
      eq(col: string, val: unknown) {
        filtered = filtered.filter((r) => r[col] === val);
        return builder;
      },
      order(col: string, opts?: { ascending?: boolean }) {
        order.push({ col, ascending: opts?.ascending ?? true });
        return builder;
      },
      range(from: number, to: number) {
        const sorted = applyOrder(filtered, order);
        return Promise.resolve({ data: sorted.slice(from, to + 1), error: null });
      },
      then(onfulfilled, onrejected) {
        // No explicit .range() was called — this is PostgREST's real
        // unbounded-select path, which silently truncates at the
        // project's configured db-max-rows.
        const sorted = applyOrder(filtered, order);
        return Promise.resolve({ data: sorted.slice(0, POSTGREST_CAP), error: null }).then(onfulfilled, onrejected);
      },
    };
    return builder;
  }
  return { from };
}

function applyOrder(rows: Row[], order: Array<{ col: string; ascending: boolean }>): Row[] {
  if (order.length === 0) return rows;
  return [...rows].sort((a, b) => {
    for (const { col, ascending } of order) {
      const av = a[col] as string;
      const bv = b[col] as string;
      if (av === bv) continue;
      const cmp = av < bv ? -1 : 1;
      return ascending ? cmp : -cmp;
    }
    return 0;
  });
}

const CLIENT_USER_ID = 'client-1';
const PRO_USER_ID = 'pro-1';
const ACCOUNT_A = 'acc-noise';
const INSTRUMENT_A = 'instr-noise';
const ACCOUNT_B = 'acc-dormant';
const INSTRUMENT_B = 'instr-dormant';

/** 1048 recent "noise" snapshots for one position + 1 dormant position whose only snapshot is dated far in the past (sorts last, descending). */
function buildSnapshots(): Row[] {
  const rows: Row[] = [];
  for (let i = 0; i < 1048; i++) {
    const day = String(i + 1).padStart(4, '0');
    rows.push({
      id: `snap-noise-${i}`,
      user_id: CLIENT_USER_ID,
      account_id: ACCOUNT_A,
      instrument_id: INSTRUMENT_A,
      as_of_date: `2026-${((i % 12) + 1).toString().padStart(2, '0')}-${((i % 27) + 1).toString().padStart(2, '0')}-${day}`, // distinct, all recent
      units: 10,
      value: 1000,
      currency_code: 'INR',
    });
  }
  rows.push({
    id: 'snap-dormant',
    user_id: CLIENT_USER_ID,
    account_id: ACCOUNT_B,
    instrument_id: INSTRUMENT_B,
    as_of_date: '2015-01-01', // far older than every noise row — sorts LAST descending
    units: 5,
    value: 500,
    currency_code: 'INR',
  });
  return rows;
}

let tables: Record<string, Row[]>;
beforeEach(() => {
  vi.resetModules();
  tables = {
    ii_accounts: [
      { id: ACCOUNT_A, user_id: CLIENT_USER_ID, institution_name: 'Noise Bank', account_type: 'demat', country_code: 'IN', currency_code: 'INR', status: 'active' },
      { id: ACCOUNT_B, user_id: CLIENT_USER_ID, institution_name: 'Dormant Bank', account_type: 'demat', country_code: 'IN', currency_code: 'INR', status: 'active' },
    ],
    ii_holding_snapshots: buildSnapshots(),
  };
  vi.doMock('@/lib/api', () => ({
    requireUser: vi.fn().mockResolvedValue({ user: { id: PRO_USER_ID }, unauthenticated: null }),
    ok: (data: unknown) => Response.json({ data }),
    bad: (msg: string, code = 400) => Response.json({ error: msg }, { status: code }),
  }));
  vi.doMock('@/lib/supabase/admin', () => ({ createAdminClient: () => makeFakeAdminClient(tables) }));
  vi.doMock('@/lib/services/professional-access/access', () => ({
    checkAccessLive: vi.fn().mockResolvedValue({ allow: true, reason: null }),
  }));
});

describe('R11 professional-access investments-summary proxy — pagination fix (positions/route.ts pattern)', () => {
  it('GREEN: fetchAllRows-based read includes the dormant position whose only snapshot sorts past row 1000', async () => {
    const { GET } = await import('@/app/api/professional-access/proxy/investments-summary/route');
    const res = await GET(new Request(`http://test/api/professional-access/proxy/investments-summary?clientUserId=${CLIENT_USER_ID}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    const positions: Array<{ account_id: string; instrument_id: string }> = body.data.positions;

    expect(positions).toHaveLength(2); // 1 noise position (collapsed from 1048 snapshots) + 1 dormant position
    const dormant = positions.find((p) => p.account_id === ACCOUNT_B && p.instrument_id === INSTRUMENT_B);
    expect(dormant, 'the dormant position (snapshot past row 1000) must not silently disappear').toBeDefined();
  });

  it('sanity: the fake client genuinely reproduces PostgREST\'s cap — an unbounded select (no .range()) on 1049 rows truncates at 1000', async () => {
    const client = makeFakeAdminClient(tables);
    const { data } = await client.from('ii_holding_snapshots').select('*').eq('user_id', CLIENT_USER_ID).order('as_of_date', { ascending: false });
    expect(data).toHaveLength(1000);
    expect(data.some((r: Row) => r.id === 'snap-dormant')).toBe(false); // proves the fake's cap actually drops the dormant row, same as real PostgREST
  });
});
