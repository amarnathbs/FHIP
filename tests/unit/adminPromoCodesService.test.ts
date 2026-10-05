// Promo codes, extension cap and expiry reminders — application-layer proof
// (hermetic fakes). The database half is proven against a real Postgres in
// tests/unit/adminPromoCodesPglite.test.ts.
//
// Each rule has a NEGATIVE CONTROL: the same assertion run against a deliberately
// broken rule must go red, and the failing assertion is named in the title.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEST_ENV } from './support/promoTestHelpers';

vi.mock('@/lib/services/countryGate', () => ({ countryConfirmationBlockResponse: async () => null }));
vi.setConfig({ testTimeout: 30_000 });

const ADMIN_ID = 'aaaaaaaa-0000-0000-0000-00000000c001';
const TARGET_ID = 'bbbbbbbb-0000-0000-0000-000000000001';
const FAKE_NOW = '2026-10-01T12:00:00.000Z';
const TODAY = '2026-10-01';
const day = (n: number) => {
  const d = new Date(`${TODAY}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

type Row = Record<string, unknown> | null;
interface FakeOpts {
  user?: { id: string } | null;
  adminRow?: Row;
  rpc?: (name: string, args: Record<string, unknown>) => { data?: unknown; error?: { code?: string; message?: string } | null };
}

function makeSupabase(opts: FakeOpts = {}) {
  const rpcCalls: { name: string; args: Record<string, unknown> }[] = [];
  const client = {
    auth: { getUser: async () => ({ data: { user: opts.user === undefined ? { id: ADMIN_ID } : opts.user } }) },
    from(table: string) {
      if (table !== 'admin_users') throw new Error(`unexpected table: ${table}`);
      return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: opts.adminRow ?? null, error: null }) }) }) };
    },
    rpc(name: string, args: Record<string, unknown>) {
      rpcCalls.push({ name, args });
      const r = opts.rpc?.(name, args) ?? { data: [] };
      return Promise.resolve({ data: r.data ?? null, error: r.error ?? null });
    },
  };
  return { client, rpcCalls };
}

beforeEach(() => {
  // The dedicated secrets are mandatory (hardening 0264), so every test starts with all four set.
  for (const [k, v] of Object.entries(TEST_ENV)) process.env[k] = v;
  vi.resetModules();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(FAKE_NOW));
});
afterEach(() => {
  for (const k of Object.keys(TEST_ENV)) delete process.env[k];
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.doUnmock('@/lib/supabase/server');
  vi.doUnmock('@/lib/supabase/admin');
  vi.doUnmock('@/lib/api');
});

async function load<T>(modulePath: string, fake: ReturnType<typeof makeSupabase>): Promise<T> {
  vi.resetModules();
  vi.doMock('@/lib/supabase/server', () => ({ createClient: async () => fake.client }));
  vi.doMock('@/lib/supabase/admin', () => ({ createAdminClient: () => fake.client }));
  return (await import(modulePath)) as T;
}

const post = (url: string, body: unknown) => new Request(`http://x${url}`, { method: 'POST', body: JSON.stringify(body) });

// ---------------------------------------------------------------------------
describe('expiry reminders — pure rules', () => {
  const row = (source: string | null, endsIn: number, extra: Record<string, unknown> = {}) => ({
    plan_tier: 'premium',
    entitlement_source: source,
    effective_from: day(-100),
    effective_to: day(endsIn),
    ...extra,
  });

  it('thresholds: >30 days none; 30..8 days "expiring_30"; 7..0 days "expiring_7"; lapsed shows for 30 days then stops', async () => {
    const { computeEntitlementReminder: c } = await import('@/lib/services/entitlementReminder');
    expect(c(row('admin_grant', 31), TODAY).kind).toBe('none');
    expect(c(row('admin_grant', 30), TODAY).kind).toBe('expiring_30');
    expect(c(row('admin_grant', 8), TODAY).kind).toBe('expiring_30');
    expect(c(row('admin_grant', 7), TODAY).kind).toBe('expiring_7');
    expect(c(row('admin_grant', 0), TODAY)).toMatchObject({ kind: 'expiring_7', days: 0, title: 'Your Premium access ends today' });
    expect(c(row('admin_grant', -1), TODAY)).toMatchObject({ kind: 'lapsed', days: 1 });
    expect(c(row('promo_code', -30), TODAY).kind).toBe('lapsed');
    expect(c(row('promo_code', -31), TODAY).kind).toBe('none');
  });

  it('a user sees exactly ONE notice: the more urgent threshold replaces the less urgent; the dismissal key changes per threshold', async () => {
    const { computeEntitlementReminder: c } = await import('@/lib/services/entitlementReminder');
    const a = c(row('promo_code', 20), TODAY);
    const b = c(row('promo_code', 5), TODAY);
    expect([a.kind, b.kind]).toEqual(['expiring_30', 'expiring_7']);
    expect(a.key).not.toBe(b.key);
    expect(a.key).toBe(`expiring_30:${day(20)}`);
  });

  it('wording names the source honestly and tells the user how to continue (real payment path or support), without inventing billing', async () => {
    const { computeEntitlementReminder: c } = await import('@/lib/services/entitlementReminder');
    const admin = c(row('admin_grant', 5), TODAY);
    expect(admin.message).toContain('granted by FHIP');
    expect(admin.message).toContain('subscribe from the Plans section on your Profile page');
    expect(admin.message).toContain('contact FHIP support');
    expect(c(row('promo_code', 5), TODAY).message).toContain('from a promo code');
    const lapsed = c(row('admin_grant', -3), TODAY);
    expect(lapsed.title).toBe('Your Premium access has ended');
    expect(lapsed.message).toContain('now on the Free plan');
  });

  async function assertNoNoticeForPaid(compute: (r: Record<string, unknown>, today: string) => { kind: string }): Promise<void> {
    expect(compute(row('payment', 3), TODAY).kind, 'paid Premium never gets a notice').toBe('none');
    expect(compute(row(null, 3), TODAY).kind, 'a legacy/unknown source never gets a notice').toBe('none');
    expect(compute({ plan_tier: 'free', entitlement_source: 'payment', effective_to: day(3) }, TODAY).kind).toBe('none');
  }

  it('NEVER for paid Premium, legacy rows, free users, missing rows, or a window that has not started', async () => {
    const { computeEntitlementReminder: c } = await import('@/lib/services/entitlementReminder');
    await assertNoNoticeForPaid(c as never);
    expect(c(null, TODAY).kind).toBe('none');
    expect(c(row('admin_grant', 3, { effective_from: day(1) }), TODAY).kind).toBe('none'); // not started: not a lapse, not "ending"
    expect(c(row('admin_grant', 3, { effective_to: null }), TODAY).kind).toBe('none');
  });

  it('NEGATIVE CONTROL — a rule that ignores the source would warn a paying customer (assertion "paid Premium never gets a notice" goes red)', async () => {
    const { computeEntitlementReminder: c } = await import('@/lib/services/entitlementReminder');
    // Same rule with the source gate removed: treat every row as an admin grant.
    const ignoringSource = (r: Record<string, unknown>, today: string) => c({ ...r, entitlement_source: 'admin_grant' } as never, today);
    expect(() => {
      expect(ignoringSource(row('payment', 3), TODAY).kind, 'paid Premium never gets a notice').toBe('none');
    }).toThrow(/paid Premium never gets a notice/);
  });

  describe('own-row loader — a user never sees another user\'s notice', () => {
    function db(rows: Record<string, Record<string, unknown>>) {
      const eqCalls: [string, string][] = [];
      return {
        eqCalls,
        client: {
          from: () => ({
            select: () => ({
              eq: (col: string, val: string) => {
                eqCalls.push([col, val]);
                return { maybeSingle: async () => ({ data: rows[val] ?? null, error: null }) };
              },
            }),
          }),
        },
      };
    }
    const A = 'user-a';
    const B = 'user-b';
    const rows = {
      [A]: { plan_tier: 'premium', entitlement_source: 'admin_grant', effective_from: day(-50), effective_to: day(5) },
      [B]: { plan_tier: 'premium', entitlement_source: 'payment', effective_from: null, effective_to: null },
    };

    async function assertIsolation(loader: (client: never, userId: string, today: string) => Promise<{ kind: string }>): Promise<void> {
      const d = db(rows);
      expect((await loader(d.client as never, B, TODAY)).kind, "another user's notice must never be shown").toBe('none');
      expect((await loader(d.client as never, A, TODAY)).kind).toBe('expiring_7');
    }

    it('reads only the requested user\'s row (filtered by user_id) and computes from that single row', async () => {
      const { getOwnEntitlementReminder } = await import('@/lib/services/premiumNotice');
      await assertIsolation(getOwnEntitlementReminder as never);
      const d = db(rows);
      await getOwnEntitlementReminder(d.client as never, A, TODAY);
      expect(d.eqCalls).toEqual([['user_id', A]]);
    });

    it('NEGATIVE CONTROL — a loader that did not filter by user would show A\'s notice to B (assertion "another user\'s notice must never be shown" goes red)', async () => {
      const { computeEntitlementReminder } = await import('@/lib/services/entitlementReminder');
      const unfiltered = async (client: { from: () => { select: () => { eq: (c: string, v: string) => { maybeSingle: () => Promise<{ data: unknown }> } } } }) => {
        const { data } = await client.from().select().eq('user_id', A).maybeSingle(); // ignores the caller's id
        return computeEntitlementReminder(data as never, TODAY);
      };
      await expect(assertIsolation((client) => unfiltered(client as never))).rejects.toThrow(/another user's notice must never be shown/);
    });

    it('fails soft: a read error, a throw or a missing row yields no notice (never breaks the page)', async () => {
      const { getOwnEntitlementReminder } = await import('@/lib/services/premiumNotice');
      const err = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: 'column does not exist' } }) }) }) }) };
      const boom = { from: () => { throw new Error('boom'); } };
      expect((await getOwnEntitlementReminder(err as never, A, TODAY)).kind).toBe('none');
      expect((await getOwnEntitlementReminder(boom as never, A, TODAY)).kind).toBe('none');
    });
  });

  it('plan wording: promo is labelled "Premium (promo code, ends <date>)"; a lapsed promo reads as lapsed; never as paid', async () => {
    const { describePlanStatus } = await import('@/lib/services/entitlementPlanStatus');
    const live = describePlanStatus({ plan_tier: 'premium', entitlement_source: 'promo_code', effective_from: day(-5), effective_to: '2026-12-25', admin_grant_ends_on: '2026-12-25' }, TODAY);
    expect(live).toMatchObject({ kind: 'premium_promo', planTier: 'premium', label: 'Premium (promo code, ends 25/12/2026)' });
    expect(describePlanStatus({ plan_tier: 'premium', entitlement_source: 'promo_code', effective_from: day(-5), effective_to: '2026-12-25', admin_grant_ends_on: '2026-12-25' }, TODAY, 'IN').label).toBe('Premium (promo code, ends 25-12-2026)');
    const lapsed = describePlanStatus({ plan_tier: 'premium', entitlement_source: 'promo_code', effective_from: day(-90), effective_to: day(-2), admin_grant_ends_on: day(-2) }, TODAY);
    expect(lapsed).toMatchObject({ kind: 'promo_lapsed', planTier: 'free' });
    expect(lapsed.label).toMatch(/promo code ended/);
  });
});

// ---------------------------------------------------------------------------
describe('promo request validation (route layer, before the database)', () => {
  const valid = (over: Record<string, unknown> = {}) => ({ durationDays: 365, maxRedemptions: 100, expiresOn: day(60), ...over });

  it('duration 1..365 (365 accepted, 366 refused), default 30 (one month); finite max by default; unlimited and no-expiry only when chosen explicitly', async () => {
    const { parseCreatePromoRequest: parse } = await import('@/lib/services/promoCodes');
    expect(parse(valid({ durationDays: 365 }), TODAY).ok).toBe(true);
    expect(parse(valid({ durationDays: 366 }), TODAY)).toMatchObject({ ok: false, code: 'PROMO_DURATION_INVALID' });
    expect(parse(valid({ durationDays: 0 }), TODAY)).toMatchObject({ ok: false, code: 'PROMO_DURATION_INVALID' });
    expect(parse(valid({ durationDays: 30.5 }), TODAY)).toMatchObject({ ok: false });
    const d = parse({ expiresOn: day(60) }, TODAY);
    expect(d.ok && d.value).toMatchObject({ durationDays: 30, maxRedemptions: 100, unlimited: false }); // access length defaults to one month
    expect(parse({ durationDays: 30, noExpiry: true, unlimited: true }, TODAY)).toMatchObject({ ok: true, value: { maxRedemptions: null, expiresOn: null } });
    expect(parse(valid({ expiresOn: undefined }), TODAY)).toMatchObject({ ok: false, code: 'PROMO_EXPIRY_INVALID' }); // no silent "never expires"
    expect(parse(valid({ unlimited: true }), TODAY)).toMatchObject({ ok: false, code: 'PROMO_MAX_INVALID' }); // not both
    expect(parse(valid({ maxRedemptions: 0 }), TODAY)).toMatchObject({ ok: false, code: 'PROMO_MAX_INVALID' });
    expect(parse(valid({ expiresOn: day(-1) }), TODAY)).toMatchObject({ ok: false, code: 'PROMO_EXPIRY_INVALID' });
  });

  it('NEGATIVE CONTROL — a parser whose duration cap is weakened to 400 accepts 366 (assertion "366 days must be refused" goes red)', async () => {
    const { parseCreatePromoRequest: parse } = await import('@/lib/services/promoCodes');
    const assertion = (max?: number) => expect(parse(valid({ durationDays: 366 }), TODAY, max).ok, '366 days must be refused').toBe(false);
    expect(() => assertion()).not.toThrow();
    expect(() => assertion(400)).toThrow(/366 days must be refused/);
  });

  it('codes: unambiguous alphabet only (no 0/O/1/I/L), 6-24 chars, normalised; blank = generate', async () => {
    const { parseCreatePromoRequest: parse } = await import('@/lib/services/promoCodes');
    for (const bad of ['ABC0EF', 'ABCOEF', 'ABC1EF', 'ABCIEF', 'ABCLEF', 'SHORT', 'ABC!DEF', 'A'.repeat(25)]) {
      expect(parse(valid({ code: bad }), TODAY), bad).toMatchObject({ ok: false, code: 'PROMO_CODE_INVALID' });
    }
    expect(parse(valid({ code: ' summer-2k26 pass ' }), TODAY)).toMatchObject({ ok: true, value: { code: 'SUMMER2K26PASS' } });
    expect(parse(valid({ code: '   ' }), TODAY)).toMatchObject({ ok: true, value: { code: null } });
  });
});

// ---------------------------------------------------------------------------
describe('authorisation — promo admin routes (separate capability) and entitlement routes stay separate', () => {
  const PROMO_ROUTES: { name: string; module: string; call: (h: Record<string, (r: Request, c?: { params: Promise<{ id: string }> }) => Promise<Response>>) => Promise<Response> }[] = [
    { name: 'GET /promo-codes', module: '@/app/api/admin/promo-codes/route', call: (h) => h.GET(new Request('http://x')) },
    { name: 'POST /promo-codes', module: '@/app/api/admin/promo-codes/route', call: (h) => h.POST(post('', { durationDays: 365, maxRedemptions: 10, expiresOn: day(30) })) },
    { name: 'POST /promo-codes/[id]/disable', module: '@/app/api/admin/promo-codes/[id]/disable/route', call: (h) => h.POST(post('', { reason: 'Campaign finished, closing' }), { params: Promise.resolve({ id: TARGET_ID }) }) },
    { name: 'GET /promo-codes/events', module: '@/app/api/admin/promo-codes/events/route', call: (h) => h.GET(new Request('http://x')) },
  ];

  for (const route of PROMO_ROUTES) {
    describe(route.name, () => {
      it('unauthenticated -> 401; not an admin -> 403; admin with ONLY the premium-entitlement capability -> 403; no DB call in any denial', async () => {
        const cases: [string, FakeOpts, number][] = [
          ['unauthenticated', { user: null }, 401],
          ['not an admin', { adminRow: null }, 403],
          ['entitlement-only admin', { adminRow: { can_manage_promo_codes: false, can_manage_premium_entitlements: true } }, 403],
          ['no-capability admin', { adminRow: { can_manage_promo_codes: false } }, 403],
        ];
        for (const [label, opts, status] of cases) {
          const fake = makeSupabase(opts);
          const h = await load<Record<string, never>>(route.module, fake);
          const res = await route.call(h as never);
          expect(res.status, label).toBe(status);
          expect(fake.rpcCalls, label).toHaveLength(0);
        }
      });
      it('the promo-code admin reaches the RPC on the caller session client (positive control)', async () => {
        const fake = makeSupabase({ adminRow: { can_manage_promo_codes: true }, rpc: () => ({ data: [] }) });
        const h = await load<Record<string, never>>(route.module, fake);
        const res = await route.call(h as never);
        expect(res.status).toBe(200);
        expect(fake.rpcCalls).toHaveLength(1);
      });
    });
  }

  it('the reverse separation: a promo-only admin is refused on the entitlement routes (403, no DB call)', async () => {
    const fake = makeSupabase({ adminRow: { can_manage_promo_codes: true, can_manage_premium_entitlements: false } });
    for (const mod of ['@/app/api/admin/entitlements/grants/route', '@/app/api/admin/entitlements/summary/route', '@/app/api/admin/entitlements/users/route']) {
      const h = await load<Record<string, (r: Request) => Promise<Response>>>(mod, fake);
      const res = await h.GET(new Request('http://x/?q=someone&filter=expiring'));
      expect(res.status, mod).toBe(403);
    }
    expect(fake.rpcCalls).toHaveLength(0);
  });

  it('NEGATIVE CONTROL — a bare requireAdmin() would admit an admin lacking the promo capability (assertion "entitlement-only admin -> 403" goes red under requireAdmin)', async () => {
    const fake = makeSupabase({ adminRow: { can_manage_promo_codes: false, can_manage_premium_entitlements: true } });
    vi.doMock('@/lib/supabase/server', () => ({ createClient: async () => fake.client }));
    const { requireAdmin } = await import('@/lib/services/adminAuth');
    expect((await requireAdmin()).forbidden).toBeNull();
    const { requirePromoCodeAdmin } = await import('@/lib/services/promoCodeAdmin');
    expect((await requirePromoCodeAdmin()).forbidden?.status).toBe(403);
  });

  it('create passes explicit values to the RPC; a 366-day request never reaches the database', async () => {
    const fake = makeSupabase({ adminRow: { can_manage_promo_codes: true }, rpc: () => ({ data: { id: 'x', code_hint: 'AB******CD', duration_days: 30 } }) });
    const h = await load<{ POST: (r: Request) => Promise<Response> }>('@/app/api/admin/promo-codes/route', fake);
    const bad = await h.POST(post('', { durationDays: 366, maxRedemptions: 5, expiresOn: day(30) }));
    expect(bad.status).toBe(422);
    expect(fake.rpcCalls).toHaveLength(0);
    const ok = await h.POST(post('', { durationDays: 30, unlimited: true, noExpiry: true, note: ' hello ' }));
    expect(ok.status).toBe(200);
    // Hash only (hardening 0264): the route generates the code, the database receives only the keyed digest and the masked hint.
    const plain = (await ok.json()).data.code as string;
    expect(plain).toMatch(/^[A-HJ-KM-NP-Z2-9]{10}$/);
    const { computePromoDigest } = await import('@/lib/services/promoCodeDigest');
    const { promoCodeHint } = await import('@/lib/services/promoCodeDigest');
    expect(fake.rpcCalls[0]).toEqual({
      name: 'admin_create_promo_code',
      args: {
        p_code_digest: computePromoDigest(plain, { version: 1, secret: TEST_ENV.PROMO_CODE_DIGEST_SECRET }),
        p_code_hint: promoCodeHint(plain),
        p_digest_version: 1,
        p_duration_days: 30,
        p_max_redemptions: null,
        p_unlimited: true,
        p_expires_on: null,
        p_no_expiry: true,
        p_note: 'hello',
        p_bound_email_hash: null,
        p_recipient_count: 0,
      },
    });
    expect(JSON.stringify(fake.rpcCalls[0].args), 'the plain code never reaches the database').not.toContain(plain);
  });

  it('creating a code refuses explicitly (503, nothing created) when the dedicated digest secret is missing, and CRON_SECRET or the IP secret are NOT used instead', async () => {
    delete process.env.PROMO_CODE_DIGEST_SECRET;
    const fake = makeSupabase({ adminRow: { can_manage_promo_codes: true }, rpc: () => ({ data: { id: 'x' } }) });
    const h = await load<{ POST: (r: Request) => Promise<Response> }>('@/app/api/admin/promo-codes/route', fake);
    const res = await h.POST(post('', { durationDays: 30, maxRedemptions: 5, expiresOn: day(30) }));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('PROMO_SECRETS_NOT_CONFIGURED');
    expect(fake.rpcCalls, 'nothing is created without the secret').toHaveLength(0);
  });

  it('disable needs a reason of at least 10 characters before it reaches the database; database errors map to explicit statuses without leaking internals', async () => {
    const fake = makeSupabase({ adminRow: { can_manage_promo_codes: true }, rpc: () => ({ error: { code: 'P0001', message: 'PROMO_CODE_ALREADY_DISABLED' } }) });
    const h = await load<{ POST: (r: Request, c: { params: Promise<{ id: string }> }) => Promise<Response> }>('@/app/api/admin/promo-codes/[id]/disable/route', fake);
    const ctx = { params: Promise.resolve({ id: TARGET_ID }) };
    expect((await h.POST(post('', { reason: 'short' }), ctx)).status).toBe(422);
    expect(fake.rpcCalls).toHaveLength(0);
    const res = await h.POST(post('', { reason: 'Campaign finished, closing' }), ctx);
    expect(res.status).toBe(409);
    const boom = makeSupabase({ adminRow: { can_manage_promo_codes: true }, rpc: () => ({ error: { code: 'XX000', message: 'relation "promo_codes" internals' } }) });
    const h2 = await load<{ POST: (r: Request, c: { params: Promise<{ id: string }> }) => Promise<Response> }>('@/app/api/admin/promo-codes/[id]/disable/route', boom);
    const r2 = await h2.POST(post('', { reason: 'Campaign finished, closing' }), ctx);
    expect(r2.status).toBe(500);
    expect(JSON.stringify(await r2.json())).not.toContain('promo_codes');
  });
});

// ---------------------------------------------------------------------------
describe('user redemption route — abuse controls and honest messages', () => {
  const CODE = 'SECRETCODE22';

  async function loadRedeem(rpc: FakeOpts['rpc'], env: Record<string, string | undefined> = {}, sessionUser: { id: string } | null = { id: TARGET_ID }) {
    const fake = makeSupabase({ rpc });
    vi.resetModules();
    // The dedicated secrets are mandatory (hardening 0264): every redemption test runs with all four set unless it overrides one.
    for (const [k, v] of Object.entries({ ...TEST_ENV, ...env })) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    vi.doMock('@/lib/supabase/admin', () => ({ createAdminClient: () => fake.client }));
    vi.doMock('@/lib/api', async () => {
      const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
      return {
        ...actual,
        requireCountryConfirmedUser: async () =>
          sessionUser ? { user: sessionUser, unauthenticated: null } : { user: null, unauthenticated: actual.bad('unauthenticated', 401) },
      };
    });
    const mod = await import('@/app/api/payments/promo/redeem/route');
    return { fake, POST: mod.POST };
  }

  it('unauthenticated -> 401 and the database is never called', async () => {
    const { fake, POST } = await loadRedeem(() => ({ data: { ok: true, ends_on: day(365) } }), {}, null);
    expect((await POST(post('', { code: CODE }))).status).toBe(401);
    expect(fake.rpcCalls).toHaveLength(0);
  });

  it('acts on the SESSION user, never a user id from the body; passes the raw code to the database only', async () => {
    const { fake, POST } = await loadRedeem(() => ({ data: { ok: true, ends_on: day(365) } }));
    const res = await POST(new Request('http://x', { method: 'POST', headers: { 'x-forwarded-for': '9.9.9.9, 203.0.113.9' }, body: JSON.stringify({ code: CODE, userId: 'attacker-id', user_id: 'attacker-id' }) }));
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ endsOn: day(365) });
    expect(fake.rpcCalls[0].name).toBe('redeem_promo_code_for_user');
    expect(fake.rpcCalls[0].args.p_user_id).toBe(TARGET_ID);
    expect(String(fake.rpcCalls[0].args.p_ip_hash)).toMatch(/^[0-9a-f]{64}$/); // HMAC, not the raw address
    expect(JSON.stringify(fake.rpcCalls[0].args)).not.toContain('203.0.113.9');
    expect(JSON.stringify(fake.rpcCalls[0].args), 'the forged left hand entry is not used either').not.toContain('9.9.9.9');
    // the code reaches the database as KEYED DIGESTS (one key version here) plus the normalised value for the legacy lookup only
    expect(fake.rpcCalls[0].args.p_digests).toHaveLength(1);
    expect(String((fake.rpcCalls[0].args.p_digests as string[])[0])).toMatch(/^[0-9a-f]{64}$/);
    expect(fake.rpcCalls[0].args.p_legacy_code).toBe(CODE);
    expect(fake.rpcCalls[0].args.p_email_hash, 'this session user has no address').toBeNull();
  });

  it('IP-equivalent: no dedicated secret -> no IP limiting (null) and NO fallback to CRON_SECRET; never the raw address', async () => {
    const { hashClientIp } = await import('@/lib/services/promoCodeIp');
    const h = new Headers({ 'x-forwarded-for': '203.0.113.9' });
    expect(hashClientIp(h, {})).toBeNull();
    expect(hashClientIp(h, { CRON_SECRET: 'secretsecretsecretsecretsecretsecret' }), 'CRON_SECRET is not a fallback any more').toBeNull();
    expect(hashClientIp(h, { PROMO_IP_HASH_SECRET: 'a'.repeat(40) })).toMatch(/^[0-9a-f]{64}$/);
    expect(hashClientIp(new Headers(), { PROMO_IP_HASH_SECRET: 'a'.repeat(40) })).toBeNull();
    expect(hashClientIp(h, { PROMO_IP_HASH_SECRET: 'a'.repeat(40) })).not.toBe(hashClientIp(h, { PROMO_IP_HASH_SECRET: 'b'.repeat(40) }));
  });

  async function verdictResponse(verdict: unknown) {
    const { POST } = await loadRedeem(() => ({ data: verdict }));
    const res = await POST(post('', { code: CODE }));
    return { status: res.status, body: await res.json() };
  }

  it('messages: unusable codes ALL read "This code cannot be used." (no existence oracle); paid / already used / rate limited are explicit', async () => {
    const unusable = await verdictResponse({ ok: false, code: 'PROMO_CODE_UNUSABLE' });
    expect(unusable).toEqual({ status: 422, body: { error: 'PROMO_CODE_UNUSABLE', message: 'This code cannot be used.' } });
    const paid = await verdictResponse({ ok: false, code: 'PROMO_PAID_ACTIVE' });
    expect(paid.status).toBe(409);
    expect(paid.body.message).toMatch(/paid Premium subscription/);
    expect((await verdictResponse({ ok: false, code: 'PROMO_ALREADY_REDEEMED' })).status).toBe(409);
    expect((await verdictResponse({ ok: false, code: 'PROMO_RATE_LIMITED' })).status).toBe(429);
    // Unknown / malformed verdicts degrade to the generic refusal, never to success.
    for (const weird of [null, {}, { ok: 'yes' }, { ok: false, code: 'SOMETHING_NEW' }, { ok: true }]) {
      expect(await verdictResponse(weird), JSON.stringify(weird)).toMatchObject({ status: 422, body: { error: 'PROMO_CODE_UNUSABLE' } });
    }
  });

  it('NEGATIVE CONTROL — mapping "expired" and "does not exist" to different messages would be an oracle (assertion "unusable reasons must read identically" goes red)', async () => {
    const leaky = (reason: string) => (reason === 'expired' ? 'This code has expired.' : 'This code does not exist.');
    expect(() => expect(leaky('expired'), 'unusable reasons must read identically').toBe(leaky('missing'))).toThrow(/unusable reasons must read identically/);
    const { REDEEM_MESSAGES } = await import('@/lib/services/promoCodes');
    expect(REDEEM_MESSAGES.PROMO_CODE_UNUSABLE.message).toBe('This code cannot be used.');
  });

  it('bad input shapes get the same generic refusal without touching the database', async () => {
    const { fake, POST } = await loadRedeem(() => ({ data: { ok: true, ends_on: day(365) } }));
    for (const body of [{}, { code: '' }, { code: 123 }, { code: 'A'.repeat(65) }, null]) {
      const res = await POST(post('', body));
      expect(res.status, JSON.stringify(body)).toBe(422);
      expect((await res.json()).error).toBe('PROMO_CODE_UNUSABLE');
    }
    expect(fake.rpcCalls).toHaveLength(0);
  });

  it('a database fault (or the migration missing) is "unavailable", grants nothing, and the code value is never logged', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { POST } = await loadRedeem(() => ({ error: { code: 'PGRST202', message: `no function (code ${CODE})` } }));
    const res = await POST(post('', { code: CODE }));
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).not.toContain(CODE);
    const logged = JSON.stringify([...errSpy.mock.calls, ...logSpy.mock.calls]);
    expect(logged, 'the code value must never appear in logs').not.toContain(CODE);
  });
});

// ---------------------------------------------------------------------------
describe('extension cap — route layer', () => {
  const caller = { adminRow: { can_manage_premium_entitlements: true } };
  const extendBody = { action: 'extend', userId: TARGET_ID, endsOn: day(60), reason: 'Customer asked for more time' };

  async function extend(searchRow: Record<string, unknown> | null, searchError = false) {
    const fake = makeSupabase({
      ...caller,
      rpc: (name) => {
        if (name === 'admin_search_premium_entitlement_users') return searchError ? { error: { code: 'XX000', message: 'boom' } } : { data: searchRow ? [searchRow] : [] };
        return { data: { plan_tier: 'premium' } };
      },
    });
    const h = await load<{ POST: (r: Request) => Promise<Response> }>('@/app/api/admin/entitlements/grants/route', fake);
    const res = await h.POST(post('', extendBody));
    return { res, fake, body: await res.json() };
  }

  it('the TypeScript constant is named and equals 5', async () => {
    const { MAX_EXTENSIONS_PER_GRANT } = await import('@/lib/services/premiumGrantAdmin');
    expect(MAX_EXTENSIONS_PER_GRANT).toBe(5);
  });

  async function assertRouteCap(): Promise<void> {
    const atLimit = await extend({ user_id: TARGET_ID, entitlement_source: 'admin_grant', extension_count: 5 });
    expect(atLimit.res.status, 'the 6th extension must be refused at the route').toBe(409);
    expect(atLimit.body.error).toBe('ENTITLEMENT_EXTENSION_LIMIT_REACHED');
    expect(atLimit.fake.rpcCalls.some((c) => c.name === 'admin_manage_premium_entitlement'), 'a refused extension never reaches the write path').toBe(false);
    const under = await extend({ user_id: TARGET_ID, entitlement_source: 'admin_grant', extension_count: 4 });
    expect(under.res.status).toBe(200);
    expect(under.fake.rpcCalls.some((c) => c.name === 'admin_manage_premium_entitlement')).toBe(true);
  }

  it('extension 5 passes; extension 6 is refused with a clear error before the write path', async () => {
    await assertRouteCap();
    const { body } = await extend({ user_id: TARGET_ID, entitlement_source: 'promo_code', extension_count: 5 });
    expect(body.message).toMatch(/extended 5 times/);
    expect(body.message).toMatch(/do not reset the lifetime limit/);
    expect(body.message).toMatch(/override capability/);
  });

  it('a failed lookup is NOT treated as "under the limit"-bypass: the request proceeds and the database enforces the cap itself', async () => {
    const r = await extend(null, true);
    expect(r.fake.rpcCalls.some((c) => c.name === 'admin_manage_premium_entitlement')).toBe(true);
  });

  it('NEGATIVE CONTROL — a route with the pre-check removed lets the 6th request through to the write path (assertion "a refused extension never reaches the write path" goes red)', async () => {
    // Simulate the broken route: skip the guard and call straight through.
    const fake = makeSupabase({ ...caller, rpc: () => ({ data: { plan_tier: 'premium' } }) });
    const { callManageEntitlement } = await import('@/lib/services/premiumGrantAdmin');
    await callManageEntitlement(fake.client as never, { action: 'extend', userId: TARGET_ID, endsOn: day(60), reason: 'Customer asked for more time', override: false });
    expect(() => expect(fake.rpcCalls.some((c) => c.name === 'admin_manage_premium_entitlement'), 'a refused extension never reaches the write path').toBe(false)).toThrow(
      /never reaches the write path/
    );
  });
});

// ---------------------------------------------------------------------------
describe('expiry summary route and the "no export" decision', () => {
  it('capability-gated; source filter validated; counts computed per bucket and source', async () => {
    const rows = [
      { user_id: 'a', entitlement_source: 'admin_grant', bucket: 'expired_this_month' },
      { user_id: 'b', entitlement_source: 'promo_code', bucket: 'expiring_this_month' },
      { user_id: 'c', entitlement_source: 'admin_grant', bucket: 'expiring_this_month' },
    ];
    const fake = makeSupabase({ adminRow: { can_manage_premium_entitlements: true }, rpc: () => ({ data: rows }) });
    const h = await load<{ GET: (r: Request) => Promise<Response> }>('@/app/api/admin/entitlements/summary/route', fake);
    const res = await h.GET(new Request('http://x/?source=admin_grant'));
    expect(res.status).toBe(200);
    const body = (await res.json()).data;
    expect(body.month).toBe('2026-10');
    expect(body.counts).toMatchObject({ expired_this_month: 1, expiring_this_month: 2, by_source: { admin_grant: { expired: 1, expiring: 1 }, promo_code: { expired: 0, expiring: 1 } } });
    expect(fake.rpcCalls[0]).toEqual({ name: 'admin_entitlement_expiry_summary', args: { p_source: 'admin_grant' } });
    expect((await h.GET(new Request('http://x/?source=payment'))).status).toBe(422);
    const denied = makeSupabase({ adminRow: { can_manage_premium_entitlements: false } });
    const h2 = await load<{ GET: (r: Request) => Promise<Response> }>('@/app/api/admin/entitlements/summary/route', denied);
    expect((await h2.GET(new Request('http://x/'))).status).toBe(403);
    expect(denied.rpcCalls).toHaveLength(0);
  });

  it('there is NO export (CSV/PDF) of the expiry list: Standard §11 prerequisites are not met, so none is built (static guard)', () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
    const dirs = ['app/api/admin/entitlements', 'app/api/admin/promo-codes', 'components/admin/PremiumEntitlementsClient.tsx', 'components/admin/PromoCodesClient.tsx'];
    const walk = (p: string, out: string[] = []): string[] => {
      const full = path.join(root, p);
      if (fs.statSync(full).isDirectory()) for (const e of fs.readdirSync(full)) walk(path.join(p, e), out);
      else out.push(full);
      return out;
    };
    for (const file of dirs.flatMap((d) => walk(d))) {
      const src = fs.readFileSync(file, 'utf8');
      expect(src, `${file} must not generate exports`).not.toMatch(/text\/csv|\.csv|Content-Disposition|application\/pdf|createObjectURL/i);
    }
  });
});

// ---------------------------------------------------------------------------
describe('admin navigation — promo codes is its own capability', () => {
  it('promoCodeManagement alone shows exactly "Promo Codes"; entitlementManagement / Super Admin do not imply it, and it does not imply them', async () => {
    const nav = await import('@/lib/admin/adminNav');
    const promoOnly = nav.buildAdminNavGroups(false, { ...nav.NO_ADMIN_CAPABILITIES, promoCodeManagement: true });
    expect(promoOnly.map((g) => g.label)).toEqual(['Promo Codes']);
    expect(promoOnly[0].items).toEqual([{ label: 'Promo Codes', href: '/admin/entitlements/promo-codes' }]);
    expect(nav.buildAdminNavGroups(false, { ...nav.NO_ADMIN_CAPABILITIES, entitlementManagement: true }).map((g) => g.label)).toEqual(['Entitlements']);
    expect(nav.buildAdminNavGroups(true, nav.NO_ADMIN_CAPABILITIES).map((g) => g.label)).not.toContain('Promo Codes');
    expect(nav.parseAdminCapabilities({ data: { capabilities: { promoCodeManagement: 'true' } } }).promoCodeManagement).toBe(false);
  });

  it('GET /api/admin/me reports each of the two capabilities independently', async () => {
    const read = async (row: Row) => {
      vi.resetModules();
      vi.doMock('@/lib/resources/permissions', () => ({
        getCurrentResourceRoles: async () => ({ userId: ADMIN_ID, isSuperAdmin: true, roles: [] }),
        canViewResourceDashboard: () => false,
        canViewResourceContent: () => false,
        canViewResourceWorkflow: () => false,
        canViewResourceDiscovery: () => false,
        canViewResourceAnalytics: () => false,
      }));
      const fake = makeSupabase({ adminRow: row });
      const { GET } = await load<{ GET: () => Promise<Response> }>('@/app/api/admin/me/route', fake);
      return (await (await GET()).json()).data.capabilities as Record<string, boolean>;
    };
    expect(await read({ can_manage_promo_codes: true, can_manage_premium_entitlements: false })).toMatchObject({ promoCodeManagement: true, entitlementManagement: false });
    expect(await read({ can_manage_promo_codes: false, can_manage_premium_entitlements: true })).toMatchObject({ promoCodeManagement: false, entitlementManagement: true });
    expect(await read(null)).toMatchObject({ promoCodeManagement: false, entitlementManagement: false });
  });
});

// ---------------------------------------------------------------------------
describe('GET /api/payments/status — promo wording and reminder', () => {
  function statusClient(entitlement: Row, sourceRow: Row) {
    return {
      from(table: string) {
        if (table === 'user_profiles') return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { billing_country: 'AU', billing_country_confirmed_at: '2026-01-01' }, error: null }) }) }) };
        if (table === 'user_entitlements') {
          return { select: (cols: string) => ({ eq: () => ({ maybeSingle: async () => (cols.includes('entitlement_source') ? { data: sourceRow, error: sourceRow ? null : { message: 'no column' } } : { data: entitlement, error: null }) }) }) };
        }
        throw new Error(table);
      },
    };
  }
  async function status(entitlement: Row, sourceRow: Row) {
    vi.resetModules();
    vi.doMock('@/lib/api', async () => {
      const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
      return { ...actual, requireCountryConfirmedUser: async () => ({ user: { id: TARGET_ID }, unauthenticated: null }) };
    });
    vi.doMock('@/lib/supabase/server', () => ({ createClient: async () => statusClient(entitlement, sourceRow) }));
    const { GET } = await import('@/app/api/payments/status/route');
    return (await (await GET()).json()).data as Record<string, unknown>;
  }
  const base = { provider: null, subscription_status: null, price_id: null, current_period_end: null, cancel_at_period_end: false };

  it('promo Premium reads "Premium (promo code, ends <date>)", reports its source, and carries the expiring-soon reminder', async () => {
    const d = await status({ plan_tier: 'premium', effective_from: day(-60), effective_to: day(5), ...base }, { entitlement_source: 'promo_code', admin_grant_ends_on: day(5) });
    expect(d).toMatchObject({ planTier: 'premium', entitlementSource: 'promo_code', promoLapsed: false });
    expect(String(d.planLabel)).toMatch(/^Premium \(promo code, ends \d{2}\/\d{2}\/2026\)$/);
    expect(d.reminder).toMatchObject({ kind: 'expiring_7', days: 5 });
  });

  it('a lapsed promo reads Free, says it ended, and carries the lapsed reminder; a paid user never has a reminder', async () => {
    const lapsed = await status({ plan_tier: 'premium', effective_from: day(-90), effective_to: day(-3), ...base }, { entitlement_source: 'promo_code', admin_grant_ends_on: day(-3) });
    expect(lapsed).toMatchObject({ planTier: 'free', promoLapsed: true });
    expect(lapsed.reminder).toMatchObject({ kind: 'lapsed' });
    const paid = await status({ plan_tier: 'premium', effective_from: null, effective_to: day(3), ...base, provider: 'stripe', subscription_status: 'active' }, { entitlement_source: 'payment', admin_grant_ends_on: null });
    expect(paid.reminder).toBeNull();
    expect(paid).toMatchObject({ planLabel: 'Premium' });
  });

  it('deployed before the migration (source columns missing): no reminder, no error', async () => {
    const d = await status({ plan_tier: 'premium', effective_from: null, effective_to: null, ...base }, null);
    expect(d.reminder).toBeNull();
    expect(d).toMatchObject({ planTier: 'premium' });
  });
});

// ---------------------------------------------------------------------------
describe('additional controls', () => {
  it('NEGATIVE CONTROL — the pre-promo wording logic would label a promo entitlement as plain "Premium" (assertion "promo Premium must not read as plain Premium" goes red)', async () => {
    const { describePlanStatus } = await import('@/lib/services/entitlementPlanStatus');
    const row = { plan_tier: 'premium', entitlement_source: 'promo_code', effective_from: day(-5), effective_to: day(20), admin_grant_ends_on: day(20) };
    expect(describePlanStatus(row, TODAY).label, 'promo Premium must not read as plain Premium').not.toBe('Premium');
    const legacyLabel = (r: typeof row) => (r.plan_tier === 'premium' && r.entitlement_source === 'admin_grant' ? 'Premium (granted by FHIP admin)' : 'Premium');
    expect(() => expect(legacyLabel(row), 'promo Premium must not read as plain Premium').not.toBe('Premium')).toThrow(/promo Premium must not read as plain Premium/);
  });

  it('NEGATIVE CONTROL — a route that logged the submitted code would be caught by the same leak check (assertion "the code value must never appear in logs" goes red)', async () => {
    const CODE = 'LOGLEAKCODE22';
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const check = () => expect(JSON.stringify(errSpy.mock.calls), 'the code value must never appear in logs').not.toContain(CODE);
    check(); // nothing logged yet
    console.error('promo redeem failed for', CODE); // the broken behaviour
    expect(check).toThrow(/the code value must never appear in logs/);
  });

  it('NEGATIVE CONTROL — a naive route taking the user id from the body would let a caller redeem for someone else (assertion "redeem must act on the session user" goes red)', async () => {
    const naive = (body: { userId?: string }, session: { id: string }) => body.userId ?? session.id;
    const acts = (resolve: (b: { userId?: string }, s: { id: string }) => string) =>
      expect(resolve({ userId: 'attacker-chosen' }, { id: TARGET_ID }), 'redeem must act on the session user').toBe(TARGET_ID);
    expect(() => acts(naive)).toThrow(/redeem must act on the session user/);
    expect(() => acts((_b, s) => s.id)).not.toThrow();
  });
});
