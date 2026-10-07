// Promo codes — list (GET) and create (POST). Capability: requirePromoCodeAdmin()
// (admin_users.can_manage_promo_codes), NOT requireAdmin() and NOT the premium
// entitlement capability (Standard §2/§3). The RPCs run on the CALLER session
// client and re-check the capability in the database.
//
// The create response is the ONLY place a generated code is returned, to the
// admin who created it (they have to hand it out), and the list never returns a code
// at all (hardening 0264: the database stores only a keyed digest and a masked hint).
// It is never logged here and never written to the audit trail.

import { adminRoute, safeDbError } from '@/lib/services/adminAuth';
import { requirePromoCodeAdmin } from '@/lib/services/promoCodeAdmin';
import { mapPromoRpcError, parseCreatePromoRequest } from '@/lib/services/promoCodes';
import { createAndEmailPromoCodes, parseEmailDispatch } from '@/lib/services/promoCodeEmail';
import { dispatchFailureResponse } from '@/lib/services/promoDispatchResponse';
import { createPromoCodeWithDigest } from '@/lib/services/promoCodeCreate';
import { createCircuitBreaker } from '@/lib/services/promoEmailBreaker';
import { promoDigestKeys, promoSecretsAdminError } from '@/lib/services/promoSecrets';
import { createResendMailer } from '@/lib/services/premiumReminderMailer';
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

  const rawJson = req.json().catch(() => null);
  const parsed = parseCreatePromoRequest(await rawJson, utcToday());
  if (!parsed.ok) return bad(parsed.message, parsed.status, parsed.code);
  const v = parsed.value;

  // Dedicated secrets (no fallbacks): creating a code needs the digest secret. Refuse explicitly when it is not usable.
  const keys = promoDigestKeys();
  const secretsProblem = promoSecretsAdminError('create');
  if (!keys || secretsProblem) {
    const p = secretsProblem ?? { status: 503, code: 'PROMO_SECRETS_NOT_CONFIGURED', message: 'The promo code key is not configured correctly. Nothing was created.' };
    return bad(p.message, p.status, p.code);
  }

  const supabase = await createClient();

  // Optional e-mail dispatch (PO request): the plaintext code is e-mailed ONCE from this same request, and is
  // returned to the admin only when the e-mail was not (fully) sent. See lib/services/promoCodeEmail.ts.
  const rawBody = await rawJson;
  const dispatch = parseEmailDispatch(rawBody);
  if (dispatch.kind === 'invalid') return bad(dispatch.message, dispatch.status, dispatch.code);
  if (dispatch.kind === 'dispatch') {
    const baseUrl = (process.env.APP_BASE_URL || 'https://app.financialhealthplatform.com').replace(/\/+$/, '');
    const result = await createAndEmailPromoCodes({ supabase, settings: v, request: dispatch.value, mailer: createResendMailer(), breaker: createCircuitBreaker(), baseUrl });
    if (!result.ok) {
      if ('rpcError' in result) return safeDbError(result.rpcError, 'admin promo codes create+email');
      return dispatchFailureResponse(result);
    }
    return ok(result);
  }

  const made = await createPromoCodeWithDigest({ supabase, settings: v, keys });
  if (!made.ok) {
    if ('rpcError' in made) return safeDbError(made.rpcError, 'admin promo codes create');
    return bad(made.message, made.status, made.code);
  }
  // The plain code is returned ONCE, here, to the admin who created it. It is not stored anywhere.
  return ok({ ...made.row, code: made.plain });
});
