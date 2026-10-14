// The Admin-visible half of the fail-closed rule, the Admin backfill button, the network address probe, and the
// "new application against a database that has not been migrated yet" behaviour (deploy safety). Hermetic fakes.
//
// NAMED NEGATIVE CONTROLS
//   NC-H1  a health report that leaks a secret VALUE (or its length) is caught by the leak scan;
//   NC-H2  a health report that calls a feature available while its secret is missing is caught;
//   NC-B1  a backfill route that runs without the capability check lets an entitlement-only admin through (caught);
//   NC-B2  a backfill that marks a row verified when the recomputed digest differs is caught by the database-side comparison
//          (proven on PGlite in promoHardeningDeploySafetyPglite.test.ts; here the route-level contract is asserted);
//   NC-N1  a network probe that reads the LEFT of the header (the client's choice) names the forged address.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TEST_ENV, testKeys } from './support/promoTestHelpers';

vi.mock('@/lib/services/countryGate', () => ({ countryConfirmationBlockResponse: async () => null }));
vi.setConfig({ testTimeout: 30_000 });

const ADMIN_ID = 'aaaaaaaa-0000-0000-0000-00000000f001';

type RpcFn = (name: string, args: Record<string, unknown>) => { data?: unknown; error?: { code?: string; message?: string } | null };

function fakeClient(opts: { adminRow?: Record<string, unknown> | null; user?: { id: string } | null; rpc?: RpcFn } = {}) {
  const rpcCalls: { name: string; args: Record<string, unknown> }[] = [];
  const client = {
    auth: { getUser: async () => ({ data: { user: opts.user === undefined ? { id: ADMIN_ID } : opts.user } }) },
    from() {
      return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: opts.adminRow ?? null, error: null }) }) }) };
    },
    rpc(name: string, args: Record<string, unknown> = {}) {
      rpcCalls.push({ name, args });
      const r = opts.rpc?.(name, args) ?? { data: null };
      return Promise.resolve({ data: r.data ?? null, error: r.error ?? null });
    },
  };
  return { client, rpcCalls };
}

const inDays = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const PROMO_ADMIN_ROW = { can_manage_promo_codes: true };
const ENT_ONLY_ROW = { can_manage_premium_entitlements: true, can_manage_promo_codes: false };

function setEnv(over: Record<string, string | undefined> = {}) {
  for (const k of Object.keys(TEST_ENV)) delete process.env[k];
  for (const [k, v] of Object.entries({ ...TEST_ENV, ...over })) if (v !== undefined) process.env[k] = v;
}

beforeEach(() => {
  vi.resetModules();
  setEnv();
});
afterEach(() => {
  for (const k of Object.keys(TEST_ENV)) delete process.env[k];
  delete process.env.PROMO_TRUSTED_PROXY_HOPS;
  delete process.env.PREMIUM_PROMO_EMAIL_ENABLED;
  vi.restoreAllMocks();
  vi.doUnmock('@/lib/supabase/server');
  vi.doUnmock('@/lib/supabase/admin');
});

async function loadRoute(modulePath: string, fake: ReturnType<typeof fakeClient>, service?: ReturnType<typeof fakeClient>) {
  vi.resetModules();
  vi.doMock('@/lib/supabase/server', () => ({ createClient: async () => fake.client }));
  vi.doMock('@/lib/supabase/admin', () => ({ createAdminClient: () => (service ?? fake).client }));
  return (await import(modulePath)) as Record<string, (req: Request) => Promise<Response>>;
}

const get = (url = 'http://x/', headers: Record<string, string> = {}) => new Request(url, { headers });
const postReq = (url = 'http://x/', body: unknown = {}) => new Request(url, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

// ---------------------------------------------------------------------------------------------------------------------
describe('the setup check (GET /api/admin/promo-codes/health)', () => {
  const HEALTHY_DB: RpcFn = (name) =>
    name === 'admin_promo_codes_hash_status'
      ? { data: { rows_total: 4, rows_with_plain_value: 3, rows_plain_without_verified_digest: 2, rows_with_digest: 1 } }
      : { data: null };

  it('capability: only a promo administrator (401 anonymous, 403 for an entitlement-only admin and for a plain admin)', async () => {
    const route = (f: ReturnType<typeof fakeClient>) => loadRoute('@/app/api/admin/promo-codes/health/route', f);
    expect((await (await route(fakeClient({ user: null }))).GET(get())).status).toBe(401);
    expect((await (await route(fakeClient({ adminRow: ENT_ONLY_ROW }))).GET(get())).status).toBe(403);
    expect((await (await route(fakeClient({ adminRow: {} }))).GET(get())).status).toBe(403);
    expect((await (await route(fakeClient({ adminRow: PROMO_ADMIN_ROW, rpc: HEALTHY_DB }))).GET(get())).status).toBe(200);
  });

  it('everything set: all four features available, counts of existing codes reported, no code and no digest anywhere', async () => {
    const f = fakeClient({ adminRow: PROMO_ADMIN_ROW, rpc: HEALTHY_DB });
    const res = await (await loadRoute('@/app/api/admin/promo-codes/health/route', f)).GET(get());
    const { data } = await res.json();
    expect(data.allAvailable).toBe(true);
    expect(data.features.map((x: { available: boolean }) => x.available)).toEqual([true, true, true, true]);
    expect(data.databaseReady).toBe(true);
    expect(data.existingCodes).toEqual({ total: 4, stillStoredInPlainText: 3, waitingForPreparation: 2, withProtectedCopy: 1 });
    expect(data.secrets.map((s: { name: string }) => s.name).sort()).toEqual(['CRON_SECRET', 'PREMIUM_PROMO_EMAIL_BIND_SECRET', 'PROMO_CODE_DIGEST_SECRET', 'PROMO_IP_HASH_SECRET']);
  });

  it('each missing secret switches off exactly the features that need it, and the report names the variable (never a value or a length)', async () => {
    const cases: [string, string[]][] = [
      ['PROMO_CODE_DIGEST_SECRET', ['create', 'email', 'redeem']],
      ['PREMIUM_PROMO_EMAIL_BIND_SECRET', ['email', 'redeem']],
      ['PROMO_IP_HASH_SECRET', ['redeem']],
      ['CRON_SECRET', ['cron']],
    ];
    for (const [name, off] of cases) {
      setEnv({ [name]: undefined });
      const f = fakeClient({ adminRow: PROMO_ADMIN_ROW, rpc: HEALTHY_DB });
      const { data } = await (await (await loadRoute('@/app/api/admin/promo-codes/health/route', f)).GET(get())).json();
      expect(data.allAvailable, `${name} missing`).toBe(false);
      const unavailable = data.features.filter((x: { available: boolean }) => !x.available).map((x: { feature: string }) => x.feature).sort();
      expect(unavailable, `${name} missing switches off`).toEqual([...off].sort());
      for (const feat of data.features.filter((x: { available: boolean }) => !x.available)) expect(feat.blockedBy).toContain(name);
      expect(data.secrets.find((s: { name: string }) => s.name === name).status).toBe('missing');
    }
  });

  it('too short and reused are reported as such, with names only', async () => {
    setEnv({ PROMO_IP_HASH_SECRET: 'short-value' });
    let f = fakeClient({ adminRow: PROMO_ADMIN_ROW, rpc: HEALTHY_DB });
    let { data } = await (await (await loadRoute('@/app/api/admin/promo-codes/health/route', f)).GET(get())).json();
    expect(data.secrets.find((s: { name: string }) => s.name === 'PROMO_IP_HASH_SECRET').status).toBe('too_short');
    setEnv({ PROMO_IP_HASH_SECRET: TEST_ENV.PREMIUM_PROMO_EMAIL_BIND_SECRET });
    f = fakeClient({ adminRow: PROMO_ADMIN_ROW, rpc: HEALTHY_DB });
    ({ data } = await (await (await loadRoute('@/app/api/admin/promo-codes/health/route', f)).GET(get())).json());
    expect(data.secrets.find((s: { name: string }) => s.name === 'PROMO_IP_HASH_SECRET').status).toBe('reused');
    expect(data.secrets.find((s: { name: string }) => s.name === 'PREMIUM_PROMO_EMAIL_BIND_SECRET').status).toBe('reused');
    expect(data.allAvailable).toBe(false);
  });

  it('NC-H1: the response never contains a secret value, a fragment of one, or a length', async () => {
    const f = fakeClient({ adminRow: PROMO_ADMIN_ROW, rpc: HEALTHY_DB });
    const text = JSON.stringify(await (await (await loadRoute('@/app/api/admin/promo-codes/health/route', f)).GET(get())).json());
    for (const v of Object.values(TEST_ENV)) {
      expect(text).not.toContain(v);
      expect(text).not.toContain(v.slice(0, 12));
    }
    expect(text).not.toMatch(/"length"|characters long/);
    // the control: a deliberately leaking report is caught by the same scan
    const leaking = JSON.stringify({ secrets: [{ name: 'PROMO_IP_HASH_SECRET', value: TEST_ENV.PROMO_IP_HASH_SECRET }] });
    let caught = false;
    try {
      expect(leaking, 'a secret value appears in the report').not.toContain(TEST_ENV.PROMO_IP_HASH_SECRET);
    } catch (e) {
      caught = (e as Error).message.includes('a secret value appears in the report');
    }
    expect(caught, 'NC-H1: the leak scan detects a leaking report').toBe(true);
  });

  it('NC-H2: a feature is never reported available while a secret it needs is missing (checked against a broken reporter)', async () => {
    setEnv({ PROMO_CODE_DIGEST_SECRET: undefined });
    const { promoSetupHealth } = await import('@/lib/services/promoSetupHealth');
    const real = promoSetupHealth();
    const create = real.features.find((x) => x.feature === 'create')!;
    expect(create.available, 'create is not available without the digest secret').toBe(false);
    const broken = { ...create, available: true, blockedBy: [] as string[] };
    let caught = false;
    try {
      expect(broken.available, 'create is not available without the digest secret').toBe(false);
    } catch (e) {
      caught = (e as Error).message.includes('create is not available without the digest secret');
    }
    expect(caught).toBe(true);
  });

  it('before the database update: databaseReady is false and existing codes are null (the page then says there is nothing to prepare)', async () => {
    const f = fakeClient({ adminRow: PROMO_ADMIN_ROW, rpc: () => ({ error: { code: 'PGRST202', message: 'Could not find the function public.admin_promo_codes_hash_status in the schema cache' } }) });
    const res = await (await loadRoute('@/app/api/admin/promo-codes/health/route', f)).GET(get());
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data).toMatchObject({ databaseReady: false, existingCodes: null, allAvailable: true });
  });

  it('the e-mail switch is reported, not changed: only the exact text true is ON', async () => {
    for (const [value, expected] of [[undefined, false], ['false', false], ['TRUE', false], ['1', false], ['true', true]] as const) {
      if (value === undefined) delete process.env.PREMIUM_PROMO_EMAIL_ENABLED;
      else process.env.PREMIUM_PROMO_EMAIL_ENABLED = value;
      const f = fakeClient({ adminRow: PROMO_ADMIN_ROW, rpc: HEALTHY_DB });
      const { data } = await (await (await loadRoute('@/app/api/admin/promo-codes/health/route', f)).GET(get())).json();
      expect(data.emailSwitchOn, String(value)).toBe(expected);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('the Admin backfill button (POST /api/admin/promo-codes/digest-backfill)', () => {
  const PENDING = [
    { id: '11111111-1111-1111-1111-111111111111', code: 'SUMMERPASS', code_digest: null, code_digest_version: null },
    { id: '22222222-2222-2222-2222-222222222222', code: 'KEMPTHREE33', code_digest: null, code_digest_version: null },
  ];

  function serviceFake(over: { missing?: boolean; verifyOk?: boolean } = {}) {
    let delivered = false;
    return fakeClient({
      rpc: (name) => {
        if (over.missing) return { error: { code: 'PGRST202', message: 'Could not find the function' } };
        if (name === 'promo_codes_digest_pending') {
          if (delivered) return { data: [] };
          delivered = true;
          return { data: PENDING };
        }
        if (name === 'promo_codes_digest_apply') return { data: true };
        if (name === 'promo_codes_digest_mark_verified') return { data: over.verifyOk !== false };
        return { data: null };
      },
    });
  }

  it('NC-B1: capability: anonymous 401, entitlement-only admin 403, plain admin 403, and none of them touches the service role', async () => {
    for (const [user, row, status] of [[null, null, 401], [{ id: ADMIN_ID }, ENT_ONLY_ROW, 403], [{ id: ADMIN_ID }, {}, 403]] as const) {
      const service = serviceFake();
      const f = fakeClient({ user, adminRow: row });
      const res = await (await loadRoute('@/app/api/admin/promo-codes/digest-backfill/route', f, service)).POST(postReq());
      expect(res.status).toBe(status);
      expect(service.rpcCalls, 'the service role was never used').toHaveLength(0);
    }
  });

  it('with the digest secret missing it refuses explicitly (503), names the variable, and calls nothing', async () => {
    setEnv({ PROMO_CODE_DIGEST_SECRET: undefined });
    const service = serviceFake();
    const f = fakeClient({ adminRow: PROMO_ADMIN_ROW });
    const res = await (await loadRoute('@/app/api/admin/promo-codes/digest-backfill/route', f, service)).POST(postReq());
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(JSON.stringify(body)).toContain('PROMO_CODE_DIGEST_SECRET');
    expect(service.rpcCalls).toHaveLength(0);
  });

  it('before the database update: 503 FEATURE_UNAVAILABLE (a clear message), nothing was changed', async () => {
    const service = serviceFake({ missing: true });
    const f = fakeClient({ adminRow: PROMO_ADMIN_ROW });
    const res = await (await loadRoute('@/app/api/admin/promo-codes/digest-backfill/route', f, service)).POST(postReq());
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('FEATURE_UNAVAILABLE');
  });

  it('runs: stores and verifies each digest with the CURRENT key, never returns a code or a digest, and records one evidence row (counts only)', async () => {
    const service = serviceFake();
    const f = fakeClient({ adminRow: PROMO_ADMIN_ROW });
    const res = await (await loadRoute('@/app/api/admin/promo-codes/digest-backfill/route', f, service)).POST(postReq());
    expect(res.status).toBe(200);
    const text = JSON.stringify(await res.json());
    expect(JSON.parse(text).data).toEqual({ rowsSeen: 2, rowsVerified: 2, rowsNotVerified: 0, stalled: false });
    expect(text).not.toMatch(/SUMMERPASS|KEMPTHREE33|[0-9a-f]{64}/);
    const applies = service.rpcCalls.filter((c) => c.name === 'promo_codes_digest_apply');
    expect(applies).toHaveLength(2);
    const { computePromoDigest } = await import('@/lib/services/promoCodeDigest');
    expect(applies[0].args.p_digest).toBe(computePromoDigest('SUMMERPASS', testKeys().current));
    expect(applies[0].args.p_version).toBe(testKeys().current.version);
    const marks = service.rpcCalls.filter((c) => c.name === 'promo_codes_digest_mark_verified');
    expect(marks.map((m) => m.args.p_recomputed_digest)).toEqual(applies.map((a) => a.args.p_digest));
    const record = service.rpcCalls.find((c) => c.name === 'promo_codes_backfill_record')!;
    expect(record.args).toEqual({ p_actor: ADMIN_ID, p_rows_seen: 2, p_rows_verified: 2 });
    expect(service.rpcCalls.map((c) => c.name)).not.toContain('promo_codes_finalise_hash_only');
  });

  it('NC-B2: a row the database does not verify is REPORTED (not counted verified), the run stalls instead of looping, and nothing is blanked', async () => {
    const service = serviceFake({ verifyOk: false });
    const f = fakeClient({ adminRow: PROMO_ADMIN_ROW });
    const res = await (await loadRoute('@/app/api/admin/promo-codes/digest-backfill/route', f, service)).POST(postReq());
    const { data } = await res.json();
    expect(data).toMatchObject({ rowsVerified: 0, rowsNotVerified: 2, stalled: true });
    expect(service.rpcCalls.filter((c) => c.name === 'promo_codes_digest_pending')).toHaveLength(1);
  });

  it('the finalise (the step that removes plain values) has NO route: it is a deliberate operator step', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const dir = path.join(process.cwd(), 'app', 'api');
    const hits: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(e.name) && fs.readFileSync(p, 'utf8').includes('promo_codes_finalise_hash_only')) hits.push(p);
      }
    };
    walk(dir);
    expect(hits, 'no API route calls the finalise function').toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('the network address probe (GET /api/admin/promo-codes/network-check)', () => {
  const probe = async (headers: Record<string, string>, hops?: string, row: Record<string, unknown> | null = PROMO_ADMIN_ROW) => {
    if (hops !== undefined) process.env.PROMO_TRUSTED_PROXY_HOPS = hops;
    const f = fakeClient({ adminRow: row });
    const res = await (await loadRoute('@/app/api/admin/promo-codes/network-check/route', f)).GET(get('http://x/', headers));
    return { res, body: res.status === 200 ? (await res.json()).data : null };
  };

  it('capability: a promo administrator only', async () => {
    expect((await probe({}, undefined, ENT_ONLY_ROW)).res.status).toBe(403);
    expect((await probe({}, undefined, null)).res.status).toBe(403);
  });

  it('hop count 1: the LAST entry is chosen, a forged first entry is ignored', async () => {
    const { body } = await probe({ 'x-forwarded-for': '9.9.9.9, 203.0.113.9' }, '1');
    expect(body).toMatchObject({ chosenAddress: '203.0.113.9', chosenFromRight: 1, reason: null, configuredHops: 1 });
    expect(body.entries).toEqual(['9.9.9.9', '203.0.113.9']);
  });

  it('hop count 2: the entry before the last is chosen', async () => {
    const { body } = await probe({ 'x-forwarded-for': '9.9.9.9, 198.51.100.7, 10.0.0.1' }, '2');
    expect(body).toMatchObject({ chosenAddress: '198.51.100.7', chosenFromRight: 2 });
  });

  it('NC-N1: the probe never names the forged left-most entry as the chosen address (a first-hop reader would)', async () => {
    const { body } = await probe({ 'x-forwarded-for': '9.9.9.9, 203.0.113.9' }, '1');
    const firstHopReader = body.entries[0];
    let caught = false;
    try {
      expect(firstHopReader, 'the chosen address is not the forged first entry').not.toBe('9.9.9.9');
    } catch (e) {
      caught = (e as Error).message.includes('the chosen address is not the forged first entry');
    }
    expect(caught, 'a first-hop reader would be caught').toBe(true);
    expect(body.chosenAddress).not.toBe('9.9.9.9');
  });

  it('every downgrade is explained: no header, too few entries, private address, invalid setting', async () => {
    expect((await probe({}, '1')).body).toMatchObject({ chosenAddress: null, reason: 'no_header' });
    expect((await probe({ 'x-forwarded-for': '203.0.113.9' }, '2')).body).toMatchObject({ chosenAddress: null, reason: 'shorter_than_hops' });
    expect((await probe({ 'x-forwarded-for': '203.0.113.9, 10.1.2.3' }, '1')).body).toMatchObject({ chosenAddress: null, reason: 'not_public' });
    expect((await probe({ 'x-forwarded-for': '203.0.113.9' }, '0')).body).toMatchObject({ chosenAddress: null, reason: 'invalid_setting' });
  });

  it('header content is sanitised and bounded before it is shown (no script, no more than ten entries)', async () => {
    const evil = ['<script>alert(1)</script>', ...Array.from({ length: 14 }, (_, i) => `203.0.113.${i + 1}`)].join(', ');
    const { body } = await probe({ 'x-forwarded-for': evil }, '1');
    expect(body.entries.length).toBeLessThanOrEqual(10);
    expect(JSON.stringify(body.entries)).not.toMatch(/[<>()]/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('the NEW application against a database that has NOT been migrated yet (deploy safety)', () => {
  const MISSING = { code: 'PGRST202', message: 'Could not find the function public.admin_create_promo_code(p_code_digest) in the schema cache' };

  it('create: 503 FEATURE_UNAVAILABLE, no code in the response, nothing logged with a code', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = fakeClient({ adminRow: PROMO_ADMIN_ROW, rpc: () => ({ error: MISSING }) });
    const route = await loadRoute('@/app/api/admin/promo-codes/route', f);
    const res = await route.POST(postReq('http://x/', { durationDays: 30, maxRedemptions: 5, expiresOn: inDays(30) }));
    expect([503, 500]).toContain(res.status);
    expect(res.status, 'a missing function is an explicit unavailable message, never a bare 500').toBe(503);
    const text = JSON.stringify(await res.json());
    expect(text).toContain('FEATURE_UNAVAILABLE');
    expect(text).not.toMatch(/"code":"[A-Z2-9]{10}"/);
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/"[A-Z2-9]{10}"/);
  });

  it('the grant route (five argument manage) refuses with 503 and the entitlement is not touched', async () => {
    const f = fakeClient({ adminRow: { can_manage_premium_entitlements: true }, rpc: () => ({ error: { code: 'PGRST202', message: 'Could not find the function public.admin_manage_premium_entitlement(p_override) in the schema cache' } }) });
    const route = await loadRoute('@/app/api/admin/entitlements/grants/route', f);
    const res = await route.POST(postReq('http://x/', { action: 'grant', userId: 'bbbbbbbb-0000-0000-0000-000000000001', endsOn: inDays(10), reason: 'Pilot customer, invoice pending' }));
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).toContain('FEATURE_UNAVAILABLE');
  });

  it('redeem: 503 PROMO_UNAVAILABLE with a generic message, nothing granted, the user is never told which function is missing', async () => {
    vi.doMock('@/lib/api', async () => {
      const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
      return { ...actual, requireCountryConfirmedUser: async () => ({ user: { id: 'u1', email: 'a@b.test', email_confirmed_at: '2026-01-01T00:00:00Z' }, unauthenticated: null }) };
    });
    const f = fakeClient({ rpc: () => ({ error: MISSING }) });
    const route = await loadRoute('@/app/api/payments/promo/redeem/route', f);
    const res = await route.POST(postReq('http://x/', { code: 'SOMECODEKX22' }));
    expect(res.status).toBe(503);
    const text = JSON.stringify(await res.json());
    expect(text).toContain('PROMO_UNAVAILABLE');
    expect(text).not.toMatch(/function|schema|rpc|public\./i);
    vi.doUnmock('@/lib/api');
  });

  it('redeem with a secret missing: 503 BEFORE any database call (nothing is attempted, nothing is granted)', async () => {
    for (const name of ['PROMO_CODE_DIGEST_SECRET', 'PREMIUM_PROMO_EMAIL_BIND_SECRET', 'PROMO_IP_HASH_SECRET']) {
      setEnv({ [name]: undefined });
      vi.doMock('@/lib/api', async () => {
        const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
        return { ...actual, requireCountryConfirmedUser: async () => ({ user: { id: 'u1', email: 'a@b.test', email_confirmed_at: '2026-01-01T00:00:00Z' }, unauthenticated: null }) };
      });
      const f = fakeClient({ rpc: () => ({ data: { ok: true } }) });
      const route = await loadRoute('@/app/api/payments/promo/redeem/route', f, f);
      const res = await route.POST(postReq('http://x/', { code: 'SOMECODEKX22' }));
      expect(res.status, name).toBe(503);
      expect(f.rpcCalls, `${name}: no database call`).toHaveLength(0);
      vi.doUnmock('@/lib/api');
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('ordinary Premium use never depends on the promo secrets', () => {
  it('no file outside the promo feature imports the secrets, the digest, or the address modules', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const roots = ['app', 'lib', 'components'];
    const importers = new Set<string>();
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) {
          if (e.name !== 'node_modules') walk(p);
        } else if (/\.(ts|tsx)$/.test(e.name)) {
          const src = fs.readFileSync(p, 'utf8');
          if (/from '@\/lib\/services\/(promoSecrets|promoCodeDigest|promoCodeIp|promoSetupHealth|premiumCronAuth)'/.test(src)) importers.add(path.relative(process.cwd(), p).replace(/\\/g, '/'));
        }
      }
    };
    for (const r of roots) walk(path.join(process.cwd(), r));
    expect([...importers].sort()).toEqual(
      [
        'app/api/admin/promo-codes/digest-backfill/route.ts',
        'app/api/admin/promo-codes/health/route.ts',
        'app/api/admin/promo-codes/network-check/route.ts',
        'app/api/admin/promo-codes/route.ts',
        'app/api/payments/promo/redeem/route.ts',
        'app/api/premium/cron/expiry-reminders/route.ts',
        'lib/services/premiumCronAuth.ts',
        'lib/services/promoCodeBackfill.ts',
        'lib/services/promoCodeCreate.ts',
        'lib/services/promoCodeDigest.ts',
        'lib/services/promoCodeEmail.ts',
        'lib/services/promoCodeIp.ts',
        'lib/services/promoSetupHealth.ts',
      ].sort()
    );
  });
});
