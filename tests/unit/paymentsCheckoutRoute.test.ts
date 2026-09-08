// LR-10 WP-02/WP-04 — POST /api/payments/checkout. Exercises the real route
// handler with billingAuthority.ts's validatePriceForBilling() UNMOCKED (it
// is already-certified G1 code — this test proves the checkout route wires
// into it correctly, not that the function itself is correct).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const USER_ID = 'checkout-user';

const { requireUserMock } = vi.hoisted(() => ({
  requireUserMock: vi.fn(() => ({ user: { id: 'checkout-user', email: 'user@example.com' }, unauthenticated: null })),
}));
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return { ...actual, requireCountryConfirmedUser: () => requireUserMock() };
});

function makeProfileClient(profile: Record<string, unknown> | null) {
  return {
    from(table: string) {
      if (table !== 'user_profiles') throw new Error(`unexpected table: ${table}`);
      return {
        select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: profile, error: null }) }) }),
      };
    },
  };
}

function jsonRequest(body: unknown) {
  return new Request('http://x', { method: 'POST', body: JSON.stringify(body) });
}

beforeEach(() => {
  vi.resetModules();
  requireUserMock.mockReturnValue({ user: { id: USER_ID, email: 'user@example.com' }, unauthenticated: null });
  process.env.STRIPE_PRICE_ID_PREMIUM_MONTHLY_AU = 'price_stripe_au_monthly';
  process.env.STRIPE_PRICE_ID_PREMIUM_ANNUAL_AU = 'price_stripe_au_annual';
  process.env.RAZORPAY_PLAN_ID_PREMIUM_MONTHLY_IN = 'plan_razorpay_in_monthly';
  process.env.RAZORPAY_PLAN_ID_PREMIUM_ANNUAL_IN = 'plan_razorpay_in_annual';
});

afterEach(() => {
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.RAZORPAY_KEY_ID;
  delete process.env.RAZORPAY_KEY_SECRET;
  vi.unstubAllEnvs();
});

describe('POST /api/payments/checkout', () => {
  it('NEG-01 — an unconfirmed billing country is denied', async () => {
    vi.doMock('@/lib/supabase/server', () => ({ createClient: async () => makeProfileClient(null) }));
    const { POST } = await import('@/app/api/payments/checkout/route');
    const res = await POST(jsonRequest({ priceId: 'premium_monthly_au' }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe('BILLING_COUNTRY_NOT_CONFIRMED');
  });

  it('a confirmed GENERIC billing country gets an honest NO_PLAN_FOR_REGION, not a false "not confirmed"', async () => {
    vi.doMock('@/lib/supabase/server', () => ({
      createClient: async () => makeProfileClient({ billing_country: 'GB', billing_country_confirmed_at: '2026-01-01T00:00:00Z' }),
    }));
    const { POST } = await import('@/app/api/payments/checkout/route');
    const res = await POST(jsonRequest({ priceId: 'premium_monthly_au' }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe('NO_PLAN_FOR_REGION');
  });

  it('NEG-02 — an AU-confirmed user requesting an India-region price is denied by region mismatch', async () => {
    vi.doMock('@/lib/supabase/server', () => ({
      createClient: async () => makeProfileClient({ billing_country: 'AU', billing_country_confirmed_at: '2026-01-01T00:00:00Z' }),
    }));
    const { POST } = await import('@/app/api/payments/checkout/route');
    const res = await POST(jsonRequest({ priceId: 'premium_monthly_in' }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe('PRICE_REGION_MISMATCH');
  });

  it('an unknown priceId is denied', async () => {
    vi.doMock('@/lib/supabase/server', () => ({
      createClient: async () => makeProfileClient({ billing_country: 'AU', billing_country_confirmed_at: '2026-01-01T00:00:00Z' }),
    }));
    const { POST } = await import('@/app/api/payments/checkout/route');
    const res = await POST(jsonRequest({ priceId: 'not_a_real_plan' }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe('PRICE_ID_UNKNOWN');
  });

  it('a valid AU checkout with Stripe unconfigured fails closed with 503, never a fabricated checkout URL', async () => {
    delete process.env.STRIPE_SECRET_KEY;
    vi.doMock('@/lib/supabase/server', () => ({
      createClient: async () => makeProfileClient({ billing_country: 'AU', billing_country_confirmed_at: '2026-01-01T00:00:00Z' }),
    }));
    const { POST } = await import('@/app/api/payments/checkout/route');
    const res = await POST(jsonRequest({ priceId: 'premium_monthly_au' }));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe('NOT_CONFIGURED');
  });

  it('a valid AU checkout with Stripe configured returns the provider session URL', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    process.env.STRIPE_SECRET_KEY = 'sk_test_abc';
    vi.doMock('@/lib/supabase/server', () => ({
      createClient: async () => makeProfileClient({ billing_country: 'AU', billing_country_confirmed_at: '2026-01-01T00:00:00Z' }),
    }));
    vi.doMock('@/lib/services/payments/stripeCheckout', () => ({
      createStripeCheckoutSession: vi.fn(async () => ({ url: 'https://checkout.stripe.com/session/abc' })),
    }));
    const { POST } = await import('@/app/api/payments/checkout/route');
    const res = await POST(jsonRequest({ priceId: 'premium_monthly_au' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ provider: 'stripe', url: 'https://checkout.stripe.com/session/abc' });
  });

  it('a valid IN checkout with Razorpay configured returns the provider session URL', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    process.env.RAZORPAY_KEY_ID = 'rzp_test_abc';
    process.env.RAZORPAY_KEY_SECRET = 'secret';
    vi.doMock('@/lib/supabase/server', () => ({
      createClient: async () => makeProfileClient({ billing_country: 'IN', billing_country_confirmed_at: '2026-01-01T00:00:00Z' }),
    }));
    vi.doMock('@/lib/services/payments/razorpaySubscription', () => ({
      createRazorpaySubscription: vi.fn(async () => ({ shortUrl: 'https://rzp.io/i/abc', subscriptionId: 'sub_abc' })),
    }));
    const { POST } = await import('@/app/api/payments/checkout/route');
    const res = await POST(jsonRequest({ priceId: 'premium_monthly_in' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ provider: 'razorpay', url: 'https://rzp.io/i/abc' });
  });
});
