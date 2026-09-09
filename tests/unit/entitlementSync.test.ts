// LR-10 WP-07 — subscription-status -> plan_tier mapping and the two
// webhook-side lookups. `past_due` deliberately keeps Premium (grace
// period); every other non-{active,trialing,past_due} status downgrades to
// 'free' — this is the one place that decision is actually enforced.
import { describe, it, expect, vi } from 'vitest';

function makeFakeAdmin(entitlementRows: Record<string, unknown>[]) {
  const updates: Record<string, unknown>[] = [];
  return {
    client: {
      from(table: string) {
        if (table !== 'user_entitlements') throw new Error(`unexpected table: ${table}`);
        let filtered = [...entitlementRows];
        return {
          update(patch: Record<string, unknown>) {
            updates.push(patch);
            return {
              eq(col: string, val: unknown) {
                const target = entitlementRows.find((r) => r[col] === val);
                if (target) Object.assign(target, patch);
                return Promise.resolve({ error: null });
              },
            };
          },
          select() {
            return this;
          },
          eq(col: string, val: unknown) {
            filtered = filtered.filter((r) => r[col] === val);
            return this;
          },
          maybeSingle() {
            return Promise.resolve({ data: filtered[0] ?? null, error: null });
          },
        };
      },
    },
    updates,
  };
}

describe('applySubscriptionEvent', () => {
  it('active -> plan_tier premium', async () => {
    vi.resetModules();
    const fake = makeFakeAdmin([{ user_id: 'u1' }]);
    vi.doMock('@/lib/supabase/admin', () => ({ createAdminClient: () => fake.client }));
    const { applySubscriptionEvent } = await import('@/lib/services/payments/entitlementSync');
    await applySubscriptionEvent({
      userId: 'u1',
      provider: 'stripe',
      providerCustomerId: 'cus_1',
      providerSubscriptionId: 'sub_1',
      subscriptionStatus: 'active',
      priceId: 'premium_monthly_au',
      currentPeriodEnd: '2026-10-01T00:00:00.000Z',
      cancelAtPeriodEnd: false,
    });
    expect(fake.updates[0]).toMatchObject({ plan_tier: 'premium' });
  });

  it('past_due -> plan_tier stays premium (grace period, not an instant downgrade)', async () => {
    vi.resetModules();
    const fake = makeFakeAdmin([{ user_id: 'u1' }]);
    vi.doMock('@/lib/supabase/admin', () => ({ createAdminClient: () => fake.client }));
    const { applySubscriptionEvent } = await import('@/lib/services/payments/entitlementSync');
    await applySubscriptionEvent({
      userId: 'u1',
      provider: 'stripe',
      providerCustomerId: 'cus_1',
      providerSubscriptionId: 'sub_1',
      subscriptionStatus: 'past_due',
      priceId: 'premium_monthly_au',
      currentPeriodEnd: '2026-10-01T00:00:00.000Z',
      cancelAtPeriodEnd: false,
    });
    expect(fake.updates[0]).toMatchObject({ plan_tier: 'premium' });
  });

  it('canceled -> plan_tier downgrades to free', async () => {
    vi.resetModules();
    const fake = makeFakeAdmin([{ user_id: 'u1' }]);
    vi.doMock('@/lib/supabase/admin', () => ({ createAdminClient: () => fake.client }));
    const { applySubscriptionEvent } = await import('@/lib/services/payments/entitlementSync');
    await applySubscriptionEvent({
      userId: 'u1',
      provider: 'stripe',
      providerCustomerId: 'cus_1',
      providerSubscriptionId: 'sub_1',
      subscriptionStatus: 'canceled',
      priceId: 'premium_monthly_au',
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
    });
    expect(fake.updates[0]).toMatchObject({ plan_tier: 'free' });
  });
});

describe('findUserIdForProviderSubscription / findUserIdForProviderCustomer', () => {
  it('resolves a userId for a known subscription/customer, null for unknown', async () => {
    vi.resetModules();
    const fake = makeFakeAdmin([{ user_id: 'u1', provider: 'stripe', provider_subscription_id: 'sub_1', provider_customer_id: 'cus_1' }]);
    vi.doMock('@/lib/supabase/admin', () => ({ createAdminClient: () => fake.client }));
    const { findUserIdForProviderSubscription, findUserIdForProviderCustomer } = await import('@/lib/services/payments/entitlementSync');

    expect(await findUserIdForProviderSubscription('stripe', 'sub_1')).toBe('u1');
    expect(await findUserIdForProviderSubscription('stripe', 'sub_unknown')).toBeNull();
    expect(await findUserIdForProviderCustomer('stripe', 'cus_1')).toBe('u1');
    expect(await findUserIdForProviderCustomer('stripe', 'cus_unknown')).toBeNull();
  });
});
