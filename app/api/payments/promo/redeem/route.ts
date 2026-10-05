// POST /api/payments/promo/redeem — a signed-in user enters a promo code to get
// free Premium for the code's duration (up to 365 days, counting the day of redemption).
//
// WHO THIS IS: the ONLY way a user reaches redemption. The database function
// redeem_promo_code_for_user() is granted to service_role ONLY (a user cannot
// call it directly), and the identity it acts on is the AUTHENTICATED session
// user taken here from the verified session, never a value from the request body.
//
// BOUND CODES (hardening 0264 item 5). The only address ever used is the session user's own address, and only when the
// authentication provider says it is VERIFIED (email_confirmed_at). A browser-supplied address is never read. The address
// goes through the one canonical normalisation (emailAddressContract.ts) and a keyed hash; the database compares hashes. If the
// user changes their address after a bound code was issued the hash no longer matches: the code stays unusable for them
// (the same generic message) until an admin issues a new one. There is no silent rebinding.
//
// ABUSE CONTROLS
//   * Rate limit: 10 attempts per user (authoritative) and 30 per trusted network address per 15 minutes, counted inside the
//     function (attempts are recorded even when they fail). The network address is chosen from the RIGHT of X-Forwarded-For
//     with a configurable trusted hop count (promoCodeIp.ts); when no trustworthy address exists only the per-user limit applies.
//   * ONE generic message for a code that does not exist, is disabled, expired, exhausted, bound to someone else, or would
//     add nothing to Premium the user already has, all through the same database path: there is no existence/validity oracle.
//   * The code value is NEVER logged here, never stored in the attempts ledger or the audit trail, and reaches the database only
//     as keyed digests (plus, until the digest backfill is finished, the normalised value to find a legacy row without one).
//   * Paid Premium is REFUSED with a clear message (never clobbered or stacked).
//   * DEDICATED SECRETS, NO FALLBACKS (promoSecrets.ts): if the digest, address or network secret is missing, too short or reused
//     the endpoint refuses with an explicit 503; nothing is granted.

import { requireCountryConfirmedUser as requireUser, bad } from '@/lib/api';
import { createAdminClient } from '@/lib/supabase/admin';
import { interpretRedeemVerdict, normalisePromoCode, REDEEM_MESSAGES } from '@/lib/services/promoCodes';
import { hashClientIp } from '@/lib/services/promoCodeIp';
import { keyedAddressHash } from '@/lib/services/promoCodeEmail';
import { digestCandidates } from '@/lib/services/promoCodeDigest';
import { promoDigestKeys, promoSecretProblems } from '@/lib/services/promoSecrets';

export const dynamic = 'force-dynamic';

const MAX_INPUT_LENGTH = 64;
const UNAVAILABLE = 'Promo codes are unavailable right now. Please try again later.';

export async function POST(req: Request) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  // Dedicated secrets: refuse explicitly when one is missing. Names only are logged, never a value.
  const problems = promoSecretProblems('redeem');
  const keys = promoDigestKeys();
  if (problems.missing.length > 0 || problems.reused.length > 0 || !keys) {
    console.error('promo redeem refused: server secrets not configured', { missing: problems.missing, reused: problems.reused });
    return bad(UNAVAILABLE, 503, 'PROMO_UNAVAILABLE');
  }

  const body = (await req.json().catch(() => null)) as { code?: unknown } | null;
  const code = body?.code;
  if (typeof code !== 'string' || code.length === 0 || code.length > MAX_INPUT_LENGTH) {
    const m = REDEEM_MESSAGES.PROMO_CODE_UNUSABLE;
    return bad(m.message, m.status, 'PROMO_CODE_UNUSABLE');
  }
  const normalised = normalisePromoCode(code);

  // Only a VERIFIED session address is ever offered for binding. Unverified or absent: no hash, so bound codes are unusable.
  const verified = Boolean((user as { email_confirmed_at?: string | null }).email_confirmed_at);
  const emailHash = verified && user.email ? keyedAddressHash('bind', user.email) : null;

  let verdict: unknown = null;
  try {
    const admin = createAdminClient();
    const { data, error } = await admin.rpc('redeem_promo_code_for_user', {
      p_user_id: user.id,
      p_digests: digestCandidates(normalised, keys),
      p_ip_hash: hashClientIp(req.headers),
      p_email_hash: emailHash,
      p_legacy_code: normalised,
    });
    if (error) {
      // Deliberately no detail and never the code. A missing function (migration not applied) or any
      // database fault is reported as unavailable; nothing is granted.
      console.error('promo redeem failed', { code: error.code });
      return bad(UNAVAILABLE, 503, 'PROMO_UNAVAILABLE');
    }
    verdict = data;
  } catch {
    console.error('promo redeem failed (client error)');
    return bad(UNAVAILABLE, 503, 'PROMO_UNAVAILABLE');
  }

  const result = interpretRedeemVerdict(verdict);
  return Response.json(result.body, { status: result.status });
}
