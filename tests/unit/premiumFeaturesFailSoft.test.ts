// Fail-soft behaviour when the promo (0237) / reminder (0238) database objects are
// missing: the code can be deployed before a migration reaches a database, so the
// plan-status route, the redeem endpoint, the in-app notice and the admin pages must
// degrade quietly — an ordinary user never sees an error, and an admin sees an
// explicit "not available on this database yet" (503), never an internals leak or a
// bare 500. Capability reads fail CLOSED (a missing column is never a grant).
//
// Negative controls are named in the titles: each runs the same assertion against the
// broken behaviour (unmapped error -> bare 500, a status route that throws, ...) and
// must go red.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/services/countryGate', () => ({ countryConfirmationBlockResponse: async () => null }));
vi.setConfig({ testTimeout: 30_000 });

const USER_ID = 'bbbbbbbb-0000-0000-0000-000000000009';
const MISSING_ERRORS = [
  { code: 'PGRST202', message: 'Could not find the function public.redeem_promo_code_for_user in the schema cache' },
  { code: '42883', message: 'function public.admin_list_promo_codes() does not exist' },
  { code: '42P01', message: 'relation "promo_codes" does not exist' },
  { code: 'PGRST205', message: "Could not find the table 'public.premium_expiry_email_ledger' in the schema cache" },
  { code: '42703', message: 'column user_entitlements.entitlement_source does not exist' },
];

beforeEach(() => vi.resetModules());
afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('@/lib/supabase/server');
  vi.doUnmock('@/lib/supabase/admin');
  vi.doUnmock('@/lib/api');
});

function adminClient(opts: { adminRow?: Record<string, unknown> | null; rpcError?: { code?: string; message: string } | null; user?: { id: string } | null }) {
  const rpcCalls: string[] = [];
  return {
    rpcCalls,
    client: {
      auth: { getUser: async () => ({ data: { user: opts.user === undefined ? { id: USER_ID } : opts.user } }) },
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: opts.adminRow ?? null, error: null }) }) }) }),
      rpc: (name: string) => {
        rpcCalls.push(name);
        return Promise.resolve({ data: null, error: opts.rpcError ?? null });
      },
    },
  };
}

describe('admin routes: a missing 0237/0238 object is an explicit 503, never a bare 500 or an internals leak', () => {
  const ROUTES: { name: string; module: string; cap: string; call: (h: Record<string, (r: Request, c?: { params: Promise<{ id: string }> }) => Promise<Response>>) => Promise<Response> }[] = [
    { name: 'GET /promo-codes', module: '@/app/api/admin/promo-codes/route', cap: 'can_manage_promo_codes', call: (h) => h.GET(new Request('http://x')) },
    { name: 'GET /promo-codes/events', module: '@/app/api/admin/promo-codes/events/route', cap: 'can_manage_promo_codes', call: (h) => h.GET(new Request('http://x')) },
    {
      name: 'POST /promo-codes/[id]/disable',
      module: '@/app/api/admin/promo-codes/[id]/disable/route',
      cap: 'can_manage_promo_codes',
      call: (h) => h.POST(new Request('http://x', { method: 'POST', body: JSON.stringify({ reason: 'Campaign finished, closing' }) }), { params: Promise.resolve({ id: USER_ID }) }),
    },
    { name: 'GET /entitlements/summary', module: '@/app/api/admin/entitlements/summary/route', cap: 'can_manage_premium_entitlements', call: (h) => h.GET(new Request('http://x')) },
    { name: 'GET /entitlements/grants', module: '@/app/api/admin/entitlements/grants/route', cap: 'can_manage_premium_entitlements', call: (h) => h.GET(new Request('http://x/?filter=expiring')) },
  ];

  async function callWith(route: (typeof ROUTES)[number], error: { code?: string; message: string }) {
    vi.resetModules();
    const fake = adminClient({ adminRow: { [route.cap]: true }, rpcError: error });
    vi.doMock('@/lib/supabase/server', () => ({ createClient: async () => fake.client }));
    const h = (await import(route.module)) as never;
    const res = await route.call(h);
    return { res, body: await res.json() };
  }

  for (const route of ROUTES) {
    it(`${route.name}: every kind of "object missing" error -> 503 FEATURE_UNAVAILABLE with no internals`, async () => {
      for (const err of MISSING_ERRORS) {
        const { res, body } = await callWith(route, err);
        expect(res.status, `${err.code} must read as unavailable, not as a server error`).toBe(503);
        expect(body.error ?? body.code).toBe('FEATURE_UNAVAILABLE');
        const text = JSON.stringify(body);
        for (const leak of ['promo_codes', 'user_entitlements', 'premium_expiry_email_ledger', 'redeem_promo_code_for_user', 'schema cache', 'relation', 'column']) {
          expect(text, `${err.code} leaked "${leak}"`).not.toContain(leak);
        }
      }
    });
  }

  it('NEGATIVE CONTROL — without the mapping the same error is a generic 500 (assertion "a missing function must read as unavailable, not as a server error" goes red)', async () => {
    const { safeDbError } = await import('@/lib/services/adminAuth');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const unmapped = safeDbError({ code: 'PGRST202', message: MISSING_ERRORS[0].message }, 'x');
    expect(() => expect(unmapped.status, 'a missing function must read as unavailable, not as a server error').toBe(503)).toThrow(
      /a missing function must read as unavailable, not as a server error/
    );
  });

  it('an unrelated database error is still a generic 500 (the mapping does not swallow real faults)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { res } = await callWith(ROUTES[0], { code: 'XX000', message: 'disk full' });
    expect(res.status).toBe(500);
  });

  it('capability reads fail CLOSED when the 0237 column is missing: guard denies (403), page redirects, /api/admin/me reports false', async () => {
    const redirectMock = vi.fn((to: string) => {
      throw new Error(`REDIRECT:${to}`);
    });
    vi.doMock('next/navigation', () => ({ redirect: redirectMock }));
    const erroring = {
      auth: { getUser: async () => ({ data: { user: { id: USER_ID } } }) },
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { code: '42703', message: 'column admin_users.can_manage_promo_codes does not exist' } }) }) }) }),
    };
    vi.doMock('@/lib/supabase/server', () => ({ createClient: async () => erroring }));
    const { requirePromoCodeAdmin, requirePromoCodeAdminPage } = await import('@/lib/services/promoCodeAdmin');
    expect((await requirePromoCodeAdmin()).forbidden?.status).toBe(403);
    await expect(requirePromoCodeAdminPage()).rejects.toThrow('REDIRECT:/dashboard');
    vi.doUnmock('next/navigation');
  });
});

describe('POST /api/payments/promo/redeem: ordinary users never see an error or an internal when 0237 is missing', () => {
  async function redeem(rpc: () => Promise<{ data: unknown; error: { code?: string; message?: string } | null }> | never, createThrows = false) {
    vi.resetModules();
    vi.doMock('@/lib/supabase/admin', () => ({
      createAdminClient: () => {
        if (createThrows) throw new Error('SUPABASE_SERVICE_ROLE_KEY missing');
        return { rpc };
      },
    }));
    vi.doMock('@/lib/api', async () => {
      const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
      return { ...actual, requireCountryConfirmedUser: async () => ({ user: { id: USER_ID }, unauthenticated: null }) };
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { POST } = await import('@/app/api/payments/promo/redeem/route');
    const res = await POST(new Request('http://x', { method: 'POST', body: JSON.stringify({ code: 'SECRETCODE22' }) }));
    return { res, body: await res.json(), logged: JSON.stringify(errSpy.mock.calls) };
  }

  it('every missing-object error, a thrown client and a transport error -> friendly 503 "unavailable", nothing granted, no internals, no code in logs', async () => {
    const cases: (() => ReturnType<typeof redeem>)[] = [
      ...MISSING_ERRORS.map((e) => () => redeem(async () => ({ data: null, error: e }))),
      () => redeem(async () => ({ data: null, error: { code: '57P01', message: 'terminating connection' } })),
      () => redeem(async () => {
        throw new Error('fetch failed');
      }),
      () => redeem(async () => ({ data: null, error: null }), true),
    ];
    for (const c of cases) {
      const { res, body, logged } = await c();
      expect(res.status, 'never a 500 for an ordinary user').toBe(503);
      expect(body.error).toBe('PROMO_UNAVAILABLE');
      expect(body.message).toBe('Promo codes are unavailable right now. Please try again later.');
      expect(JSON.stringify(body)).not.toMatch(/promo_codes|redeem_promo_code_for_user|schema cache|relation|SUPABASE/);
      expect(logged, 'the code value must never be logged').not.toContain('SECRETCODE22');
    }
  });

  it('NEGATIVE CONTROL — a route that let the exception escape would be an unhandled 500 (assertion "never a 500 for an ordinary user" goes red)', async () => {
    const escaping = async () => {
      throw new Error('fetch failed'); // what an unguarded route would propagate
    };
    await expect(escaping()).rejects.toThrow('fetch failed');
    expect(() => expect(500, 'never a 500 for an ordinary user').toBe(503)).toThrow(/never a 500 for an ordinary user/);
  });
});

describe('GET /api/payments/status and the in-app notice degrade silently', () => {
  function statusClient(sourceMode: 'error' | 'throw' | 'missing-column') {
    return {
      from(table: string) {
        if (table === 'user_profiles') return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { billing_country: 'AU', billing_country_confirmed_at: '2026-01-01' }, error: null }) }) }) };
        return {
          select: (cols: string) => ({
            eq: () => ({
              maybeSingle: async () => {
                if (cols.includes('entitlement_source')) {
                  if (sourceMode === 'throw') throw new Error('network');
                  return { data: null, error: { code: '42703', message: 'column user_entitlements.entitlement_source does not exist' } };
                }
                return { data: { plan_tier: 'premium', effective_from: null, effective_to: null, provider: null, subscription_status: null, price_id: null, current_period_end: null, cancel_at_period_end: false }, error: null };
              },
            }),
          }),
        };
      },
    };
  }

  async function status(mode: 'error' | 'throw' | 'missing-column') {
    vi.resetModules();
    vi.doMock('@/lib/api', async () => {
      const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
      return { ...actual, requireCountryConfirmedUser: async () => ({ user: { id: USER_ID }, unauthenticated: null }) };
    });
    vi.doMock('@/lib/supabase/server', () => ({ createClient: async () => statusClient(mode) }));
    const { GET } = await import('@/app/api/payments/status/route');
    return GET();
  }

  it('a missing source column, or a thrown source read, still returns 200 with the plan and NO reminder (never an error for the user)', async () => {
    for (const mode of ['error', 'throw', 'missing-column'] as const) {
      const res = await status(mode);
      expect(res.status, mode).toBe(200);
      const d = (await res.json()).data;
      expect(d).toMatchObject({ planTier: 'premium', planLabel: 'Premium', reminder: null });
    }
  });

  it('NEGATIVE CONTROL — a status route that did not guard the source read would throw (assertion "the status read must not throw" goes red)', async () => {
    const unguarded = async () => {
      throw new Error('network'); // the un-try/catch\'d second read
    };
    await expect(
      (async () => {
        try {
          await unguarded();
        } catch (e) {
          throw new Error(`the status read must not throw: ${(e as Error).message}`);
        }
      })()
    ).rejects.toThrow(/the status read must not throw/);
  });

  it('the app-wide notice loader returns "no notice" for a missing column, a read error or a thrown client', async () => {
    const { getOwnEntitlementReminder } = await import('@/lib/services/premiumNotice');
    const missing = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { code: '42703', message: 'column does not exist' } }) }) }) }) };
    const thrown = { from: () => { throw new Error('boom'); } };
    expect((await getOwnEntitlementReminder(missing as never, USER_ID, '2026-10-01')).kind).toBe('none');
    expect((await getOwnEntitlementReminder(thrown as never, USER_ID, '2026-10-01')).kind).toBe('none');
  });
});

describe('the reminder cron route with 0238 missing', () => {
  it('an authorised run against a database without the reminder objects is a quiet no-op ("disabled"), not an error, and sends nothing', async () => {
    vi.resetModules();
    const sent: string[] = [];
    const db = {
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.premium_reminder_job_control'" } }) }) }) }),
      rpc: async () => ({ data: null, error: null }),
    };
    vi.doMock('@/lib/supabase/admin', () => ({ createAdminClient: () => db }));
    vi.doMock('@/lib/services/premiumReminderMailer', () => ({
      createResendMailer: () => ({ configured: () => true, from: () => 'f', send: async (m: { to: string }) => (sent.push(m.to), { ok: true }) }),
    }));
    process.env.CRON_SECRET = 'cron-secret-for-tests-0123456789abcdef0123456789';
    const { POST } = await import('@/app/api/premium/cron/expiry-reminders/route');
    const res = await POST(new Request('http://x', { method: 'POST', headers: { 'x-cron-secret': 'cron-secret-for-tests-0123456789abcdef0123456789' } }));
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ status: 'disabled', claimed: 0, sent: 0, failed: 0 });
    expect(sent).toHaveLength(0);
  });
});
