// LR-10 WP-04 — Razorpay subscription creation. Uses Razorpay's own hosted
// authorisation page (`short_url`) — identical card-handling guarantee as
// Stripe Checkout (see stripeCheckout.ts's own header): FHIP never collects
// or stores a raw card/UPI/bank credential at any point.
//
// Unlike Stripe, Razorpay does not require a pre-created customer object —
// the subscription's `customer_id` is populated automatically once the
// customer completes the authorisation payment on the hosted page, and that
// value only becomes available via the webhook, not this creation call.
import { createAdminClient } from '@/lib/supabase/admin';
import { getRazorpayClient } from '@/lib/services/payments/razorpayClient';
import type { PlanCatalogueEntry } from '@/lib/services/paymentPlanCatalogue';

export interface RazorpaySubscriptionResult {
  shortUrl: string;
  subscriptionId: string;
}

// Razorpay requires a fixed total_count (number of billing cycles) rather
// than an open-ended "until cancelled" subscription — these are deliberately
// large so a "cancel anytime" monthly/annual plan never naturally expires
// mid-use; WP-11 (failure recovery)/resubscribe still works normally via a
// fresh subscription if one is ever cancelled.
const TOTAL_COUNT_BY_INTERVAL: Record<'monthly' | 'annual', number> = {
  monthly: 120, // 10 years
  annual: 20, // 20 years
};

export async function createRazorpaySubscription(params: {
  userId: string;
  plan: PlanCatalogueEntry;
}): Promise<RazorpaySubscriptionResult> {
  const razorpay = getRazorpayClient();
  if (!razorpay) throw new Error('Razorpay is not configured');
  if (!params.plan.providerPriceId) throw new Error('PROVIDER_NOT_CONFIGURED');

  const subscription = await razorpay.subscriptions.create({
    plan_id: params.plan.providerPriceId,
    total_count: TOTAL_COUNT_BY_INTERVAL[params.plan.interval],
    customer_notify: 1,
    notes: { fhip_user_id: params.userId, fhip_price_id: params.plan.priceId },
  });

  // Record the pending subscription id immediately, before redirecting the
  // user to the hosted authorisation page — the webhook (subscription
  // activated/charged) needs a row to find by provider_subscription_id even
  // if it arrives before this request handler returns.
  const admin = createAdminClient();
  await admin
    .from('user_entitlements')
    .update({
      provider: 'razorpay',
      provider_subscription_id: subscription.id,
      subscription_status: 'incomplete',
      updated_at: new Date().toISOString(),
    })
    .eq('user_id', params.userId);

  return { shortUrl: subscription.short_url, subscriptionId: subscription.id };
}
