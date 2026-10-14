// Planning Benchmarks staged upload (F5): the API layer. Evidence label: UNIT-TESTED (route handlers run for real
// against an in-memory Supabase fake whose filters apply; the database RPCs themselves are proven on PGlite in
// planningBenchmarkUploadPglite.test.ts).
//
// Admin Architecture Standard: s2 separately named capabilities, s4 direct-API on EVERY verb (401 / 403 / 503, never a
// quiet 200), s11 template download safe, s13 fail closed, no raw database text.
//
// NAMED NEGATIVE CONTROLS
//   NC-R1  a holder of ONLY the upload capability gets 403 on Activate (capability separation) and the RPC is never called;
//   NC-R2  a Super Admin row with NO upload capability gets 403 everywhere (admin_users row existence is not the capability);
//   NC-R3  a missing capability column (migration not applied) is 503 - distinguishable from 403 - never an empty 200;
//   NC-R4  the service-role client is not imported by any upload route or by the upload service (static check).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createInMemoryDb } from './support/inMemorySupabase';
import { countryRegistryFrom } from './support/countryRegistryFake';

const mockGetUser = vi.fn();
const db = createInMemoryDb();
const rpc = vi.fn();
let adminUsersError: { message: string } | null = null;

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: mockGetUser },
    rpc,
    from: (t: string) => {
      if (t === 'admin_users' && adminUsersError) {
        // Only the capability-column read fails (as a missing column would); the plain admin-row read works.
        const real = db.client.from(t) as Record<string, (...a: unknown[]) => unknown>;
        const chain: Record<string, unknown> = {};
        let capRead = false;
        chain.select = (cols: string) => {
          capRead = String(cols).includes('can_upload_planning_benchmarks');
          if (!capRead) real.select(cols);
          return chain;
        };
        chain.eq = (c: string, v: unknown) => {
          if (!capRead) real.eq(c, v);
          return chain;
        };
        chain.maybeSingle = async () => (capRead ? { data: null, error: adminUsersError } : (real.maybeSingle() as Promise<unknown>));
        return chain;
      }
      return countryRegistryFrom(t) ?? (db.client.from(t) as never);
    },
  }),
}));

import { GET as listGET, POST as stagePOST } from '@/app/api/admin/benchmarks/upload/route';
import { GET as templateGET } from '@/app/api/admin/benchmarks/upload/templates/[kind]/route';
import { GET as batchGET } from '@/app/api/admin/benchmarks/upload/[id]/route';
import { POST as activatePOST } from '@/app/api/admin/benchmarks/upload/[id]/activate/route';
import { POST as discardPOST } from '@/app/api/admin/benchmarks/upload/[id]/discard/route';
import { mapRpcError } from '@/lib/planning-benchmarks/uploadService';
import { planningBenchmarkFlagsFromRow } from '@/lib/planning-benchmarks/guards';

const U = '11111111-1111-4111-8111-111111111111';
const BATCH = '22222222-2222-4222-8222-222222222222';
const profile = { user_id: U, country_of_residence: 'AU', country_confirmed_at: '2026-08-29T00:00:00Z', country_source: 'USER_CONFIRMED', onboarding_completed: true };
const sha = 'a'.repeat(64);

function actor(flags: { upload?: boolean; activate?: boolean } | 'not-admin') {
  db.reset({
    user_profiles: [profile],
    admin_users: flags === 'not-admin' ? [] : [{ user_id: U, can_upload_planning_benchmarks: flags.upload === true, can_activate_planning_benchmarks: flags.activate === true }],
    benchmark_upload_batches: [],
  });
}
const ctx = (id = BATCH) => ({ params: Promise.resolve({ id }) });
const json = (body: unknown) => new Request('http://t/x', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
const activateBody = { confirmed: true, expectedSha256: sha, expectedDigest: 'b'.repeat(64), expectedCounts: { new: 1 } };
const tpl = (kind: string, fmt = 'csv') => templateGET(new Request(`http://t/x?format=${fmt}`), { params: Promise.resolve({ kind }) });

beforeEach(() => {
  vi.clearAllMocks();
  adminUsersError = null;
  mockGetUser.mockResolvedValue({ data: { user: { id: U } } });
  rpc.mockResolvedValue({ data: null, error: null });
});

describe('F5 routes: direct-API on every verb (Standard s4)', () => {
  it('401 when signed out, on every route', async () => {
    actor({ upload: true, activate: true });
    mockGetUser.mockResolvedValue({ data: { user: null } });
    const results = await Promise.all([
      listGET(), stagePOST(new Request('http://t/x', { method: 'POST' })), tpl('values'), batchGET(new Request('http://t/x'), ctx()), activatePOST(json(activateBody), ctx()), discardPOST(json({}), ctx()),
    ]);
    expect(results.map((r) => r.status)).toEqual([401, 401, 401, 401, 401, 401]);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('403 for a signed-in user who is not an admin at all', async () => {
    actor('not-admin');
    const r = await Promise.all([listGET(), tpl('values'), activatePOST(json(activateBody), ctx())]);
    expect(r.map((x) => x.status)).toEqual([403, 403, 403]);
  });

  it('NC-R2: an admin row with NO upload capability is refused everywhere (Super Admin is not the capability)', async () => {
    actor({});
    const r = await Promise.all([listGET(), stagePOST(new Request('http://t/x', { method: 'POST' })), tpl('values'), batchGET(new Request('http://t/x'), ctx()), activatePOST(json(activateBody), ctx())]);
    expect(r.map((x) => x.status)).toEqual([403, 403, 403, 403, 403]);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('NC-R1: upload-only holder can stage and view but is 403 on Activate, and the RPC is never reached', async () => {
    actor({ upload: true });
    expect((await listGET()).status).not.toBe(403);
    expect((await tpl('values')).status).toBe(200);
    const act = await activatePOST(json(activateBody), ctx());
    expect(act.status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('activate-only holder cannot stage (403) but can activate (the RPC is called with the bound hash and digest)', async () => {
    actor({ activate: true });
    const stage = await stagePOST(new Request('http://t/x', { method: 'POST' }));
    expect(stage.status).toBe(403);
    rpc.mockResolvedValueOnce({ data: { status: 'activated', batch_id: BATCH }, error: null });
    const act = await activatePOST(json(activateBody), ctx());
    expect(act.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith('activate_planning_benchmark_upload', { p_batch: BATCH, p: expect.objectContaining({ expected_sha256: sha, expected_digest: 'b'.repeat(64), self_activation_ack: false }) });
  });

  it('Activate requires the explicit confirmation and a bound hash (422 otherwise, no RPC)', async () => {
    actor({ activate: true });
    expect((await activatePOST(json({ ...activateBody, confirmed: false }), ctx())).status).toBe(422);
    expect((await activatePOST(json({ confirmed: true }), ctx())).status).toBe(422);
    expect((await activatePOST(json(activateBody), ctx('not-a-uuid'))).status).toBe(422);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('NC-R3: a missing capability column (migration not applied) is 503, never a grant and never an empty 200', async () => {
    actor({ upload: true, activate: true });
    adminUsersError = { message: 'column admin_users.can_upload_planning_benchmarks does not exist' };
    const r = await listGET();
    expect(r.status).toBe(503);
    expect((await activatePOST(json(activateBody), ctx())).status).toBe(503);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('a database failure in Activate is an explicit mapped error with no raw database text', async () => {
    actor({ activate: true });
    rpc.mockResolvedValueOnce({ data: null, error: { code: 'XX000', message: 'relation "benchmark_upload_rows" violates something secret' } });
    const r = await activatePOST(json(activateBody), ctx());
    expect(r.status).toBe(500);
    expect(JSON.stringify(await r.json())).not.toContain('benchmark_upload_rows');
  });

  it('curated PB_E_ messages are forwarded without the prefix, with the right status', () => {
    expect(mapRpcError({ message: 'PB_E_STALE: live figures changed since this was staged, stage the file again' })).toMatchObject({ status: 409, code: 'STALE' });
    expect(mapRpcError({ message: 'PB_E_DENIED: not allowed' })).toMatchObject({ status: 403, code: 'FORBIDDEN' });
    expect(mapRpcError({ message: 'PB_E_SELF: tick the acknowledgement' })).toMatchObject({ status: 403 });
    expect(mapRpcError({ code: 'PGRST202', message: 'Could not find the function public.activate_planning_benchmark_upload' })).toMatchObject({ status: 503 });
  });
});

describe('F5 template download (Standard s11)', () => {
  it('serves CSV and XLSX with no-store, an attachment name, and nosniff; refuses unknown kinds and formats', async () => {
    actor({ upload: true });
    const csv = await tpl('values', 'csv');
    expect(csv.status).toBe(200);
    expect(csv.headers.get('cache-control')).toBe('no-store');
    expect(csv.headers.get('content-disposition')).toMatch(/attachment; filename=".*\.csv"/);
    expect(csv.headers.get('x-content-type-options')).toBe('nosniff');
    const x = await tpl('target_ranges', 'xlsx');
    expect(x.status).toBe(200);
    expect(x.headers.get('content-type')).toMatch(/spreadsheetml/);
    expect((await tpl('nope')).status).toBe(404);
    expect((await tpl('values', 'pdf')).status).toBe(422);
  });
});

describe('F5 capability flags and static safety', () => {
  it('flags are strictly === true; view is the union of the two read capabilities only', () => {
    expect(planningBenchmarkFlagsFromRow({ can_upload_planning_benchmarks: 'true', can_activate_planning_benchmarks: 1 })).toEqual({ upload: false, activate: false, view: false });
    expect(planningBenchmarkFlagsFromRow({ can_upload_planning_benchmarks: true, can_activate_planning_benchmarks: false })).toEqual({ upload: true, activate: false, view: true });
    expect(planningBenchmarkFlagsFromRow(null)).toEqual({ upload: false, activate: false, view: false });
  });

  it('NC-R4: no upload route and not the upload service imports the service-role client', () => {
    const root = path.resolve(__dirname, '..', '..');
    const files = [
      'lib/planning-benchmarks/uploadService.ts',
      'lib/planning-benchmarks/routeSupport.ts',
      'lib/planning-benchmarks/guards.ts',
      'app/api/admin/benchmarks/upload/route.ts',
      'app/api/admin/benchmarks/upload/[id]/route.ts',
      'app/api/admin/benchmarks/upload/[id]/activate/route.ts',
      'app/api/admin/benchmarks/upload/[id]/discard/route.ts',
      'app/api/admin/benchmarks/upload/templates/[kind]/route.ts',
    ];
    for (const f of files) {
      const src = fs.readFileSync(path.join(root, f), 'utf8');
      expect(src, f).not.toMatch(/supabase\/admin|createAdminClient|adminClient\(/);
    }
  });
});
