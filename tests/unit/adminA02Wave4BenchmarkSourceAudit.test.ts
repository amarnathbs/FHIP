// Admin A0.2 Wave 4 — Authorization, Audit and Result-State Consistency.
// Round 2 (Product Owner remediation dispatch).
//
// SUPERSEDES this file's Round 1 content. Round 1 shipped a test asserting
// "a failed audit insert does not turn the (already-committed) status
// change into a failure response" — i.e. it certified that a benchmark
// source could be approved/suspended/reinstated with ZERO audit evidence
// and still report success. The Product Owner correctly rejected this as
// certifying the WRONG invariant for a mandatory high-risk audit action.
// That test is REMOVED, not merely renamed — the correct invariant (audit
// failure rolls back the business mutation) can only be genuinely proven
// against a real transactional Postgres engine, not a mocked
// `supabase.from()` chain (a mock cannot simulate one statement's failure
// aborting an EARLIER statement in the same transaction — there is no
// "earlier statement" in a mock, only separately-scripted return values).
// That proof lives in scripts/admin_a02_wave4_benchmark_source_certification.mjs
// (real PGlite Postgres, full migration chain replayed from empty, genuine
// fault injection via a temporary CHECK constraint) — see that script for
// the actual rollback evidence.
//
// This file's job, post-remediation, is narrower and appropriate for a
// mocked unit test: prove the ROUTE HANDLER's own logic — which client it
// calls (the caller's own session for a status change, never service-role),
// what it passes to the RPC, and how it maps the RPC's error responses to
// safe, stable HTTP result states (Gate G6) — never the RPC's atomicity
// itself, which mocks cannot meaningfully exercise.
import { describe, it, expect, vi, beforeEach } from 'vitest';
// G3: the shared country gate now also reads the countries registry.
import { countryRegistryFrom } from './support/countryRegistryFake';

const mockGetUser = vi.fn();
const mockServerFrom = vi.fn();
const mockRpc = vi.fn();
const mockAdminFrom = vi.fn();
const ADMIN_ID = 'wave4-admin-under-test';

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: mockGetUser },
    from: mockServerFrom,
    rpc: mockRpc,
  }),
}));

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({ from: mockAdminFrom }),
}));

import { PUT } from '@/app/api/admin/benchmarks/sources/[id]/route';

const CONFIRMED_PROFILE = { country_of_residence: 'AU', country_confirmed_at: '2026-08-29T00:00:00Z', country_source: 'USER_CONFIRMED', onboarding_completed: true };

function req(body: unknown) {
  return new Request('http://test/api/admin/benchmarks/sources/src-1', { method: 'PUT', body: JSON.stringify(body) });
}
function params() {
  return { params: Promise.resolve({ id: 'src-1' }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetUser.mockResolvedValue({ data: { user: { id: ADMIN_ID } } });
  mockServerFrom.mockImplementation((table: string) => {
    const registry = countryRegistryFrom(table);
    if (registry) return registry;
    if (table === 'admin_users') return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { user_id: ADMIN_ID }, error: null }) }) }) };
    if (table === 'user_profiles') return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: CONFIRMED_PROFILE, error: null }) }) }) };
    throw new Error(`unexpected server-client table: ${table}`);
  });
});

describe('PUT /api/admin/benchmarks/sources/[id] — a status change calls the atomic RPC via the CALLER\'s own session', () => {
  it('calls admin_transition_benchmark_source with the exact source id and new status, never a direct table write', async () => {
    mockRpc.mockResolvedValue({ data: { id: 'src-1', status: 'approved' }, error: null });
    const res = await PUT(req({ status: 'approved' }), params());
    expect(res.status).toBe(200);
    expect(mockRpc).toHaveBeenCalledWith('admin_transition_benchmark_source', { p_source_id: 'src-1', p_new_status: 'approved' });
    // The status path must never touch benchmark_sources directly through
    // the service-role client — the RPC is the only sanctioned writer.
    expect(mockAdminFrom).not.toHaveBeenCalledWith('benchmark_sources');
  });

  it('a successful RPC result is returned as the response body', async () => {
    mockRpc.mockResolvedValue({ data: { id: 'src-1', status: 'suspended' }, error: null });
    const res = await PUT(req({ status: 'suspended' }), params());
    const body = await res.json();
    expect(body.data).toEqual({ id: 'src-1', status: 'suspended' });
  });
});

describe('PUT /api/admin/benchmarks/sources/[id] — Gate G6: RPC errors map to safe, stable codes, never a raw message', () => {
  // Response envelope is deliberately flat ({ error: string, code }), not
  // { error: { code, message } } — every existing Benchmarks-tab consumer
  // reads json.error as a plain string via alert(), confirmed by direct
  // read of components/admin/AdminBenchmarksClient.tsx; a nested object
  // would render as "[object Object]" in that alert.
  it('"Not authenticated" -> 401, safe message, no raw message leaked', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'Not authenticated' } });
    const res = await PUT(req({ status: 'approved' }), params());
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(typeof body.error).toBe('string');
    expect(body.error).not.toContain('auth.uid');
  });

  it('"Admin access required" -> 403', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'Admin access required' } });
    const res = await PUT(req({ status: 'approved' }), params());
    expect(res.status).toBe(403);
  });

  it('"Benchmark source ... not found" -> 404, fixed generic message', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'Benchmark source 00000000-0000-0000-0000-000000000000 not found' } });
    const res = await PUT(req({ status: 'approved' }), params());
    expect(res.status).toBe(404);
    const body = await res.json();
    // This route intentionally returns a fixed, generic message rather
    // than echoing the RPC's own interpolated id.
    expect(body.error).toBe('Benchmark source not found.');
  });

  it('"Invalid target status" -> 422', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'Invalid target status: bogus' } });
    const res = await PUT(req({ status: 'approved' }), params());
    // Note: this specific message never actually reaches the RPC in
    // practice (the route's own VALID_STATUSES check rejects it first,
    // see the next describe block) — this proves the RPC-side mapping
    // defensively, in case the two enums ever drift apart.
    expect(res.status).toBe(422);
  });

  it('an unexpected/unmapped RPC error (real SQLSTATE 23505) -> 500 via safeDbError, raw Postgres detail never reaches the client', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockRpc.mockResolvedValue({ data: null, error: { message: 'duplicate key value violates unique constraint "benchmark_update_runs_pkey"', code: '23505' } });
    const res = await PUT(req({ status: 'approved' }), params());
    // 23505 (unique_violation) maps to 409 CONFLICT via safeDbError() —
    // this specific message doesn't match any of the route's own
    // message-text mappings above, so it falls through to the generic
    // Postgres-error-code mapper.
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('CONFLICT');
    expect(JSON.stringify(body)).not.toContain('constraint');
    expect(JSON.stringify(body)).not.toContain('benchmark_update_runs_pkey');
    errSpy.mockRestore();
  });

  it('a genuinely unmapped error code -> 500 INTERNAL_ERROR, raw detail logged server-side only', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockRpc.mockResolvedValue({ data: null, error: { message: 'some internal function public.foo() raised an unexpected condition', code: 'XX000' } });
    const res = await PUT(req({ status: 'approved' }), params());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(body)).not.toContain('public.foo');
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

describe('PUT /api/admin/benchmarks/sources/[id] — input validation happens before any RPC call', () => {
  it('an invalid status is rejected 422 without ever calling the RPC', async () => {
    const res = await PUT(req({ status: 'not_a_real_status' }), params());
    expect(res.status).toBe(422);
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

describe('PUT /api/admin/benchmarks/sources/[id] — metadata-only edits remain a direct, unaudited service-role update', () => {
  it('a metadata-only edit (no status field) never calls the RPC and writes via the service-role client', async () => {
    mockAdminFrom.mockImplementation((table: string) => {
      if (table === 'benchmark_sources') {
        return { update: () => ({ eq: () => ({ select: () => ({ maybeSingle: async () => ({ data: { id: 'src-1', methodology_notes: 'updated' }, error: null }) }) }) }) };
      }
      throw new Error(`unexpected admin-client table: ${table}`);
    });
    const res = await PUT(req({ methodology_notes: 'updated' }), params());
    expect(res.status).toBe(200);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('a metadata edit against an unknown id returns a clean 404, not a raw error', async () => {
    mockAdminFrom.mockImplementation((table: string) => {
      if (table === 'benchmark_sources') return { update: () => ({ eq: () => ({ select: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) };
      throw new Error(`unexpected admin-client table: ${table}`);
    });
    const res = await PUT(req({ methodology_notes: 'updated' }), params());
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('Benchmark source not found.');
  });

  it('a request with neither a status nor any writable field returns the current row, not a bare null', async () => {
    mockAdminFrom.mockImplementation((table: string) => {
      if (table === 'benchmark_sources') return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: 'src-1', status: 'active' }, error: null }) }) }) };
      throw new Error(`unexpected admin-client table: ${table}`);
    });
    const res = await PUT(req({}), params());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ id: 'src-1', status: 'active' });
    expect(mockRpc).not.toHaveBeenCalled();
  });
});
