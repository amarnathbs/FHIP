// Promo codes — the append-only audit trail (create / disable / redeem), newest
// first, optionally for one code. Carries the code id and a masked hint, never a
// code value. Capability-gated at the route and inside the database function.

import { adminRoute, safeDbError } from '@/lib/services/adminAuth';
import { requirePromoCodeAdmin } from '@/lib/services/promoCodeAdmin';
import { mapPromoRpcError } from '@/lib/services/promoCodes';
import { createClient } from '@/lib/supabase/server';
import { ok, bad } from '@/lib/api';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const GET = adminRoute(async (req: Request) => {
  const { forbidden } = await requirePromoCodeAdmin();
  if (forbidden) return forbidden;

  const promoId = new URL(req.url).searchParams.get('promoId');
  if (promoId !== null && !UUID_RE.test(promoId)) return bad('Invalid promo code id.', 422, 'PROMO_NOT_FOUND');

  const supabase = await createClient();
  const { data, error } = await supabase.rpc('admin_promo_code_events', { p_promo_id: promoId ? promoId.toLowerCase() : null, p_limit: 100 });
  if (error) {
    const mapped = mapPromoRpcError(error);
    if (mapped) return bad(mapped.message, mapped.status, mapped.code);
    return safeDbError(error, 'admin promo codes events');
  }
  return ok(data ?? []);
});
