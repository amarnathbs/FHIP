// LR-7 WP-05/06/07/08 — archive/pause/resume/permanent-delete route tests.
// Before this phase these four routes had zero UI caller anywhere in the
// app; this exercises the routes directly (the real production code, not a
// reimplementation), proving the state-transition guards and the
// dependency-checked permanent delete this phase added.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const USER_ID = 'goal-lifecycle-user';
const GOAL_ID = 'goal-1';

const { requireUserMock } = vi.hoisted(() => ({
  requireUserMock: vi.fn(() => ({ user: { id: USER_ID }, unauthenticated: null })),
}));
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return { ...actual, requireUser: () => requireUserMock(), requireCountryConfirmedUser: () => requireUserMock() };
});

// Minimal fake covering exactly the chains these four routes use:
//   .from(t).select(...).eq().eq().maybeSingle()
//   .from(t).select('id', {count:'exact', head:true}).eq().eq()   (resolves via `then`)
//   .from(t).update(patch).eq().eq().select().single()
//   .from(t).delete().eq().eq()                                    (resolves via `then`)
type FakeRow = Record<string, unknown>;
interface FakeQueryResult {
  data: FakeRow | FakeRow[] | null;
  error: null;
  count?: number;
}
interface FakeBuilder extends PromiseLike<FakeQueryResult> {
  select(cols?: string, opts?: { count?: string; head?: boolean }): FakeBuilder;
  eq(col: string, val: unknown): FakeBuilder;
  update(patch: FakeRow): FakeBuilder;
  delete(): FakeBuilder;
  maybeSingle(): Promise<FakeQueryResult>;
  single(): Promise<FakeQueryResult>;
}

function makeFakeSupabase(tables: Record<string, { rows: FakeRow[] }>) {
  const updates: { table: string; patch: FakeRow }[] = [];
  const deletes: { table: string }[] = [];

  function from(table: string): FakeBuilder {
    const state = tables[table] ?? { rows: [] };
    let rows = [...state.rows];
    let mode: 'select' | 'update' | 'delete' = 'select';
    let pendingPatch: FakeRow = {};
    let wantCount = false;

    const builder: FakeBuilder = {
      select(_cols, opts) {
        if (opts?.count) wantCount = true;
        return builder;
      },
      eq(col, val) {
        rows = rows.filter((r) => r[col] === val);
        return builder;
      },
      update(patch) {
        mode = 'update';
        pendingPatch = patch;
        return builder;
      },
      delete() {
        mode = 'delete';
        return builder;
      },
      maybeSingle() {
        return Promise.resolve({ data: rows[0] ?? null, error: null });
      },
      single() {
        if (mode === 'update') {
          updates.push({ table, patch: pendingPatch });
          const updated = { ...(rows[0] ?? {}), ...pendingPatch };
          return Promise.resolve({ data: updated, error: null });
        }
        return Promise.resolve({ data: rows[0] ?? null, error: null });
      },
      then(resolve) {
        if (mode === 'delete') {
          deletes.push({ table });
          return Promise.resolve(resolve!({ data: null, error: null }));
        }
        return Promise.resolve(resolve!(wantCount ? { data: rows, error: null, count: rows.length } : { data: rows, error: null }));
      },
    };
    return builder;
  }
  return { client: { from }, updates, deletes };
}

beforeEach(() => {
  requireUserMock.mockClear();
});

describe('POST /api/goals/[id]/pause', () => {
  it('pauses an active goal', async () => {
    vi.resetModules();
    const { client } = makeFakeSupabase({ user_goals: { rows: [{ id: GOAL_ID, user_id: USER_ID, status: 'active' }] } });
    vi.doMock('@/lib/supabase/server', () => ({ createClient: async () => client }));
    const { POST } = await import('@/app/api/goals/[id]/pause/route');
    const res = await POST(new Request('http://x', { method: 'POST', body: JSON.stringify({ reason: 'test' }) }), {
      params: Promise.resolve({ id: GOAL_ID }),
    });
    expect(res.status).toBe(200);
  });

  it('NEG — refuses to pause a goal that is not active (e.g. already archived)', async () => {
    vi.resetModules();
    const { client } = makeFakeSupabase({ user_goals: { rows: [{ id: GOAL_ID, user_id: USER_ID, status: 'archived' }] } });
    vi.doMock('@/lib/supabase/server', () => ({ createClient: async () => client }));
    const { POST } = await import('@/app/api/goals/[id]/pause/route');
    const res = await POST(new Request('http://x', { method: 'POST' }), { params: Promise.resolve({ id: GOAL_ID }) });
    expect(res.status).toBe(409);
  });
});

describe('POST /api/goals/[id]/resume — NEG-07 (resume duplicates contributions)', () => {
  it('resumes a paused goal, touching only status/paused_at — never current_amount', async () => {
    vi.resetModules();
    const { client, updates } = makeFakeSupabase({ user_goals: { rows: [{ id: GOAL_ID, user_id: USER_ID, status: 'paused', current_amount: 5000 }] } });
    vi.doMock('@/lib/supabase/server', () => ({ createClient: async () => client }));
    const { POST } = await import('@/app/api/goals/[id]/resume/route');
    const res = await POST(new Request('http://x', { method: 'POST' }), { params: Promise.resolve({ id: GOAL_ID }) });
    expect(res.status).toBe(200);
    const patch = updates.find((u) => u.table === 'user_goals')?.patch;
    expect(patch).toBeDefined();
    expect('current_amount' in patch!).toBe(false);
    expect(patch!.status).toBe('active');
  });

  it('NEG — refuses to resume a goal that is not paused (e.g. archived — must not be silently resurrected)', async () => {
    vi.resetModules();
    const { client } = makeFakeSupabase({ user_goals: { rows: [{ id: GOAL_ID, user_id: USER_ID, status: 'archived' }] } });
    vi.doMock('@/lib/supabase/server', () => ({ createClient: async () => client }));
    const { POST } = await import('@/app/api/goals/[id]/resume/route');
    const res = await POST(new Request('http://x', { method: 'POST' }), { params: Promise.resolve({ id: GOAL_ID }) });
    expect(res.status).toBe(409);
  });

  it('refuses a double-resume of an already-active goal', async () => {
    vi.resetModules();
    const { client } = makeFakeSupabase({ user_goals: { rows: [{ id: GOAL_ID, user_id: USER_ID, status: 'active' }] } });
    vi.doMock('@/lib/supabase/server', () => ({ createClient: async () => client }));
    const { POST } = await import('@/app/api/goals/[id]/resume/route');
    const res = await POST(new Request('http://x', { method: 'POST' }), { params: Promise.resolve({ id: GOAL_ID }) });
    expect(res.status).toBe(409);
  });
});

describe('POST /api/goals/[id]/archive — NEG-06 (archive loses history)', () => {
  it('archives an active goal without touching any other table (history preserved by construction — nothing else is written)', async () => {
    vi.resetModules();
    const { client, updates, deletes } = makeFakeSupabase({ user_goals: { rows: [{ id: GOAL_ID, user_id: USER_ID, status: 'active' }] } });
    vi.doMock('@/lib/supabase/server', () => ({ createClient: async () => client }));
    const { POST } = await import('@/app/api/goals/[id]/archive/route');
    const res = await POST(new Request('http://x', { method: 'POST' }), { params: Promise.resolve({ id: GOAL_ID }) });
    expect(res.status).toBe(200);
    expect(deletes.length).toBe(0);
    expect(updates).toEqual([{ table: 'user_goals', patch: expect.objectContaining({ status: 'archived' }) }]);
  });

  it('refuses to double-archive an already-archived goal', async () => {
    vi.resetModules();
    const { client } = makeFakeSupabase({ user_goals: { rows: [{ id: GOAL_ID, user_id: USER_ID, status: 'archived' }] } });
    vi.doMock('@/lib/supabase/server', () => ({ createClient: async () => client }));
    const { POST } = await import('@/app/api/goals/[id]/archive/route');
    const res = await POST(new Request('http://x', { method: 'POST' }), { params: Promise.resolve({ id: GOAL_ID }) });
    expect(res.status).toBe(409);
  });
});

describe('DELETE /api/goals/[id] — WP-07 permanent delete, NEG-03 (goal delete orphans links)', () => {
  it('permanently deletes a genuinely unused goal (no funding sources, no contributions, no forecast snapshots)', async () => {
    vi.resetModules();
    const { client, deletes } = makeFakeSupabase({
      user_goals: { rows: [{ id: GOAL_ID, user_id: USER_ID }] },
      goal_funding_sources: { rows: [] },
      goal_contributions: { rows: [] },
      forecast_results: { rows: [] },
    });
    vi.doMock('@/lib/supabase/server', () => ({ createClient: async () => client }));
    const { DELETE } = await import('@/app/api/goals/[id]/route');
    const res = await DELETE(new Request('http://x', { method: 'DELETE' }), { params: Promise.resolve({ id: GOAL_ID }) });
    expect(res.status).toBe(200);
    expect(deletes).toEqual([{ table: 'user_goals' }]);
  });

  it('fails closed with a clear, itemised reason when the goal has funding sources and contribution history — and performs no delete at all', async () => {
    vi.resetModules();
    const { client, deletes } = makeFakeSupabase({
      user_goals: { rows: [{ id: GOAL_ID, user_id: USER_ID }] },
      goal_funding_sources: { rows: [{ id: 'fs-1', goal_id: GOAL_ID, user_id: USER_ID }] },
      goal_contributions: { rows: [{ id: 'c-1', goal_id: GOAL_ID, user_id: USER_ID }, { id: 'c-2', goal_id: GOAL_ID, user_id: USER_ID }] },
      forecast_results: { rows: [] },
    });
    vi.doMock('@/lib/supabase/server', () => ({ createClient: async () => client }));
    const { DELETE } = await import('@/app/api/goals/[id]/route');
    const res = await DELETE(new Request('http://x', { method: 'DELETE' }), { params: Promise.resolve({ id: GOAL_ID }) });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/1 funding source/);
    expect(body.error).toMatch(/2 contributions/);
    expect(deletes.length).toBe(0); // NEG-03: no partial/orphaning delete ever happens on a blocked request
  });

  it('fails closed when the goal has saved forecast history alone', async () => {
    vi.resetModules();
    const { client, deletes } = makeFakeSupabase({
      user_goals: { rows: [{ id: GOAL_ID, user_id: USER_ID }] },
      goal_funding_sources: { rows: [] },
      goal_contributions: { rows: [] },
      forecast_results: { rows: [{ id: 'fr-1', entity_id: GOAL_ID, entity_type: 'goal', user_id: USER_ID }] },
    });
    vi.doMock('@/lib/supabase/server', () => ({ createClient: async () => client }));
    const { DELETE } = await import('@/app/api/goals/[id]/route');
    const res = await DELETE(new Request('http://x', { method: 'DELETE' }), { params: Promise.resolve({ id: GOAL_ID }) });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/saved forecast history/);
    expect(deletes.length).toBe(0);
  });

  it('permanently deletes a goal with only unmet milestones — milestones alone do not block a delete', async () => {
    vi.resetModules();
    const { client, deletes } = makeFakeSupabase({
      user_goals: { rows: [{ id: GOAL_ID, user_id: USER_ID }] },
      goal_funding_sources: { rows: [] },
      goal_contributions: { rows: [] },
      forecast_results: { rows: [] },
      goal_milestones: { rows: [{ id: 'm-1', goal_id: GOAL_ID, user_id: USER_ID }] },
    });
    vi.doMock('@/lib/supabase/server', () => ({ createClient: async () => client }));
    const { DELETE } = await import('@/app/api/goals/[id]/route');
    const res = await DELETE(new Request('http://x', { method: 'DELETE' }), { params: Promise.resolve({ id: GOAL_ID }) });
    expect(res.status).toBe(200);
    expect(deletes).toEqual([{ table: 'user_goals' }]);
  });
});
