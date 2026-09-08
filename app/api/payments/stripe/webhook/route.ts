import { getStripeClient, getStripeUnavailableReason } from '@/lib/services/payments/stripeClient';
import { claimWebhookEvent, markWebhookEventOutcome } from '@/lib/services/payments/webhookIdempotency';
import { applySubscriptionEvent, findUserIdForProviderCustomer, type SubscriptionStatus } from '@/lib/services/payments/entitlementSync';
import { findPlanByProviderPriceId } from '@/lib/services/paymentPlanCatalogue';
import type Stripe from 'stripe';

// LR-10 WP-05/06 — the ONLY route that ever grants/revokes Premium via
// Stripe. NEG-03 "Premium granted before webhook": nothing else in this
// codebase writes user_entitlements.plan_tier from a Stripe-related signal —
// not the checkout-session creation, not a client-side success redirect.
//
// Verification uses stripe.webhooks.constructEvent() against the RAW request
// body (never the parsed JSON — signature verification is over the exact
// bytes Stripe sent) with STRIPE_WEBHOOK_SECRET (NEG-05 "invalid signature
// accepted").
export async function POST(req: Request) {
  const stripe = getStripeClient();
  const unavailable = getStripeUnavailableReason();
  if (!stripe || unavailable) {
    // Fail closed, not silently 200 — a misconfigured production webhook
    // endpoint must be visibly broken (Stripe's own retry/alerting picks
    // this up), never a quiet no-op that looks like success.
    return new Response('Stripe not configured', { status: 503 });
  }
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) return new Response('Webhook secret not configured', { status: 503 });

  const signature = req.headers.get('stripe-signature');
  if (!signature) return new Response('Missing signature', { status: 400 });

  const rawBody = await req.text();
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch {
    // Deliberately no detail in the response — an invalid-signature request
    // learns nothing about why it failed.
    return new Response('Invalid signature', { status: 400 });
  }

  const claim = await claimWebhookEvent('stripe', event.id, event.type);
  if (claim.result === 'ALREADY_PROCESSED') return new Response('OK (duplicate)', { status: 200 });
  if (claim.result === 'ERROR') return new Response('Could not record event', { status: 500 });

  try {
    if (event.type === 'customer.subscription.created' || event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
      const subscription = event.data.object as Stripe.Subscription;
      await handleSubscriptionEvent(subscription);
      await markWebhookEventOutcome('stripe', event.id, 'processed');
    } else {
      // Unknown/unhandled event types fail safely -- acknowledged so Stripe
      // stops retrying, but never treated as an entitlement signal.
      await markWebhookEventOutcome('stripe', event.id, 'ignored');
    }
    return new Response('OK', { status: 200 });
  } catch (err) {
    await markWebhookEventOutcome('stripe', event.id, 'failed', err instanceof Error ? err.message : 'unknown error');
    // 500 so Stripe retries this event later -- the claim row's
    // processing_status stays 'failed', not 'processed', so a retry is not
    // blocked by the idempotency check above.
    return new Response('Processing failed', { status: 500 });
  }
}

async function handleSubscriptionEvent(subscription: Stripe.Subscription): Promise<void> {
  const userId =
    subscription.metadata?.fhip_user_id ??
    (await findUserIdForProviderCustomer('stripe', typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id));
  if (!userId) {
    // A subscription this app has no record of at all -- nothing to update.
    // Not an error (could be an unrelated object in the same Stripe account
    // if one is ever shared), just nothing to do.
    return;
  }

  const providerPriceId = subscription.items.data[0]?.price?.id ?? null;
  const plan = providerPriceId ? findPlanByProviderPriceId('stripe', providerPriceId) : null;
  const currentPeriodEndUnix = subscription.items.data[0]?.current_period_end ?? null;

  await applySubscriptionEvent({
    userId,
    provider: 'stripe',
    providerCustomerId: typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id,
    providerSubscriptionId: subscription.id,
    subscriptionStatus: mapStripeStatus(subscription.status),
    priceId: plan?.priceId ?? null,
    currentPeriodEnd: currentPeriodEndUnix ? new Date(currentPeriodEndUnix * 1000).toISOString() : null,
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
  });
}

function mapStripeStatus(status: Stripe.Subscription.Status): SubscriptionStatus {
  switch (status) {
    case 'active':
      return 'active';
    case 'trialing':
      return 'trialing';
    case 'past_due':
      return 'past_due';
    case 'canceled':
      return 'canceled';
    case 'incomplete':
      return 'incomplete';
    case 'incomplete_expired':
      return 'incomplete_expired';
    case 'unpaid':
      return 'unpaid';
    default:
      // paused, or any future Stripe status this codebase doesn't yet name —
      // fail closed to the safest non-premium state rather than guessing.
      return 'incomplete_expired';
  }
}
