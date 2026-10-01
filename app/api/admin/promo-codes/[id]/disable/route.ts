// Promo codes — disable one code. This stops FUTURE redemptions; Premium already
// granted by it is not revoked (an admin can Revoke an individual user). A reason
// is mandatory and the action is audited. Capability-gated at the route and
// inside the database function.

import { adminRoute, safeDbError } from '@/lib/services/adminAuth';
import { requirePromoCodeAdmin } from '@/lib/services/promoCodeAdmin';
import { mapPromoRpcError, PROMO_DISABLE_REASON_MIN_LENGTH } from '@/lib/services/promoCodes';
import { createClient } from '@/lib/supabase/server';
import { ok, bad } from '@/lib/api';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const POST = adminRoute(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { forbidden } = await requirePromoCodeAdmin();
  if (forbidden) return forbidden;

  const { id } = await params;
  if (!UUID_RE.test(id)) return bad('Invalid promo code id.', 422, 'PROMO_NOT_FOUND');
  const body = (await req.json().catch(() => null)) as { reason?: unknown } | null;
  const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
  if (reason.length < PROMO_DISABLE_REASON_MIN_LENGTH) {
    return bad(`A reason of at least ${PROMO_DISABLE_REASON_MIN_LENGTH} characters is required.`, 422, 'PROMO_REASON_REQUIRED');
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc('admin_disable_promo_code', { p_id: id.toLowerCase(), p_reason: reason });
  if (error) {
    const mapped = mapPromoRpcError(error);
    if (mapped) return bad(mapped.message, mapped.status, mapped.code);
    return safeDbError(error, 'admin promo codes disable');
  }
  return ok(data);
});
