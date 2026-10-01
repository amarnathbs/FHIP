// Admin Premium grant (migration 0231) — list grants (GET) and grant / extend /
// revoke Premium for a user who has not paid (POST).
//
// Capability: requirePremiumEntitlementAdmin() (admin_users.can_manage_premium_entitlements),
// NOT bare requireAdmin() — Admin Architecture Standard §2. An unauthorised
// caller gets an explicit 401/403, never an empty 200 (§4).
//
// THE WRITE RUNS ON THE CALLER'S SESSION CLIENT, not the service-role client:
// the database function admin_manage_premium_entitlement() authorises on
// auth.uid() and re-checks the capability itself (Standard §4 layer 1), so the
// grant rules cannot be bypassed by reaching the RPC another way, and a
// service-role caller (auth.uid() null) is refused by design. Inside the
// function: row lock, 365-day cap, mandatory reason, paid-entitlement
// protection, and the audit row in the same transaction.

import { adminRoute, safeDbError } from '@/lib/services/adminAuth';
import { requirePremiumEntitlementAdmin } from '@/lib/services/premiumEntitlementAdmin';
import { callListGrants, callManageEntitlement, mapEntitlementRpcError, parseManageRequest } from '@/lib/services/premiumGrantAdmin';
import { utcToday } from '@/lib/services/entitlementWindow';
import { createClient } from '@/lib/supabase/server';
import { ok, bad } from '@/lib/api';

export const dynamic = 'force-dynamic';

const FILTERS = ['expiring', 'active', 'lapsed'] as const;
type GrantFilter = (typeof FILTERS)[number];

export const GET = adminRoute(async (req: Request) => {
  const { forbidden } = await requirePremiumEntitlementAdmin();
  if (forbidden) return forbidden;

  const url = new URL(req.url);
  const filter = (url.searchParams.get('filter') ?? 'expiring') as GrantFilter;
  if (!FILTERS.includes(filter)) return bad('filter must be expiring, active or lapsed.', 422, 'ENTITLEMENT_FILTER_INVALID');
  const withinRaw = url.searchParams.get('withinDays');
  const withinDays = withinRaw === null ? 30 : Number(withinRaw);
  if (!Number.isInteger(withinDays) || withinDays < 1 || withinDays > 365) {
    return bad('withinDays must be a whole number from 1 to 365.', 422, 'ENTITLEMENT_FILTER_INVALID');
  }

  const supabase = await createClient();
  const { data, error } = await callListGrants(supabase, filter, withinDays);
  if (error) {
    const mapped = mapEntitlementRpcError(error);
    if (mapped) return bad(mapped.message, mapped.status, mapped.code);
    return safeDbError(error, 'admin entitlements grants list');
  }
  return ok({ filter, withinDays, as_of: utcToday(), grants: data ?? [] });
});

export const POST = adminRoute(async (req: Request) => {
  const { forbidden } = await requirePremiumEntitlementAdmin();
  if (forbidden) return forbidden;

  const parsed = parseManageRequest(await req.json().catch(() => null), utcToday());
  if (!parsed.ok) return bad(parsed.message, parsed.status, parsed.code);

  const supabase = await createClient();
  const { data, error } = await callManageEntitlement(supabase, parsed.value);
  if (error) {
    const mapped = mapEntitlementRpcError(error);
    if (mapped) return bad(mapped.message, mapped.status, mapped.code);
    return safeDbError(error, 'admin entitlements manage');
  }
  return ok(data);
});
