// Staff admin Premium (migration 0283) -- GET the staff accounts and their automatic Premium state, or (with ?history=<user id>) the
// start / end / paid_over events of one account. READ ONLY: staff Premium is written by the database itself when a staff role is
// assigned or removed, so this route has no write method on purpose and the screen offers no button for it.
//
// Capability: requirePremiumEntitlementAdmin() (admin_users.can_manage_premium_entitlements), the existing separately named capability --
// NOT bare requireAdmin() (Admin Architecture Standard section 2). An unauthorised caller gets an explicit 401 or 403, never an empty
// 200 (section 4). The database functions re-check the capability on auth.uid() themselves (layer 1) and run on the CALLER's session
// client. Fail closed (section 13): a missing function (migration not applied) is a 503, never an empty list.
//
// Returned: e-mail address (already shown by this screen to this capability), role names and the entitlement state. No financial data.

import { adminRoute, safeDbError } from '@/lib/services/adminAuth';
import { requirePremiumEntitlementAdmin } from '@/lib/services/premiumEntitlementAdmin';
import { mapEntitlementRpcError } from '@/lib/services/premiumGrantAdmin';
import { createClient } from '@/lib/supabase/server';
import { ok, bad } from '@/lib/api';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const GET = adminRoute(async (req: Request) => {
  const { forbidden } = await requirePremiumEntitlementAdmin();
  if (forbidden) return forbidden;

  const supabase = await createClient();
  const history = new URL(req.url).searchParams.get('history');

  if (history !== null) {
    if (!UUID_RE.test(history)) return bad('history must be a valid user id.', 422, 'ENTITLEMENT_TARGET_REQUIRED');
    const { data, error } = await supabase.rpc('admin_staff_premium_history', { p_target_user_id: history.toLowerCase(), p_limit: 50 });
    if (error) {
      const mapped = mapEntitlementRpcError(error);
      if (mapped) return bad(mapped.message, mapped.status, mapped.code);
      return safeDbError(error, 'admin staff premium history');
    }
    return ok(data ?? []);
  }

  const { data, error } = await supabase.rpc('admin_list_staff_premium');
  if (error) {
    const mapped = mapEntitlementRpcError(error);
    if (mapped) return bad(mapped.message, mapped.status, mapped.code);
    return safeDbError(error, 'admin staff premium list');
  }
  return ok({ staff: data ?? [] });
});
