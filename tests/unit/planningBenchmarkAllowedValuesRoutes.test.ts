// Planning Benchmarks upload: the allowed-values route and the template route's live Read me lists.
// Evidence label: UNIT-TESTED (route handlers run for real against the in-memory Supabase fake).
//
// Admin Architecture Standard: s2/s4 the same `view` capability gate as the templates and history (401 / 403 / 503,
// never a quiet 200), s8/s13 an unreadable database is an explicit "unavailable" (the template download still works),
// s11 safe export (no-store, nosniff, attachment name), s9 global reference data only.
//
// NAMED NEGATIVE CONTROLS
//   NC-L1  a Super Admin row with no upload/activate capability gets 403 on the new route (row existence is not the capability);
//   NC-L2  a logged-out caller gets 401; a not-an-admin caller gets 403;
//   NC-L3  with the reference tables unreadable the template still downloads (200) and its Read me says the lists are unavailable.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { createInMemoryDb } from './support/inMemorySupabase';
import { countryRegistryFrom } from './support/countryRegistryFake';
import { pbReferenceTables } from './support/pbAllowedFixture';

const mockGetUser = vi.fn();
const db = createInMemoryDb();
let referenceReadFails = false;
const REFERENCE = ['benchmark_datasets', 'benchmark_sources', 'benchmark_metric_definitions', 'benchmark_cohorts', 'benchmark_target_ranges', 'benchmark_values'];

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: mockGetUser },
    rpc: vi.fn(),
    from: (t: string) => {
      if (referenceReadFails && REFERENCE.includes(t)) {
        return { select: () => ({ limit: async () => ({ data: null, error: { code: '57P01', message: 'terminating connection' } }) }) };
      }
      return countryRegistryFrom(t) ?? (db.client.from(t) as never);
    },
  }),
}));

import { GET as allowedGET } from '@/app/api/admin/benchmarks/upload/allowed-values/route';
import { GET as templateGET } from '@/app/api/admin/benchmarks/upload/templates/[kind]/route';

const U = '11111111-1111-4111-8111-111111111111';
const profile = { user_id: U, country_of_residence: 'AU', country_confirmed_at: '2026-08-29T00:00:00Z', country_source: 'USER_CONFIRMED', onboarding_completed: true };

function actor(flags: { upload?: boolean; activate?: boolean } | 'not-admin') {
  db.reset({
    ...(pbReferenceTables() as Record<string, never[]>),
    user_profiles: [profile] as never[],
    admin_users: (flags === 'not-admin' ? [] : [{ user_id: U, can_upload_planning_benchmarks: flags.upload === true, can_activate_planning_benchmarks: flags.activate === true }]) as never[],
  });
}
const get = (q = '') => allowedGET(new Request(`http://t/x${q}`));
const tpl = (kind: string, fmt: string) => templateGET(new Request(`http://t/x?format=${fmt}`), { params: Promise.resolve({ kind }) });

beforeEach(() => {
  vi.clearAllMocks();
  referenceReadFails = false;
  mockGetUser.mockResolvedValue({ data: { user: { id: U } } });
});

describe('GET /api/admin/benchmarks/upload/allowed-values', () => {
  it('JSON: a holder of upload OR activate sees the lists with the counts; no-store', async () => {
    for (const flags of [{ upload: true }, { activate: true }]) {
      actor(flags);
      const res = await get();
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      const body = (await res.json()) as { data: { state: string; counts: Record<string, number>; datasets: unknown[] } };
      expect(body.data.state).toBe('ok');
      expect(body.data.counts).toMatchObject({ datasetsOpen: 3, datasetsTotal: 5, metricsTotal: 4, cohortsTotal: 2 });
      expect(body.data.datasets).toHaveLength(5);
    }
  });

  it('CSV: attachment with a non-identifying name, nosniff, the same counts', async () => {
    actor({ upload: true });
    const res = await get('?format=csv');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/csv/);
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="planning_benchmarks_allowed_values.csv"');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toContain('3 datasets are open for upload today');
  });

  it('an unknown format is 422', async () => {
    actor({ upload: true });
    expect((await get('?format=pdf')).status).toBe(422);
  });

  it('NC-L1: a Super Admin row with no planning-benchmark capability gets 403 (not an empty 200)', async () => {
    actor({});
    expect((await get()).status).toBe(403);
    expect((await get('?format=csv')).status).toBe(403);
  });

  it('NC-L2: logged out is 401; not an admin is 403', async () => {
    actor({ upload: true });
    mockGetUser.mockResolvedValue({ data: { user: null } });
    expect((await get()).status).toBe(401);
    mockGetUser.mockResolvedValue({ data: { user: { id: U } } });
    actor('not-admin');
    expect((await get()).status).toBe(403);
  });

  it('an unreadable database is state "unavailable" (explicit), in JSON and in the CSV - never an empty list', async () => {
    actor({ upload: true });
    referenceReadFails = true;
    const json = (await (await get()).json()) as { data: { state: string; datasets?: unknown } };
    expect(json.data.state).toBe('unavailable');
    expect(json.data.datasets).toBeUndefined();
    const csv = await (await get('?format=csv')).text();
    expect(csv).toContain('unavailable');
  });
});

describe('template route: the XLSX Read me carries the live lists', () => {
  it('xlsx download has the count heading and every dataset; csv template stays header and examples only', async () => {
    actor({ upload: true });
    const x = await tpl('values', 'xlsx');
    expect(x.status).toBe(200);
    const wb = XLSX.read(new Uint8Array(await x.arrayBuffer()), { type: 'array' });
    const cells = (XLSX.utils.sheet_to_json(wb.Sheets['Read me'], { header: 1, defval: '' }) as unknown[][]).flat().map(String);
    expect(cells).toContain('3 datasets are open for upload today');
    expect(cells).toContain('AU household wealth distribution');
    const csv = await (await tpl('values', 'csv')).text();
    expect(csv).not.toContain('datasets are open');
  });

  it('NC-L3: with the reference tables unreadable the XLSX still downloads and its Read me says the lists are unavailable', async () => {
    actor({ upload: true });
    referenceReadFails = true;
    const x = await tpl('target_ranges', 'xlsx');
    expect(x.status).toBe(200);
    const wb = XLSX.read(new Uint8Array(await x.arrayBuffer()), { type: 'array' });
    expect(wb.SheetNames).toEqual(['Data', 'Read me']);
    const cells = (XLSX.utils.sheet_to_json(wb.Sheets['Read me'], { header: 1, defval: '' }) as unknown[][]).flat().map(String);
    expect(cells.some((c) => /allowed lists are unavailable right now/.test(c) && /Datasets tab/.test(c))).toBe(true);
    expect(cells.some((c) => /datasets are open for upload today/.test(c))).toBe(false);
  });

  it('the new route never imports the service-role client', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '..', '..', 'app/api/admin/benchmarks/upload/allowed-values/route.ts'), 'utf8');
    expect(src).not.toMatch(/supabase\/admin|createAdminClient|adminClient\(/);
    expect(src).toMatch(/guarded\('view'\)/);
  });
});
