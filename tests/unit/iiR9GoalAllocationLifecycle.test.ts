// R9 — goalAllocations.ts lifecycle + security fixes, driven against a
// hermetic in-memory fake of the Supabase query-builder chain (the same
// "deliberately narrow fake, not a general mock" convention established by
// tests/unit/iiR3RepublishFieldRestoration.test.ts — this codebase's
// DB-touching orchestration layer is otherwise verified LIVE-DEV/PGlite
// only). This closes the loop scripts/ii_r9_certification.mjs's
// cross-tenant section explicitly deferred: RLS alone does NOT validate
// that ii_goal_allocations.linked_investment_id belongs to the caller (it
// is a plain FK, not owner-checked at the DB layer) — assertOwnsInvestment()
// in goalAllocations.ts is the actual control, and this test proves it
// fires, using a real second tenant's real investment row (valid FK,
// wrong owner — exactly spec section 67's "valid-FK same-user forgery"
// shape).

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/services/investment-intelligence/audit', () => ({
  emitAuditEvent: vi.fn().mockResolvedValue({ error: null }),
}));

type Row = Record<string, unknown>;

function makeStore() {
  const tables: Record<string, Row[]> = {
    investments: [
      { id: 'inv-a-1', user_id: 'user-a', current_value: 100000 },
      { id: 'inv-b-1', user_id: 'user-b', current_value: 50000 }, // belongs to a DIFFERENT tenant
    ],
    ii_goal_allocations: [],
    goal_funding_sources: [],
  };
  return tables;
}

function makeFakeClient(tables: Record<string, Row[]>) {
  function from(table: string) {
    const rows = tables[table] ?? (tables[table] = []);
    let filtered = rows;
    let pendingInsert: Row | Row[] | null = null;
    let pendingUpdate: Row | null = null;
    let pendingDelete = false;

    const builder = {
      select() {
        return builder;
      },
      insert(payload: Row | Row[]) {
        pendingInsert = payload;
        return builder;
      },
      update(payload: Row) {
        pendingUpdate = payload;
        return builder;
      },
      delete() {
        pendingDelete = true;
        return builder;
      },
      eq(col: string, val: unknown) {
        filtered = filtered.filter((r) => r[col] === val);
        return builder;
      },
      neq(col: string, val: unknown) {
        filtered = filtered.filter((r) => r[col] !== val);
        return builder;
      },
      maybeSingle() {
        return finish(filtered[0] ?? null);
      },
      single() {
        return finish(filtered[0] ?? null, filtered[0] === undefined);
      },
      then(resolve: (v: unknown) => unknown) {
        return finish(filtered).then(resolve);
      },
    };

    function finish(result: Row | Row[] | null, forceError = false) {
      if (pendingInsert) {
        const items = Array.isArray(pendingInsert) ? pendingInsert : [pendingInsert];
        const inserted = items.map((item) => ({ id: `${table}-${rows.length + Math.random()}`, created_at: new Date().toISOString(), effective_from: new Date().toISOString().slice(0, 10), status: 'active', ...item }));
        rows.push(...inserted);
        return Promise.resolve({ data: table.includes('goal_allocations') || table.includes('goal_funding_sources') ? inserted[0] : inserted, error: null });
      }
      if (pendingUpdate) {
        for (const r of filtered) Object.assign(r, pendingUpdate);
        return Promise.resolve({ data: filtered, error: null });
      }
      if (pendingDelete) {
        for (const r of filtered) {
          const idx = rows.indexOf(r);
          if (idx >= 0) rows.splice(idx, 1);
        }
        return Promise.resolve({ data: filtered, error: null });
      }
      if (forceError) return Promise.resolve({ data: null, error: null });
      return Promise.resolve({ data: result, error: null });
    }

    return builder;
  }
  return { from };
}

let store: Record<string, Row[]>;
beforeEach(() => {
  store = makeStore();
  vi.doMock('@/lib/supabase/admin', () => ({ createAdminClient: () => makeFakeClient(store) }));
  vi.doMock('@/lib/supabase/server', () => ({ createClient: async () => makeFakeClient(store) }));
});

describe('R9 goalAllocations.ts — ownership + cap enforcement fixes (spec sections 16, 66-71)', () => {
  it('rejects linking to another tenant\'s real investment row (valid FK, wrong owner) and creates NO ii_goal_allocations row', async () => {
    vi.resetModules();
    const { createOrUpdateGoalAllocation } = await import('@/lib/services/investment-intelligence/goalAllocations');
    const result = await createOrUpdateGoalAllocation(
      'user-a',
      { goalId: 'goal-a-1', investmentPositionId: 'pos-1', allocationType: 'percentage', allocationValue: 50, source: 'user' },
      'inv-b-1' // belongs to user-b — valid row, wrong tenant
    );
    expect(result.allocationId).toBeNull();
    expect(result.error).toMatch(/not found or not owned/i);
    expect(store.ii_goal_allocations).toHaveLength(0);
    expect(store.goal_funding_sources).toHaveLength(0);
  });

  it('allows linking to the caller\'s own real investment and syncs goal_funding_sources', async () => {
    vi.resetModules();
    const { createOrUpdateGoalAllocation } = await import('@/lib/services/investment-intelligence/goalAllocations');
    const result = await createOrUpdateGoalAllocation(
      'user-a',
      { goalId: 'goal-a-1', investmentPositionId: 'pos-1', allocationType: 'percentage', allocationValue: 50, source: 'user' },
      'inv-a-1'
    );
    expect(result.error).toBeNull();
    expect(result.allocationId).not.toBeNull();
    expect(store.ii_goal_allocations).toHaveLength(1);
    expect(store.goal_funding_sources).toHaveLength(1);
    expect(store.goal_funding_sources[0].linked_investment_id).toBe('inv-a-1');
    expect(store.goal_funding_sources[0].allocation_percentage).toBe(50);
  });

  it('rejects a second allocation against the same investment that would exceed 100% (the fixed cap-enforcement gap) — no orphaned ii_goal_allocations row is left behind', async () => {
    vi.resetModules();
    const { createOrUpdateGoalAllocation } = await import('@/lib/services/investment-intelligence/goalAllocations');
    const first = await createOrUpdateGoalAllocation('user-a', { goalId: 'goal-a-1', investmentPositionId: 'pos-1', allocationType: 'percentage', allocationValue: 70, source: 'user' }, 'inv-a-1');
    expect(first.error).toBeNull();

    const second = await createOrUpdateGoalAllocation('user-a', { goalId: 'goal-a-2', investmentPositionId: 'pos-1', allocationType: 'percentage', allocationValue: 60, source: 'user' }, 'inv-a-1');
    expect(second.allocationId).toBeNull();
    expect(second.capExceeded).toBe(true);
    expect(second.error).toMatch(/100%/);
    // Exactly the first allocation persisted — the rejected second attempt left no orphaned row.
    expect(store.ii_goal_allocations).toHaveLength(1);
    expect(store.goal_funding_sources).toHaveLength(1);
  });
});
