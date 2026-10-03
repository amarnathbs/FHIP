// Factsheet benchmark reader: Admin Architecture Standard compliance of the NEW surfaces, and the cron route.
//
// Admin capabilities affected (no new capability): `view` (read the queue; the held-schemes list enrichment) and
// `catalogue` (decide a queued change). The terms-status setter uses the existing entitlement-approver capability
// inside the database (tests/unit/factsheetReaderMigration.test.ts).
//
// Standard clauses covered: s2 (each route gates on its own named capability: matrix over every capability),
// s4 (explicit 401 / 403; fail closed on a role-resolution error), s8 ('unavailable' is an explicit 503, never an empty
// success), s9 (no personal data in any response), s13 (a failing read is an explicit error). Database-bypass: the
// functions are service-role / capability-checked inside the database (migration test; PGlite script).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { countryRegistryFrom } from './support/countryRegistryFake';

const mockGetUser = vi.fn();
const mockRpc = vi.fn();
let adminRow: { data: Record<string, unknown> | null; error: { message: string } | null } = { data: null, error: null };
let tableData: Record<string, unknown[]> = {};
let tableError: Record<string, { code?: string; message: string }> = {};
const adminClientUsed = vi.fn();
let cronFakeControl: { enabled: boolean; disabled_reason: string | null } | null = null;

vi.mock('next/navigation', () => ({ redirect: (to: string) => { throw new Error(`REDIRECT:${to}`); } }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => {
    adminClientUsed();
    const chain = (table: string) => {
      const b: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'in', 'order', 'limit', 'update']) b[m] = () => b;
      b.maybeSingle = async () => ({ data: table === 'ii_reference_job_control' ? cronFakeControl && { job_key: 'factsheet_benchmark_reader', consecutive_failures: 0, next_attempt_not_before: null, last_success_at: null, ...cronFakeControl } : null, error: null });
      b.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(res);
      return b;
    };
    return { from: chain, rpc: async () => ({ data: [], error: null }) };
  },
}));

function chain(table: string) {
  const b: Record<string, unknown> = {};
  const self = () => b;
  for (const m of ['select', 'eq', 'neq', 'in', 'order', 'limit', 'gte', 'lte', 'is', 'range']) b[m] = self;
  b.maybeSingle = async () => ({ data: (tableData[table] ?? [])[0] ?? null, error: tableError[table] ?? null });
  b.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: tableError[table] ? null : (tableData[table] ?? []), error: tableError[table] ?? null }).then(res);
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

import { GET as changesGET } from '@/app/api/admin/investment-intelligence/benchmark-data/factsheet/changes/route';
import { POST as reviewPOST } from '@/app/api/admin/investment-intelligence/benchmark-data/factsheet/changes/[id]/review/route';
import { GET as heldGET } from '@/app/api/admin/investment-intelligence/benchmark-data/mappings/held/route';
import { POST as cronPOST } from '@/app/api/investment-intelligence/cron/factsheet-benchmark-reader/route';

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

const ROUTES: Array<{ name: string; allowed: Cap[]; call: () => Promise<Response> }> = [
  { name: 'GET factsheet/changes', allowed: [...CAPS], call: () => changesGET() },
  { name: 'GET mappings/held (with the factsheet enrichment)', allowed: [...CAPS], call: () => heldGET() },
  { name: 'POST factsheet/changes/[id]/review', allowed: ['catalogue'], call: () => reviewPOST(json({ decision: 'reject', note: 'rejected: ambiguous tier' }), params) },
];

const VERSION = {
  id: 'v-2',
  instrument_id: 'i-1',
  version_no: 2,
  supersedes_version_id: 'v-1',
  tier1_name: 'NIFTY 50 Hybrid Composite Debt 50:50 Index (Total Returns Index)',
  additional_names: ['NIFTY 50 TRI'],
  benchmark_kind: 'single_index',
  composition: [],
  catalogue_state: 'matched_verified',
  match_confidence: 'high',
  effective_from: '2024-06-01',
  effective_from_basis: 'estimated_document_month',
  source_url: 'https://files.hdfcfund.com/x.pdf',
  source_title: null,
  source_document_type: 'amc_sid',
  document_date: '2024-06-28',
  document_month: '2024-06-01',
  retrieved_at: '2026-10-03T02:00:00.000Z',
  extraction_method: 'text_pattern',
  extraction_confidence: 'high',
  evidence_excerpt: 'Benchmark: NIFTY 50 Hybrid Composite Debt 50:50 Index',
  review_state: 'pending_review',
  review_reason: 'The declared benchmark changed.',
  ii_instruments: { instrument_name: 'HDFC Balanced Advantage Fund - Regular Plan - Growth' },
  ii_benchmarks: { benchmark_key: 'IN_NIFTY50_HYBRID_COMP_DEBT_5050_TRI' },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetUser.mockResolvedValue({ data: { user: { id: 'admin-1' } } });
  adminRow = hasOnly('view');
  tableData = {};
  tableError = {};
  cronFakeControl = null;
  mockRpc.mockResolvedValue({ data: [], error: null });
});

describe('s2 / s4: capability matrix for the new routes', () => {
  for (const r of ROUTES) {
    it(`${r.name}: unauthenticated -> 401 and no database call`, async () => {
      mockGetUser.mockResolvedValue({ data: { user: null } });
      expect((await r.call()).status).toBe(401);
      expect(mockRpc).not.toHaveBeenCalled();
    });
    it(`${r.name}: signed in with NO admin row -> 403 and no RPC`, async () => {
      adminRow = { data: null, error: null };
      expect((await r.call()).status).toBe(403);
      expect(mockRpc).not.toHaveBeenCalled();
    });
    for (const cap of CAPS) {
      const should = r.allowed.includes(cap);
      it(`${r.name}: holder of ONLY ${cap} -> ${should ? 'passes the guard' : '403, no RPC'}`, async () => {
        adminRow = hasOnly(cap);
        const res = await r.call();
        if (should) expect([401, 403]).not.toContain(res.status);
        else {
          expect(res.status).toBe(403);
          expect(mockRpc).not.toHaveBeenCalled();
        }
      });
    }
  }
  it('s13: a role-resolution error is a denial on every new route; a truthy non-true column grants nothing', async () => {
    adminRow = { data: null, error: { message: 'column admin_users.can_manage_benchmark_catalogue does not exist' } };
    for (const r of ROUTES) expect((await r.call()).status, r.name).toBe(403);
    adminRow = { data: { can_manage_benchmark_catalogue: 'true', can_view_reference_data_quality: 1 }, error: null };
    for (const r of ROUTES) expect((await r.call()).status, r.name).toBe(403);
  });
  it('a view-only admin cannot decide a change (separation of duties): the RPC is never reached', async () => {
    adminRow = hasOnly('view');
    expect((await reviewPOST(json({ decision: 'approve', note: 'approved after reading it' }), params)).status).toBe(403);
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

describe('the queue', () => {
  it('returns the waiting items with previous / new benchmark, document, confidence and evidence; and no personal data', async () => {
    tableData = {
      ii_scheme_declared_benchmark_versions: [VERSION, { ...VERSION, id: 'v-1', supersedes_version_id: null, tier1_name: 'NIFTY 50 Hybrid Composite Debt 65:35 Index (TRI)', review_state: 'awaiting_confirmation' }],
      ii_factsheet_version_events: [{ version_id: 'v-2', event_type: 'proposal_created', proposal_id: 'p-1', created_at: '2026-10-03' }],
      ii_factsheet_sources: [{ source_key: 'hdfc_baf_sid_2024_06', amc_name: 'HDFC Mutual Fund', document_type: 'amc_sid', host: 'files.hdfcfund.com', terms_review_status: 'not_reviewed', enabled: true }],
      ii_reference_job_control: [{ enabled: false }],
    };
    const res = await changesGET();
    expect(res.status).toBe(200);
    const body = (await res.json()).data;
    expect(body.state).toBe('ok');
    expect(body.readerSwitchedOn).toBe(false);
    expect(body.sources[0]).toMatchObject({ termsReviewStatus: 'not_reviewed' });
    const item = body.items.find((i: { versionId: string }) => i.versionId === 'v-2');
    expect(item).toMatchObject({ kind: 'changed', newBenchmark: expect.stringMatching(/50:50/), instrumentName: expect.stringMatching(/HDFC Balanced/), documentUrl: 'https://files.hdfcfund.com/x.pdf', proposalId: 'p-1', canApprove: true, extractionConfidence: 'high' });
    const wire = JSON.stringify(body);
    expect(wire).not.toMatch(/user_id|holder|folio|units|amount|email/i);
  });
  it('s8: when the factsheet tables are absent the answer is an explicit 503 (never an empty 200)', async () => {
    tableError.ii_scheme_declared_benchmark_versions = { code: '42P01', message: 'relation "ii_scheme_declared_benchmark_versions" does not exist' };
    const res = await changesGET();
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe('unavailable');
  });
  it('s13: any other read failure is an explicit error, never an empty success', async () => {
    tableError.ii_factsheet_sources = { code: '57P01', message: 'terminating connection' };
    tableData.ii_scheme_declared_benchmark_versions = [];
    expect((await changesGET()).status).toBeGreaterThanOrEqual(500);
  });
  it('"cannot read the switch" is reported as unknown (null), never as on', async () => {
    tableError.ii_reference_job_control = { code: '42501', message: 'permission denied' };
    tableData.ii_scheme_declared_benchmark_versions = [];
    tableData.ii_factsheet_sources = [];
    const body = (await (await changesGET()).json()).data;
    expect(body.readerSwitchedOn).toBeNull();
  });
});

describe('deciding a change', () => {
  it('validates the body (note of at least 10 characters, a known decision) before any RPC', async () => {
    adminRow = hasOnly('catalogue');
    expect((await reviewPOST(json({ decision: 'approve', note: 'short' }), params)).status).toBe(422);
    expect((await reviewPOST(json({ decision: 'publish-it', note: 'a long enough note' }), params)).status).toBe(422);
    expect((await reviewPOST(new Request(`${BASE}/x`, { method: 'POST', body: 'not json' }), params)).status).toBe(422);
    expect((await reviewPOST(json({ decision: 'approve', note: 'a long enough note' }), { params: Promise.resolve({ id: 'not-a-uuid' }) })).status).toBe(422);
    expect(mockRpc).not.toHaveBeenCalled();
  });
  it('approve calls the review FUNCTION (which uses the existing mapping review path) with the version, decision, note and closePrevious', async () => {
    adminRow = hasOnly('catalogue');
    mockRpc.mockResolvedValue({ data: { decision: 'approve', mapping_id: 'map-1' }, error: null });
    const res = await reviewPOST(json({ decision: 'approve', note: 'checked against the SID, close the old one', closePrevious: true }), params);
    expect(res.status).toBe(200);
    expect(mockRpc).toHaveBeenCalledWith('review_factsheet_change', { p_version: ID, p_decision: 'approve', p_note: 'checked against the SID, close the old one', p_close_previous: true });
    expect((await res.json()).data).toEqual({ decision: 'approve', mappingId: 'map-1' });
  });
  it('the four decisions are accepted; the database refusal of a repeat decision is surfaced, not hidden', async () => {
    adminRow = hasOnly('catalogue');
    for (const d of ['approve', 'reject', 'manual', 'acknowledge']) expect((await reviewPOST(json({ decision: d, note: 'a long enough note' }), params)).status, d).toBe(200);
    mockRpc.mockResolvedValue({ data: null, error: { code: '55000', message: 'factsheet review: this item has already been decided' } });
    const res = await reviewPOST(json({ decision: 'reject', note: 'a long enough note' }), params);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
  it('the route never imports the service-role client', () => {
    for (const f of ['app/api/admin/investment-intelligence/benchmark-data/factsheet/changes/route.ts', 'app/api/admin/investment-intelligence/benchmark-data/factsheet/changes/[id]/review/route.ts', 'app/api/admin/investment-intelligence/benchmark-data/mappings/held/route.ts']) {
      expect(fs.readFileSync(path.join(ROOT, f), 'utf8'), f).not.toMatch(/createAdminClient|service_role|SUPABASE_SERVICE_ROLE/);
    }
    expect(adminClientUsed).not.toHaveBeenCalled();
  });
});

describe('held-schemes list: last factsheet check, and a declared-but-unsupported scheme', () => {
  const HELD_ROW = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ instrument_id: id, instrument_name: name, amc_name: 'X', amfi_scheme_code: '1', sub_category: 'Multi Asset Allocation', category_header_raw: null, holder_count: null, first_held_date: null, mapped: false, proposal_waiting: false, ...extra });
  function rpcFor(held: unknown[], declared: unknown) {
    mockRpc.mockImplementation(async (name: string) => {
      if (name === 'benchmark_held_schemes') return { data: held, error: null };
      if (name === 'declared_benchmark_records_for') return declared as { data: unknown; error: unknown };
      return { data: null, error: null };
    });
  }
  it('shows the declared benchmark with "cannot be compared" (no category benchmark, no number) and the last check date and result', async () => {
    rpcFor([HELD_ROW('i-multi', 'SBI Multi Asset Allocation Fund'), HELD_ROW('i-plain', 'Some Large Cap Fund', { sub_category: 'Large Cap Fund' })], {
      data: [{ instrument_id: 'i-multi', declared_name: '45% BSE 500 TRI + 40% Crisil Composite Bond Fund Index + 10% Domestic prices of Gold + 5% Domestic prices of silver', benchmark_kind: 'composite', catalogue_state: 'unsupported_composite' }],
      error: null,
    });
    tableData.ii_factsheet_attempts = [
      { instrument_id: 'i-multi', attempted_at: '2026-10-03T02:00:00.000Z', outcome: 'recorded_first_observation', document_date: '2026-04-30' },
      { instrument_id: 'i-multi', attempted_at: '2026-09-03T02:00:00.000Z', outcome: 'document_too_large', document_date: null },
    ];
    const res = await heldGET();
    expect(res.status).toBe(200);
    const body = (await res.json()).data;
    const multi = body.rows.find((r: { instrumentId: string }) => r.instrumentId === 'i-multi');
    expect(multi.benchmark.kind).toBe('declared_unsupported');
    expect(multi.benchmark.message).toMatch(/^Declared benchmark: 45% BSE 500 TRI .* \(cannot be compared with the data we hold\)$/);
    expect(multi.factsheetCheck).toMatchObject({ checkedAt: '2026-10-03T02:00:00.000Z', outcome: 'recorded_first_observation', result: 'Benchmark recorded (first reading)', documentDate: '2026-04-30' });
    const plain = body.rows.find((r: { instrumentId: string }) => r.instrumentId === 'i-plain');
    expect(plain.benchmark.kind).toBe('category_reference'); // NO declared record: still the category benchmark
    expect(plain.factsheetCheck).toBeNull();
    expect(body.counts).toMatchObject({ declaredUnsupported: 1, categoryReference: 1 });
  });
  it('migration 0252 not applied (function / table missing): the list still works, exactly as before', async () => {
    rpcFor([HELD_ROW('i-plain', 'Some Large Cap Fund', { sub_category: 'Large Cap Fund' })], { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.declared_benchmark_records_for' } });
    tableError.ii_factsheet_attempts = { code: '42P01', message: 'relation does not exist' };
    const res = await heldGET();
    expect(res.status).toBe(200);
    const row = (await res.json()).data.rows[0];
    expect(row.benchmark.kind).toBe('category_reference');
    expect(row.factsheetCheck).toBeNull();
  });
  it('any OTHER failure to read declared records is explicit (never "no declared record", which would show a category benchmark by guess)', async () => {
    rpcFor([HELD_ROW('i-plain', 'Some Large Cap Fund', { sub_category: 'Large Cap Fund' })], { data: null, error: { code: '57P01', message: 'terminating connection' } });
    expect((await heldGET()).status).toBeGreaterThanOrEqual(500);
  });
});

describe('the cron route', () => {
  const req = (headers: Record<string, string> = {}, body: unknown = {}) => new Request('http://test/api/investment-intelligence/cron/factsheet-benchmark-reader', { method: 'POST', headers, body: JSON.stringify(body) });
  it('rejects a missing or wrong x-cron-secret with 401 before touching anything', async () => {
    process.env.CRON_SECRET = 'right-secret';
    expect((await cronPOST(req())).status).toBe(401);
    expect((await cronPOST(req({ 'x-cron-secret': 'wrong' }))).status).toBe(401);
    expect(adminClientUsed).not.toHaveBeenCalled();
  });
  it('refuses a malformed runMonth with 422 (after the secret check, before any client)', async () => {
    process.env.CRON_SECRET = 'right-secret';
    expect((await cronPOST(req({ 'x-cron-secret': 'right-secret' }, { runMonth: '2026-10-15' }))).status).toBe(422);
    expect(adminClientUsed).not.toHaveBeenCalled();
  });
  it('NEGATIVE CONTROL: with the kill switch OFF the route makes NO network request and returns skipped_kill_switch', async () => {
    process.env.CRON_SECRET = 'right-secret';
    cronFakeControl = { enabled: false, disabled_reason: 'Shipped disabled by migration 0252.' };
    const spy = vi.fn(async () => new Response('x'));
    vi.stubGlobal('fetch', spy);
    try {
      const res = await cronPOST(req({ 'x-cron-secret': 'right-secret' }));
      expect(res.status).toBe(200);
      const body = (await res.json()).data;
      expect(body).toMatchObject({ status: 'skipped_kill_switch', kill_switch: 'off', requests_made: 0, ledger_rows_written: 0 });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('a missing switch row also means no work; a dry run reports a plan and fetches nothing', async () => {
    process.env.CRON_SECRET = 'right-secret';
    const spy = vi.fn(async () => new Response('x'));
    vi.stubGlobal('fetch', spy);
    try {
      cronFakeControl = null;
      const off = (await (await cronPOST(req({ 'x-cron-secret': 'right-secret' }))).json()).data;
      expect(off).toMatchObject({ status: 'skipped_kill_switch', kill_switch: 'missing' });
      const dry = (await (await cronPOST(req({ 'x-cron-secret': 'right-secret' }, { dryRun: true }))).json()).data;
      expect(dry).toMatchObject({ status: 'dry_run', dry_run: true, requests_made: 0, ledger_rows_written: 0 });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('the route sets a maxDuration, is force-dynamic, and exposes counts and outcome codes only (no body, header or credential field)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'app/api/investment-intelligence/cron/factsheet-benchmark-reader/route.ts'), 'utf8');
    expect(src).toMatch(/export const maxDuration = \d+/);
    expect(src).toMatch(/export const dynamic = 'force-dynamic'/);
    expect(src).not.toMatch(/bytes:|rawText|Authorization|apiKey/);
  });
});
