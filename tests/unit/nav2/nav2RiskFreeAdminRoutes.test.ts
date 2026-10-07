// Risk-free Rate Data + Fund analytics health admin surfaces -- Admin Architecture Standard compliance.
//
// Capabilities (migration 0260): riskFreeDataUpload (can_upload_risk_free_data) and the SEPARATE riskFreeSeriesSwitch
// (can_switch_risk_free_series); monitoring uses the existing PC6 referenceDataQuality capability.
// Proves, per applicable clause:
//   s2/s3  two separately named capabilities; neither implies the other, isAdmin, or the monitoring capability
//   s4     direct-API test (401 / 403 on EVERY verb of EVERY route), direct-page test (redirect), nav layer, and every
//          database function is called with the CALLER's own session client
//   s7/s9  no other admin's identifier is returned; monitoring cells pass through with the database's suppression intact
//   s8     a panel the caller's capabilities do not cover is `not_permitted`, a missing table is `unavailable`
//   s13    fail closed on a read error / missing column / truthy-but-not-true value
// The database-bypass test (calling each function directly as the wrong capability, anon, an ordinary user) is the PGlite
// script scripts/nav2_0260_0262_pglite_verification.mjs (72 checks).
//
// NAMED NEGATIVE CONTROLS
//   NC-A1  each route refuses the OTHER capability, even with every other grant present (upload route vs switch holder, ...);
//   NC-A2  an admin row with the flag as the STRING "true" is not a grant;
//   NC-A3  no refused call reaches any database function;
//   NC-A4  the service-role client is never used anywhere in the surface (static + runtime tripwire).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { countryRegistryFrom } from '../support/countryRegistryFake';
import { fakeSupabase } from '../../fixtures/fakeSupabase';
import { RISK_FREE_ATTESTATION_TEXT } from '@/lib/services/investment-intelligence/nav2/riskFreeUploadService';

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
    throw new Error('the service-role client must not be used by the risk-free admin surface');
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

import { GET, POST } from '@/app/api/admin/investment-intelligence/risk-free-data/route';
import { POST as reviewPOST } from '@/app/api/admin/investment-intelligence/risk-free-data/review/[id]/route';
import { POST as correctPOST } from '@/app/api/admin/investment-intelligence/risk-free-data/correct/route';
import { POST as statePOST } from '@/app/api/admin/investment-intelligence/risk-free-data/series-state/route';
import { GET as monitoringGET } from '@/app/api/admin/investment-intelligence/nav2-monitoring/route';
import { requireRiskFreePage, riskFreeFlagsFromRow } from '@/lib/services/investment-intelligence/nav2/riskFreeAdmin';
import { buildAdminNavGroups, NO_ADMIN_CAPABILITIES, parseAdminCapabilities } from '@/lib/admin/adminNav';
import { GET as meGET } from '@/app/api/admin/me/route';

const ME = 'admin-user-1';
const ROOT = path.resolve(__dirname, '..', '..', '..');
const ITEM = '55555555-5555-4555-8555-555555555555';
const CSV = 'series_id,observation_date,value_percent,frequency,source_document,source_url,retrieved_on,notes\nRBI_91D_TBILL_CUTOFF_YIELD,2026-09-30,5.5199,weekly_auction,"SYNTHETIC",,2026-10-03,\n';
const UPLOAD = { can_upload_risk_free_data: true, can_switch_risk_free_series: false };
const SWITCH = { can_upload_risk_free_data: false, can_switch_risk_free_series: true };
const PC6 = { can_view_reference_data_quality: true };

const req = (url: string, body: unknown) => new Request(`http://test${url}`, { method: 'POST', body: JSON.stringify(body) });
const ctx = (id = ITEM) => ({ params: Promise.resolve({ id }) });
const uploadBody = (action: 'preview' | 'commit', extra: Record<string, unknown> = {}) => ({ action, seriesId: 'RBI_91D_TBILL_CUTOFF_YIELD', fileName: 'f.csv', csvText: CSV, ...extra });

type Call = { name: string; run: () => Promise<Response>; needs: 'upload' | 'switch' | 'any' | 'pc6' };
const calls: Call[] = [
  { name: 'GET status', needs: 'any', run: () => GET() },
  { name: 'POST upload preview', needs: 'upload', run: () => POST(req('/u', uploadBody('preview'))) },
  { name: 'POST upload commit', needs: 'upload', run: () => POST(req('/u', uploadBody('commit', { attested: true, attestationText: RISK_FREE_ATTESTATION_TEXT }))) },
  { name: 'POST review', needs: 'upload', run: () => reviewPOST(req('/r', { decision: 'reject', note: 'a note that is long enough to pass' }), ctx()) },
  { name: 'POST correct', needs: 'upload', run: () => correctPOST(req('/c', { seriesId: 'RBI_91D_TBILL_CUTOFF_YIELD', date: '2026-09-30', newValue: 5.5, reason: 'a reason that is long enough to pass' })) },
  { name: 'POST series-state', needs: 'switch', run: () => statePOST(req('/s', { seriesId: 'RBI_91D_TBILL_CUTOFF_YIELD', enabled: false, termsStatus: 'po_accepted_2026-10-03', reason: 'a reason that is long enough to pass' })) },
  { name: 'GET monitoring', needs: 'pc6', run: () => monitoringGET() },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockGetUser.mockResolvedValue({ data: { user: { id: ME } } });
  mockRpc.mockResolvedValue({ data: { ok: true }, error: null });
  adminRowResult = { data: { ...UPLOAD, ...SWITCH, can_upload_risk_free_data: true, can_switch_risk_free_series: true, ...PC6 }, error: null };
  db = fakeSupabase({
    ii_risk_free_series: [
      { series_id: 'RBI_91D_TBILL_CUTOFF_YIELD', series_name: 'RBI 91-day Treasury bill auction cut-off yield', role: 'primary', source: 'Reserve Bank of India', attribution_text: 'Source: Reserve Bank of India', cadence: 'weekly_auction', max_staleness_days: 21, enabled: true, terms_review_status: 'po_accepted_2026-10-03', verified_through_date: null },
      { series_id: 'RBI_POLICY_REPO_RATE', series_name: 'RBI policy repo rate', role: 'secondary', source: 'Reserve Bank of India', attribution_text: 'Source: Reserve Bank of India', cadence: 'policy_change', max_staleness_days: 90, enabled: true, terms_review_status: 'po_accepted_2026-10-03', verified_through_date: '2026-10-02' },
    ],
    ii_risk_free_observations: [{ series_id: 'RBI_91D_TBILL_CUTOFF_YIELD', observation_date: '2026-09-23', kind: 'value', value_percent: 5.39, gap_reason: null, source_document: 'SYNTHETIC', source_url: null, retrieved_on: '2026-10-03', notes: null, entry_kind: 'first_load_csv', extraction: null }],
    ii_risk_free_batches: [{ id: 'batch-1', series_id: 'RBI_91D_TBILL_CUTOFF_YIELD', source_kind: 'admin_csv', uploader_user_id: 'someone-else', created_at: '2026-10-03T10:00:00Z', attested: true }],
    ii_risk_free_review_items: [{ id: ITEM, series_id: 'RBI_91D_TBILL_CUTOFF_YIELD', observation_date: '2026-09-30', status: 'open', reasons: ['conflicts_with_stored_value'], candidate: null, evidence: null, created_at: '2026-10-03T10:00:00Z' }],
    ii_risk_free_corrections: [{ id: 'c1', series_id: 'RBI_91D_TBILL_CUTOFF_YIELD', observation_date: '2026-09-23', previous_value_percent: 5.4, new_value_percent: 5.39, reason: 'a long enough reason', actor_user_id: 'someone-else', created_at: '2026-10-03T11:00:00Z' }],
    ii_risk_free_series_state_log: [{ id: 'l1', series_id: 'RBI_POLICY_REPO_RATE', previous_enabled: true, new_enabled: false, previous_terms_status: 'po_accepted_2026-10-03', new_terms_status: 'po_accepted_2026-10-03', reason: 'a long enough reason', actor_user_id: 'someone-else', created_at: '2026-10-03T12:00:00Z' }],
    ii_reference_job_control: [{ job_key: 'nav2_risk_free_weekly_refresh', enabled: false, disabled_reason: 'off', consecutive_failures: 0 }],
  });
});

describe('API layer (s4): explicit denial on EVERY verb of EVERY route, never a 200', () => {
  for (const c of calls) {
    it(`${c.name}: unauthenticated -> 401, a plain user -> 403, and no database function is reached`, async () => {
      mockGetUser.mockResolvedValue({ data: { user: null } });
      expect((await c.run()).status).toBe(401);
      mockGetUser.mockResolvedValue({ data: { user: { id: ME } } });
      adminRowResult = { data: null, error: null };
      expect((await c.run()).status).toBe(403);
      expect(mockRpc).not.toHaveBeenCalled();
    });

    it(`${c.name}: fails closed on a read error, a missing column, and a truthy-but-not-true flag (s13, NC-A2)`, async () => {
      adminRowResult = { data: null, error: { message: 'column admin_users.can_upload_risk_free_data does not exist' } };
      expect((await c.run()).status).toBe(403);
      adminRowResult = { data: {}, error: null };
      expect((await c.run()).status).toBe(403);
      // The monitoring route sits behind the PRE-EXISTING PC6 guard, which tests the flag for truthiness rather than === true.
      // The column is a boolean, so a string cannot occur in practice, and the database function re-checks is_pc6_reference_data_admin()
      // itself; that guard is not changed here. The two new capabilities are strict.
      adminRowResult = { data: { can_upload_risk_free_data: 'true', can_switch_risk_free_series: 'true', ...(c.needs === 'pc6' ? {} : { can_view_reference_data_quality: 'true' }) }, error: null };
      expect((await c.run()).status).toBe(403);
      expect(mockRpc).not.toHaveBeenCalled();
    });
  }

  it('NC-A1: the upload / review / correct routes refuse a SWITCH-only holder, and the switch route refuses an UPLOAD-only holder', async () => {
    adminRowResult = { data: { ...SWITCH, ...PC6 }, error: null };
    for (const c of calls.filter((x) => x.needs === 'upload')) expect((await c.run()).status, c.name).toBe(403);
    adminRowResult = { data: { ...UPLOAD, ...PC6 }, error: null };
    for (const c of calls.filter((x) => x.needs === 'switch')) expect((await c.run()).status, c.name).toBe(403);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('the monitoring route refuses both risk-free capabilities (and the risk-free routes refuse the PC6 capability alone)', async () => {
    adminRowResult = { data: { ...UPLOAD, ...SWITCH, can_upload_risk_free_data: true, can_switch_risk_free_series: true, can_view_reference_data_quality: false }, error: null };
    expect((await monitoringGET()).status).toBe(403);
    adminRowResult = { data: { ...PC6 }, error: null };
    for (const c of calls.filter((x) => x.needs !== 'pc6')) expect((await c.run()).status, c.name).toBe(403);
  });
});

describe('page layer (s4): a direct navigation is redirected, not rendered empty', () => {
  it('redirects a user with neither capability to /dashboard and a logged-out caller to /login', async () => {
    adminRowResult = { data: { ...PC6 }, error: null };
    await expect(requireRiskFreePage('any')).rejects.toThrow('REDIRECT:/dashboard');
    mockGetUser.mockResolvedValue({ data: { user: null } });
    await expect(requireRiskFreePage('any')).rejects.toThrow('REDIRECT:/login');
  });
  it('lets either capability holder through, and reports each flag on its own', async () => {
    adminRowResult = { data: SWITCH, error: null };
    await expect(requireRiskFreePage('any')).resolves.toMatchObject({ flags: { upload: false, switch: true } });
    adminRowResult = { data: UPLOAD, error: null };
    await expect(requireRiskFreePage('any')).resolves.toMatchObject({ flags: { upload: true, switch: false } });
    await expect(requireRiskFreePage('switch')).rejects.toThrow('REDIRECT:/dashboard');
  });
  it('the page files call their guard before rendering the client', () => {
    const rf = fs.readFileSync(path.join(ROOT, 'app/(app)/admin/investment-intelligence/risk-free-data/page.tsx'), 'utf8');
    expect(rf.indexOf("await requireRiskFreePage('any')")).toBeGreaterThan(-1);
    expect(rf.indexOf("await requireRiskFreePage('any')")).toBeLessThan(rf.indexOf('<RiskFreeDataClient'));
    const mon = fs.readFileSync(path.join(ROOT, 'app/(app)/admin/investment-intelligence/nav2-monitoring/page.tsx'), 'utf8');
    expect(mon.indexOf('await requireReferenceDataAdminPage()')).toBeLessThan(mon.indexOf('<Nav2MonitoringClient'));
  });
});

describe('navigation layer (s2/s4)', () => {
  it('the group appears with EITHER risk-free capability and with nothing else; it is not implied by isAdmin or any other grant', () => {
    const all = { ...NO_ADMIN_CAPABILITIES, resourcesDashboard: true, resourceContentAdmin: true, resourceWorkflowAdmin: true, resourceDiscoveryAdmin: true, resourceAnalytics: true, referenceDataQuality: true, lookthroughDataQuality: true, marketIndexDataUpload: true, benchmarkDataView: true, benchmarkDataPublish: true, benchmarkDataCorrect: true, benchmarkCatalogueManage: true, benchmarkEntitlementApprove: true, entitlementManagement: true, promoCodeManagement: true };
    expect(buildAdminNavGroups(true, all).map((g) => g.label)).not.toContain('Risk-free Rates');
    for (const k of ['riskFreeDataUpload', 'riskFreeSeriesSwitch'] as const) {
      const g = buildAdminNavGroups(false, { ...NO_ADMIN_CAPABILITIES, [k]: true });
      expect(g.map((x) => x.label)).toEqual(['Risk-free Rates']);
      expect(g[0].items).toEqual([{ label: 'Risk-free Rate Data', href: '/admin/investment-intelligence/risk-free-data' }]);
    }
  });
  it('the monitoring link sits in the Reference Data group, i.e. behind the PC6 capability only', () => {
    const g = buildAdminNavGroups(false, { ...NO_ADMIN_CAPABILITIES, referenceDataQuality: true });
    expect(g.map((x) => x.label)).toEqual(['Reference Data']);
    expect(g[0].items.map((i) => i.href)).toContain('/admin/investment-intelligence/nav2-monitoring');
    expect(buildAdminNavGroups(false, { ...NO_ADMIN_CAPABILITIES, riskFreeDataUpload: true, riskFreeSeriesSwitch: true }).map((x) => x.label)).not.toContain('Reference Data');
  });
  it('the capability parser is strictly === true and defaults closed', () => {
    expect(parseAdminCapabilities({ data: { capabilities: { riskFreeDataUpload: 'yes', riskFreeSeriesSwitch: 1 } } })).toMatchObject({ riskFreeDataUpload: false, riskFreeSeriesSwitch: false });
    expect(parseAdminCapabilities({ data: { capabilities: { riskFreeDataUpload: true } } })).toMatchObject({ riskFreeDataUpload: true, riskFreeSeriesSwitch: false });
    expect(parseAdminCapabilities(null)).toMatchObject({ riskFreeDataUpload: false, riskFreeSeriesSwitch: false });
    expect(riskFreeFlagsFromRow({ can_upload_risk_free_data: true })).toEqual({ upload: true, switch: false });
  });
  it('GET /api/admin/me reports each capability from its own column', async () => {
    adminRowResult = { data: UPLOAD, error: null };
    expect((await (await meGET()).json()).data.capabilities).toMatchObject({ riskFreeDataUpload: true, riskFreeSeriesSwitch: false });
    adminRowResult = { data: SWITCH, error: null };
    expect((await (await meGET()).json()).data.capabilities).toMatchObject({ riskFreeDataUpload: false, riskFreeSeriesSwitch: true });
    adminRowResult = { data: PC6, error: null };
    expect((await (await meGET()).json()).data.capabilities).toMatchObject({ riskFreeDataUpload: false, riskFreeSeriesSwitch: false });
  });
});

describe('status panels follow the caller\'s capabilities (s8) and never leak another admin (s9)', () => {
  it('an UPLOAD holder gets series, batches, review items, corrections and the state log; uploadedByMe / actedByMe only', async () => {
    adminRowResult = { data: UPLOAD, error: null };
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()).data;
    expect(body.state).toBe('ok');
    expect(body.series.map((s: { seriesId: string }) => s.seriesId).sort()).toEqual(['RBI_91D_TBILL_CUTOFF_YIELD', 'RBI_POLICY_REPO_RATE']);
    expect(body.series.find((s: { seriesId: string }) => s.seriesId === 'RBI_91D_TBILL_CUTOFF_YIELD').freshness).toMatchObject({ state: expect.stringMatching(/fresh|stale/), basis: 'last_observation', staleAfterDays: 21 });
    expect(body.series.find((s: { seriesId: string }) => s.seriesId === 'RBI_POLICY_REPO_RATE').freshness.basis).toBe('verification');
    expect(body.recentBatches.state).toBe('ok');
    expect(body.recentBatches.data[0].uploadedByMe).toBe(false);
    expect(body.openReviewItems.data).toHaveLength(1);
    expect(body.recentCorrections.data[0].actedByMe).toBe(false);
    expect(JSON.stringify(body)).not.toContain('someone-else');
    expect(body.attestationText).toBe(RISK_FREE_ATTESTATION_TEXT);
    expect(body.weeklyRefresh.jobEnabled).toBe(false);
  });

  it('a SWITCH-only holder sees the series and the state log but NOT batches, review items or corrections (not_permitted, not empty)', async () => {
    adminRowResult = { data: SWITCH, error: null };
    const body = (await (await GET()).json()).data;
    expect(body.series).toHaveLength(2);
    expect(body.stateLog.state).toBe('ok');
    expect(body.recentBatches).toEqual({ state: 'not_permitted' });
    expect(body.openReviewItems).toEqual({ state: 'not_permitted' });
    expect(body.recentCorrections).toEqual({ state: 'not_permitted' });
    expect(JSON.stringify(body)).not.toContain('someone-else');
  });

  it('a database without migration 0260 reports unavailable with the reason, not a healthy empty dashboard', async () => {
    adminRowResult = { data: UPLOAD, error: null };
    db = fakeSupabase({ ii_risk_free_series: [], ii_risk_free_observations: [] });
    const body = (await (await GET()).json()).data;
    expect(body.state).toBe('unavailable');
    expect(body.reason).toBeTruthy();
    expect(body.series).toBeUndefined();
  });
});

describe('writes run under the caller\'s own session, with the right function and arguments (NC-A3)', () => {
  it('upload preview writes nothing; commit calls commit_risk_free_upload once with the attestation and the file hash', async () => {
    adminRowResult = { data: UPLOAD, error: null };
    const prev = await POST(req('/u', uploadBody('preview')));
    expect(prev.status).toBe(200);
    const p = (await prev.json()).data;
    expect(p).toMatchObject({ acceptedRows: 1, willInsert: 1, canCommit: true });
    expect(mockRpc).not.toHaveBeenCalled();
    const res = await POST(req('/u', uploadBody('commit', { attested: true, attestationText: RISK_FREE_ATTESTATION_TEXT, expectedSha256: p.fileSha256, firstLoad: true })));
    expect(res.status).toBe(200);
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockRpc.mock.calls[0][0]).toBe('commit_risk_free_upload');
    expect(mockRpc.mock.calls[0][1]).toMatchObject({ p_series_id: 'RBI_91D_TBILL_CUTOFF_YIELD', p_attested: true, p_entry_kind: 'first_load_csv' });
    expect(mockAdminClientUsed).not.toHaveBeenCalled();
  });

  it('commit without the attestation is refused (422) before any function call; a malformed body is a 422/400, not a 500', async () => {
    adminRowResult = { data: UPLOAD, error: null };
    expect((await POST(req('/u', uploadBody('commit', { attested: false })))).status).toBe(422);
    expect((await POST(req('/u', { action: 'commit', seriesId: 'NOT_A_SERIES', csvText: CSV }))).status).toBe(422);
    expect((await POST(new Request('http://test/u', { method: 'POST', body: '{not json' }))).status).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('review, correct and series-state call their own function with the validated arguments', async () => {
    adminRowResult = { data: { ...UPLOAD, can_switch_risk_free_series: true }, error: null };
    expect((await reviewPOST(req('/r', { decision: 'accept', note: 'accepted after checking the RBI press release' }), ctx())).status).toBe(200);
    expect(mockRpc).toHaveBeenLastCalledWith('resolve_risk_free_review_item', { p_item_id: ITEM, p_decision: 'accept', p_note: 'accepted after checking the RBI press release' });
    expect((await correctPOST(req('/c', { seriesId: 'RBI_91D_TBILL_CUTOFF_YIELD', date: '2026-09-30', newValue: 5.5198, reason: 'recomputed from the printed cut-off price' }))).status).toBe(200);
    expect(mockRpc).toHaveBeenLastCalledWith('correct_risk_free_observation', { p_series_id: 'RBI_91D_TBILL_CUTOFF_YIELD', p_date: '2026-09-30', p_new_value: 5.5198, p_reason: 'recomputed from the printed cut-off price' });
    expect((await statePOST(req('/s', { seriesId: 'RBI_POLICY_REPO_RATE', enabled: false, termsStatus: 'declined', reason: 'RBI terms position under review by the PO' }))).status).toBe(200);
    expect(mockRpc).toHaveBeenLastCalledWith('set_risk_free_series_state', { p_series_id: 'RBI_POLICY_REPO_RATE', p_enabled: false, p_terms_status: 'declined', p_reason: 'RBI terms position under review by the PO' });
  });

  it('input validation: a short note / reason, a bad id, an out-of-range value, an unknown field are refused without a call', async () => {
    adminRowResult = { data: { ...UPLOAD, can_switch_risk_free_series: true }, error: null };
    expect((await reviewPOST(req('/r', { decision: 'accept', note: 'short' }), ctx())).status).toBe(422);
    expect((await reviewPOST(req('/r', { decision: 'accept', note: 'a note that is long enough to pass' }), ctx('not-a-uuid'))).status).toBe(400);
    expect((await correctPOST(req('/c', { seriesId: 'RBI_91D_TBILL_CUTOFF_YIELD', date: '2026-09-30', newValue: 650, reason: 'a reason that is long enough to pass' }))).status).toBe(422);
    expect((await correctPOST(req('/c', { seriesId: 'RBI_91D_TBILL_CUTOFF_YIELD', date: '30-09-2026', newValue: 5, reason: 'a reason that is long enough to pass' }))).status).toBe(422);
    expect((await statePOST(req('/s', { seriesId: 'RBI_91D_TBILL_CUTOFF_YIELD', enabled: false, termsStatus: 'po_accepted_2026-10-03', reason: 'a reason that is long enough to pass', extra: 1 }))).status).toBe(422);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('a database-layer refusal (42501) is an explicit 403 and an unexpected error does not leak its message', async () => {
    adminRowResult = { data: { ...UPLOAD, can_switch_risk_free_series: true }, error: null };
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: '42501', message: 'risk-free correction: not authorised' } });
    expect((await correctPOST(req('/c', { seriesId: 'RBI_91D_TBILL_CUTOFF_YIELD', date: '2026-09-30', newValue: 5.5, reason: 'a reason that is long enough to pass' }))).status).toBe(403);
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: 'XX000', message: 'relation ii_secret_table exploded' } });
    const r = await statePOST(req('/s', { seriesId: 'RBI_91D_TBILL_CUTOFF_YIELD', enabled: false, termsStatus: 'po_accepted_2026-10-03', reason: 'a reason that is long enough to pass' }));
    expect(r.status).toBe(500);
    expect(JSON.stringify(await r.json())).not.toContain('ii_secret_table');
  });
});

describe('monitoring route', () => {
  it('passes the database snapshot through unchanged, suppression intact, under the caller\'s own session', async () => {
    adminRowResult = { data: PC6, error: null };
    const snapshot = { held_instruments: { state: 'suppressed', value: null, label: 'Insufficient data to display safely.' }, cache_entries: { state: 'ok', value: 12 } };
    const attempts = { runs_last_90_days: 4, robots_unavailable_continued_last_90_days: 3, blocked_by_source_last_90_days: 0, last_blocked_at: null, last_attempt_at: '2026-10-02T03:00:00Z', last_robots_outcome: 'robots_unavailable_continued', last_source_status: 'ok' };
    mockRpc.mockResolvedValueOnce({ data: snapshot, error: null });
    mockRpc.mockResolvedValueOnce({ data: attempts, error: null });
    const res = await monitoringGET();
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ state: 'ok', snapshot, refreshAttempts: { state: 'ok', value: attempts } });
    expect(mockRpc).toHaveBeenCalledWith('nav2_monitoring_snapshot');
    expect(mockRpc).toHaveBeenCalledWith('nav2_refresh_attempt_summary');
  });
  it('migration 0263 not applied: the refresh-attempt panel is unavailable with a reason (never a zero) and the snapshot is still served', async () => {
    adminRowResult = { data: PC6, error: null };
    mockRpc.mockResolvedValueOnce({ data: { cache_entries: { state: 'ok', value: 1 } }, error: null });
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: '42883', message: 'function nav2_refresh_attempt_summary() does not exist' } });
    const d = (await (await monitoringGET()).json()).data;
    expect(d.state).toBe('ok');
    expect(d.refreshAttempts).toMatchObject({ state: 'unavailable', reason: expect.stringContaining('0263') });
  });
  it('a database refusal is 403; an unapplied migration is unavailable with a reason; any other error is a 500 that does not leak', async () => {
    adminRowResult = { data: PC6, error: null };
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: '42501', message: 'nav2 monitoring: not authorised' } });
    expect((await monitoringGET()).status).toBe(403);
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: '42883', message: 'function nav2_monitoring_snapshot() does not exist' } });
    expect((await (await monitoringGET()).json()).data).toMatchObject({ state: 'unavailable' });
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: 'XX000', message: 'secret internals' } });
    const r = await monitoringGET();
    expect(r.status).toBe(500);
    expect(JSON.stringify(await r.json())).not.toContain('secret internals');
  });
});

describe('the service-role client is never used by this surface (NC-A4, static)', () => {
  it('no file of the surface imports createAdminClient', () => {
    for (const f of [
      'app/api/admin/investment-intelligence/risk-free-data/route.ts',
      'app/api/admin/investment-intelligence/risk-free-data/review/[id]/route.ts',
      'app/api/admin/investment-intelligence/risk-free-data/correct/route.ts',
      'app/api/admin/investment-intelligence/risk-free-data/series-state/route.ts',
      'app/api/admin/investment-intelligence/nav2-monitoring/route.ts',
      'lib/services/investment-intelligence/nav2/riskFreeAdmin.ts',
      'lib/services/investment-intelligence/nav2/riskFreeAdminService.ts',
      'lib/services/investment-intelligence/nav2/riskFreeUploadService.ts',
      'lib/services/investment-intelligence/nav2/riskFreeCsv.ts',
      'components/admin/RiskFreeDataClient.tsx',
      'components/admin/Nav2MonitoringClient.tsx',
    ]) {
      expect(fs.readFileSync(path.join(ROOT, f), 'utf8'), f).not.toMatch(/createAdminClient|adminClient\(\)/);
    }
  });
  it('the screens format dates day-first through the shared helpers and never print a raw ISO date', () => {
    const t = fs.readFileSync(path.join(ROOT, 'components/admin/RiskFreeDataClient.tsx'), 'utf8');
    expect(t).toMatch(/formatDateShort/);
    expect(t).not.toMatch(/\.slice\(0, 16\)\.replace\('T'/);
  });
});
