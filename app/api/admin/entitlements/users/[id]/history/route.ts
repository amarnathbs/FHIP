// Admin Premium grant (migration 0231) — one user's grant / extend / revoke
// history from the append-only admin_entitlement_events trail. Capability-gated
// at the route AND inside the RPC (Standard §4).

import { adminRoute, safeDbError } from '@/lib/services/adminAuth';
import { requirePremiumEntitlementAdmin } from '@/lib/services/premiumEntitlementAdmin';
import { callHistory, mapEntitlementRpcError } from '@/lib/services/premiumGrantAdmin';
import { createClient } from '@/lib/supabase/server';
import { ok, bad } from '@/lib/api';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const GET = adminRoute(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { forbidden } = await requirePremiumEntitlementAdmin();
  if (forbidden) return forbidden;

  const { id } = await params;
  if (!UUID_RE.test(id)) return bad('userId must be a valid user id.', 422, 'ENTITLEMENT_TARGET_REQUIRED');

  const supabase = await createClient();
  const { data, error } = await callHistory(supabase, id.toLowerCase());
  if (error) {
    const mapped = mapEntitlementRpcError(error);
    if (mapped) return bad(mapped.message, mapped.status, mapped.code);
    return safeDbError(error, 'admin entitlements history');
  }
  return ok(data ?? []);
});
