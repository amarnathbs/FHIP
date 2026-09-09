// LR-9 WP-08/WP-09, NEG-04 ("unauthorised admin deletion") — Admin
// account-deletion queue and execute routes. Exercises the real route
// handlers, proving the separately-named requireAccountDeletionAdmin()
// capability (not bare requireAdmin()) actually gates both routes, and that
// the execute route's pending->processing claim prevents a double-execute.
import { describe, it, expect, vi } from 'vitest';

const ADMIN_USER_ID = 'deletion-admin';
const TARGET_USER_ID = 'target-user';

// The admin's own country-confirmation gate (requireAccountDeletionAdmin
// applies the identical check every other admin route does) has its own
// dedicated test coverage elsewhere (tests/unit/countryGate*.test.ts) —
// mocked out here so these tests isolate the account-deletion capability
// logic specifically, matching this codebase's own convention of mocking
// out cross-cutting concerns a test file isn't about (see e.g.
// tests/unit/g3ConfirmCountryRoute.test.ts's own header).
vi.mock('@/lib/services/countryGate', () => ({ countryConfirmationBlockResponse: async () => null }));

type FakeRow = Record<string, unknown>;

function makeFakeSupabase(opts: { adminRow: FakeRow | null; requests: FakeRow[] }) {
  const requests = [...opts.requests];
  const deleteUserCalls: string[] = [];
  const client = {
    auth: {
      getUser: async () => ({ data: { user: { id: ADMIN_USER_ID } } }),
      admin: {
        getUserById: async (id: string) => ({ data: { user: { id, email: `${id}@example.com` } } }),
        deleteUser: async (id: string) => {
          deleteUserCalls.push(id);
          return { error: null };
        },
      },
    },
    from(table: string) {
      if (table === 'admin_users') {
        return {
          select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: opts.adminRow, error: null }) }) }),
        };
      }
      if (table === 'account_deletion_requests') {
        let filtered = [...requests];
        let mode: 'select' | 'update' = 'select';
        let pendingPatch: FakeRow = {};
        const builder = {
          select() {
            return builder;
          },
          in(col: string, vals: unknown[]) {
            filtered = filtered.filter((r) => vals.includes(r[col]));
            return builder;
          },
          eq(col: string, val: unknown) {
            filtered = filtered.filter((r) => r[col] === val);
            return builder;
          },
          order() {
            return builder;
          },
          update(patch: FakeRow) {
            mode = 'update';
            pendingPatch = patch;
            return builder;
          },
          maybeSingle() {
            if (mode === 'update') {
              const target = filtered[0];
              if (!target) return Promise.resolve({ data: null, error: null });
              Object.assign(target, pendingPatch);
              return Promise.resolve({ data: { id: target.id, user_id: target.user_id }, error: null });
            }
            return Promise.resolve({ data: filtered[0] ?? null, error: null });
          },
          single() {
            const target = filtered[0];
            if (target) Object.assign(target, pendingPatch);
            return Promise.resolve({ data: target ?? null, error: null });
          },
          then(resolve: (v: { data: FakeRow[]; error: null }) => void) {
            return Promise.resolve(resolve({ data: filtered, error: null }));
          },
        };
        return builder;
      }
      throw new Error(`unexpected table: ${table}`);
    },
  };
  return { client, deleteUserCalls };
}

describe('GET /api/admin/account-deletions', () => {
  it('NEG-04 — refuses a plain admin_users row with no can_manage_account_deletions flag', async () => {
    vi.resetModules();
    const { client } = makeFakeSupabase({ adminRow: { can_manage_account_deletions: false }, requests: [] });
    vi.doMock('@/lib/supabase/server', () => ({ createClient: async () => client }));
    vi.doMock('@/lib/supabase/admin', () => ({ createAdminClient: () => client }));
    const { GET } = await import('@/app/api/admin/account-deletions/route');
    const res = await GET(new Request('http://x/api/admin/account-deletions?queue=pending'));
    expect(res.status).toBe(403);
  });

  it('a genuine account-deletion admin sees the pending queue with minimal identity only', async () => {
    vi.resetModules();
    const { client } = makeFakeSupabase({
      adminRow: { can_manage_account_deletions: true },
      requests: [{ id: 'req-1', user_id: TARGET_USER_ID, status: 'pending', reason: 'test', requested_at: '2026-09-08T00:00:00Z' }],
    });
    vi.doMock('@/lib/supabase/server', () => ({ createClient: async () => client }));
    vi.doMock('@/lib/supabase/admin', () => ({ createAdminClient: () => client }));
    const { GET } = await import('@/app/api/admin/account-deletions/route');
    const res = await GET(new Request('http://x/api/admin/account-deletions?queue=pending'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([expect.objectContaining({ id: 'req-1', email: `${TARGET_USER_ID}@example.com` })]);
  });
});

describe('POST /api/admin/account-deletions/[id]/execute', () => {
  it('NEG-04 — refuses execution for an admin lacking the capability, and never calls deleteUser', async () => {
    vi.resetModules();
    const { client, deleteUserCalls } = makeFakeSupabase({
      adminRow: null,
      requests: [{ id: 'req-1', user_id: TARGET_USER_ID, status: 'pending' }],
    });
    vi.doMock('@/lib/supabase/server', () => ({ createClient: async () => client }));
    vi.doMock('@/lib/supabase/admin', () => ({ createAdminClient: () => client }));
    vi.doMock('@/lib/services/accountDeletionOrchestration', () => ({ executeAccountDeletion: vi.fn() }));
    const { POST } = await import('@/app/api/admin/account-deletions/[id]/execute/route');
    const res = await POST(new Request('http://x', { method: 'POST' }), { params: Promise.resolve({ id: 'req-1' }) });
    expect(res.status).toBe(403);
    expect(deleteUserCalls).toEqual([]);
  });

  it('refuses to execute a request that is not pending (already processing) — no double-execute', async () => {
    vi.resetModules();
    const { client, deleteUserCalls } = makeFakeSupabase({
      adminRow: { can_manage_account_deletions: true },
      requests: [{ id: 'req-1', user_id: TARGET_USER_ID, status: 'processing' }],
    });
    vi.doMock('@/lib/supabase/server', () => ({ createClient: async () => client }));
    vi.doMock('@/lib/supabase/admin', () => ({ createAdminClient: () => client }));
    vi.doMock('@/lib/services/accountDeletionOrchestration', () => ({ executeAccountDeletion: vi.fn() }));
    const { POST } = await import('@/app/api/admin/account-deletions/[id]/execute/route');
    const res = await POST(new Request('http://x', { method: 'POST' }), { params: Promise.resolve({ id: 'req-1' }) });
    expect(res.status).toBe(409);
    expect(deleteUserCalls).toEqual([]);
  });

  it('a genuine deletion admin executing a real pending request claims it, runs the orchestration, and finalises to completed', async () => {
    vi.resetModules();
    const { client } = makeFakeSupabase({
      adminRow: { can_manage_account_deletions: true },
      requests: [{ id: 'req-1', user_id: TARGET_USER_ID, status: 'pending' }],
    });
    vi.doMock('@/lib/supabase/server', () => ({ createClient: async () => client }));
    vi.doMock('@/lib/supabase/admin', () => ({ createAdminClient: () => client }));
    const executeMock = vi.fn(async () => ({ success: true, storageResults: [], authDeleteError: null }));
    vi.doMock('@/lib/services/accountDeletionOrchestration', () => ({ executeAccountDeletion: executeMock }));
    const { POST } = await import('@/app/api/admin/account-deletions/[id]/execute/route');
    const res = await POST(new Request('http://x', { method: 'POST' }), { params: Promise.resolve({ id: 'req-1' }) });
    expect(res.status).toBe(200);
    expect(executeMock).toHaveBeenCalledWith(TARGET_USER_ID);
    const body = await res.json();
    expect(body.data.request.status).toBe('completed');
    expect(body.data.request.processed_by).toBe(ADMIN_USER_ID);
  });
});
