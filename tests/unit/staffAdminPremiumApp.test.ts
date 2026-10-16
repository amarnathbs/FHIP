// Staff admin Premium (migration 0283) -- application layer proof.
//   * the read-only staff route: explicit 401 / 403, capability read, fail-closed on a missing function, no write method;
//   * the Premium Access grant route tells a staff row from a paid one when it refuses;
//   * the promo redeem route answers a staff account plainly BEFORE any code is looked up or consumed;
//   * the wording a staff person reads (never a purchase, no end date, no reminder e-mail, no cancel flow);
//   * the billing status endpoint reports the staff source;
//   * the TypeScript role list is the one the database function uses.
// The database half is proven on a real Postgres in tests/unit/staffAdminPremiumPglite.test.ts.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEST_ENV } from './support/promoTestHelpers';
import { describePlanStatus } from '@/lib/services/entitlementPlanStatus';
import { computeEntitlementReminder } from '@/lib/services/entitlementReminder';
import {
  STAFF_PREMIUM_PLAN_LABEL,
  STAFF_PREMIUM_EXCLUDED_RESOURCE_ROLES,
  STAFF_PREMIUM_PROMO_NOTE,
  STAFF_PREMIUM_RESOURCE_ROLES,
  STAFF_PREMIUM_SOURCE,
  isStaffPremiumSource,
} from '@/lib/services/staffPremium';

vi.mock('@/lib/services/countryGate', () => ({ countryConfirmationBlockResponse: async () => null }));
vi.setConfig({ testTimeout: 30_000 });

const ADMIN_ID = 'aaaaaaaa-0000-0000-0000-00000000a001';
const TARGET_ID = 'bbbbbbbb-0000-0000-0000-000000000001';
const TODAY = '2026-10-16';

type RpcResult = { data?: unknown; error?: { code?: string; message?: string } | null };
interface FakeOpts {
  user?: { id: string } | null;
  adminRow?: Record<string, unknown> | null;
  entitlementRow?: Record<string, unknown> | null;
  entitlementError?: { message: string } | null;
  rpc?: (name: string, args: Record<string, unknown>) => RpcResult;
}

function makeSupabase(opts: FakeOpts = {}) {
  const rpcCalls: { name: string; args: Record<string, unknown> }[] = [];
  const client = {
    auth: { getUser: async () => ({ data: { user: opts.user === undefined ? { id: ADMIN_ID } : opts.user } }) },
    from(table: string) {
      if (table === 'admin_users') return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: opts.adminRow ?? null, error: null }) }) }) };
      if (table === 'user_entitlements') {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: opts.entitlementRow ?? null, error: opts.entitlementError ?? null }) }) }) };
      }
      throw new Error(`unexpected table: ${table}`);
    },
    rpc(name: string, args: Record<string, unknown>) {
      rpcCalls.push({ name, args });
      const r = opts.rpc ? opts.rpc(name, args) : {};
      return Promise.resolve({ data: r.data ?? null, error: r.error ?? null });
    },
  };
  return { client, rpcCalls };
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(`${TODAY}T12:00:00.000Z`));
  for (const [k, v] of Object.entries(TEST_ENV)) process.env[k] = v;
});
afterEach(() => {
  vi.useRealTimers();
  vi.doUnmock('@/lib/supabase/server');
  vi.doUnmock('@/lib/supabase/admin');
  vi.doUnmock('@/lib/api');
  for (const k of Object.keys(TEST_ENV)) delete process.env[k];
});

async function load<T>(modulePath: string, fake: ReturnType<typeof makeSupabase>): Promise<T> {
  vi.resetModules();
  vi.doMock('@/lib/supabase/server', () => ({ createClient: async () => fake.client }));
  vi.doMock('@/lib/supabase/admin', () => ({ createAdminClient: () => fake.client }));
  return (await import(modulePath)) as T;
}
type Handlers = Record<string, (req: Request, ctx?: { params: Promise<{ id: string }> }) => Promise<Response>>;
const CAP = { can_manage_premium_entitlements: true };

describe('GET /api/admin/entitlements/staff -- read only, capability gated, fail closed', () => {
  const MODULE = '@/app/api/admin/entitlements/staff/route';
  const get = (qs = '') => new Request(`http://x/api/admin/entitlements/staff${qs}`);

  it('unauthenticated -> 401, no capability -> 403, and the database is never reached (direct-API test)', async () => {
    const anon = makeSupabase({ user: null });
    expect((await (await load<Handlers>(MODULE, anon)).GET(get())).status).toBe(401);
    expect(anon.rpcCalls).toHaveLength(0);
    const noCap = makeSupabase({ adminRow: { can_manage_premium_entitlements: false } });
    expect((await (await load<Handlers>(MODULE, noCap)).GET(get())).status).toBe(403);
    expect(noCap.rpcCalls).toHaveLength(0);
    const notAdmin = makeSupabase({ adminRow: null });
    expect((await (await load<Handlers>(MODULE, notAdmin)).GET(get())).status).toBe(403);
    expect(notAdmin.rpcCalls).toHaveLength(0);
  });

  it('the capability holder gets the list from the database function, as the caller (not the service role)', async () => {
    const rows = [{ user_id: TARGET_ID, email: 'a@b.test', roles: 'Super Admin', plan_tier: 'premium', entitlement_source: 'staff_admin', effective_from: '2026-10-01', entitlement_active: true, state: 'staff_premium' }];
    const fake = makeSupabase({ adminRow: CAP, rpc: () => ({ data: rows }) });
    const res = await (await load<Handlers>(MODULE, fake)).GET(get());
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ staff: rows });
    expect(fake.rpcCalls.map((c) => c.name)).toEqual(['admin_list_staff_premium']);
  });

  it('?history= needs a real user id (422) and then asks only for that person', async () => {
    const bad = makeSupabase({ adminRow: CAP });
    expect((await (await load<Handlers>(MODULE, bad)).GET(get('?history=not-a-uuid'))).status).toBe(422);
    expect(bad.rpcCalls).toHaveLength(0);
    const fake = makeSupabase({ adminRow: CAP, rpc: () => ({ data: [] }) });
    const res = await (await load<Handlers>(MODULE, fake)).GET(get(`?history=${TARGET_ID.toUpperCase()}`));
    expect(res.status).toBe(200);
    expect(fake.rpcCalls).toEqual([{ name: 'admin_staff_premium_history', args: { p_target_user_id: TARGET_ID, p_limit: 50 } }]);
  });

  it('a missing database function (migration not applied) is a 503, never an empty 200 (fail closed)', async () => {
    const fake = makeSupabase({ adminRow: CAP, rpc: () => ({ error: { code: 'PGRST202', message: 'Could not find the function public.admin_list_staff_premium' } }) });
    const res = await (await load<Handlers>(MODULE, fake)).GET(get());
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('FEATURE_UNAVAILABLE');
  });

  it('a database refusal of the capability is passed on as 403, internals never leak', async () => {
    const fake = makeSupabase({ adminRow: CAP, rpc: () => ({ error: { code: '42501', message: 'ENTITLEMENT_ADMIN_REQUIRED' } }) });
    expect((await (await load<Handlers>(MODULE, fake)).GET(get())).status).toBe(403);
    const boom = makeSupabase({ adminRow: CAP, rpc: () => ({ error: { code: 'XX000', message: 'relation "staff_premium_events" internals' } }) });
    const r = await (await load<Handlers>(MODULE, boom)).GET(get());
    expect(r.status).toBe(500);
    expect(JSON.stringify(await r.json())).not.toContain('staff_premium_events');
  });

  it('there is no write method: staff Premium cannot be changed from the application', async () => {
    const mod = await load<Record<string, unknown>>(MODULE, makeSupabase({ adminRow: CAP }));
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) expect(mod[method], method).toBeUndefined();
  });
});

describe('POST /api/admin/entitlements/grants -- a staff row is not described as paid', () => {
  const MODULE = '@/app/api/admin/entitlements/grants/route';
  const post = (body: unknown) => new Request('http://x/api/admin/entitlements/grants', { method: 'POST', body: JSON.stringify(body) });
  const body = (over: Record<string, unknown> = {}) => ({ action: 'revoke', userId: TARGET_ID, reason: 'Trying to revoke staff access', ...over });
  const refused = { error: { code: 'P0001', message: 'ENTITLEMENT_PAID_ACTIVE' } };

  function rpcFor(searchRow: Record<string, unknown> | 'error') {
    return (name: string): RpcResult => {
      if (name === 'admin_manage_premium_entitlement') return refused;
      if (name === 'admin_search_premium_entitlement_users') return searchRow === 'error' ? { error: { code: 'XX000', message: 'boom' } } : { data: [searchRow] };
      return {};
    };
  }

  it('staff target: 409 ENTITLEMENT_STAFF_PREMIUM with the truthful message', async () => {
    const fake = makeSupabase({ adminRow: CAP, rpc: rpcFor({ user_id: TARGET_ID, entitlement_source: 'staff_admin' }) });
    const res = await (await load<Handlers>(MODULE, fake)).POST(post(body()));
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe('ENTITLEMENT_STAFF_PREMIUM');
    expect(json.message ?? json.data ?? '').toBeDefined();
    expect(JSON.stringify(json)).toMatch(/staff account/i);
    expect(JSON.stringify(json)).not.toMatch(/paid, or set manually/i);
  });

  it('NEGATIVE CONTROL -- a paid target keeps the original refusal (assertion "paid stays paid" goes red if every refusal said staff)', async () => {
    const fake = makeSupabase({ adminRow: CAP, rpc: rpcFor({ user_id: TARGET_ID, entitlement_source: 'payment' }) });
    const res = await (await load<Handlers>(MODULE, fake)).POST(post(body()));
    expect(res.status, 'paid stays paid').toBe(409);
    expect((await res.json()).error, 'paid stays paid').toBe('ENTITLEMENT_PAID_ACTIVE');
  });

  it('an unreadable lookup falls back to the original refusal (never a guess)', async () => {
    const fake = makeSupabase({ adminRow: CAP, rpc: rpcFor('error') });
    const res = await (await load<Handlers>(MODULE, fake)).POST(post(body()));
    expect((await res.json()).error).toBe('ENTITLEMENT_PAID_ACTIVE');
  });
});

describe('POST /api/payments/promo/redeem -- a staff account is answered before any code is touched', () => {
  async function loadRedeem(entitlementRow: Record<string, unknown> | null, entitlementError: { message: string } | null = null) {
    const fake = makeSupabase({ entitlementRow, entitlementError, rpc: () => ({ data: { ok: true, ends_on: '2026-11-15' } }) });
    vi.resetModules();
    vi.doMock('@/lib/supabase/admin', () => ({ createAdminClient: () => fake.client }));
    vi.doMock('@/lib/api', async () => {
      const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
      return { ...actual, requireCountryConfirmedUser: async () => ({ user: { id: TARGET_ID }, unauthenticated: null }) };
    });
    const mod = await import('@/app/api/payments/promo/redeem/route');
    return { fake, POST: mod.POST };
  }
  const req = () => new Request('http://x', { method: 'POST', body: JSON.stringify({ code: 'SOMECODE2222' }) });

  it('staff: 409 PROMO_STAFF_PREMIUM and the redeem function is never called (no attempt counted, no code consumed)', async () => {
    const { fake, POST } = await loadRedeem({ entitlement_source: 'staff_admin' });
    const res = await POST(req());
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('PROMO_STAFF_PREMIUM');
    expect(fake.rpcCalls).toHaveLength(0);
  });

  it('NEGATIVE CONTROL -- an ordinary customer is NOT stopped (assertion "customers still redeem" goes red if the check refused everyone)', async () => {
    const { fake, POST } = await loadRedeem({ entitlement_source: 'payment' });
    const res = await POST(req());
    expect(res.status, 'customers still redeem').toBe(200);
    expect(fake.rpcCalls.map((c) => c.name), 'customers still redeem').toEqual(['redeem_promo_code_for_user']);
  });

  it('fail soft: an unreadable entitlement falls through to the database, which refuses a staff row itself (the control is the trigger)', async () => {
    const { fake, POST } = await loadRedeem(null, { message: 'read failed' });
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(fake.rpcCalls).toHaveLength(1);
  });
});

describe('what a staff person reads and is offered', () => {
  const staffRow = { plan_tier: 'premium', entitlement_source: STAFF_PREMIUM_SOURCE, effective_from: '2026-10-01', effective_to: null, admin_grant_ends_on: null };

  it('plan wording: Premium included with the staff account, no end date, never a purchase', () => {
    const s = describePlanStatus(staffRow, TODAY, 'AU');
    expect(s.kind).toBe('premium_staff');
    expect(s.planTier).toBe('premium');
    expect(s.label).toBe(STAFF_PREMIUM_PLAN_LABEL);
    expect(s.grantEndsOn).toBeNull();
    expect(s.label).not.toMatch(/paid|subscri|renew|\d{2}[-/]\d{2}[-/]\d{4}/i);
  });

  it('an admin grant, a promo and a paid plan are described exactly as before (regression)', () => {
    expect(describePlanStatus({ plan_tier: 'premium', entitlement_source: 'admin_grant', effective_to: '2026-12-01', admin_grant_ends_on: '2026-12-01' }, TODAY, 'AU').kind).toBe('premium_admin_grant');
    expect(describePlanStatus({ plan_tier: 'premium', entitlement_source: 'promo_code', effective_to: '2026-12-01', admin_grant_ends_on: '2026-12-01' }, TODAY, 'AU').kind).toBe('premium_promo');
    expect(describePlanStatus({ plan_tier: 'premium', entitlement_source: 'payment' }, TODAY, 'AU').kind).toBe('premium_paid');
    expect(describePlanStatus({ plan_tier: 'free', entitlement_source: 'payment' }, TODAY, 'AU').kind).toBe('free');
  });

  it('no expiry reminder is ever produced for a staff row (it has no end)', () => {
    expect(computeEntitlementReminder(staffRow, TODAY).kind).toBe('none');
    expect(computeEntitlementReminder({ ...staffRow, effective_to: '2026-10-20' }, TODAY).kind, 'even a malformed end date cannot trigger a reminder').toBe('none');
  });

  it('the promo note and the plan label never use a US or ISO date', () => {
    for (const t of [STAFF_PREMIUM_PROMO_NOTE, STAFF_PREMIUM_PLAN_LABEL]) expect(t).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('GET /api/payments/status reports the staff source and the staff label, and no end date', async () => {
    const fake = {
      auth: { getUser: async () => ({ data: { user: { id: TARGET_ID } } }) },
      from(table: string) {
        const rows: Record<string, Record<string, unknown>> = {
          user_profiles: { billing_country: 'AU', billing_country_confirmed_at: '2026-01-01', country_of_residence: 'AU' },
          user_entitlements: { ...staffRow, provider: null, subscription_status: null, price_id: null, current_period_end: null, cancel_at_period_end: false },
        };
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: rows[table] ?? null, error: null }) }) }) };
      },
    };
    vi.resetModules();
    vi.doMock('@/lib/supabase/server', () => ({ createClient: async () => fake }));
    vi.doMock('@/lib/api', async () => {
      const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
      return { ...actual, requireCountryConfirmedUser: async () => ({ user: { id: TARGET_ID }, unauthenticated: null }) };
    });
    const { GET } = await import('@/app/api/payments/status/route');
    const res = await GET();
    expect(res.status).toBe(200);
    const data = (await res.json()).data;
    expect(data.planTier).toBe('premium');
    expect(data.entitlementSource).toBe('staff_admin');
    expect(data.planLabel).toBe(STAFF_PREMIUM_PLAN_LABEL);
    expect(data.adminGrantEndsOn).toBeNull();
    expect(data.promoEndsOn).toBeNull();
    expect(data.reminder).toBeNull();
    expect(data.subscriptionStatus).toBeNull();
  });
});

describe('the role list', () => {
  it('the TypeScript lists split the six Resources roles exactly: Resource Administrator and Editor are staff, the other four are excluded (PO decision D1)', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const rolesSrc = fs.readFileSync(path.join(here, '..', '..', 'lib', 'resources', 'admin', 'userRoles.ts'), 'utf8');
    const m = rolesSrc.match(/export const RESOURCE_ROLES: ResourceRole\[\] = \[([^\]]*)\]/);
    expect(m).not.toBeNull();
    const all = m![1].split(',').map((s) => s.trim().replace(/'/g, '')).filter(Boolean).sort();
    expect([...STAFF_PREMIUM_RESOURCE_ROLES].sort()).toEqual(['editor', 'resource_admin']);
    expect([...STAFF_PREMIUM_EXCLUDED_RESOURCE_ROLES].sort()).toEqual(['analyst', 'author', 'compliance_reviewer', 'publisher']);
    expect([...STAFF_PREMIUM_RESOURCE_ROLES, ...STAFF_PREMIUM_EXCLUDED_RESOURCE_ROLES].sort()).toEqual(all);
    expect(isStaffPremiumSource('staff_admin')).toBe(true);
    expect(isStaffPremiumSource('admin_grant')).toBe(false);
    expect(isStaffPremiumSource(undefined)).toBe(false);
  });
});

describe('the Premium Access screen (server render smoke: the effects that load data do not run here)', () => {
  it('renders the Staff Premium section with its explanation and no grant button for it, and does not crash', async () => {
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { createElement } = await import('react');
    const { PremiumEntitlementsClient } = await import('@/components/admin/PremiumEntitlementsClient');
    const html = renderToStaticMarkup(createElement(PremiumEntitlementsClient));
    expect(html).toContain('Staff Premium (automatic)');
    expect(html).toContain('not a paid');
    expect(html).toContain('cannot be granted, extended or revoked here');
    expect(html).toContain('staff-heading');
    // the existing sections are all still there
    for (const h of ['Admin grants', 'Find a user', 'expired and expiring']) expect(html).toContain(h);
  });

  it('the billing panel hides the promo box for a staff account and shows the explanation (source check, as no React test harness exists)', () => {
    const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'components', 'profile', 'BillingPanel.tsx'), 'utf8');
    expect(src).toContain("status.entitlementSource === 'staff_admin'");
    expect(src).toContain('STAFF_PREMIUM_PROMO_NOTE');
    // the cancel / manage flows are driven by subscriptionStatus and are untouched
    expect(src).toContain('hasLiveSubscription');
  });
});
