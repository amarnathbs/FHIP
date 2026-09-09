// LR-10 WP-06 — NEG-04 "duplicate entitlement": a second delivery of the
// same (provider, provider_event_id) must be recognised as ALREADY_PROCESSED
// via the table's own unique-violation, never silently reprocessed.
import { describe, it, expect, vi } from 'vitest';

function makeFakeAdmin() {
  const claimed: { provider: string; provider_event_id: string; event_type: string }[] = [];
  const updates: Record<string, unknown>[] = [];
  return {
    client: {
      from(table: string) {
        if (table !== 'payment_webhook_events') throw new Error(`unexpected table: ${table}`);
        return {
          insert(row: { provider: string; provider_event_id: string; event_type: string }) {
            const dup = claimed.find((c) => c.provider === row.provider && c.provider_event_id === row.provider_event_id);
            if (dup) return Promise.resolve({ error: { code: '23505', message: 'duplicate key' } });
            claimed.push(row);
            return Promise.resolve({ error: null });
          },
          update(patch: Record<string, unknown>) {
            updates.push(patch);
            return {
              eq: () => ({ eq: () => Promise.resolve({ error: null }) }),
            };
          },
        };
      },
    },
    claimed,
    updates,
  };
}

describe('claimWebhookEvent / markWebhookEventOutcome', () => {
  it('claims a new event and detects a duplicate delivery of the same event', async () => {
    vi.resetModules();
    const fake = makeFakeAdmin();
    vi.doMock('@/lib/supabase/admin', () => ({ createAdminClient: () => fake.client }));
    const { claimWebhookEvent } = await import('@/lib/services/payments/webhookIdempotency');

    const first = await claimWebhookEvent('stripe', 'evt_1', 'customer.subscription.updated');
    expect(first.result).toBe('CLAIMED');

    const second = await claimWebhookEvent('stripe', 'evt_1', 'customer.subscription.updated');
    expect(second.result).toBe('ALREADY_PROCESSED');
  });

  it('a non-duplicate insert failure is surfaced as ERROR, not silently treated as a duplicate', async () => {
    vi.resetModules();
    const client = {
      from: () => ({ insert: () => Promise.resolve({ error: { code: '500', message: 'db unavailable' } }) }),
    };
    vi.doMock('@/lib/supabase/admin', () => ({ createAdminClient: () => client }));
    const { claimWebhookEvent } = await import('@/lib/services/payments/webhookIdempotency');
    const result = await claimWebhookEvent('razorpay', 'evt_x', 'subscription.activated');
    expect(result.result).toBe('ERROR');
  });
});
