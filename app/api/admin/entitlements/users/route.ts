// Admin Premium grant (migration 0231) — find a user to manage, by email
// fragment or full user id. Capability-gated (Standard §2/§4); the RPC re-checks
// the capability in the database. Minimal identity only (email + entitlement
// state): no financial data of any kind is read, and the RPC needs >= 3
// characters and returns at most 20 rows so it cannot be used as a directory dump.

import { adminRoute, safeDbError } from '@/lib/services/adminAuth';
import { requirePremiumEntitlementAdmin } from '@/lib/services/premiumEntitlementAdmin';
import { callSearchUsers, mapEntitlementRpcError } from '@/lib/services/premiumGrantAdmin';
import { createClient } from '@/lib/supabase/server';
import { ok, bad } from '@/lib/api';

export const dynamic = 'force-dynamic';

export const GET = adminRoute(async (req: Request) => {
  const { forbidden } = await requirePremiumEntitlementAdmin();
  if (forbidden) return forbidden;

  const q = (new URL(req.url).searchParams.get('q') ?? '').trim();
  if (q.length < 3) return bad('Enter at least 3 characters of an email, or a full user id.', 422, 'ENTITLEMENT_QUERY_TOO_SHORT');
  if (q.length > 254) return bad('The search text is too long.', 422, 'ENTITLEMENT_QUERY_TOO_SHORT');

  const supabase = await createClient();
  const { data, error } = await callSearchUsers(supabase, q);
  if (error) {
    const mapped = mapEntitlementRpcError(error);
    if (mapped) return bad(mapped.message, mapped.status, mapped.code);
    return safeDbError(error, 'admin entitlements user search');
  }
  return ok(data ?? []);
});
