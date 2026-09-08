// LR-10 WP-12 — activation control for both payment providers. Confirms the
// same fail-safe behaviour is enforced for Stripe AND Razorpay: unconfigured
// -> NOT_CONFIGURED, and a test/live key mismatched against NODE_ENV ->
// KEY_ENVIRONMENT_MISMATCH (NEG: "a DEV/test key must never construct a
// client believed to be live, and vice versa").
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

function resetEnv() {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, ORIGINAL_ENV);
}

describe('getStripeUnavailableReason / getStripeClient', () => {
  beforeEach(() => {
    vi.resetModules();
    resetEnv();
  });
  afterEach(() => {
    resetEnv();
    vi.unstubAllEnvs();
  });

  it('NOT_CONFIGURED when no key is set', async () => {
    delete process.env.STRIPE_SECRET_KEY;
    const { getStripeUnavailableReason, getStripeClient } = await import('@/lib/services/payments/stripeClient');
    expect(getStripeUnavailableReason()).toBe('NOT_CONFIGURED');
    expect(getStripeClient()).toBeNull();
  });

  it('KEY_ENVIRONMENT_MISMATCH — a live key outside production', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    process.env.STRIPE_SECRET_KEY = 'sk_live_abc123';
    const { getStripeUnavailableReason, getStripeClient } = await import('@/lib/services/payments/stripeClient');
    expect(getStripeUnavailableReason()).toBe('KEY_ENVIRONMENT_MISMATCH');
    expect(getStripeClient()).toBeNull();
  });

  it('KEY_ENVIRONMENT_MISMATCH — a test key inside production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    process.env.STRIPE_SECRET_KEY = 'sk_test_abc123';
    const { getStripeUnavailableReason, getStripeClient } = await import('@/lib/services/payments/stripeClient');
    expect(getStripeUnavailableReason()).toBe('KEY_ENVIRONMENT_MISMATCH');
    expect(getStripeClient()).toBeNull();
  });

  it('a matching test key outside production is usable', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    process.env.STRIPE_SECRET_KEY = 'sk_test_abc123';
    const { getStripeUnavailableReason, getStripeClient } = await import('@/lib/services/payments/stripeClient');
    expect(getStripeUnavailableReason()).toBeNull();
    expect(getStripeClient()).not.toBeNull();
  });
});

describe('getRazorpayUnavailableReason / getRazorpayClient', () => {
  beforeEach(() => {
    vi.resetModules();
    resetEnv();
  });
  afterEach(() => {
    resetEnv();
    vi.unstubAllEnvs();
  });

  it('NOT_CONFIGURED when key id or secret is missing', async () => {
    delete process.env.RAZORPAY_KEY_ID;
    delete process.env.RAZORPAY_KEY_SECRET;
    const { getRazorpayUnavailableReason, getRazorpayClient } = await import('@/lib/services/payments/razorpayClient');
    expect(getRazorpayUnavailableReason()).toBe('NOT_CONFIGURED');
    expect(getRazorpayClient()).toBeNull();
  });

  it('KEY_ENVIRONMENT_MISMATCH — a live key outside production', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    process.env.RAZORPAY_KEY_ID = 'rzp_live_abc123';
    process.env.RAZORPAY_KEY_SECRET = 'secret';
    const { getRazorpayUnavailableReason, getRazorpayClient } = await import('@/lib/services/payments/razorpayClient');
    expect(getRazorpayUnavailableReason()).toBe('KEY_ENVIRONMENT_MISMATCH');
    expect(getRazorpayClient()).toBeNull();
  });

  it('KEY_ENVIRONMENT_MISMATCH — a test key inside production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    process.env.RAZORPAY_KEY_ID = 'rzp_test_abc123';
    process.env.RAZORPAY_KEY_SECRET = 'secret';
    const { getRazorpayUnavailableReason, getRazorpayClient } = await import('@/lib/services/payments/razorpayClient');
    expect(getRazorpayUnavailableReason()).toBe('KEY_ENVIRONMENT_MISMATCH');
    expect(getRazorpayClient()).toBeNull();
  });

  it('a matching test key outside production is usable', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    process.env.RAZORPAY_KEY_ID = 'rzp_test_abc123';
    process.env.RAZORPAY_KEY_SECRET = 'secret';
    const { getRazorpayUnavailableReason, getRazorpayClient } = await import('@/lib/services/payments/razorpayClient');
    expect(getRazorpayUnavailableReason()).toBeNull();
    expect(getRazorpayClient()).not.toBeNull();
  });
});
