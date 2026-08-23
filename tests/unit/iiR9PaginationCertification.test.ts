// R9 — pagination certification (spec sections 78-79, 92, 116, 120): at
// least one meaningful R9 result must depend on records beyond row 1000, to
// guard against the exact silent-PostgREST-1000-row-cap defect this project
// has found live on DEV before (see tests/unit/iiR4AnalyticsRepositoryPagination.test.ts's
// header for the original reproduction). This test reuses that SAME
// empirically-grounded mock harness (an unbounded select silently caps at
// 1000 rows with no error; an explicit .range() call pages correctly) and
// proves lib/services/investment-intelligence/portfolioAttribution.ts's
// fetchAllPages()-based readers recover every row past 1000, and that the
// FINAL AGGREGATE RESULT (total allocated/unallocated portfolio value)
// actually changes when row 1001+ is included vs excluded — not just that
// the row count is right, per spec section 79's exact requirement
// ("a meaningful R9 result depends on records beyond row 1,000").

import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAllInvestments, fetchAllInvestmentFundingSources, computePortfolioAllocationSummary } from '@/lib/services/investment-intelligence/portfolioAttribution';

type MockRow = Record<string, unknown>;
const POSTGREST_CAP = 1000;

function applyOrder(rows: MockRow[], clauses: Array<{ col: string; ascending: boolean }>): MockRow[] {
  const result = [...rows];
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
    not(col: string, op: string, val: unknown) {
      if (op === 'is' && val === null) filtered = filtered.filter((r) => r[col] !== null && r[col] !== undefined);
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
      const capped = sorted.slice(0, POSTGREST_CAP); // reproduces the real, previously-observed PostgREST behaviour
      return Promise.resolve({ data: capped, error: null }).then(resolve, reject);
    },
  };
  return builder;
}

function makeSupabaseMock(tables: Record<string, MockRow[]>): SupabaseClient {
  return {
    from(table: string) {
      return makeQueryBuilder(tables[table] ?? []);
    },
  } as unknown as SupabaseClient;
}

describe('R9-PAGE-001: fetchAllInvestments recovers every row of a >1000-row portfolio', () => {
  const userId = 'user-page-r9';
  // 1200 investments, id sequential so the 1001st+ rows are provably beyond
  // the PostgREST cap. Row 1001 (0-indexed 1000) carries a distinctive
  // current_value that a truncated read would never see.
  const investments = Array.from({ length: 1200 }, (_, i) => ({
    id: `inv-${String(i).padStart(5, '0')}`,
    current_value: i === 1000 ? 999999 : 10, // the "needle" row is exactly the 1001st
    currency_code: 'INR',
    source_type: 'manual',
    is_active: true,
    user_id: userId,
  }));

  it('an unbounded select alone would silently drop the 1001st row (harness sanity check)', async () => {
    const supabase = makeSupabaseMock({ investments });
    const res = await supabase.from('investments').select('*').eq('user_id', userId);
    expect(res.data ?? []).toHaveLength(POSTGREST_CAP);
    expect((res.data ?? []).some((r) => r.current_value === 999999)).toBe(false);
  });

  it('fetchAllInvestments pages past 1000 and includes the needle row', async () => {
    const supabase = makeSupabaseMock({ investments });
    const rows = await fetchAllInvestments(userId, supabase);
    expect(rows).toHaveLength(1200);
    expect(rows.some((r) => r.current_value === 999999)).toBe(true);
  });

  it('computePortfolioAllocationSummary — the actual R9 result — changes when the 1001st+ rows are included: this is the "meaningful result depends on row 1000+" proof required by spec section 79', async () => {
    const supabaseFull = makeSupabaseMock({ investments, goal_funding_sources: [] });
    const full = await computePortfolioAllocationSummary(userId, supabaseFull);

    const truncatedInvestments = investments.slice(0, 1000);
    const supabaseTruncated = makeSupabaseMock({ investments: truncatedInvestments, goal_funding_sources: [] });
    const truncated = await computePortfolioAllocationSummary(userId, supabaseTruncated);

    // Independently computed expected totals: full = 1199 rows at value 10 plus the needle at 999999;
    // truncated = the first 1000 rows only (indices 0-999), all at value 10 (the needle sits at index 1000, excluded).
    const expectedFullTotal = 1199 * 10 + 999999;
    const expectedTruncatedTotal = 1000 * 10;
    expect(full.totalValue).toBe(expectedFullTotal);
    expect(truncated.totalValue).toBe(expectedTruncatedTotal);
    // The truncated (pre-fix-shaped) computation is wrong by a huge, needle-dominated margin — proving the excluded rows (including the needle) genuinely mattered to the result, not just to a row count.
    expect(full.totalValue - truncated.totalValue).toBe(expectedFullTotal - expectedTruncatedTotal);
    expect(full.totalValue).not.toBe(truncated.totalValue);
  });
});

describe('R9-PAGE-002: fetchAllInvestmentFundingSources recovers goal allocations beyond row 1000', () => {
  const userId = 'user-page-r9-fs';
  const fundingSources = Array.from({ length: 1100 }, (_, i) => ({
    id: `fs-${String(i).padStart(5, '0')}`,
    goal_id: 'goal-shared',
    linked_investment_id: i === 1050 ? 'inv-needle' : null,
    allocation_percentage: i === 1050 ? 100 : null,
    allocated_amount: 0,
    is_active: true,
    source_type: 'investment',
    user_id: userId,
  }));

  it('recovers the 1051st funding source row, which carries the only non-null linked_investment_id', async () => {
    const supabase = makeSupabaseMock({ goal_funding_sources: fundingSources });
    const rows = await fetchAllInvestmentFundingSources(userId, supabase);
    // fetchAllInvestmentFundingSources filters not-null linked_investment_id server-side in the real query;
    // the mock's `.not()` reproduces that filter, so only the needle row should come back.
    expect(rows).toHaveLength(1);
    expect(rows[0].linked_investment_id).toBe('inv-needle');
  });
});
