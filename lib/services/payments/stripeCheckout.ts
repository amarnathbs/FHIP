// LR-10 WP-04 — Stripe checkout-session creation. Uses Stripe's own hosted
// Checkout page: FHIP never collects, transmits, or stores a raw card
// number, CVC, or expiry at any point — the browser is redirected straight
// to a page Stripe itself serves and secures. This file's only job is to
// decide WHICH price the session is for (server-side, from the already-
// validated catalogue entry — never a client-supplied amount or arbitrary
// price id, see app/api/payments/checkout/route.ts's own validation) and to
// record the resulting customer id immediately, before the redirect, so the
// webhook that arrives later has a row to find (lib/services/payments/
// entitlementSync.ts's findUserIdForProviderCustomer()).
import { createAdminClient } from '@/lib/supabase/admin';
import { getStripeClient } from '@/lib/services/payments/stripeClient';
import type { PlanCatalogueEntry } from '@/lib/services/paymentPlanCatalogue';

export interface StripeCheckoutResult {
  url: string;
}

async function getOrCreateStripeCustomerId(userId: string, email: string): Promise<string> {
  const admin = createAdminClient();
  const { data: existing } = await admin
    .from('user_entitlements')
    .select('provider_customer_id')
    .eq('user_id', userId)
    .eq('provider', 'stripe')
    .maybeSingle();
  if (existing?.provider_customer_id) return existing.provider_customer_id;

  const stripe = getStripeClient();
  if (!stripe) throw new Error('Stripe is not configured');
  const customer = await stripe.customers.create({ email, metadata: { fhip_user_id: userId } });

  // Record the mapping immediately, before redirecting the user anywhere —
  // a webhook can arrive at any point after this, and must be able to find
  // this user by provider_customer_id even if the checkout is abandoned
  // before completion.
  await admin
    .from('user_entitlements')
    .update({ provider: 'stripe', provider_customer_id: customer.id, updated_at: new Date().toISOString() })
    .eq('user_id', userId);

  return customer.id;
}

export async function createStripeCheckoutSession(params: {
  userId: string;
  email: string;
  plan: PlanCatalogueEntry;
  successUrl: string;
  cancelUrl: string;
}): Promise<StripeCheckoutResult> {
  const stripe = getStripeClient();
  if (!stripe) throw new Error('Stripe is not configured');
  if (!params.plan.providerPriceId) throw new Error('PROVIDER_NOT_CONFIGURED');

  const customerId = await getOrCreateStripeCustomerId(params.userId, params.email);

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price: params.plan.providerPriceId, quantity: 1 }],
    success_url: params.successUrl,
    cancel_url: params.cancelUrl,
    // NEG-03 "Premium granted before webhook" — this metadata is for
    // operator/support traceability only (visible in the Stripe dashboard);
    // it is never read back by this app to grant entitlement. Entitlement is
    // granted only by the webhook route, from a verified event.
    metadata: { fhip_user_id: params.userId, fhip_price_id: params.plan.priceId },
    subscription_data: { metadata: { fhip_user_id: params.userId, fhip_price_id: params.plan.priceId } },
  });

  if (!session.url) throw new Error('Stripe did not return a checkout URL');
  return { url: session.url };
}
