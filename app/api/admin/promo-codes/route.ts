// Promo codes — list (GET) and create (POST). Capability: requirePromoCodeAdmin()
// (admin_users.can_manage_promo_codes), NOT requireAdmin() and NOT the premium
// entitlement capability (Standard §2/§3). The RPCs run on the CALLER session
// client and re-check the capability in the database.
//
// The create response is the ONLY place a generated code is returned, to the
// admin who created it (they have to hand it out). It is never logged here and
// never written to the audit trail (the trail holds the code id and a masked hint).

import { adminRoute, safeDbError } from '@/lib/services/adminAuth';
import { requirePromoCodeAdmin } from '@/lib/services/promoCodeAdmin';
import { mapPromoRpcError, parseCreatePromoRequest } from '@/lib/services/promoCodes';
import { utcToday } from '@/lib/services/entitlementWindow';
import { createClient } from '@/lib/supabase/server';
import { ok, bad } from '@/lib/api';

export const dynamic = 'force-dynamic';

export const GET = adminRoute(async () => {
  const { forbidden } = await requirePromoCodeAdmin();
  if (forbidden) return forbidden;
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('admin_list_promo_codes');
  if (error) {
    const mapped = mapPromoRpcError(error);
    if (mapped) return bad(mapped.message, mapped.status, mapped.code);
    return safeDbError(error, 'admin promo codes list');
  }
  return ok(data ?? []);
});

export const POST = adminRoute(async (req: Request) => {
  const { forbidden } = await requirePromoCodeAdmin();
  if (forbidden) return forbidden;

  const parsed = parseCreatePromoRequest(await req.json().catch(() => null), utcToday());
  if (!parsed.ok) return bad(parsed.message, parsed.status, parsed.code);
  const v = parsed.value;

  const supabase = await createClient();
  const { data, error } = await supabase.rpc('admin_create_promo_code', {
    p_code: v.code,
    p_duration_days: v.durationDays,
    p_max_redemptions: v.maxRedemptions,
    p_unlimited: v.unlimited,
    p_expires_on: v.expiresOn,
    p_no_expiry: v.noExpiry,
    p_note: v.note,
  });
  if (error) {
    const mapped = mapPromoRpcError(error);
    if (mapped) return bad(mapped.message, mapped.status, mapped.code);
    return safeDbError(error, 'admin promo codes create');
  }
  return ok(data);
});
