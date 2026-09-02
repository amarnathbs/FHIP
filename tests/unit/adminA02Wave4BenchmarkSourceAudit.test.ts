// Admin A0.2 Wave 4 — Authorization, Audit and Result-State Consistency.
//
// Focused evidence for the one concrete AUDIT_MISSING_HIGH_RISK gap this
// Wave found and closed: PUT /api/admin/benchmarks/sources/[id] could
// approve/suspend/reinstate a benchmark source (spec §9 priorities 2/4)
// with zero audit trail, unlike its sibling dataset lifecycle
// (datasets/[id]/activate, which has always written benchmark_update_runs).
// Migration 0125 widens benchmark_update_runs.approval_status's CHECK
// constraint so the existing (already-locked-down, service-role-only) audit
// table can honestly record a source status transition; this test proves
// the route's own new behaviour, not the database constraint itself
// (that is exercised live in DEV — see the Wave 4 certification report).
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetUser = vi.fn();
const mockServerFrom = vi.fn();
const mockAdminFrom = vi.fn();
const ADMIN_ID = 'wave4-admin-under-test';

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: mockGetUser },
    from: mockServerFrom,
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
    if (table === 'admin_users') return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { user_id: ADMIN_ID }, error: null }) }) }) };
    if (table === 'user_profiles') return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: CONFIRMED_PROFILE, error: null }) }) }) };
    throw new Error(`unexpected server-client table: ${table}`);
  });
});

describe('PUT /api/admin/benchmarks/sources/[id] — audit evidence (Wave 4)', () => {
  it('a genuine status transition writes a benchmark_update_runs audit row with source_id, previous/new status and the trusted actor id', async () => {
    const insert = vi.fn<(row: Record<string, unknown>) => Promise<{ data: null; error: null }>>(async () => ({ data: null, error: null }));
    mockAdminFrom.mockImplementation((table: string) => {
      if (table === 'benchmark_sources') {
        return {
          select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { status: 'under_review' }, error: null }), single: async () => ({ data: { id: 'src-1', status: 'approved' }, error: null }) }) }),
          update: () => ({ eq: () => ({ select: () => ({ single: async () => ({ data: { id: 'src-1', status: 'approved' }, error: null }) }) }) }),
        };
      }
      if (table === 'benchmark_update_runs') return { insert };
      throw new Error(`unexpected admin-client table: ${table}`);
    });

    const res = await PUT(req({ status: 'approved' }), params());
    expect(res.status).toBe(200);
    expect(insert).toHaveBeenCalledTimes(1);
    const row = insert.mock.calls[0][0];
    expect(row).toMatchObject({
      source_id: 'src-1',
      dataset_id: null,
      approval_status: 'approved',
      previous_version: 'under_review',
      new_version: 'approved',
      audit_user: ADMIN_ID, // trusted actor from requireAdmin(), never client-supplied
    });
  });

  it('an edit that does not change status (e.g. methodology_notes only) writes NO audit row', async () => {
    const insert = vi.fn(async () => ({ data: null, error: null }));
    mockAdminFrom.mockImplementation((table: string) => {
      if (table === 'benchmark_sources') {
        return {
          select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { status: 'active' }, error: null }) }) }),
          update: () => ({ eq: () => ({ select: () => ({ single: async () => ({ data: { id: 'src-1', status: 'active' }, error: null }) }) }) }),
        };
      }
      if (table === 'benchmark_update_runs') return { insert };
      throw new Error(`unexpected admin-client table: ${table}`);
    });

    const res = await PUT(req({ methodology_notes: 'updated wording' }), params());
    expect(res.status).toBe(200);
    expect(insert).not.toHaveBeenCalled();
  });

  it('re-submitting the SAME status (idempotent no-op) writes NO duplicate audit row', async () => {
    const insert = vi.fn(async () => ({ data: null, error: null }));
    mockAdminFrom.mockImplementation((table: string) => {
      if (table === 'benchmark_sources') {
        return {
          select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { status: 'approved' }, error: null }) }) }),
          update: () => ({ eq: () => ({ select: () => ({ single: async () => ({ data: { id: 'src-1', status: 'approved' }, error: null }) }) }) }),
        };
      }
      if (table === 'benchmark_update_runs') return { insert };
      throw new Error(`unexpected admin-client table: ${table}`);
    });

    const res = await PUT(req({ status: 'approved' }), params());
    expect(res.status).toBe(200);
    expect(insert).not.toHaveBeenCalled();
  });

  it('an unknown source id returns a clean 404 (not a raw Postgrest error mapped to 400) and writes no audit row', async () => {
    const insert = vi.fn(async () => ({ data: null, error: null }));
    mockAdminFrom.mockImplementation((table: string) => {
      if (table === 'benchmark_sources') return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) };
      if (table === 'benchmark_update_runs') return { insert };
      throw new Error(`unexpected admin-client table: ${table}`);
    });

    const res = await PUT(req({ status: 'approved' }), params());
    expect(res.status).toBe(404);
    expect(insert).not.toHaveBeenCalled();
  });

  it('an invalid status is rejected 422 before any table is touched', async () => {
    mockAdminFrom.mockImplementation((table: string) => {
      throw new Error(`no table should be touched for invalid input: ${table}`);
    });
    const res = await PUT(req({ status: 'not_a_real_status' }), params());
    expect(res.status).toBe(422);
  });

  it('a failed audit insert does not turn the (already-committed) status change into a failure response', async () => {
    const insert = vi.fn(async () => ({ data: null, error: { message: 'simulated audit-log outage' } }));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockAdminFrom.mockImplementation((table: string) => {
      if (table === 'benchmark_sources') {
        return {
          select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { status: 'draft' }, error: null }) }) }),
          update: () => ({ eq: () => ({ select: () => ({ single: async () => ({ data: { id: 'src-1', status: 'suspended' }, error: null }) }) }) }),
        };
      }
      if (table === 'benchmark_update_runs') return { insert };
      throw new Error(`unexpected admin-client table: ${table}`);
    });

    const res = await PUT(req({ status: 'suspended' }), params());
    expect(res.status).toBe(200); // the business mutation already committed — an audit-log outage must not be reported as a failed request
    expect(insert).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
  });
});
