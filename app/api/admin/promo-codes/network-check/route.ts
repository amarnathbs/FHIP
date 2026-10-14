// Promo codes: the network address probe (hardening item 6). Capability: requirePromoCodeAdmin().
//
// The per-network redemption limit counts the client address from the RIGHT of X-Forwarded-For with a configurable trusted
// hop count (PROMO_TRUSTED_PROXY_HOPS). Whether the deployed host adds one trusted hop or two cannot be proven from the repository,
// so this shows an operator what the SAME selection would use for THEIR OWN request: the header entries as received and the entry
// that would be chosen. Open the Promo Codes page on the deployed site: if the chosen address is your own public address the hop
// count is right. Nothing is stored, hashed or logged here, and the answer is about the caller's own request only.

import { adminRoute } from '@/lib/services/adminAuth';
import { requirePromoCodeAdmin } from '@/lib/services/promoCodeAdmin';
import { describeNetworkCheck } from '@/lib/services/promoCodeIp';
import { ok } from '@/lib/api';

export const dynamic = 'force-dynamic';

export const GET = adminRoute(async (req: Request) => {
  const { forbidden } = await requirePromoCodeAdmin();
  if (forbidden) return forbidden;
  return ok(describeNetworkCheck(req.headers));
});
