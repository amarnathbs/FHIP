// LR-10 WP-06 — shared idempotency gate for both webhook routes, backed by
// payment_webhook_events (migration 0133). A webhook route must claim an
// event BEFORE doing any entitlement work, and only proceed if the claim
// succeeded (a fresh insert) — the table's primary key (provider,
// provider_event_id) is what actually enforces "process at most once", not
// application logic alone (NEG-04 "duplicate entitlement" via a race between
// two near-simultaneous deliveries of the same event).
import { createAdminClient } from '@/lib/supabase/admin';
import type { PaymentProvider } from '@/lib/services/paymentPlanCatalogue';

export type ClaimResult = 'CLAIMED' | 'ALREADY_PROCESSED' | 'ERROR';

export async function claimWebhookEvent(
  provider: PaymentProvider,
  providerEventId: string,
  eventType: string
): Promise<{ result: ClaimResult; error?: string }> {
  const admin = createAdminClient();
  const { error } = await admin.from('payment_webhook_events').insert({ provider, provider_event_id: providerEventId, event_type: eventType });
  if (!error) return { result: 'CLAIMED' };
  // 23505 = unique_violation on the (provider, provider_event_id) primary key -- a genuine duplicate delivery, not a real error.
  if (error.code === '23505') return { result: 'ALREADY_PROCESSED' };
  return { result: 'ERROR', error: error.message };
}

export async function markWebhookEventOutcome(
  provider: PaymentProvider,
  providerEventId: string,
  outcome: 'processed' | 'ignored' | 'failed',
  failureReason?: string
): Promise<void> {
  const admin = createAdminClient();
  await admin
    .from('payment_webhook_events')
    .update({ processing_status: outcome, processed_at: new Date().toISOString(), failure_reason: failureReason ?? null })
    .eq('provider', provider)
    .eq('provider_event_id', providerEventId);
}
