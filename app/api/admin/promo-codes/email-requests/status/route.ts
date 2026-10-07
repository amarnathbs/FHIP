// Promo code e-mail requests — per recipient status (hardening 0266, item 8).
//
// Used after a browser refresh, a lost response or a repeated request key. The admin who started the request supplies the
// request key and the recipient addresses again; the server recomputes the keyed hashes and asks the ledger. The answer is
// a status per recipient (sent, failed, unknown) and NEVER a code, an address or a hash. Only the initiating admin can read
// a request (the database function filters on auth.uid()). Capability: requirePromoCodeAdmin().

import { adminRoute } from '@/lib/services/adminAuth';
import { requirePromoCodeAdmin } from '@/lib/services/promoCodeAdmin';
import { getEmailRequestStatus, PROMO_EMAIL_MAX_RECIPIENTS } from '@/lib/services/promoCodeEmail';
import { checkRecipientAddress } from '@/lib/services/emailAddressContract';
import { dispatchFailureResponse } from '@/lib/services/promoDispatchResponse';
import { createClient } from '@/lib/supabase/server';
import { ok, bad } from '@/lib/api';

export const dynamic = 'force-dynamic';

export const POST = adminRoute(async (req: Request) => {
  const { forbidden } = await requirePromoCodeAdmin();
  if (forbidden) return forbidden;

  const body = (await req.json().catch(() => null)) as { requestKey?: unknown; emailTo?: unknown } | null;
  if (!body || typeof body.requestKey !== 'string') return bad('A request key is required.', 422, 'PROMO_EMAIL_KEY_INVALID');
  const raw: unknown[] = Array.isArray(body.emailTo) ? body.emailTo : typeof body.emailTo === 'string' ? body.emailTo.split(/[\s,;]+/) : [];
  const recipients: string[] = [];
  for (const item of raw) {
    const checked = checkRecipientAddress(item);
    if (!checked.ok) {
      if (checked.reason === 'empty') continue;
      return bad('One of the recipient addresses is not valid.', 422, 'PROMO_RECIPIENTS_INVALID');
    }
    if (!recipients.includes(checked.address)) recipients.push(checked.address);
  }
  if (recipients.length === 0 || recipients.length > PROMO_EMAIL_MAX_RECIPIENTS) {
    return bad(`Give between 1 and ${PROMO_EMAIL_MAX_RECIPIENTS} recipient addresses.`, 422, 'PROMO_RECIPIENTS_INVALID');
  }

  const supabase = await createClient();
  const status = await getEmailRequestStatus(supabase, body.requestKey, recipients);
  if (!status.ok) return dispatchFailureResponse(status);
  return ok({ requestExists: status.requestExists, recipients: status.recipients });
});
