// LR-10 WP-05/07 — the ONE place a verified webhook event becomes an
// entitlement change. Both webhook routes (Stripe, Razorpay) call this
// after signature verification and idempotency-checking, never before —
// this module trusts its caller completely and does no verification of its
// own, matching this codebase's own established split (e.g. FDH's storage
// layer trusting its caller has already authenticated — see that module's
// own header for the identical pattern).
import { createAdminClient } from '@/lib/supabase/admin';
import type { PaymentProvider } from '@/lib/services/paymentPlanCatalogue';

// WP-07: "Cancellation/expiry/past-due transitions must be explicit." A
// subscription in its provider's own PAST_DUE state keeps Premium during a
// grace period rather than being instantly downgraded on the first missed
// payment (both Stripe and Razorpay retry a failed charge automatically
// before finally cancelling) — this is a deliberate, named product decision,
// not an oversight: the alternative (instant downgrade on past_due) would
// punish a user for a transient card-decline the provider itself is still
// retrying.
const PREMIUM_SUBSCRIPTION_STATUSES = new Set(['active', 'trialing', 'past_due']);

/** WP-10 reuses this same "is this subscription live" test to decide whether a billing-country change needs to be blocked — see app/api/user/billing-country/confirm/route.ts. */
export function isPremiumSubscriptionStatus(status: string): boolean {
  return PREMIUM_SUBSCRIPTION_STATUSES.has(status);
}

export type SubscriptionStatus =
  | 'active'
  | 'trialing'
  | 'past_due'
  | 'canceled'
  | 'incomplete'
  | 'incomplete_expired'
  | 'unpaid';

export interface EntitlementUpsertParams {
  userId: string;
  provider: PaymentProvider;
  providerCustomerId: string;
  providerSubscriptionId: string;
  subscriptionStatus: SubscriptionStatus;
  priceId: string | null;
  currentPeriodEnd: string | null; // ISO timestamp
  cancelAtPeriodEnd: boolean;
}

/**
 * Creates or updates this user's ONE entitlement row from a verified event.
 * `user_entitlements.user_id` is unique (migration 0010) — this is always an
 * upsert-by-user_id, never an insert, so a duplicate webhook delivery (after
 * idempotency has already let it through once, e.g. an out-of-order retry)
 * still converges to the same final state rather than creating a second row
 * (NEG-04 "duplicate entitlement").
 */
export async function applySubscriptionEvent(params: EntitlementUpsertParams): Promise<void> {
  const admin = createAdminClient();
  const confersPremium = PREMIUM_SUBSCRIPTION_STATUSES.has(params.subscriptionStatus);
  const planTier = confersPremium ? 'premium' : 'free';

  // Admin Premium grant (migration 0231). A provider event must never shorten,
  // cut off or silently downgrade an admin-allocated entitlement, and a payment
  // must win over a grant sensibly. That merge happens atomically in the
  // database (row-locked) rather than as a read-then-write here, so it cannot
  // race an admin grant/extend/revoke:
  //   - a premium event sets source='payment' and clears the live window's end
  //     date (otherwise the grant's effective_to would end a PAYING customer's
  //     Premium on the grant's expiry date);
  //   - a non-premium event (cancelled / abandoned checkout) restores an
  //     unexpired admin grant held in reserve instead of dropping to free.
  const { error: rpcError } = await admin.rpc('apply_subscription_entitlement_event', {
    p_user_id: params.userId,
    p_provider: params.provider,
    p_provider_customer_id: params.providerCustomerId,
    p_provider_subscription_id: params.providerSubscriptionId,
    p_confers_premium: confersPremium,
    p_subscription_status: params.subscriptionStatus,
    p_price_id: params.priceId,
    p_current_period_end: params.currentPeriodEnd,
    p_cancel_at_period_end: params.cancelAtPeriodEnd,
  });
  if (!rpcError) return;

  // Deploy-order safety: if this code is live before migration 0231 has been
  // applied the function does not exist yet (PostgREST PGRST202 / Postgres
  // 42883). Fall back to the pre-0231 behaviour rather than failing every
  // webhook delivery. That is only safe because, before 0231, no admin grants
  // can exist. Any OTHER error is a real failure and is thrown so the provider retries.
  const missingFunction = rpcError.code === 'PGRST202' || rpcError.code === '42883';
  if (!missingFunction) throw new Error(`applySubscriptionEvent: ${rpcError.message}`);

  const { error } = await admin
    .from('user_entitlements')
    .update({
      plan_tier: planTier,
      provider: params.provider,
      provider_customer_id: params.providerCustomerId,
      provider_subscription_id: params.providerSubscriptionId,
      subscription_status: params.subscriptionStatus,
      price_id: params.priceId,
      current_period_end: params.currentPeriodEnd,
      cancel_at_period_end: params.cancelAtPeriodEnd,
      updated_at: new Date().toISOString(),
    })
    .eq('user_id', params.userId);
  if (error) throw new Error(`applySubscriptionEvent: ${error.message}`);
}

/**
 * Resolves which userId a webhook event applies to. Provider webhooks never
 * carry FHIP's own user_id directly — Stripe/Razorpay only know about their
 * own customer/subscription ids, which were recorded on user_entitlements at
 * checkout-session-creation time (lib/services/payments/stripeCheckout.ts /
 * razorpaySubscription.ts, both of which set provider_customer_id up front,
 * before redirecting the user to the provider). A webhook whose
 * subscription/customer id matches no row is treated as unknown, never as a
 * reason to guess or create a new entitlement row from webhook data alone.
 */
export async function findUserIdForProviderSubscription(
  provider: PaymentProvider,
  providerSubscriptionId: string
): Promise<string | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from('user_entitlements')
    .select('user_id')
    .eq('provider', provider)
    .eq('provider_subscription_id', providerSubscriptionId)
    .maybeSingle();
  return data?.user_id ?? null;
}

export async function findUserIdForProviderCustomer(provider: PaymentProvider, providerCustomerId: string): Promise<string | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from('user_entitlements')
    .select('user_id')
    .eq('provider', provider)
    .eq('provider_customer_id', providerCustomerId)
    .maybeSingle();
  return data?.user_id ?? null;
}
