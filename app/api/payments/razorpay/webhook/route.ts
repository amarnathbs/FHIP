import Razorpay from 'razorpay';
import { getRazorpayUnavailableReason } from '@/lib/services/payments/razorpayClient';
import { claimWebhookEvent, markWebhookEventOutcome } from '@/lib/services/payments/webhookIdempotency';
import { applySubscriptionEvent, findUserIdForProviderSubscription, type SubscriptionStatus } from '@/lib/services/payments/entitlementSync';
import { findPlanByProviderPriceId } from '@/lib/services/paymentPlanCatalogue';

// LR-10 WP-05/06 — the Razorpay counterpart to app/api/payments/stripe/webhook/route.ts.
// Same discipline: raw-body signature verification via Razorpay's own SDK
// utility (never a hand-rolled HMAC comparison), idempotency claim before
// any entitlement write, unknown event types acknowledged but ignored.
//
// Razorpay's webhook payload shape (per Razorpay's own documentation) —
// typed locally since the SDK types its own outbound API calls, not
// third-party-delivered webhook bodies:
interface RazorpaySubscriptionEntity {
  id: string;
  plan_id: string;
  customer_id: string | null;
  status: 'created' | 'authenticated' | 'active' | 'pending' | 'halted' | 'cancelled' | 'completed' | 'expired';
  current_end: number | null; // unix seconds
  notes?: { fhip_user_id?: string; fhip_price_id?: string };
}
interface RazorpayWebhookPayload {
  event: string;
  payload: { subscription?: { entity: RazorpaySubscriptionEntity } };
}

export async function POST(req: Request) {
  const unavailable = getRazorpayUnavailableReason();
  if (unavailable) return new Response('Razorpay not configured', { status: 503 });
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!webhookSecret) return new Response('Webhook secret not configured', { status: 503 });

  const signature = req.headers.get('x-razorpay-signature');
  if (!signature) return new Response('Missing signature', { status: 400 });

  const rawBody = await req.text();
  const validSignature = Razorpay.validateWebhookSignature(rawBody, signature, webhookSecret);
  if (!validSignature) return new Response('Invalid signature', { status: 400 });

  let body: RazorpayWebhookPayload;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return new Response('Invalid payload', { status: 400 });
  }

  const subscriptionEntity = body.payload.subscription?.entity;
  // Razorpay's X-Razorpay-Event-Id header is used where present; where a
  // given Razorpay account/API version does not send one, this falls back
  // to a composite key that is still stable across redelivery of the SAME
  // event (event type + subscription id + the entity's own current status),
  // which is the best available idempotency key without a documented
  // universal event id -- disclosed as a real limitation in the LR-10 phase
  // report rather than assumed reliable.
  const eventId = req.headers.get('x-razorpay-event-id') ?? `${body.event}:${subscriptionEntity?.id ?? 'unknown'}:${subscriptionEntity?.status ?? 'unknown'}`;

  const claim = await claimWebhookEvent('razorpay', eventId, body.event);
  if (claim.result === 'ALREADY_PROCESSED') return new Response('OK (duplicate)', { status: 200 });
  if (claim.result === 'ERROR') return new Response('Could not record event', { status: 500 });

  try {
    if (subscriptionEntity && body.event.startsWith('subscription.')) {
      await handleSubscriptionEvent(subscriptionEntity);
      await markWebhookEventOutcome('razorpay', eventId, 'processed');
    } else {
      await markWebhookEventOutcome('razorpay', eventId, 'ignored');
    }
    return new Response('OK', { status: 200 });
  } catch (err) {
    await markWebhookEventOutcome('razorpay', eventId, 'failed', err instanceof Error ? err.message : 'unknown error');
    return new Response('Processing failed', { status: 500 });
  }
}

async function handleSubscriptionEvent(entity: RazorpaySubscriptionEntity): Promise<void> {
  const userId = entity.notes?.fhip_user_id ?? (await findUserIdForProviderSubscription('razorpay', entity.id));
  if (!userId) return;

  const plan = findPlanByProviderPriceId('razorpay', entity.plan_id);

  await applySubscriptionEvent({
    userId,
    provider: 'razorpay',
    providerCustomerId: entity.customer_id ?? '',
    providerSubscriptionId: entity.id,
    subscriptionStatus: mapRazorpayStatus(entity.status),
    priceId: plan?.priceId ?? null,
    currentPeriodEnd: entity.current_end ? new Date(entity.current_end * 1000).toISOString() : null,
    cancelAtPeriodEnd: false, // Razorpay's cancel() call is immediate-or-at-cycle-end at cancellation time, not a standing subscription flag this webhook payload carries.
  });
}

function mapRazorpayStatus(status: RazorpaySubscriptionEntity['status']): SubscriptionStatus {
  switch (status) {
    case 'active':
      return 'active';
    case 'authenticated':
    case 'created':
      return 'incomplete';
    case 'pending':
      return 'past_due';
    case 'halted':
      return 'unpaid';
    case 'cancelled':
      return 'canceled';
    case 'completed':
      return 'canceled';
    case 'expired':
      return 'incomplete_expired';
    default:
      return 'incomplete_expired';
  }
}
