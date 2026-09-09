// LR-10 WP-05/06 — the two webhook routes. NEG-05 "invalid signature
// accepted" and NEG-04 "duplicate entitlement" are the two properties that
// matter most here; both are exercised against the real route handlers.
import { describe, it, expect, vi, beforeEach } from 'vitest';

function makeIdempotencyFake(alreadyClaimed: Set<string> = new Set()) {
  const marked: { key: string; outcome: string }[] = [];
  return {
    claimWebhookEvent: vi.fn(async (provider: string, id: string) => {
      const key = `${provider}:${id}`;
      if (alreadyClaimed.has(key)) return { result: 'ALREADY_PROCESSED' as const };
      alreadyClaimed.add(key);
      return { result: 'CLAIMED' as const };
    }),
    markWebhookEventOutcome: vi.fn(async (provider: string, id: string, outcome: string) => {
      marked.push({ key: `${provider}:${id}`, outcome });
    }),
    marked,
  };
}

describe('POST /api/payments/stripe/webhook', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
  });

  it('returns 503 when Stripe is not configured', async () => {
    vi.doMock('@/lib/services/payments/stripeClient', () => ({
      getStripeClient: () => null,
      getStripeUnavailableReason: () => 'NOT_CONFIGURED',
    }));
    const { POST } = await import('@/app/api/payments/stripe/webhook/route');
    const res = await POST(new Request('http://x', { method: 'POST', headers: { 'stripe-signature': 'sig' }, body: '{}' }));
    expect(res.status).toBe(503);
  });

  it('NEG-05 — an invalid signature is rejected with 400 and never reaches entitlement logic', async () => {
    const idem = makeIdempotencyFake();
    vi.doMock('@/lib/services/payments/stripeClient', () => ({
      getStripeClient: () => ({
        webhooks: {
          constructEvent: () => {
            throw new Error('signature mismatch');
          },
        },
      }),
      getStripeUnavailableReason: () => null,
    }));
    vi.doMock('@/lib/services/payments/webhookIdempotency', () => idem);
    const { POST } = await import('@/app/api/payments/stripe/webhook/route');
    const res = await POST(new Request('http://x', { method: 'POST', headers: { 'stripe-signature': 'bad' }, body: '{}' }));
    expect(res.status).toBe(400);
    expect(idem.claimWebhookEvent).not.toHaveBeenCalled();
  });

  it('NEG-04 — a duplicate event delivery is acknowledged without reprocessing', async () => {
    const idem = makeIdempotencyFake(new Set(['stripe:evt_1']));
    vi.doMock('@/lib/services/payments/stripeClient', () => ({
      getStripeClient: () => ({
        webhooks: { constructEvent: () => ({ id: 'evt_1', type: 'customer.subscription.updated', data: { object: {} } }) },
      }),
      getStripeUnavailableReason: () => null,
    }));
    vi.doMock('@/lib/services/payments/webhookIdempotency', () => idem);
    const { POST } = await import('@/app/api/payments/stripe/webhook/route');
    const res = await POST(new Request('http://x', { method: 'POST', headers: { 'stripe-signature': 'sig' }, body: '{}' }));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('duplicate');
  });

  it('an unhandled event type is claimed and marked ignored, not processed as a subscription event', async () => {
    const idem = makeIdempotencyFake();
    vi.doMock('@/lib/services/payments/stripeClient', () => ({
      getStripeClient: () => ({
        webhooks: { constructEvent: () => ({ id: 'evt_2', type: 'invoice.payment_failed', data: { object: {} } }) },
      }),
      getStripeUnavailableReason: () => null,
    }));
    vi.doMock('@/lib/services/payments/webhookIdempotency', () => idem);
    const { POST } = await import('@/app/api/payments/stripe/webhook/route');
    const res = await POST(new Request('http://x', { method: 'POST', headers: { 'stripe-signature': 'sig' }, body: '{}' }));
    expect(res.status).toBe(200);
    expect(idem.marked).toEqual([{ key: 'stripe:evt_2', outcome: 'ignored' }]);
  });

  it('a subscription.updated event resolves the userId and applies the entitlement update', async () => {
    const idem = makeIdempotencyFake();
    const applySubscriptionEvent = vi.fn(async () => {});
    vi.doMock('@/lib/services/payments/stripeClient', () => ({
      getStripeClient: () => ({
        webhooks: {
          constructEvent: () => ({
            id: 'evt_3',
            type: 'customer.subscription.updated',
            data: {
              object: {
                id: 'sub_1',
                customer: 'cus_1',
                status: 'active',
                cancel_at_period_end: false,
                metadata: { fhip_user_id: 'user-1' },
                items: { data: [{ price: { id: 'price_stripe_au_monthly' }, current_period_end: 1893456000 }] },
              },
            },
          }),
        },
      }),
      getStripeUnavailableReason: () => null,
    }));
    vi.doMock('@/lib/services/payments/webhookIdempotency', () => idem);
    vi.doMock('@/lib/services/payments/entitlementSync', () => ({
      applySubscriptionEvent,
      findUserIdForProviderCustomer: vi.fn(async () => null),
    }));
    vi.doMock('@/lib/services/paymentPlanCatalogue', () => ({
      findPlanByProviderPriceId: () => ({ priceId: 'premium_monthly_au' }),
    }));
    const { POST } = await import('@/app/api/payments/stripe/webhook/route');
    const res = await POST(new Request('http://x', { method: 'POST', headers: { 'stripe-signature': 'sig' }, body: '{}' }));
    expect(res.status).toBe(200);
    expect(applySubscriptionEvent).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', provider: 'stripe', providerSubscriptionId: 'sub_1', subscriptionStatus: 'active', priceId: 'premium_monthly_au' })
    );
  });
});

describe('POST /api/payments/razorpay/webhook', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.RAZORPAY_WEBHOOK_SECRET = 'whsec_test';
  });

  it('returns 503 when Razorpay is not configured', async () => {
    vi.doMock('@/lib/services/payments/razorpayClient', () => ({ getRazorpayUnavailableReason: () => 'NOT_CONFIGURED' }));
    const { POST } = await import('@/app/api/payments/razorpay/webhook/route');
    const res = await POST(new Request('http://x', { method: 'POST', headers: { 'x-razorpay-signature': 'sig' }, body: '{}' }));
    expect(res.status).toBe(503);
  });

  it('NEG-05 — an invalid signature is rejected with 400', async () => {
    vi.doMock('@/lib/services/payments/razorpayClient', () => ({ getRazorpayUnavailableReason: () => null }));
    vi.doMock('razorpay', () => ({ default: { validateWebhookSignature: () => false } }));
    const { POST } = await import('@/app/api/payments/razorpay/webhook/route');
    const res = await POST(new Request('http://x', { method: 'POST', headers: { 'x-razorpay-signature': 'bad' }, body: '{}' }));
    expect(res.status).toBe(400);
  });

  it('NEG-04 — a duplicate event delivery is acknowledged without reprocessing', async () => {
    const idem = makeIdempotencyFake(new Set(['razorpay:evt_1']));
    vi.doMock('@/lib/services/payments/razorpayClient', () => ({ getRazorpayUnavailableReason: () => null }));
    vi.doMock('razorpay', () => ({ default: { validateWebhookSignature: () => true } }));
    vi.doMock('@/lib/services/payments/webhookIdempotency', () => idem);
    const { POST } = await import('@/app/api/payments/razorpay/webhook/route');
    const res = await POST(
      new Request('http://x', {
        method: 'POST',
        headers: { 'x-razorpay-signature': 'sig', 'x-razorpay-event-id': 'evt_1' },
        body: JSON.stringify({ event: 'subscription.activated', payload: {} }),
      })
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('duplicate');
  });

  it('a subscription.activated event resolves the userId (via notes) and applies the entitlement update', async () => {
    const idem = makeIdempotencyFake();
    const applySubscriptionEvent = vi.fn(async () => {});
    vi.doMock('@/lib/services/payments/razorpayClient', () => ({ getRazorpayUnavailableReason: () => null }));
    vi.doMock('razorpay', () => ({ default: { validateWebhookSignature: () => true } }));
    vi.doMock('@/lib/services/payments/webhookIdempotency', () => idem);
    vi.doMock('@/lib/services/payments/entitlementSync', () => ({
      applySubscriptionEvent,
      findUserIdForProviderSubscription: vi.fn(async () => null),
    }));
    vi.doMock('@/lib/services/paymentPlanCatalogue', () => ({
      findPlanByProviderPriceId: () => ({ priceId: 'premium_monthly_in' }),
    }));
    const { POST } = await import('@/app/api/payments/razorpay/webhook/route');
    const res = await POST(
      new Request('http://x', {
        method: 'POST',
        headers: { 'x-razorpay-signature': 'sig', 'x-razorpay-event-id': 'evt_2' },
        body: JSON.stringify({
          event: 'subscription.activated',
          payload: {
            subscription: {
              entity: {
                id: 'sub_1',
                plan_id: 'plan_razorpay_in_monthly',
                customer_id: 'cust_1',
                status: 'active',
                current_end: 1893456000,
                notes: { fhip_user_id: 'user-2' },
              },
            },
          },
        }),
      })
    );
    expect(res.status).toBe(200);
    expect(applySubscriptionEvent).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-2', provider: 'razorpay', providerSubscriptionId: 'sub_1', subscriptionStatus: 'active', priceId: 'premium_monthly_in' })
    );
  });
});
