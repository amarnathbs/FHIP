// LR-9 WP-06/WP-07 — user-facing account-closure request routes. Exercises
// the real route handlers via a typed fake Supabase client.
import { describe, it, expect, vi } from 'vitest';

const USER_ID = 'close-account-user';

const { requireUserMock } = vi.hoisted(() => ({
  requireUserMock: vi.fn(() => ({ user: { id: USER_ID }, unauthenticated: null })),
}));
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return { ...actual, requireUser: () => requireUserMock(), requireCountryConfirmedUser: () => requireUserMock() };
});

type FakeRow = Record<string, unknown>;

function makeFakeSupabase(initialRows: FakeRow[]) {
  const rows = [...initialRows];
  const client = {
    from(table: string) {
      if (table !== 'account_deletion_requests') throw new Error(`unexpected table: ${table}`);
      let filtered = [...rows];
      let mode: 'select' | 'insert' | 'update' = 'select';
      let pendingInsert: FakeRow | null = null;
      let pendingUpdate: FakeRow | null = null;
      const builder = {
        select() {
          return builder;
        },
        eq(col: string, val: unknown) {
          filtered = filtered.filter((r) => r[col] === val);
          return builder;
        },
        order() {
          return builder;
        },
        insert(row: FakeRow) {
          mode = 'insert';
          pendingInsert = row;
          return builder;
        },
        update(patch: FakeRow) {
          mode = 'update';
          pendingUpdate = patch;
          return builder;
        },
        maybeSingle() {
          if (mode === 'update') {
            const target = filtered[0];
            if (!target) return Promise.resolve({ data: null, error: null });
            Object.assign(target, pendingUpdate);
            return Promise.resolve({ data: target, error: null });
          }
          return Promise.resolve({ data: filtered[0] ?? null, error: null });
        },
        single() {
          if (mode === 'insert') {
            const active = rows.find((r) => r.user_id === pendingInsert!.user_id && ['pending', 'processing'].includes(r.status as string));
            if (active) return Promise.resolve({ data: null, error: { code: '23505', message: 'duplicate' } });
            const newRow: FakeRow = { id: `req-${rows.length + 1}`, requested_at: new Date().toISOString(), reason: null, ...pendingInsert };
            rows.push(newRow);
            return Promise.resolve({ data: newRow, error: null });
          }
          return Promise.resolve({ data: filtered[0] ?? null, error: null });
        },
        then(resolve: (v: { data: FakeRow[]; error: null }) => void) {
          return Promise.resolve(resolve({ data: filtered, error: null }));
        },
      };
      return builder;
    },
  };
  return { client, getRows: () => rows };
}

describe('POST /api/account/close', () => {
  it('creates a pending request for the caller', async () => {
    vi.resetModules();
    const { client } = makeFakeSupabase([]);
    vi.doMock('@/lib/supabase/server', () => ({ createClient: async () => client }));
    const { POST } = await import('@/app/api/account/close/route');
    const res = await POST(new Request('http://x', { method: 'POST', body: JSON.stringify({ reason: 'no longer needed' }) }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe('pending');
    expect(body.data.user_id).toBe(USER_ID);
  });

  it('WP-07 idempotency — refuses a second active request with 409', async () => {
    vi.resetModules();
    const { client } = makeFakeSupabase([{ id: 'req-1', user_id: USER_ID, status: 'pending' }]);
    vi.doMock('@/lib/supabase/server', () => ({ createClient: async () => client }));
    const { POST } = await import('@/app/api/account/close/route');
    const res = await POST(new Request('http://x', { method: 'POST', body: JSON.stringify({}) }));
    expect(res.status).toBe(409);
  });
});

describe('DELETE /api/account/close/[id] — cancel', () => {
  it('cancels the caller\'s own pending request', async () => {
    vi.resetModules();
    const { client } = makeFakeSupabase([{ id: 'req-1', user_id: USER_ID, status: 'pending' }]);
    vi.doMock('@/lib/supabase/server', () => ({ createClient: async () => client }));
    const { DELETE } = await import('@/app/api/account/close/[id]/route');
    const res = await DELETE(new Request('http://x', { method: 'DELETE' }), { params: Promise.resolve({ id: 'req-1' }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe('cancelled');
  });

  it('NEG-03-adjacent — refuses to cancel a request that is no longer pending', async () => {
    vi.resetModules();
    const { client } = makeFakeSupabase([{ id: 'req-1', user_id: USER_ID, status: 'processing' }]);
    vi.doMock('@/lib/supabase/server', () => ({ createClient: async () => client }));
    const { DELETE } = await import('@/app/api/account/close/[id]/route');
    const res = await DELETE(new Request('http://x', { method: 'DELETE' }), { params: Promise.resolve({ id: 'req-1' }) });
    expect(res.status).toBe(409);
  });
});
