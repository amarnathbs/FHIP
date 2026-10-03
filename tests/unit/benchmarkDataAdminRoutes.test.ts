// BENCH-1 Phase 2 - Market Index Data Admin API: Admin Architecture Standard compliance.
//
// Capabilities touched (six, separately named): view (PC6 can_view_reference_data_quality or any of the
// others, READ only), upload (can_upload_market_index_data), publish (can_publish_benchmark_data),
// correct (can_correct_benchmark_data), catalogue (can_manage_benchmark_catalogue), entitlementApprove
// (can_approve_benchmark_entitlements).
//
// Proves: s2 each capability gates only its routes (capability MATRIX over every route x every
// capability); s4 direct-API denial is an explicit 401/403 on every verb, fail-closed on a read error
// or a missing column; s5 separation of duties (a publisher cannot publish a correction, a corrector
// cannot publish new history, a catalogue admin cannot approve an entitlement, an approver cannot
// propose, an uploader cannot publish); s8 'unavailable' is explicit; s11 the validation-error export
// neutralises formula cells and is no-store; s13 safe failure. The database-bypass test (calling the
// RPCs directly) is scripts/bench1_phase2_0239_pglite_verification.mjs.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { countryRegistryFrom } from './support/countryRegistryFake';

const mockGetUser = vi.fn();
const mockRpc = vi.fn();
let adminRow: { data: Record<string, unknown> | null; error: { message: string } | null } = { data: null, error: null };
let jobMode: 'new_history' | 'correction' | null = 'new_history';
let tableData: Record<string, unknown[]> = {};
let tableError: { code?: string; message: string } | null = null;
const adminClientUsed = vi.fn();

vi.mock('next/navigation', () => ({ redirect: (to: string) => { throw new Error(`REDIRECT:${to}`); } }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => { adminClientUsed(); throw new Error('service-role client must not be used'); } }));

function chain(table: string) {
  const b: Record<string, unknown> = {};
  const self = () => b;
  for (const m of ['select', 'eq', 'neq', 'in', 'order', 'limit', 'gte', 'lte', 'is', 'range']) b[m] = self;
  b.maybeSingle = async () => {
    if (table === 'ii_benchmark_import_jobs') return { data: jobMode ? { mode: jobMode, id: 'j' } : null, error: tableError };
    return { data: (tableData[table] ?? [])[0] ?? null, error: tableError };
  };
  b.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: tableData[table] ?? [], error: tableError, count: (tableData[table] ?? []).length }).then(res);
  return b;
}
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: mockGetUser },
    rpc: mockRpc,
    from: (table: string) => {
      const registry = countryRegistryFrom(table);
      if (registry) return registry;
      if (table === 'admin_users') return { select: () => ({ eq: () => ({ maybeSingle: async () => adminRow }) }) };
      if (table === 'user_profiles') return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { country_of_residence: 'IN', country_confirmed_at: '2026-08-29T00:00:00Z', country_source: 'USER_CONFIRMED', onboarding_completed: true }, error: null }) }) }) };
      return chain(table);
    },
  }),
}));

import { GET as overviewGET } from '@/app/api/admin/investment-intelligence/benchmark-data/overview/route';
import { POST as uploadPOST } from '@/app/api/admin/investment-intelligence/benchmark-data/upload/route';
import { POST as inspectPOST } from '@/app/api/admin/investment-intelligence/benchmark-data/upload/inspect/route';
import { GET as jobsGET } from '@/app/api/admin/investment-intelligence/benchmark-data/jobs/route';
import { GET as jobGET } from '@/app/api/admin/investment-intelligence/benchmark-data/jobs/[id]/route';
import { GET as errorsGET } from '@/app/api/admin/investment-intelligence/benchmark-data/jobs/[id]/errors/route';
import { POST as publishPOST } from '@/app/api/admin/investment-intelligence/benchmark-data/jobs/[id]/publish/route';
import { POST as cancelPOST } from '@/app/api/admin/investment-intelligence/benchmark-data/jobs/[id]/cancel/route';
import { POST as rollbackPOST } from '@/app/api/admin/investment-intelligence/benchmark-data/jobs/[id]/rollback/route';
import { GET as templatesGET } from '@/app/api/admin/investment-intelligence/benchmark-data/templates/[name]/route';
import { GET as helpGET } from '@/app/api/admin/investment-intelligence/benchmark-data/help/route';
import { GET as catalogueGET, POST as cataloguePOST } from '@/app/api/admin/investment-intelligence/benchmark-data/catalogue/route';
import { POST as verifyPOST } from '@/app/api/admin/investment-intelligence/benchmark-data/catalogue/[id]/verify/route';
import { GET as entitlementsGET, POST as entitlementsPOST } from '@/app/api/admin/investment-intelligence/benchmark-data/entitlements/route';
import { POST as approvePOST } from '@/app/api/admin/investment-intelligence/benchmark-data/entitlements/[id]/approve/route';
import { POST as revokePOST } from '@/app/api/admin/investment-intelligence/benchmark-data/entitlements/[id]/revoke/route';
import { GET as mappingsGET, POST as mappingsPOST } from '@/app/api/admin/investment-intelligence/benchmark-data/mappings/route';
import { POST as reviewPOST } from '@/app/api/admin/investment-intelligence/benchmark-data/mappings/[id]/review/route';
import { GET as unmappedGET } from '@/app/api/admin/investment-intelligence/benchmark-data/mappings/unmapped/route';
import { POST as modePOST } from '@/app/api/admin/investment-intelligence/benchmark-data/ingestion/[id]/mode/route';
import { flagsFromAdminRow, requireBenchmarkPage, NO_BENCHMARK_CAPABILITIES } from '@/lib/services/investment-intelligence/benchmarkData/guards';
import { mapRpcError } from '@/lib/services/investment-intelligence/benchmarkData/publishService';
import { buildJobErrorCsv } from '@/lib/services/investment-intelligence/benchmarkData/publishService';
import { buildAdminNavGroups, NO_ADMIN_CAPABILITIES, parseAdminCapabilities } from '@/lib/admin/adminNav';
import { GET as meGET } from '@/app/api/admin/me/route';

const ROOT = path.resolve(__dirname, '..', '..');
const ID = '11111111-1111-4111-8111-111111111111';
const BASE = 'http://test/api/admin/investment-intelligence/benchmark-data';
const params = { params: Promise.resolve({ id: ID }) };

const COLUMN = {
  view: 'can_view_reference_data_quality',
  upload: 'can_upload_market_index_data',
  publish: 'can_publish_benchmark_data',
  correct: 'can_correct_benchmark_data',
  catalogue: 'can_manage_benchmark_catalogue',
  entitlementApprove: 'can_approve_benchmark_entitlements',
} as const;
type Cap = keyof typeof COLUMN;
const CAPS = Object.keys(COLUMN) as Cap[];
const hasOnly = (cap: Cap) => ({ data: { [COLUMN[cap]]: true } as Record<string, unknown>, error: null });

const json = (body: unknown) => new Request(`${BASE}/x`, { method: 'POST', body: JSON.stringify(body) });
const KEY = 'IN_NIFTY_100_TRI';

function multipart(params: unknown) {
  const form = new FormData();
  form.set('file', new File(['date,value\n2024-01-01,1000\n'], 'x.csv', { type: 'text/csv' }));
  form.set('params', JSON.stringify(params));
  return new Request(`${BASE}/upload`, { method: 'POST', body: form });
}
const sha = 'a'.repeat(64);

interface RouteCase {
  name: string;
  /** Capabilities that must PASS the guard (everything else must be 403). */
  allowed: Cap[];
  call: () => Promise<Response>;
}
const READ_ALLOWED: Cap[] = [...CAPS]; // view is the union of read access
const ROUTES: RouteCase[] = [
  { name: 'GET overview', allowed: READ_ALLOWED, call: () => overviewGET() },
  { name: 'POST upload', allowed: ['upload'], call: () => uploadPOST(multipart({})) },
  { name: 'POST upload/inspect', allowed: ['upload'], call: () => inspectPOST(multipart({})) },
  { name: 'GET jobs', allowed: READ_ALLOWED, call: () => jobsGET() },
  { name: 'GET jobs/[id]', allowed: READ_ALLOWED, call: () => jobGET(new Request(BASE), params) },
  { name: 'GET jobs/[id]/errors', allowed: READ_ALLOWED, call: () => errorsGET(new Request(BASE), params) },
  { name: 'POST jobs/[id]/publish (new_history job)', allowed: ['publish'], call: () => { jobMode = 'new_history'; return publishPOST(json({ expectedSha256: sha, expectedDigest: sha, expectedCounts: { new: 1, identical: 0, correction: 0 }, acknowledged: [] }), params); } },
  { name: 'POST jobs/[id]/publish (correction job)', allowed: ['correct'], call: () => { jobMode = 'correction'; return publishPOST(json({ expectedSha256: sha, expectedDigest: sha, expectedCounts: { new: 0, identical: 0, correction: 1 }, acknowledged: [] }), params); } },
  { name: 'POST jobs/[id]/cancel', allowed: ['upload', 'publish', 'correct'], call: () => cancelPOST(json({}), params) },
  { name: 'POST jobs/[id]/rollback', allowed: ['correct'], call: () => rollbackPOST(json({ reason: 'x'.repeat(25) }), params) },
  { name: 'GET templates/[name]', allowed: READ_ALLOWED, call: () => templatesGET(new Request(BASE), { params: Promise.resolve({ name: 'single_date_value' }) }) },
  { name: 'GET help', allowed: READ_ALLOWED, call: () => helpGET() },
  { name: 'GET catalogue', allowed: READ_ALLOWED, call: () => catalogueGET() },
  { name: 'POST catalogue', allowed: ['catalogue'], call: () => cataloguePOST(json({})) },
  { name: 'POST catalogue/[id]/verify', allowed: ['catalogue'], call: () => verifyPOST(json({ note: 'verified against the owner page' }), params) },
  { name: 'GET entitlements', allowed: READ_ALLOWED, call: () => entitlementsGET() },
  { name: 'POST entitlements (propose)', allowed: ['catalogue'], call: () => entitlementsPOST(json({})) },
  { name: 'POST entitlements/[id]/approve', allowed: ['entitlementApprove'], call: () => approvePOST(json({ note: 'approved after review' }), params) },
  { name: 'POST entitlements/[id]/revoke', allowed: ['entitlementApprove'], call: () => revokePOST(json({ reason: 'licence ended on the owner side' }), params) },
  { name: 'GET mappings', allowed: READ_ALLOWED, call: () => mappingsGET() },
  { name: 'GET mappings/unmapped (schemes with no mapping, counts by category)', allowed: READ_ALLOWED, call: () => unmappedGET() },
  { name: 'POST mappings (propose)', allowed: ['catalogue'], call: () => mappingsPOST(json({})) },
  { name: 'POST mappings/[id]/review', allowed: ['catalogue'], call: () => reviewPOST(json({ decision: 'reject', note: 'rejected: ambiguous tier' }), params) },
  { name: 'POST ingestion/[id]/mode', allowed: ['catalogue'], call: () => modePOST(json({ mode: 'manual_import', automationEnabled: false, reason: 'governed manual import mode' }), params) },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockGetUser.mockResolvedValue({ data: { user: { id: 'admin-1' } } });
  adminRow = hasOnly('view');
  jobMode = 'new_history';
  tableData = {};
  tableError = null;
  mockRpc.mockResolvedValue({ data: null, error: null });
});

describe('s2/s4: capability MATRIX - every route x every capability (each capability gates only its own routes)', () => {
  for (const r of ROUTES) {
    it(`${r.name}: unauthenticated -> 401`, async () => {
      mockGetUser.mockResolvedValue({ data: { user: null } });
      expect((await r.call()).status).toBe(401);
      expect(mockRpc).not.toHaveBeenCalled();
    });
    it(`${r.name}: authenticated with NO admin row -> 403 and no RPC`, async () => {
      adminRow = { data: null, error: null };
      expect((await r.call()).status).toBe(403);
      expect(mockRpc).not.toHaveBeenCalled();
    });
    for (const cap of CAPS) {
      const should = r.allowed.includes(cap);
      it(`${r.name}: holder of ONLY ${cap} -> ${should ? 'passes the guard' : '403'}`, async () => {
        adminRow = hasOnly(cap);
        const res = await r.call();
        if (should) expect([401, 403], `${r.name} must not be denied for ${cap}`).not.toContain(res.status);
        else {
          expect(res.status, `${r.name} must be denied for ${cap}`).toBe(403);
          expect(mockRpc, 'a denied caller must never reach an RPC').not.toHaveBeenCalled();
        }
      });
    }
  }
});

describe('s13 fail closed', () => {
  it('a role-resolution error is a denial on every route', async () => {
    adminRow = { data: null, error: { message: 'column admin_users.can_publish_benchmark_data does not exist' } };
    for (const r of ROUTES) expect((await r.call()).status, r.name).toBe(403);
  });
  it('a row missing the columns (migration 0239 not applied) grants nothing; a truthy non-true value grants nothing', async () => {
    adminRow = { data: {}, error: null };
    expect((await overviewGET()).status).toBe(403);
    adminRow = { data: { can_publish_benchmark_data: 'true', can_upload_market_index_data: 1 }, error: null };
    expect((await jobsGET()).status).toBe(403);
    expect(flagsFromAdminRow({ can_publish_benchmark_data: 'true' })).toEqual(NO_BENCHMARK_CAPABILITIES);
    expect(flagsFromAdminRow(null)).toEqual(NO_BENCHMARK_CAPABILITIES);
  });
  it('s8: when the benchmark governance tables are absent the overview is an explicit UNAVAILABLE state (not an empty healthy dashboard)', async () => {
    tableError = { code: '42P01', message: 'relation "ii_benchmark_ingestion_state" does not exist' };
    const res = await overviewGET();
    expect(res.status).toBe(200);
    const body = (await res.json()).data;
    expect(body.state).toBe('unavailable');
    expect(body.reason).toMatch(/not available/i);
    expect(body.rows).toEqual([]);
  });
  it('any other database error on the overview is an explicit error, never an empty success', async () => {
    tableError = { code: '57P01', message: 'terminating connection' };
    expect((await overviewGET()).status).toBeGreaterThanOrEqual(500);
  });
});

describe('s5 separation of duties across capabilities', () => {
  it('a publisher cannot publish a CORRECTION job and a corrector cannot publish NEW history', async () => {
    jobMode = 'correction';
    adminRow = hasOnly('publish');
    const body = { expectedSha256: sha, expectedDigest: sha, expectedCounts: { new: 0, identical: 0, correction: 1 }, acknowledged: [] };
    expect((await publishPOST(json(body), params)).status).toBe(403);
    jobMode = 'new_history';
    adminRow = hasOnly('correct');
    expect((await publishPOST(json({ ...body, expectedCounts: { new: 1, identical: 0, correction: 0 } }), params)).status).toBe(403);
    expect(mockRpc).not.toHaveBeenCalled();
  });
  it('an uploader (stage) cannot publish, rollback, approve an entitlement or edit the catalogue', async () => {
    adminRow = hasOnly('upload');
    expect((await publishPOST(json({ expectedSha256: sha, expectedDigest: sha, expectedCounts: { new: 1, identical: 0, correction: 0 }, acknowledged: [] }), params)).status).toBe(403);
    expect((await rollbackPOST(json({ reason: 'x'.repeat(25) }), params)).status).toBe(403);
    expect((await approvePOST(json({ note: 'approve it please' }), params)).status).toBe(403);
    expect((await cataloguePOST(json({}))).status).toBe(403);
  });
  it('a catalogue admin cannot approve an entitlement; an approver cannot propose one', async () => {
    adminRow = hasOnly('catalogue');
    expect((await approvePOST(json({ note: 'approve it please' }), params)).status).toBe(403);
    adminRow = hasOnly('entitlementApprove');
    expect((await entitlementsPOST(json({}))).status).toBe(403);
  });
  it('a view-only (PC6) admin is denied EVERY write route', async () => {
    adminRow = hasOnly('view');
    for (const r of ROUTES.filter((x) => !x.allowed.includes('view'))) expect((await r.call()).status, r.name).toBe(403);
  });
});

describe('validation, size and shape (422 / 413) after authorisation', () => {
  it('upload: a missing file is 422, malformed params JSON is 422, an invalid params object is 422 and nothing is staged', async () => {
    adminRow = hasOnly('upload');
    expect((await uploadPOST(new Request(`${BASE}/upload`, { method: 'POST', body: 'not multipart', headers: { 'content-type': 'text/plain' } }))).status).toBe(422);
    const form = new FormData();
    form.set('params', '{}');
    expect((await uploadPOST(new Request(`${BASE}/upload`, { method: 'POST', body: form }))).status).toBe(422);
    const bad = new FormData();
    bad.set('file', new File(['x'], 'x.csv'));
    bad.set('params', 'not json');
    expect((await uploadPOST(new Request(`${BASE}/upload`, { method: 'POST', body: bad }))).status).toBe(422);
    expect((await uploadPOST(multipart({ shape: 'single' }))).status).toBe(422);
    expect(mockRpc).not.toHaveBeenCalled();
  });
  it('upload: an oversize declared content-length is 413 before the body is read', async () => {
    adminRow = hasOnly('upload');
    const req = new Request(`${BASE}/upload`, { method: 'POST', body: 'x', headers: { 'content-length': String(50 * 1024 * 1024) } });
    expect((await uploadPOST(req)).status).toBe(413);
  });
  it('upload: a correction without a >= 20 character reason is 422', async () => {
    adminRow = hasOnly('upload');
    const good = { shape: 'single', mode: 'correction', benchmarkKey: KEY, returnVariant: 'total_return', currencyCode: 'INR', historyClass: 'live', dateFormat: 'YYYY-MM-DD', numberLocale: 'plain', sourceOwner: 'Owner Ltd', sourceReference: 'https://example.test/file' };
    expect((await uploadPOST(multipart({ ...good, reason: 'too short' }))).status).toBe(422);
  });
  it('bad ids are 422; unknown template is 404; malformed governance bodies are 422 with no RPC', async () => {
    adminRow = hasOnly('catalogue');
    expect((await verifyPOST(json({ note: 'verified against the owner page' }), { params: Promise.resolve({ id: 'not-a-uuid' }) })).status).toBe(422);
    expect((await verifyPOST(json({ note: 'short' }), params)).status).toBe(422);
    expect((await reviewPOST(json({ decision: 'maybe', note: 'a long enough note' }), params)).status).toBe(422);
    expect((await modePOST(json({ mode: 'turbo', automationEnabled: true, reason: 'a long enough reason' }), params)).status).toBe(422);
    expect((await cataloguePOST(json({ benchmark_key: 'lowercase bad' }))).status).toBe(422);
    adminRow = hasOnly('view');
    expect((await templatesGET(new Request(BASE), { params: Promise.resolve({ name: '../../etc/passwd' }) })).status).toBe(404);
    expect(mockRpc).not.toHaveBeenCalled();
  });
  it('rollback needs a reason of >= 20 characters', async () => {
    adminRow = hasOnly('correct');
    expect((await rollbackPOST(json({ reason: 'short' }), params)).status).toBe(422);
  });
});

describe('publish failure mapping (the database is the authority; the route only translates)', () => {
  const body = { expectedSha256: sha, expectedDigest: sha, expectedCounts: { new: 1, identical: 0, correction: 0 }, acknowledged: [] };
  const cases: Array<[string, number, string]> = [
    ['42501', 403, 'forbidden'],
    ['40001', 409, 'stale'],
    ['23505', 409, 'duplicate'],
    ['22023', 422, 'invalid'],
    ['55000', 409, 'wrong_state'],
  ];
  for (const [code, status, kind] of cases) {
    it(`SQLSTATE ${code} -> HTTP ${status} (${kind}) and never a success`, async () => {
      adminRow = hasOnly('publish');
      mockRpc.mockResolvedValue({ data: null, error: { code, message: 'operator-safe sentence' } });
      const res = await publishPOST(json(body), params);
      expect(res.status).toBe(status);
      expect((await res.json()).code).toBe(kind);
    });
  }
  it('an unknown database error is a 503 with a generic message (no internals leak)', async () => {
    adminRow = hasOnly('publish');
    mockRpc.mockResolvedValue({ data: null, error: { code: 'XX000', message: 'relation ii_benchmark_series internal detail' } });
    const res = await publishPOST(json(body), params);
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).not.toContain('ii_benchmark_series');
  });
  it('a stale preview is recorded on the job (recoverable: re-stage) via record_benchmark_import_failure', async () => {
    adminRow = hasOnly('publish');
    mockRpc.mockResolvedValue({ data: null, error: { code: '40001', message: 'stale preview' } });
    await publishPOST(json(body), params);
    expect(mockRpc.mock.calls.map((c) => c[0])).toEqual(['publish_benchmark_import', 'record_benchmark_import_failure']);
  });
  it('success passes the checksum, digest, counts and acknowledgements to the RPC under the caller session', async () => {
    adminRow = hasOnly('publish');
    mockRpc.mockResolvedValue({ data: { already_published: false, job_id: ID, batch_id: 'b1', inserted: 1, revived: 0, corrected: 0, identical_skipped: 0, date_from: '2024-01-01', date_to: '2024-01-01' }, error: null });
    const res = await publishPOST(json({ ...body, acknowledged: ['large_moves'], selfPublishAck: true }), params);
    expect(res.status).toBe(200);
    const [name, args] = mockRpc.mock.calls[0];
    expect(name).toBe('publish_benchmark_import');
    expect(args).toMatchObject({ p_job: ID, p: { expected_sha256: sha, expected_digest: sha, expected_counts: { new: 1, identical: 0, correction: 0 }, acknowledged: ['large_moves'], self_publish_ack: true } });
    expect(adminClientUsed).not.toHaveBeenCalled();
  });
  it('mapRpcError is total: every code maps to a typed failure', () => {
    for (const code of ['42501', '40001', '23505', '22023', '23514', '55000', 'P0002', undefined]) {
      const f = mapRpcError({ code, message: 'm' });
      expect(f.status).toBe('failed');
      expect(f.httpStatus).toBeGreaterThanOrEqual(400);
    }
  });
});

describe('s11 export: the validation-error CSV', () => {
  it('neutralises formula cells, is text/csv, no-store, nosniff and has a non-identifying file name', async () => {
    adminRow = hasOnly('view');
    tableData = {
      ii_benchmark_import_jobs: [{ id: ID }],
      ii_benchmark_import_errors: [{ row_no: 3, severity: 'error', code: 'VALUE_NOT_NUMERIC', message: '=HYPERLINK("http://evil.test","x")', raw_excerpt: '@SUM(A1:A9)' }, { row_no: 4, severity: 'error', code: 'X', message: '+1+1', raw_excerpt: '-2' }],
    };
    const res = await errorsGET(new Request(BASE), params);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-disposition')).toMatch(/filename="benchmark-import-11111111-validation\.csv"/);
    const text = await res.text();
    expect(text).not.toMatch(/(^|,)"?=HYPERLINK/m);
    expect(text).toContain("'=HYPERLINK");
    expect(text).toContain("'@SUM");
    expect(text).toContain("'+1+1");
  });
  it('buildJobErrorCsv returns null for an unknown job (404 at the route), never an empty file', async () => {
    adminRow = hasOnly('view');
    tableData = {};
    const fake = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) };
    expect(await buildJobErrorCsv(fake as never, ID)).toBeNull();
    jobMode = null;
    expect((await errorsGET(new Request(BASE), params)).status).toBe(404);
  });
  it('templates are text/csv attachments, no-store', async () => {
    adminRow = hasOnly('view');
    const res = await templatesGET(new Request(BASE), { params: Promise.resolve({ name: 'single_date_value' }) });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toMatch(/^date,value/);
  });
});

describe('s9 / s14: no service-role client, no other admin identifiers (static)', () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === 'route.ts') files.push(p);
    }
  };
  walk(path.join(ROOT, 'app/api/admin/investment-intelligence/benchmark-data'));
  it('discovers every benchmark-data route (19 handlers across the route files)', () => {
    expect(files.length).toBeGreaterThanOrEqual(19);
  });
  it('no route file mentions the service-role client or key', () => {
    for (const f of files) expect(fs.readFileSync(f, 'utf8'), f).not.toMatch(/createAdminClient|adminClient\(\)|SERVICE_ROLE|service_role/);
  });
  it('every route file calls a capability guard before any other work (guarded(...) / requireBenchmarkCapability)', () => {
    for (const f of files) expect(fs.readFileSync(f, 'utf8'), f).toMatch(/guarded\('|requireBenchmarkCapability\(/);
  });
  it('the jobs list never returns another admin identifier', async () => {
    adminRow = hasOnly('view');
    tableData = { ii_benchmark_import_jobs: [{ id: ID, status: 'published', mode: 'new_history', shape: 'single', file_name: 'a.csv', file_format: 'csv', file_sha256: sha, benchmark_keys: [KEY], return_variant: 'total_return', currency_code: 'INR', history_class: 'live', rows_total: 1, rows_new: 1, rows_identical: 0, rows_correction: 0, rows_revive: 0, hard_error_total: 0, warning_count: 0, required_acks: [], eligible: true, staged_at: 'x', validated_at: 'x', published_at: 'x', rolled_back_at: null, expires_at: 'x', staged_by: 'someone-else-id', published_by: 'another-admin-id', self_published: false, duplicate_of: null, error_code: null, source_owner: 'Owner', source_reference: 'https://x.test/y', reason: null }] };
    const res = await jobsGET();
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain('someone-else-id');
    expect(text).not.toContain('another-admin-id');
    expect(text).toContain('"stagedByMe":false');
  });
});

describe('page + nav + /me (s4 layers 3 and 4)', () => {
  it('the page guard redirects a caller without any benchmark capability to /dashboard and a logged-out caller to /login; a viewer passes', async () => {
    adminRow = { data: {}, error: null };
    await expect(requireBenchmarkPage('view')).rejects.toThrow('REDIRECT:/dashboard');
    mockGetUser.mockResolvedValue({ data: { user: null } });
    await expect(requireBenchmarkPage('view')).rejects.toThrow('REDIRECT:/login');
    mockGetUser.mockResolvedValue({ data: { user: { id: 'admin-1' } } });
    adminRow = hasOnly('view');
    await expect(requireBenchmarkPage('view')).resolves.toMatchObject({ user: { id: 'admin-1' } });
    adminRow = hasOnly('upload');
    await expect(requireBenchmarkPage('publish')).rejects.toThrow('REDIRECT:/dashboard');
  });
  it('the Market Index Data nav group shows for each of the six capabilities independently and for none other', () => {
    const label = (caps: object) => buildAdminNavGroups(false, { ...NO_ADMIN_CAPABILITIES, ...caps }).map((g) => g.label);
    for (const k of ['marketIndexDataUpload', 'benchmarkDataView', 'benchmarkDataPublish', 'benchmarkDataCorrect', 'benchmarkCatalogueManage', 'benchmarkEntitlementApprove', 'referenceDataQuality']) {
      expect(label({ [k]: true }), k).toContain(k === 'referenceDataQuality' ? 'Reference Data' : 'Market Index Data');
    }
    expect(label({ lookthroughDataQuality: true })).not.toContain('Market Index Data');
    expect(label({})).toEqual([]);
  });
  it('the parser is strictly === true for the new capabilities and defaults closed', () => {
    expect(parseAdminCapabilities({ data: { capabilities: { benchmarkDataPublish: 'yes', benchmarkEntitlementApprove: true } } })).toMatchObject({ benchmarkDataPublish: false, benchmarkEntitlementApprove: true });
    expect(NO_ADMIN_CAPABILITIES.benchmarkDataCorrect).toBe(false);
  });
  it('GET /api/admin/me reports each new capability from its own column and false when absent or erroring', async () => {
    adminRow = { data: { can_publish_benchmark_data: true, can_correct_benchmark_data: false }, error: null };
    const c = (await (await meGET()).json()).data.capabilities;
    expect(c).toMatchObject({ benchmarkDataPublish: true, benchmarkDataCorrect: false, benchmarkCatalogueManage: false, benchmarkEntitlementApprove: false, benchmarkDataView: true });
    adminRow = { data: null, error: { message: 'boom' } };
    const d = (await (await meGET()).json()).data.capabilities;
    expect(d).toMatchObject({ benchmarkDataPublish: false, benchmarkDataView: false });
  });
});
