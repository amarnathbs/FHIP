// Admin Premium grant (migration 0231) — application-layer proof: the route
// guards (401/403 on every route), server-side request validation (the 365-day
// cap and the mandatory reason are enforced on the server, not only in the UI),
// RPC error mapping, the window-aware plan tier every non-AI consumer now uses,
// the honest plan wording, the Stripe webhook RPC path, the admin nav
// capability, and a static guard that no new reader of user_entitlements.plan_tier
// can ignore the validity window.
//
// The database half (capability in SQL, the cap in SQL, audit atomicity, the
// webhook merge, AI-path expiry, RLS, isolation) is proven separately against a
// real Postgres in tests/unit/adminPremiumGrantPglite.test.ts.
//
// Each rule has a NEGATIVE CONTROL: the same assertion run against a deliberately
// broken rule must go red, and the failing assertion is named in the control's title.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

vi.mock('@/lib/services/countryGate', () => ({ countryConfirmationBlockResponse: async () => null }));

// Cold dynamic imports of route modules can exceed vitest's 5 s default when the machine is busy.
vi.setConfig({ testTimeout: 30_000 });

const ADMIN_ID = 'aaaaaaaa-0000-0000-0000-00000000a001';
const TARGET_ID = 'bbbbbbbb-0000-0000-0000-000000000001';
const FAKE_NOW = '2026-10-01T12:00:00.000Z';
const TODAY = '2026-10-01';

type Row = Record<string, unknown> | null;

interface FakeOpts {
  user?: { id: string } | null;
  adminRow?: Row;
  adminError?: { message: string } | null;
  rpcResult?: { data?: unknown; error?: { code?: string; message?: string } | null };
}

function makeSupabase(opts: FakeOpts = {}) {
  const rpcCalls: { name: string; args: Record<string, unknown> }[] = [];
  const client = {
    auth: { getUser: async () => ({ data: { user: opts.user === undefined ? { id: ADMIN_ID } : opts.user } }) },
    from(table: string) {
      if (table !== 'admin_users') throw new Error(`unexpected table: ${table}`);
      return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: opts.adminRow ?? null, error: opts.adminError ?? null }) }) }) };
    },
    rpc(name: string, args: Record<string, unknown>) {
      rpcCalls.push({ name, args });
      return Promise.resolve({ data: opts.rpcResult?.data ?? null, error: opts.rpcResult?.error ?? null });
    },
  };
  return { client, rpcCalls };
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(FAKE_NOW));
});
afterEach(() => {
  vi.useRealTimers();
  vi.doUnmock('@/lib/supabase/server');
  vi.doUnmock('@/lib/supabase/admin');
});

async function load<T>(modulePath: string, fake: ReturnType<typeof makeSupabase>): Promise<T> {
  vi.resetModules(); // each call binds the module graph to THIS fake client
  vi.doMock('@/lib/supabase/server', () => ({ createClient: async () => fake.client }));
  vi.doMock('@/lib/supabase/admin', () => ({ createAdminClient: () => fake.client }));
  return (await import(modulePath)) as T;
}

const jsonPost = (body: unknown) => new Request('http://x/api/admin/entitlements/grants', { method: 'POST', body: JSON.stringify(body) });
const dayOffset = (n: number) => {
  const d = new Date(`${TODAY}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const validBody = (over: Record<string, unknown> = {}) => ({
  action: 'grant',
  userId: TARGET_ID,
  endsOn: dayOffset(364),
  reason: 'Pilot customer, invoice pending',
  ...over,
});

type Handlers = Record<string, (req: Request, ctx?: { params: Promise<{ id: string }> }) => Promise<Response>>;
const ROUTES: { name: string; module: string; call: (h: Handlers) => Promise<Response> }[] = [
  { name: 'GET /grants', module: '@/app/api/admin/entitlements/grants/route', call: (h) => h.GET(new Request('http://x/api/admin/entitlements/grants?filter=expiring')) },
  { name: 'POST /grants', module: '@/app/api/admin/entitlements/grants/route', call: (h) => h.POST(jsonPost(validBody())) },
  { name: 'GET /users', module: '@/app/api/admin/entitlements/users/route', call: (h) => h.GET(new Request('http://x/api/admin/entitlements/users?q=someone')) },
  {
    name: 'GET /users/[id]/history',
    module: '@/app/api/admin/entitlements/users/[id]/history/route',
    call: (h) => h.GET(new Request('http://x'), { params: Promise.resolve({ id: TARGET_ID }) }),
  },
];

describe('authorisation — every route returns an explicit denial and never reaches the database', () => {
  for (const route of ROUTES) {
    describe(route.name, () => {
      it('unauthenticated -> 401', async () => {
        const fake = makeSupabase({ user: null });
        const h = await load<Handlers>(route.module, fake);
        const res = await route.call(h);
        expect(res.status).toBe(401);
        expect(fake.rpcCalls).toHaveLength(0);
      });
      it('signed in but not in admin_users -> 403', async () => {
        const fake = makeSupabase({ adminRow: null });
        const h = await load<Handlers>(route.module, fake);
        const res = await route.call(h);
        expect(res.status).toBe(403);
        expect(fake.rpcCalls).toHaveLength(0);
      });
      it('an admin WITHOUT can_manage_premium_entitlements -> 403 (capability-less admin)', async () => {
        const fake = makeSupabase({ adminRow: { can_manage_premium_entitlements: false } });
        const h = await load<Handlers>(route.module, fake);
        const res = await route.call(h);
        expect(res.status).toBe(403);
        expect(fake.rpcCalls).toHaveLength(0);
      });
      it('a role-lookup failure fails closed -> 403 (never a default grant)', async () => {
        const fake = makeSupabase({ adminRow: { can_manage_premium_entitlements: true }, adminError: { message: 'column does not exist' } });
        const h = await load<Handlers>(route.module, fake);
        const res = await route.call(h);
        expect(res.status).toBe(403);
        expect(fake.rpcCalls).toHaveLength(0);
      });
      it('the capability holder reaches the RPC on the CALLER session client (positive control)', async () => {
        const fake = makeSupabase({ adminRow: { can_manage_premium_entitlements: true }, rpcResult: { data: [] } });
        const h = await load<Handlers>(route.module, fake);
        const res = await route.call(h);
        expect(res.status).toBe(200);
        expect(fake.rpcCalls).toHaveLength(1);
      });
    });
  }

  it('NEGATIVE CONTROL — a bare requireAdmin() gate WOULD admit a capability-less admin (assertion "capability-less admin -> 403" goes red under requireAdmin)', async () => {
    const fake = makeSupabase({ adminRow: { can_manage_premium_entitlements: false } });
    vi.doMock('@/lib/supabase/server', () => ({ createClient: async () => fake.client }));
    const { requireAdmin } = await import('@/lib/services/adminAuth');
    const { forbidden } = await requireAdmin();
    // requireAdmin only proves "is some admin" -> it lets this caller through, which is exactly why the
    // dedicated capability exists. If the routes used it, the 403 assertions above would fail.
    expect(forbidden).toBeNull();
    const { requirePremiumEntitlementAdmin } = await import('@/lib/services/premiumEntitlementAdmin');
    expect((await requirePremiumEntitlementAdmin()).forbidden?.status).toBe(403);
  });

  it('a user cannot call the routes for themselves: an ordinary user is refused, and the database refuses an admin who targets themselves', async () => {
    const fake = makeSupabase({ adminRow: null });
    const h = await load<Handlers>('@/app/api/admin/entitlements/grants/route', fake);
    const res = await h.POST(jsonPost(validBody({ userId: ADMIN_ID })));
    expect(res.status).toBe(403);

    const fake2 = makeSupabase({ adminRow: { can_manage_premium_entitlements: true }, rpcResult: { error: { code: 'P0001', message: 'ENTITLEMENT_SELF_TARGET' } } });
    const h2 = await load<Handlers>('@/app/api/admin/entitlements/grants/route', fake2);
    const res2 = await h2.POST(jsonPost(validBody({ userId: ADMIN_ID })));
    expect(res2.status).toBe(422);
    expect((await res2.json()).error).toBe('ENTITLEMENT_SELF_TARGET');
  });

  it('page guard: no session -> /login, no capability -> /dashboard, capability -> returns the user', async () => {
    const redirectMock = vi.fn((to: string) => {
      throw new Error(`REDIRECT:${to}`);
    });
    vi.doMock('next/navigation', () => ({ redirect: redirectMock }));
    const none = makeSupabase({ user: null });
    let mod = await load<typeof import('@/lib/services/premiumEntitlementAdmin')>('@/lib/services/premiumEntitlementAdmin', none);
    await expect(mod.requirePremiumEntitlementAdminPage()).rejects.toThrow('REDIRECT:/login');

    vi.resetModules();
    const noCap = makeSupabase({ adminRow: { can_manage_premium_entitlements: false } });
    mod = await load('@/lib/services/premiumEntitlementAdmin', noCap);
    await expect(mod.requirePremiumEntitlementAdminPage()).rejects.toThrow('REDIRECT:/dashboard');

    vi.resetModules();
    const cap = makeSupabase({ adminRow: { can_manage_premium_entitlements: true } });
    mod = await load('@/lib/services/premiumEntitlementAdmin', cap);
    await expect(mod.requirePremiumEntitlementAdminPage()).resolves.toMatchObject({ id: ADMIN_ID });
    vi.doUnmock('next/navigation');
  });
});

describe('server-side request validation (before the database) — the cap and the reason are not UI-only', () => {
  const caller = { adminRow: { can_manage_premium_entitlements: true }, rpcResult: { data: { plan_tier: 'premium' } } };

  async function post(body: unknown) {
    const fake = makeSupabase(caller);
    const h = await load<Handlers>('@/app/api/admin/entitlements/grants/route', fake);
    const res = await h.POST(jsonPost(body));
    return { res, fake };
  }

  async function assertCapRoute(action: 'grant' | 'extend'): Promise<void> {
    const over = await post(validBody({ action, endsOn: dayOffset(365) }));
    expect(over.res.status, `${action} with a 366 day grant (end date today plus 365) must be rejected`).toBe(422);
    expect((await over.res.json()).error).toBe('ENTITLEMENT_END_DATE_EXCEEDS_MAX');
    expect(over.fake.rpcCalls, `a rejected ${action} must not reach the database`).toHaveLength(0);
    const exact = await post(validBody({ action, endsOn: dayOffset(364) }));
    expect(exact.res.status, `${action} with exactly 365 days must be accepted`).toBe(200);
    // (an extend first reads the user's extension count for the route-level cap check, then writes)
    const write = exact.fake.rpcCalls.find((c) => c.name === 'admin_manage_premium_entitlement');
    expect(write?.args).toMatchObject({ p_action: action, p_ends_on: dayOffset(364) });
  }

  it('grant: 366 days rejected, exactly 365 accepted', async () => {
    await assertCapRoute('grant');
  });
  it('extend: 366 days rejected, exactly 365 accepted (measured from the date of the extension)', async () => {
    await assertCapRoute('extend');
  });

  it('NEGATIVE CONTROL — a weakened cap (400 days) accepts a 366 day grant (assertion "a 366 day grant (end date today plus 365) must be rejected" goes red)', async () => {
    const { checkEndDate } = await import('@/lib/services/premiumGrantAdmin');
    const real = () => expect(checkEndDate(dayOffset(365), TODAY)?.code, 'a 366 day grant (end date today plus 365) must be rejected').toBe('ENTITLEMENT_END_DATE_EXCEEDS_MAX');
    const weakened = () => expect(checkEndDate(dayOffset(365), TODAY, 400)?.code, 'a 366 day grant (end date today plus 365) must be rejected').toBe('ENTITLEMENT_END_DATE_EXCEEDS_MAX');
    expect(real).not.toThrow();
    expect(weakened).toThrow(/366 day grant .* must be rejected/);
    // And the boundary itself: 365 is allowed by the real rule.
    expect(checkEndDate(dayOffset(364), TODAY)).toBeNull();
  });

  async function assertReasonRoute(): Promise<void> {
    for (const reason of [undefined, '', '   ', 'too short']) {
      const r = await post(validBody({ reason }));
      expect(r.res.status, `reason ${JSON.stringify(reason)} must be rejected`).toBe(422);
      expect((await r.res.json()).error).toBe('ENTITLEMENT_REASON_REQUIRED');
      expect(r.fake.rpcCalls).toHaveLength(0);
    }
    const revoke = await post(validBody({ action: 'revoke', endsOn: undefined, reason: '' }));
    expect(revoke.res.status, 'revoke also needs a reason').toBe(422);
  }
  it('a reason of at least 10 characters is mandatory for grant, extend and revoke', async () => {
    await assertReasonRoute();
  });
  it('NEGATIVE CONTROL — a parser that skipped the reason rule would accept an empty reason (assertion "reason \\"\\" must be rejected" goes red)', async () => {
    const { parseManageRequest } = await import('@/lib/services/premiumGrantAdmin');
    const parseWithoutReasonRule = (b: Record<string, unknown>) => parseManageRequest({ ...b, reason: b.reason || 'padding to satisfy the skipped rule' }, TODAY);
    const assertion = () => expect(parseWithoutReasonRule(validBody({ reason: '' })).ok, 'reason "" must be rejected').toBe(false);
    expect(assertion).toThrow(/reason "" must be rejected/);
    expect(parseManageRequest(validBody({ reason: '' }), TODAY).ok).toBe(false); // the real rule rejects it
  });

  it('rejects past dates, malformed dates, unknown actions and malformed user ids', async () => {
    expect((await post(validBody({ endsOn: dayOffset(-1) }))).res.status).toBe(422);
    expect((await post(validBody({ endsOn: '2026-13-45' }))).res.status).toBe(422);
    expect((await post(validBody({ endsOn: undefined }))).res.status).toBe(422);
    expect((await post(validBody({ action: 'upgrade' }))).res.status).toBe(422);
    expect((await post(validBody({ userId: 'not-a-uuid' }))).res.status).toBe(422);
    expect((await post('nope')).res.status).toBe(422);
  });

  it('passes the caller-supplied values to the RPC exactly (action, target, end date, trimmed reason) and nothing else', async () => {
    const r = await post(validBody({ reason: '  Pilot customer, invoice pending  ' }));
    expect(r.fake.rpcCalls).toEqual([
      { name: 'admin_manage_premium_entitlement', args: { p_action: 'grant', p_target_user_id: TARGET_ID, p_ends_on: dayOffset(364), p_reason: 'Pilot customer, invoice pending', p_override: false } },
    ]);
  });

  it('maps database refusals to explicit statuses: paid-protected 409, database-level admin denial 403, unknown errors do not leak internals', async () => {
    const paid = makeSupabase({ ...caller, rpcResult: { error: { code: 'P0001', message: 'ENTITLEMENT_PAID_ACTIVE' } } });
    let h = await load<Handlers>('@/app/api/admin/entitlements/grants/route', paid);
    let res = await h.POST(jsonPost(validBody()));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('ENTITLEMENT_PAID_ACTIVE');

    vi.resetModules();
    const dbDenied = makeSupabase({ ...caller, rpcResult: { error: { code: '42501', message: 'ENTITLEMENT_ADMIN_REQUIRED' } } });
    h = await load<Handlers>('@/app/api/admin/entitlements/grants/route', dbDenied);
    res = await h.POST(jsonPost(validBody()));
    expect(res.status).toBe(403);

    vi.resetModules();
    const boom = makeSupabase({ ...caller, rpcResult: { error: { code: 'XX000', message: 'relation "user_entitlements" has secret column internals' } } });
    h = await load<Handlers>('@/app/api/admin/entitlements/grants/route', boom);
    res = await h.POST(jsonPost(validBody()));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('user_entitlements');
  });
});

describe('window-aware plan tier — every non-AI consumer honours effective_from / effective_to', () => {
  function tierClient(row: Row) {
    return { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row, error: null }) }) }) }) };
  }
  // The pre-0231 implementation, verbatim: the bare stored flag.
  async function legacyGetPlanTier(client: ReturnType<typeof tierClient>): Promise<string> {
    const { data } = await client.from().select().eq().maybeSingle();
    return ((data as { plan_tier?: string } | null)?.plan_tier as string) ?? 'free';
  }

  async function assertExpiryReturnsFree(getTier: (row: Row) => Promise<string>): Promise<void> {
    expect(await getTier({ plan_tier: 'premium', effective_from: dayOffset(-30), effective_to: dayOffset(-1) }), 'expired grant must read as free').toBe('free');
  }

  it('premium inside the window (incl. the inclusive end date) is premium; expired, not-yet-started and missing rows are free; legacy open-ended rows stay premium', async () => {
    const { getPlanTier } = await import('@/lib/services/entitlements');
    const tier = (row: Row) => getPlanTier(TARGET_ID, tierClient(row) as never);
    expect(await tier({ plan_tier: 'premium', effective_from: dayOffset(-5), effective_to: dayOffset(30) })).toBe('premium');
    expect(await tier({ plan_tier: 'premium', effective_from: dayOffset(-5), effective_to: TODAY })).toBe('premium'); // inclusive
    expect(await tier({ plan_tier: 'premium', effective_from: null, effective_to: null })).toBe('premium');
    expect(await tier({ plan_tier: 'premium' })).toBe('premium'); // pre-existing rows/fakes without dates
    await assertExpiryReturnsFree(tier);
    expect(await tier({ plan_tier: 'premium', effective_from: dayOffset(1), effective_to: dayOffset(30) })).toBe('free');
    expect(await tier({ plan_tier: 'free', effective_from: null, effective_to: null })).toBe('free');
    expect(await tier(null)).toBe('free');
    expect(await tier({ plan_tier: 'platinum' })).toBe('free'); // unrecognised tier fails closed
  });

  it('NEGATIVE CONTROL — the pre-0231 bare-flag reader keeps an expired grant premium (assertion "expired grant must read as free" goes red)', async () => {
    await expect(assertExpiryReturnsFree((row) => legacyGetPlanTier(tierClient(row)))).rejects.toThrow(/expired grant must read as free/);
  });

  it('canExportReports and canViewPremiumReport (report export gates) follow the window', async () => {
    const { canExportReports, canViewPremiumReport } = await import('@/lib/services/entitlements');
    const expired = tierClient({ plan_tier: 'premium', effective_from: dayOffset(-30), effective_to: dayOffset(-1) }) as never;
    const live = tierClient({ plan_tier: 'premium', effective_from: dayOffset(-1), effective_to: dayOffset(20) }) as never;
    expect(await canExportReports(TARGET_ID, expired)).toBe(false);
    expect(await canViewPremiumReport(TARGET_ID, expired)).toBe(false);
    expect(await canExportReports(TARGET_ID, live)).toBe(true);
    expect(await canViewPremiumReport(TARGET_ID, live)).toBe(true);
  });

  it('countEffectivePremium counts Premium TODAY: filters on plan_tier AND both window bounds', async () => {
    const calls: [string, ...unknown[]][] = [];
    const builder: Record<string, unknown> = {};
    builder.select = (...a: unknown[]) => (calls.push(['select', ...a]), builder);
    builder.eq = (...a: unknown[]) => (calls.push(['eq', ...a]), builder);
    builder.or = (...a: unknown[]) => (calls.push(['or', ...a]), builder);
    const admin = { from: (t: string) => (calls.push(['from', t]), builder) };
    const { countEffectivePremium } = await import('@/lib/services/entitlementWindow');
    countEffectivePremium(admin as never, TODAY);
    expect(calls).toContainEqual(['from', 'user_entitlements']);
    expect(calls).toContainEqual(['eq', 'plan_tier', 'premium']);
    expect(calls).toContainEqual(['or', `effective_from.is.null,effective_from.lte.${TODAY}`]);
    expect(calls).toContainEqual(['or', `effective_to.is.null,effective_to.gte.${TODAY}`]);
  });

  describe('static inventory guard — no reader of user_entitlements.plan_tier may ignore the window', () => {
    const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
    // Files that WRITE plan_tier (webhook merge) are not readers; they are reviewed separately.
    const WRITERS = new Set(['lib/services/payments/entitlementSync.ts']);

    function readsPlanTierWithoutWindow(src: string): boolean {
      return (
        /from\(\s*['"]user_entitlements['"]\s*\)/.test(src) &&
        /plan_tier/.test(src) &&
        !/effective_to|effective_from|effectivePlanTier|getPlanTier|countEffectivePremium/.test(src)
      );
    }

    function walk(dir: string, out: string[] = []): string[] {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === '.next' || e.name.startsWith('.')) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full, out);
        else if (/\.(ts|tsx)$/.test(e.name)) out.push(full);
      }
      return out;
    }

    it('every app/, lib/ and components/ file that reads plan_tier from user_entitlements is window-aware', () => {
      const offenders: string[] = [];
      for (const top of ['app', 'lib', 'components']) {
        for (const file of walk(path.join(ROOT, top))) {
          const rel = path.relative(ROOT, file).split(path.sep).join('/');
          if (WRITERS.has(rel)) continue;
          if (readsPlanTierWithoutWindow(fs.readFileSync(file, 'utf8'))) offenders.push(rel);
        }
      }
      expect(offenders, 'these files read user_entitlements.plan_tier without honouring effective_from/effective_to').toEqual([]);
    }, 300_000);

    it('NEGATIVE CONTROL — the detector flags a bare-flag reader (assertion "no window-blind reader" goes red on a synthetic offender)', () => {
      const offender = `const { data } = await supabase.from('user_entitlements').select('plan_tier').eq('user_id', id).maybeSingle();`;
      expect(readsPlanTierWithoutWindow(offender)).toBe(true);
      const fixed = `const { data } = await supabase.from('user_entitlements').select('plan_tier, effective_to').eq('user_id', id).maybeSingle();`;
      expect(readsPlanTierWithoutWindow(fixed)).toBe(false);
    });
  });
});

describe('honest plan wording (PO requirement 6)', () => {
  it('describePlanStatus: admin grant is labelled as such with its end date; lapsed grant reads as lapsed; paid reads as plain Premium', async () => {
    const { describePlanStatus } = await import('@/lib/services/entitlementPlanStatus');
    const grant = describePlanStatus({ plan_tier: 'premium', entitlement_source: 'admin_grant', effective_from: dayOffset(-10), effective_to: '2026-10-12', admin_grant_ends_on: '2026-10-12' }, TODAY);
    expect(grant).toMatchObject({ kind: 'premium_admin_grant', planTier: 'premium', label: 'Premium (granted by FHIP admin, ends 12/10/2026)' });
    // the user's own country decides the day-first shape: India dd-mm-yyyy, never ISO or a month name
    const india = describePlanStatus({ plan_tier: 'premium', entitlement_source: 'admin_grant', effective_from: dayOffset(-10), effective_to: '2026-10-12', admin_grant_ends_on: '2026-10-12' }, TODAY, 'IN');
    expect(india.label).toBe('Premium (granted by FHIP admin, ends 12-10-2026)');
    const lapsed = describePlanStatus({ plan_tier: 'premium', entitlement_source: 'admin_grant', effective_from: dayOffset(-40), effective_to: dayOffset(-3), admin_grant_ends_on: dayOffset(-3) }, TODAY);
    expect(lapsed).toMatchObject({ kind: 'admin_grant_lapsed', planTier: 'free' });
    expect(lapsed.label).toMatch(/^Free \(your Premium access granted by FHIP admin ended /);
    expect(describePlanStatus({ plan_tier: 'premium', entitlement_source: 'payment' }, TODAY)).toMatchObject({ kind: 'premium_paid', label: 'Premium' });
    expect(describePlanStatus({ plan_tier: 'free', entitlement_source: 'payment' }, TODAY)).toMatchObject({ kind: 'free', label: 'Free' });
    expect(describePlanStatus(null, TODAY)).toMatchObject({ kind: 'free' });
    // a paid label must never claim a grant
    expect(describePlanStatus({ plan_tier: 'premium', entitlement_source: 'payment' }, TODAY).label).not.toMatch(/granted/i);
  });

  it('NEGATIVE CONTROL — the previous wording (planTier === premium ? Premium : Free) cannot say "granted by FHIP admin" (assertion "label names the admin grant" goes red)', () => {
    const legacyLabel = (planTier: string) => (planTier === 'premium' ? 'Premium' : 'Free');
    expect(() => expect(legacyLabel('premium'), 'label names the admin grant').toMatch(/granted by FHIP admin/)).toThrow(/label names the admin grant/);
  });

  describe('GET /api/payments/status', () => {
    function statusClient(entitlement: Row, sourceResult: { data: Row; error: { message: string } | null }) {
      return {
        from(table: string) {
          if (table === 'user_profiles') {
            return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { billing_country: 'AU', billing_country_confirmed_at: '2026-01-01' }, error: null }) }) }) };
          }
          if (table === 'user_entitlements') {
            return {
              select: (cols: string) => ({
                eq: () => ({ maybeSingle: async () => (cols.includes('entitlement_source') ? sourceResult : { data: entitlement, error: null }) }),
              }),
            };
          }
          throw new Error(`unexpected table ${table}`);
        },
      };
    }
    async function status(entitlement: Row, sourceResult: { data: Row; error: { message: string } | null }) {
      vi.doMock('@/lib/api', async () => {
        const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
        return { ...actual, requireCountryConfirmedUser: async () => ({ user: { id: TARGET_ID }, unauthenticated: null }) };
      });
      vi.doMock('@/lib/supabase/server', () => ({ createClient: async () => statusClient(entitlement, sourceResult) }));
      const { GET } = await import('@/app/api/payments/status/route');
      const res = await GET();
      expect(res.status).toBe(200);
      return (await res.json()).data as Record<string, unknown>;
    }
    const base = { provider: null, subscription_status: null, price_id: null, current_period_end: null, cancel_at_period_end: false };

    it('an ACTIVE admin grant shows "Premium (granted by FHIP admin, ends <date>)", premium tier, and its source', async () => {
      const d = await status(
        { plan_tier: 'premium', effective_from: dayOffset(-3), effective_to: '2026-12-25', ...base },
        { data: { entitlement_source: 'admin_grant', admin_grant_ends_on: '2026-12-25' }, error: null }
      );
      expect(d).toMatchObject({ planTier: 'premium', planLabel: 'Premium (granted by FHIP admin, ends 25/12/2026)', entitlementSource: 'admin_grant', adminGrantEndsOn: '2026-12-25', adminGrantLapsed: false });
    });

    it('a LAPSED admin grant reads as Free (window-aware) and says it lapsed', async () => {
      const d = await status(
        { plan_tier: 'premium', effective_from: dayOffset(-40), effective_to: dayOffset(-2), ...base },
        { data: { entitlement_source: 'admin_grant', admin_grant_ends_on: dayOffset(-2) }, error: null }
      );
      expect(d).toMatchObject({ planTier: 'free', adminGrantLapsed: true });
      expect(String(d.planLabel)).toMatch(/^Free \(your Premium access granted by FHIP admin ended/);
    });

    it('a paid Premium is plain "Premium" and is never described as granted', async () => {
      const d = await status(
        { plan_tier: 'premium', effective_from: null, effective_to: null, ...base, provider: 'stripe', subscription_status: 'active' },
        { data: { entitlement_source: 'payment', admin_grant_ends_on: null }, error: null }
      );
      expect(d).toMatchObject({ planTier: 'premium', planLabel: 'Premium', entitlementSource: 'payment' });
    });

    it('deployed before migration 0231 (source columns missing): still 200, and the plan is unchanged — never an error for the user', async () => {
      const d = await status({ plan_tier: 'premium', effective_from: null, effective_to: null, ...base }, { data: null, error: { message: 'column entitlement_source does not exist' } });
      expect(d).toMatchObject({ planTier: 'premium', planLabel: 'Premium' });
    });
  });
});

describe('payment webhook uses the merge RPC (a payment never shortens or silently downgrades an admin grant)', () => {
  const params = (status: string) => ({
    userId: TARGET_ID,
    provider: 'stripe' as const,
    providerCustomerId: 'cus_1',
    providerSubscriptionId: 'sub_1',
    subscriptionStatus: status as never,
    priceId: 'premium_monthly_au',
    currentPeriodEnd: '2026-10-31T00:00:00.000Z',
    cancelAtPeriodEnd: false,
  });

  function webhookAdmin(rpcError: { code?: string; message: string } | null) {
    const rpcCalls: Record<string, unknown>[] = [];
    const updates: unknown[] = [];
    const client = {
      rpc: (name: string, args: Record<string, unknown>) => {
        rpcCalls.push({ name, ...args });
        return Promise.resolve({ error: rpcError });
      },
      from: () => ({ update: (patch: unknown) => (updates.push(patch), { eq: () => Promise.resolve({ error: null }) }) }),
    };
    return { client, rpcCalls, updates };
  }

  it('the caller decides whether a status confers Premium (active/trialing/past_due yes; every other status no) and the RPC does the merge', async () => {
    for (const [status, confers] of [['active', true], ['trialing', true], ['past_due', true], ['canceled', false], ['incomplete', false], ['unpaid', false], ['incomplete_expired', false]] as const) {
      vi.resetModules();
      const fake = webhookAdmin(null);
      vi.doMock('@/lib/supabase/admin', () => ({ createAdminClient: () => fake.client }));
      const { applySubscriptionEvent } = await import('@/lib/services/payments/entitlementSync');
      await applySubscriptionEvent(params(status));
      expect(fake.rpcCalls[0], status).toMatchObject({ name: 'apply_subscription_entitlement_event', p_user_id: TARGET_ID, p_confers_premium: confers, p_subscription_status: status });
      expect(fake.updates, `${status}: no blind UPDATE of plan_tier when the RPC is available`).toHaveLength(0);
    }
  });

  it('a real RPC failure is thrown so the provider retries (never swallowed, never falls back to the blind update)', async () => {
    const fake = webhookAdmin({ code: 'XX000', message: 'boom' });
    vi.doMock('@/lib/supabase/admin', () => ({ createAdminClient: () => fake.client }));
    const { applySubscriptionEvent } = await import('@/lib/services/payments/entitlementSync');
    await expect(applySubscriptionEvent(params('canceled'))).rejects.toThrow(/boom/);
    expect(fake.updates).toHaveLength(0);
  });

  it('deploy-order safety: with the function absent (migration not yet applied) it falls back to the legacy write; only safe because no grants can exist before 0231', async () => {
    const fake = webhookAdmin({ code: 'PGRST202', message: 'Could not find the function' });
    vi.doMock('@/lib/supabase/admin', () => ({ createAdminClient: () => fake.client }));
    const { applySubscriptionEvent } = await import('@/lib/services/payments/entitlementSync');
    await applySubscriptionEvent(params('active'));
    expect(fake.updates[0]).toMatchObject({ plan_tier: 'premium' });
  });
});

describe('admin navigation — the capability gates its own item and is implied by nothing', () => {
  it('entitlementManagement alone shows exactly the Premium Access item (in the shared Premium and Promo Codes group); Super Admin alone does not; no other capability shows it', async () => {
    const nav = await import('@/lib/admin/adminNav');
    const only = nav.buildAdminNavGroups(false, { ...nav.NO_ADMIN_CAPABILITIES, entitlementManagement: true });
    expect(only.map((g) => g.label)).toEqual(['Premium and Promo Codes']);
    expect(only[0].items).toEqual([{ label: 'Premium Access', href: '/admin/entitlements' }]);
    expect(nav.buildAdminNavGroups(true, nav.NO_ADMIN_CAPABILITIES).map((g) => g.label)).not.toContain('Premium and Promo Codes'); // §3: Super Admin does not imply it
    const everythingElse = { ...nav.NO_ADMIN_CAPABILITIES, resourcesDashboard: true, resourceContentAdmin: true, resourceWorkflowAdmin: true, resourceDiscoveryAdmin: true, resourceAnalytics: true, referenceDataQuality: true, lookthroughDataQuality: true };
    expect(nav.buildAdminNavGroups(true, everythingElse).map((g) => g.label)).not.toContain('Premium and Promo Codes');
    expect(nav.shouldShowAdminMenu(false, { ...nav.NO_ADMIN_CAPABILITIES, entitlementManagement: true })).toBe(true);
  });

  it('fails closed: a missing, truthy-but-not-boolean or malformed field is false', async () => {
    const nav = await import('@/lib/admin/adminNav');
    expect(nav.parseAdminCapabilities({ data: { capabilities: {} } }).entitlementManagement).toBe(false);
    expect(nav.parseAdminCapabilities({ data: { capabilities: { entitlementManagement: 'true' } } }).entitlementManagement).toBe(false);
    expect(nav.parseAdminCapabilities({ data: { capabilities: { entitlementManagement: 1 } } }).entitlementManagement).toBe(false);
    expect(nav.parseAdminCapabilities({ data: { capabilities: { entitlementManagement: true } } }).entitlementManagement).toBe(true);
    expect(nav.parseAdminCapabilities(null)).toEqual(nav.NO_ADMIN_CAPABILITIES);
  });

  it('GET /api/admin/me reports entitlementManagement only for the flag holder (and false on a read error)', async () => {
    vi.doMock('@/lib/resources/permissions', () => ({
      getCurrentResourceRoles: async () => ({ userId: ADMIN_ID, isSuperAdmin: true, roles: [] }),
      canViewResourceDashboard: () => false,
      canViewResourceContent: () => false,
      canViewResourceWorkflow: () => false,
      canViewResourceDiscovery: () => false,
      canViewResourceAnalytics: () => false,
    }));
    const read = async (fake: ReturnType<typeof makeSupabase>) => {
      vi.resetModules();
      vi.doMock('@/lib/resources/permissions', () => ({
        getCurrentResourceRoles: async () => ({ userId: ADMIN_ID, isSuperAdmin: true, roles: [] }),
        canViewResourceDashboard: () => false,
        canViewResourceContent: () => false,
        canViewResourceWorkflow: () => false,
        canViewResourceDiscovery: () => false,
        canViewResourceAnalytics: () => false,
      }));
      const { GET } = await load<{ GET: () => Promise<Response> }>('@/app/api/admin/me/route', fake);
      return (await (await GET()).json()).data.capabilities.entitlementManagement as boolean;
    };
    expect(await read(makeSupabase({ adminRow: { can_manage_premium_entitlements: true } }))).toBe(true);
    expect(await read(makeSupabase({ adminRow: { can_manage_premium_entitlements: false } }))).toBe(false);
    expect(await read(makeSupabase({ adminRow: null }))).toBe(false);
    // Super Admin (isSuperAdmin: true above) without the flag is still false (§3).
  });
});
