import { z } from 'zod';
import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';
import { createClient } from '@/lib/supabase/server';
import { validatePriceForBilling } from '@/lib/services/billingAuthority';
import { getPlanCatalogueEntry, plansForBillingCountry, PLAN_CATALOGUE_ENTRIES } from '@/lib/services/paymentPlanCatalogue';
import { isKnownCountry } from '@/lib/services/jurisdiction';
import { createStripeCheckoutSession } from '@/lib/services/payments/stripeCheckout';
import { createRazorpaySubscription } from '@/lib/services/payments/razorpaySubscription';
import { getStripeUnavailableReason } from '@/lib/services/payments/stripeClient';
import { getRazorpayUnavailableReason } from '@/lib/services/payments/razorpayClient';

// LR-10 WP-02/WP-04 — the one route that starts a real checkout. Client
// supplies only the internal catalogue priceId (never an amount, currency,
// or raw provider price id — NEG-02 "client can select arbitrary price");
// the billing country that actually decides which price/provider applies is
// read server-side from this user's own CONFIRMED billing_country, never
// from the request body.
const schema = z.object({ priceId: z.string().min(1) });

export async function POST(req: Request) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return bad('INVALID_REQUEST', 422);

  const supabase = await createClient();
  const { data: profile, error: profileError } = await supabase
    .from('user_profiles')
    .select('billing_country, billing_country_confirmed_at')
    .eq('user_id', user.id)
    .maybeSingle();
  if (profileError) return bad(profileError.message);

  const billingCountry = profile?.billing_country;
  const billingConfirmed = Boolean(profile?.billing_country_confirmed_at);

  if (!billingConfirmed || !billingCountry || !isKnownCountry(billingCountry)) {
    return bad('BILLING_COUNTRY_NOT_CONFIRMED', 422);
  }

  // Honest, distinct denial for a confirmed GENERIC billing country — no
  // approved price exists for it yet (see paymentPlanCatalogue.ts's own
  // header on why none is invented here). Checked BEFORE
  // validatePriceForBilling() so a genuinely-confirmed GENERIC user gets an
  // accurate reason rather than being told their billing country isn't
  // confirmed when it is.
  if (plansForBillingCountry(billingCountry).length === 0) {
    return bad('NO_PLAN_FOR_REGION', 422);
  }

  const validation = validatePriceForBilling({
    billingCountry,
    billingConfirmed,
    requestedPriceId: parsed.data.priceId,
    catalogue: PLAN_CATALOGUE_ENTRIES,
  });
  if (!validation.allowed) return bad(validation.reason, 422);

  const plan = getPlanCatalogueEntry(validation.priceId)!;

  if (plan.provider === 'stripe') {
    const unavailable = getStripeUnavailableReason();
    if (unavailable) return bad(unavailable, 503);
    if (!plan.providerPriceId) return bad('PROVIDER_NOT_CONFIGURED', 503);
    const baseUrl = process.env.APP_BASE_URL || 'http://localhost:3000';
    try {
      const session = await createStripeCheckoutSession({
        userId: user.id,
        email: user.email ?? '',
        plan,
        successUrl: `${baseUrl}/profile?checkout=success`,
        cancelUrl: `${baseUrl}/profile?checkout=cancelled`,
      });
      return ok({ provider: 'stripe', url: session.url });
    } catch (err) {
      return bad(err instanceof Error ? err.message : 'Could not start Stripe checkout', 500);
    }
  }

  // razorpay
  const unavailable = getRazorpayUnavailableReason();
  if (unavailable) return bad(unavailable, 503);
  if (!plan.providerPriceId) return bad('PROVIDER_NOT_CONFIGURED', 503);
  try {
    const subscription = await createRazorpaySubscription({ userId: user.id, plan });
    return ok({ provider: 'razorpay', url: subscription.shortUrl });
  } catch (err) {
    return bad(err instanceof Error ? err.message : 'Could not start Razorpay checkout', 500);
  }
}
