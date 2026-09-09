// LR-10 WP-10 — POST /api/user/billing-country/confirm. Confirms the new
// guard added ahead of the existing (unmodified) confirm_billing_country
// RPC: a user with a LIVE subscription changing their billing country to a
// DIFFERENT country is blocked; everything else (first-time confirmation,
// re-confirming the same country, a free user, a cancelled subscription) is
// unaffected.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { requireUserMock } = vi.hoisted(() => ({
  requireUserMock: vi.fn(() => ({ user: { id: 'billing-user' }, unauthenticated: null })),
}));
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return { ...actual, requireCountryConfirmedUser: () => requireUserMock() };
});

function makeClient(profile: Record<string, unknown> | null, entitlement: Record<string, unknown> | null) {
  const rpcCalls: unknown[] = [];
  return {
    client: {
      from(table: string) {
        if (table === 'user_profiles') {
          return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: profile, error: null }) }) }) };
        }
        if (table === 'user_entitlements') {
          return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: entitlement, error: null }) }) }) };
        }
        throw new Error(`unexpected table: ${table}`);
      },
      rpc(name: string, args: unknown) {
        rpcCalls.push({ name, args });
        return Promise.resolve({ data: { billing_country: (args as { p_billing_country: string }).p_billing_country }, error: null });
      },
    },
    rpcCalls,
  };
}

function jsonRequest(body: unknown) {
  return new Request('http://x', { method: 'POST', body: JSON.stringify(body) });
}

beforeEach(() => {
  vi.resetModules();
  requireUserMock.mockReturnValue({ user: { id: 'billing-user' }, unauthenticated: null });
});

describe('POST /api/user/billing-country/confirm', () => {
  it('first-time confirmation (no prior billing_country) proceeds even with no entitlement row', async () => {
    const fake = makeClient(null, null);
    vi.doMock('@/lib/supabase/server', () => ({ createClient: async () => fake.client }));
    const { POST } = await import('@/app/api/user/billing-country/confirm/route');
    const res = await POST(jsonRequest({ billing_country: 'AU' }));
    expect(res.status).toBe(200);
    expect(fake.rpcCalls).toHaveLength(1);
  });

  it('re-confirming the SAME billing country is never blocked, even with an active subscription', async () => {
    const fake = makeClient({ billing_country: 'AU' }, { subscription_status: 'active' });
    vi.doMock('@/lib/supabase/server', () => ({ createClient: async () => fake.client }));
    const { POST } = await import('@/app/api/user/billing-country/confirm/route');
    const res = await POST(jsonRequest({ billing_country: 'AU' }));
    expect(res.status).toBe(200);
  });

  it('WP-10 — changing billing country while a subscription is active (status=active) is blocked with 409', async () => {
    const fake = makeClient({ billing_country: 'AU' }, { subscription_status: 'active' });
    vi.doMock('@/lib/supabase/server', () => ({ createClient: async () => fake.client }));
    const { POST } = await import('@/app/api/user/billing-country/confirm/route');
    const res = await POST(jsonRequest({ billing_country: 'IN' }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('ACTIVE_SUBSCRIPTION_BLOCKS_COUNTRY_CHANGE');
    expect(fake.rpcCalls).toHaveLength(0);
  });

  it('WP-10 — a past_due (grace-period) subscription also blocks a country change', async () => {
    const fake = makeClient({ billing_country: 'AU' }, { subscription_status: 'past_due' });
    vi.doMock('@/lib/supabase/server', () => ({ createClient: async () => fake.client }));
    const { POST } = await import('@/app/api/user/billing-country/confirm/route');
    const res = await POST(jsonRequest({ billing_country: 'IN' }));
    expect(res.status).toBe(409);
  });

  it('a CANCELLED subscription does not block a country change', async () => {
    const fake = makeClient({ billing_country: 'AU' }, { subscription_status: 'canceled' });
    vi.doMock('@/lib/supabase/server', () => ({ createClient: async () => fake.client }));
    const { POST } = await import('@/app/api/user/billing-country/confirm/route');
    const res = await POST(jsonRequest({ billing_country: 'IN' }));
    expect(res.status).toBe(200);
    expect(fake.rpcCalls).toHaveLength(1);
  });

  it('a free user (no entitlement row at all) can change billing country freely', async () => {
    const fake = makeClient({ billing_country: 'AU' }, null);
    vi.doMock('@/lib/supabase/server', () => ({ createClient: async () => fake.client }));
    const { POST } = await import('@/app/api/user/billing-country/confirm/route');
    const res = await POST(jsonRequest({ billing_country: 'IN' }));
    expect(res.status).toBe(200);
  });
});
