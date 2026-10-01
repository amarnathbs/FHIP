import { createClient } from '@/lib/supabase/server';
import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';
import { ownerClassField, resolveOwnerClassScope } from '@/lib/services/investment-intelligence/ownerClassScope';
import { loadHoldingsTable } from '@/lib/services/investment-intelligence/holdingsRepository';

// Investment Intelligence — Performance tab Holdings drilldown (2026-09-17).
//
// Retrieves the Holdings table (one row per account/instrument position),
// matching the Product Owner's own reference workbook's "Holdings" tab
// shape. Strictly read-only, same security model as
// /api/investment-intelligence/analytics: the ONLY identity used is
// `user.id` from the authenticated session — there is no household/account/
// instrument id request parameter, so there is nothing for a caller to
// spoof.
export async function GET(request: Request) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  try {
    const rootClient = await createClient();
    const scope = await resolveOwnerClassScope(request, rootClient, user.id);
    if (!scope.ok) return scope.response;
    const supabase = scope.client;
    const result = await loadHoldingsTable(supabase, user.id);
    return ok({ ...result, ownerClass: ownerClassField(scope) });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unknown error';
    return bad(`Holdings could not be loaded: ${message}`, 500);
  }
}
