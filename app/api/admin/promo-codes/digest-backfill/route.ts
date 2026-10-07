// Promo codes: prepare EXISTING codes for hash-only storage (hardening, deploy safety). Capability: requirePromoCodeAdmin().
//
// Runs the digest backfill (lib/services/promoCodeBackfill.ts) inside the application, where the dedicated digest secret
// lives. It stores and VERIFIES a keyed digest for every code that still has a plain value. It never blanks a plain value (that is
// the separate SQL finalise step the PO runs deliberately), never returns a code or a digest, and is safe to repeat. Existing
// codes keep working at every step: until a row is verified, redemption finds it through the legacy plain lookup.
//
// The service-role client is used ONLY after the caller passed the promo capability check; the functions it calls are granted to
// service_role alone, so a signed-in user cannot call them any other way.

import { adminRoute } from '@/lib/services/adminAuth';
import { requirePromoCodeAdmin } from '@/lib/services/promoCodeAdmin';
import { promoDigestKeys, promoSecretsAdminError } from '@/lib/services/promoSecrets';
import { runDigestBackfill, type BackfillClient } from '@/lib/services/promoCodeBackfill';
import { isMissingDbObjectError } from '@/lib/services/premiumGrantAdmin';
import { createAdminClient } from '@/lib/supabase/admin';
import { ok, bad } from '@/lib/api';

export const dynamic = 'force-dynamic';

export const POST = adminRoute(async () => {
  const { user, forbidden } = await requirePromoCodeAdmin();
  if (forbidden) return forbidden;

  const keys = promoDigestKeys();
  const problem = promoSecretsAdminError('create');
  if (!keys || problem) {
    const p = problem ?? { status: 503, code: 'PROMO_SECRETS_NOT_CONFIGURED', message: 'The promo code key is not configured correctly. Nothing was changed.' };
    return bad(p.message, p.status, p.code);
  }

  const summary = await runDigestBackfill({ db: createAdminClient() as unknown as BackfillClient, keys, actorId: user?.id ?? null });
  if (summary.failure) {
    // A missing function means migrations 0264 to 0268 are not applied yet.
    const missing = isMissingDbObjectError({ code: summary.failureCode ?? undefined });
    return bad(missing ? 'The database migrations 0264 to 0268 have not been applied yet. Nothing was changed.' : `The preparation stopped early: ${summary.failure}. What was done before it is kept.`, missing ? 503 : 500, missing ? 'FEATURE_UNAVAILABLE' : 'PROMO_BACKFILL_FAILED');
  }
  return ok({
    rowsSeen: summary.rowsSeen,
    rowsVerified: summary.rowsVerified,
    rowsNotVerified: summary.rowsNotVerified,
    stalled: summary.stalled,
  });
});
