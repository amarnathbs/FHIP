// GET /api/payments/status — LR-10. The one read-only endpoint the
// billing/upgrade UI needs: this user's own plan tier, subscription
// lifecycle fields, and current billing-country state, all read directly
// (never derived/cached) so the UI always reflects the latest webhook-synced
// truth. Returns null subscription fields for a free user with no
// entitlement row activity yet — not an error state.
import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';
import { createClient } from '@/lib/supabase/server';
import { plansForBillingCountry } from '@/lib/services/paymentPlanCatalogue';
import { isKnownCountry } from '@/lib/services/jurisdiction';

export async function GET() {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const supabase = await createClient();

  const [{ data: profile, error: profileError }, { data: entitlement, error: entitlementError }] = await Promise.all([
    supabase.from('user_profiles').select('billing_country, billing_country_confirmed_at').eq('user_id', user.id).maybeSingle(),
    supabase
      .from('user_entitlements')
      .select('plan_tier, provider, subscription_status, price_id, current_period_end, cancel_at_period_end')
      .eq('user_id', user.id)
      .maybeSingle(),
  ]);
  if (profileError) return bad(profileError.message);
  if (entitlementError) return bad(entitlementError.message);

  const billingCountry = profile?.billing_country ?? null;
  const billingConfirmed = Boolean(profile?.billing_country_confirmed_at);
  const availablePlans = billingConfirmed && billingCountry && isKnownCountry(billingCountry) ? plansForBillingCountry(billingCountry) : [];

  return ok({
    billingCountry,
    billingConfirmed,
    planTier: entitlement?.plan_tier ?? 'free',
    provider: entitlement?.provider ?? null,
    subscriptionStatus: entitlement?.subscription_status ?? null,
    priceId: entitlement?.price_id ?? null,
    currentPeriodEnd: entitlement?.current_period_end ?? null,
    cancelAtPeriodEnd: entitlement?.cancel_at_period_end ?? false,
    availablePlans: availablePlans.map((p) => ({
      priceId: p.priceId,
      provider: p.provider,
      interval: p.interval,
      currencyCode: p.currencyCode,
      displayAmount: p.displayAmount,
      configured: Boolean(p.providerPriceId),
    })),
  });
}
