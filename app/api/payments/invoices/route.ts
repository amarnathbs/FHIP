// GET /api/payments/invoices — LR-10 WP-08. Reads this user's OWN
// provider_customer_id/provider_subscription_id from user_entitlements
// (RLS-scoped — a user can never request another user's receipts through
// this route since the query is always `.eq('user_id', user.id)` via the
// session-scoped client, not an admin client), then asks the matching
// provider for its own generated receipts. Returns an empty list (not an
// error) for a free user or a provider not yet configured.
import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';
import { createClient } from '@/lib/supabase/server';
import { listStripeReceipts, listRazorpayReceipts } from '@/lib/services/payments/invoices';

export async function GET() {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const supabase = await createClient();
  const { data: entitlement, error } = await supabase
    .from('user_entitlements')
    .select('provider, provider_customer_id, provider_subscription_id')
    .eq('user_id', user.id)
    .maybeSingle();
  if (error) return bad(error.message);

  if (!entitlement?.provider) return ok([]);

  try {
    if (entitlement.provider === 'stripe' && entitlement.provider_customer_id) {
      return ok(await listStripeReceipts(entitlement.provider_customer_id));
    }
    if (entitlement.provider === 'razorpay' && entitlement.provider_subscription_id) {
      return ok(await listRazorpayReceipts(entitlement.provider_subscription_id));
    }
    return ok([]);
  } catch (err) {
    return bad(err instanceof Error ? err.message : 'Could not load receipts', 502);
  }
}
