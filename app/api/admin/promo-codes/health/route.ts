// Promo codes: the setup check (hardening, deploy safety). Capability: requirePromoCodeAdmin().
//
// Tells a promo administrator, in plain terms, WHICH server variables are missing, too short or reused (names and states only,
// never a value or a length), WHICH actions are therefore switched off, and how many existing codes still wait for the
// hash-only preparation. It is the Admin-visible half of the fail-closed rule: a feature that refuses must say why where the person
// who can fix it will read it. It reads no code and no digest. Ordinary Premium use never calls it.

import { adminRoute, safeDbError } from '@/lib/services/adminAuth';
import { requirePromoCodeAdmin } from '@/lib/services/promoCodeAdmin';
import { promoSetupHealth } from '@/lib/services/promoSetupHealth';
import { isMissingDbObjectError } from '@/lib/services/premiumGrantAdmin';
import { createClient } from '@/lib/supabase/server';
import { ok } from '@/lib/api';

export const dynamic = 'force-dynamic';

export const GET = adminRoute(async () => {
  const { forbidden } = await requirePromoCodeAdmin();
  if (forbidden) return forbidden;

  const health = promoSetupHealth();
  const supabase = await createClient();
  const status = await supabase.rpc('admin_promo_codes_hash_status');
  if (status.error) {
    if (isMissingDbObjectError(status.error)) {
      return ok({ ...health, databaseReady: false, existingCodes: null });
    }
    return safeDbError(status.error, 'admin promo codes setup check');
  }
  const s = (status.data ?? {}) as { rows_total?: number; rows_with_plain_value?: number; rows_plain_without_verified_digest?: number; rows_with_digest?: number };
  return ok({
    ...health,
    databaseReady: true,
    existingCodes: {
      total: s.rows_total ?? 0,
      stillStoredInPlainText: s.rows_with_plain_value ?? 0,
      waitingForPreparation: s.rows_plain_without_verified_digest ?? 0,
      withProtectedCopy: s.rows_with_digest ?? 0,
    },
  });
});
