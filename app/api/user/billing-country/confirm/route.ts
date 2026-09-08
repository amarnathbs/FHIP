// POST /api/user/billing-country/confirm — spec section 6.7/17. LR-10 is the
// first caller (the checkout/upgrade UI, so a user can set/change their
// billing country before starting a real checkout) — confirm_billing_country
// RPC (migration 0122) remains the single write path, unchanged.
//
// WP-10 "billing-country change vs. active paid subscription": the RPC
// itself has no concept of an active subscription (it predates checkout
// entirely) and is certified/reused as-is, so this is enforced here, at the
// one call site that can reach it with a real subscription in play. A user
// with a live Stripe (AU) or Razorpay (IN) subscription who confirms a NEW
// billing country would otherwise silently end up billed by a provider that
// no longer matches their region with no path back to the plan catalogue —
// blocked with an actionable reason instead of allowed silently.
import { z } from 'zod';
import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';
import { createClient } from '@/lib/supabase/server';
import { isPremiumSubscriptionStatus } from '@/lib/services/payments/entitlementSync';

const schema = z.object({ billing_country: z.string().length(2) });

export async function POST(req: Request) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return bad('INVALID_REQUEST', 422);

  const requestedCountry = parsed.data.billing_country.trim().toUpperCase();

  const supabase = await createClient();

  const { data: profile, error: profileError } = await supabase
    .from('user_profiles')
    .select('billing_country')
    .eq('user_id', user.id)
    .maybeSingle();
  if (profileError) return bad(profileError.message);

  const isActualChange = profile?.billing_country && profile.billing_country !== requestedCountry;
  if (isActualChange) {
    const { data: entitlement, error: entitlementError } = await supabase
      .from('user_entitlements')
      .select('subscription_status')
      .eq('user_id', user.id)
      .maybeSingle();
    if (entitlementError) return bad(entitlementError.message);
    if (entitlement?.subscription_status && isPremiumSubscriptionStatus(entitlement.subscription_status)) {
      // Deliberately not "cancel first" as the only escape hatch — cancelling
      // loses the user's Premium immediately, which is a worse outcome than
      // just keeping the existing billing country. The actionable step is
      // support-mediated (a plan/region migration is a provider-side
      // operation, not something this RPC can do safely on its own), so the
      // response names that path rather than implying self-service.
      return bad('ACTIVE_SUBSCRIPTION_BLOCKS_COUNTRY_CHANGE', 409);
    }
  }

  const { data, error } = await supabase.rpc('confirm_billing_country', {
    p_billing_country: requestedCountry,
  });

  if (error) {
    const message = error.message ?? '';
    if (message.includes('BILLING_COUNTRY_NOT_SELECTABLE')) return bad('BILLING_COUNTRY_NOT_SELECTABLE', 422);
    if (message.includes('UNAUTHENTICATED')) return bad('UNAUTHENTICATED', 401);
    return bad('OPERATIONAL_ERROR', 500);
  }

  return ok(data);
}
