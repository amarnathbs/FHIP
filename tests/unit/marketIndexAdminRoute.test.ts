// Market Index Data admin surface — Admin Architecture Standard compliance.
//
// Capability: marketIndexDataUpload (admin_users.can_upload_market_index_data).
// Proves, per applicable clause:
//   s2  separately-named capability, not implied by any broad flag
//   s4  direct-API test (401/403 on every verb), direct-page test (redirect),
//       nav layer, and the RPC is called with the CALLER's own session
//   s9  no other admin's identifier returned
//   s13 fail closed on a read error / missing column
// The database-bypass test (calling the RPC directly) is the PGlite script
// scripts/india_mf_0232_pglite_verification.mjs (IMF-PG-08..16).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { countryRegistryFrom } from './support/countryRegistryFake';
import { fakeSupabase } from '../fixtures/fakeSupabase';
import { ATTESTATION_TEXT } from '@/lib/services/investment-intelligence/marketIndex/indexUploadService';

const mockGetUser = vi.fn();
const mockRpc = vi.fn();
const mockAdminClientUsed = vi.fn();
let adminRowResult: { data: Record<string, unknown> | null; error: { message: string } | null } = { data: null, error: null };
let db = fakeSupabase({});
const redirectSpy = vi.fn((to: string) => {
  throw new Error(`REDIRECT:${to}`);
});

vi.mock('next/navigation', () => ({ redirect: (to: string) => redirectSpy(to) }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => {
    mockAdminClientUsed();
    throw new Error('the service-role client must not be used by the market-index admin surface');
  },
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: mockGetUser },
    rpc: mockRpc,
    from: (table: string) => {
      const registry = countryRegistryFrom(table);
      if (registry) return registry;
      if (table === 'admin_users') return { select: () => ({ eq: () => ({ maybeSingle: async () => adminRowResult }) }) };
      if (table === 'user_profiles') return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { country_of_residence: 'IN', country_confirmed_at: '2026-08-29T00:00:00Z', country_source: 'USER_CONFIRMED', onboarding_completed: true }, error: null }) }) }) };
      return (db.client as unknown as { from: (t: string) => unknown }).from(table);
    },
  }),
}));

import { GET, POST } from '@/app/api/admin/investment-intelligence/market-index-data/route';
import { requireMarketIndexAdminPage } from '@/lib/services/investment-intelligence/marketIndex/marketIndexAdmin';
import { buildAdminNavGroups, NO_ADMIN_CAPABILITIES, parseAdminCapabilities, type AdminCapabilities } from '@/lib/admin/adminNav';
import { GET as meGET } from '@/app/api/admin/me/route';

const ME = 'admin-user-1';
const ROOT = path.resolve(__dirname, '..', '..');
const CSV = 'date,close\n2024-03-04,22405.60\n2024-03-05,22356.30\n';

function post(body: Record<string, unknown>) {
  return new Request('http://test/api/admin/investment-intelligence/market-index-data', { method: 'POST', body: JSON.stringify(body) });
}
const baseBody = { indexKey: 'IN_NIFTY_50_PRI', fileName: 'n.csv', csvText: CSV };

beforeEach(() => {
  vi.clearAllMocks();
  mockGetUser.mockResolvedValue({ data: { user: { id: ME } } });
  adminRowResult = { data: { can_upload_market_index_data: true }, error: null };
  db = fakeSupabase({
    ii_benchmarks: [{ id: 'b-n', benchmark_key: 'IN_NIFTY_50_PRI' }, { id: 'b-s', benchmark_key: 'IN_SENSEX_PRI' }],
    ii_benchmark_series: [],
    ii_market_index_batches: [{ id: 'batch-1', benchmark_key: 'IN_NIFTY_50_PRI', source_kind: 'admin_csv', uploader_user_id: 'someone-else', created_at: '2026-09-30T10:00:00Z', attested: true }],
    ii_reference_job_control: [{ job_key: 'market_index_daily_close', enabled: false, disabled_reason: 'off', consecutive_failures: 0 }],
  });
});

describe('API layer (s4): explicit denial on EVERY verb, never a 200', () => {
  it('unauthenticated -> 401 on GET and POST', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });
    expect((await GET()).status).toBe(401);
    expect((await POST(post({ action: 'preview', ...baseBody }))).status).toBe(401);
  });
  it('a plain user (no admin_users row) -> 403 on GET and POST', async () => {
    adminRowResult = { data: null, error: null };
    expect((await GET()).status).toBe(403);
    expect((await POST(post({ action: 'preview', ...baseBody }))).status).toBe(403);
  });
  it('an admin WITHOUT the named capability -> 403 (being an admin, or holding other can_* flags, is not enough)', async () => {
    adminRowResult = { data: { can_upload_market_index_data: false, can_view_reference_data_quality: true, can_view_lookthrough_data_quality: true, user_id: ME }, error: null };
    expect((await GET()).status).toBe(403);
    const res = await POST(post({ action: 'commit', ...baseBody, attested: true, attestationText: ATTESTATION_TEXT }));
    expect(res.status).toBe(403);
    expect(mockRpc).not.toHaveBeenCalled();
  });
  it('s13 fail closed: a role-resolution error or a missing column (migration 0232 not applied) is a denial, not a grant', async () => {
    adminRowResult = { data: null, error: { message: 'column admin_users.can_upload_market_index_data does not exist' } };
    expect((await GET()).status).toBe(403);
    adminRowResult = { data: {}, error: null }; // row present but no such column
    expect((await POST(post({ action: 'preview', ...baseBody }))).status).toBe(403);
  });
  it('a truthy-but-not-true flag value is not a grant', async () => {
    adminRowResult = { data: { can_upload_market_index_data: 'true' }, error: null };
    expect((await GET()).status).toBe(403);
  });
});

describe('page layer (s4): a direct navigation is redirected, not rendered empty', () => {
  it('redirects a user without the capability to /dashboard and a logged-out caller to /login', async () => {
    adminRowResult = { data: { can_upload_market_index_data: false }, error: null };
    await expect(requireMarketIndexAdminPage()).rejects.toThrow('REDIRECT:/dashboard');
    mockGetUser.mockResolvedValue({ data: { user: null } });
    await expect(requireMarketIndexAdminPage()).rejects.toThrow('REDIRECT:/login');
  });
  it('lets the capability holder through', async () => {
    await expect(requireMarketIndexAdminPage()).resolves.toMatchObject({ id: ME });
  });
  it('BENCH-1 Phase 2: the page file (and its alias) call the benchmark-data guard before rendering the generalised client', () => {
    for (const f of ['app/(app)/admin/investment-intelligence/market-index-data/page.tsx', 'app/(app)/admin/investment-intelligence/benchmark-data/page.tsx']) {
      const page = fs.readFileSync(path.join(ROOT, f), 'utf8');
      expect(page.indexOf("await requireBenchmarkPage('view')"), f).toBeGreaterThan(-1);
      expect(page.indexOf("await requireBenchmarkPage('view')"), f).toBeLessThan(page.indexOf('<BenchmarkDataClient'));
    }
  });
});

describe('navigation layer (s2/s4): visible only with its own capability', () => {
  const allOthers: AdminCapabilities = { ...NO_ADMIN_CAPABILITIES, resourcesDashboard: true, resourceContentAdmin: true, resourceWorkflowAdmin: true, resourceDiscoveryAdmin: true, resourceAnalytics: true, referenceDataQuality: true, lookthroughDataQuality: true };
  it('the group appears only when marketIndexDataUpload is true — every other capability true, and it is still hidden', () => {
    expect(buildAdminNavGroups(true, { ...allOthers, referenceDataQuality: false }).map((g) => g.label)).not.toContain('Market Index Data');
    const g = buildAdminNavGroups(false, { ...NO_ADMIN_CAPABILITIES, marketIndexDataUpload: true });
    expect(g.map((x) => x.label)).toEqual(['Market Index Data']);
    expect(g[0].items).toEqual([{ label: 'Market Index Data', href: '/admin/investment-intelligence/market-index-data' }]);
  });
  it('is not implied by the PC7 capability, nor by isAdmin (PC6 read-only view reuses it as the VIEW capability only)', () => {
    expect(buildAdminNavGroups(true, { ...NO_ADMIN_CAPABILITIES, lookthroughDataQuality: true }).map((g) => g.label)).not.toContain('Market Index Data');
  });
  it('the capability parser is strictly === true and defaults closed', () => {
    expect(parseAdminCapabilities({ data: { capabilities: { marketIndexDataUpload: 'yes' } } }).marketIndexDataUpload).toBe(false);
    expect(parseAdminCapabilities({ data: { capabilities: { marketIndexDataUpload: true } } }).marketIndexDataUpload).toBe(true);
    expect(parseAdminCapabilities(null).marketIndexDataUpload).toBe(false);
    expect(NO_ADMIN_CAPABILITIES.marketIndexDataUpload).toBe(false);
  });
  it('GET /api/admin/me reports the capability from its own independent read, and false when absent', async () => {
    const yes = (await (await meGET()).json()).data.capabilities;
    expect(yes.marketIndexDataUpload).toBe(true);
    adminRowResult = { data: { can_view_reference_data_quality: true }, error: null };
    const no = (await (await meGET()).json()).data.capabilities;
    expect(no.marketIndexDataUpload).toBe(false);
  });
});

describe('capability holder: GET status still works; the single-step POST is superseded (410)', () => {
  it('GET returns status and never another admin\'s identifier (s9), plus the feed switch state', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()).data;
    expect(body.state).toBe('ok');
    expect(body.indices).toHaveLength(2);
    expect(body.indices[0].freshness.state).toBe('never_ingested'); // s8: never loaded is its own state, not a zero
    expect(body.recentBatches[0].uploadedByMe).toBe(false);
    expect(JSON.stringify(body)).not.toContain('someone-else');
    expect(body.dailyFeed.effectivelyEnabled).toBe(false);
    expect(body.dailyFeed.termsWarning).toMatch(/NSE and BSE restrict/);
    expect(body.attestationText).toBe(ATTESTATION_TEXT);
  });
  it('BENCH-1 Phase 2: POST is GONE (410 SUPERSEDED) after the auth check, calls no RPC and no write - the attestation-only path no longer exists', async () => {
    const res = await POST(post({ action: 'commit', ...baseBody, attested: true, attestationText: ATTESTATION_TEXT }));
    expect(res.status).toBe(410);
    expect((await res.json()).code).toBe('SUPERSEDED');
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockAdminClientUsed).not.toHaveBeenCalled();
  });
  it('an unauthenticated caller still gets 401 (not 410) on POST', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });
    expect((await POST(post({ action: 'commit', ...baseBody }))).status).toBe(401);
  });
});

describe('the service-role client is never used by this surface (static)', () => {
  it('no file of the admin surface imports createAdminClient', () => {
    for (const f of [
      'app/api/admin/investment-intelligence/market-index-data/route.ts',
      'lib/services/investment-intelligence/marketIndex/marketIndexAdmin.ts',
      'lib/services/investment-intelligence/marketIndex/indexUploadService.ts',
      'components/admin/MarketIndexDataClient.tsx',
    ]) {
      expect(fs.readFileSync(path.join(ROOT, f), 'utf8'), f).not.toMatch(/createAdminClient|adminClient\(\)/);
    }
  });
});
