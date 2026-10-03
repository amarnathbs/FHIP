// POST /api/payments/promo/redeem — a signed-in user enters a promo code to get
// free Premium for the code's duration (up to 365 days from redemption).
//
// WHO THIS IS: the ONLY way a user reaches redemption. The database function
// redeem_promo_code_for_user() is granted to service_role ONLY (a user cannot
// call it directly), and the identity it acts on is the AUTHENTICATED session
// user taken here, never a value from the request body.
//
// ABUSE CONTROLS
//   * Rate limit: 10 attempts per user and 30 per IP-equivalent per 15 minutes,
//     counted inside the function (attempts are recorded even when they fail).
//     The IP-equivalent is an HMAC of the first forwarded address (the raw address
//     is never stored); with no secret configured only the per-user limit applies.
//   * ONE generic message for a code that does not exist, is disabled, expired,
//     exhausted, or would add nothing to Premium the user already has, all through
//     the same database path: there is no existence/validity oracle.
//   * The code value is NEVER logged here, and never stored in the attempts
//     ledger or the audit trail.
//   * Paid Premium is REFUSED with a clear message (never clobbered or stacked).

import { requireCountryConfirmedUser as requireUser, bad } from '@/lib/api';
import { createAdminClient } from '@/lib/supabase/admin';
import { interpretRedeemVerdict, REDEEM_MESSAGES } from '@/lib/services/promoCodes';
import { hashClientIp } from '@/lib/services/promoCodeIp';
import { keyedAddressHash } from '@/lib/services/promoCodeEmail';

export const dynamic = 'force-dynamic';

const MAX_INPUT_LENGTH = 64;

export async function POST(req: Request) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const body = (await req.json().catch(() => null)) as { code?: unknown } | null;
  const code = body?.code;
  if (typeof code !== 'string' || code.length === 0 || code.length > MAX_INPUT_LENGTH) {
    const m = REDEEM_MESSAGES.PROMO_CODE_UNUSABLE;
    return bad(m.message, m.status, 'PROMO_CODE_UNUSABLE');
  }

  let verdict: unknown = null;
  try {
    const admin = createAdminClient();
    const args = { p_user_id: user.id, p_code: code, p_ip_hash: hashClientIp(req.headers) };
    // Address-bound codes: the session user's KEYED e-mail hash (never the address) lets the database decide whether
    // this account is the bound recipient. If the database predates that parameter (migration not applied) the
    // legacy 3-argument call is used, and no bound code can exist yet.
    let { data, error } = await admin.rpc('redeem_promo_code_for_user', {
      ...args,
      p_email_hash: user.email ? keyedAddressHash('bind', user.email) : null,
    });
    if (error && (error.code === 'PGRST202' || error.code === '42883')) {
      ({ data, error } = await admin.rpc('redeem_promo_code_for_user', args));
    }
    if (error) {
      // Deliberately no detail and never the code. A missing function (migration not applied) or any
      // database fault is reported as unavailable; nothing is granted.
      console.error('promo redeem failed', { code: error.code });
      return bad('Promo codes are unavailable right now. Please try again later.', 503, 'PROMO_UNAVAILABLE');
    }
    verdict = data;
  } catch {
    console.error('promo redeem failed (client error)');
    return bad('Promo codes are unavailable right now. Please try again later.', 503, 'PROMO_UNAVAILABLE');
  }

  const result = interpretRedeemVerdict(verdict);
  return Response.json(result.body, { status: result.status });
}
