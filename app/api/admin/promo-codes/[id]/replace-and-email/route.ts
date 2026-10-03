// Promo codes — "Generate a replacement code and email it".
//
// For a code that already exists the admin console does NOT retrieve or re-send the old code. Instead this
// route reads the OLD code's settings (access length, redemption limit, redeem-by date, note) and creates a NEW
// generated code with the same settings, then e-mails the new code once (same rules as creating with
// "Email to": idempotent per request key, bounded retries, kill switch, optional address binding, the code
// returned to the admin only if the e-mail was not delivered). The old code is left as it is; the admin can
// disable it separately.
//
// Capability: requirePromoCodeAdmin() (can_manage_promo_codes) — no new capability. The plaintext code never
// appears in a URL, a log or an error message.

import { adminRoute, safeDbError } from '@/lib/services/adminAuth';
import { requirePromoCodeAdmin } from '@/lib/services/promoCodeAdmin';
import { mapPromoRpcError } from '@/lib/services/promoCodes';
import { createAndEmailPromoCodes, parseEmailDispatch } from '@/lib/services/promoCodeEmail';
import { createResendMailer } from '@/lib/services/premiumReminderMailer';
import { createClient } from '@/lib/supabase/server';
import { ok, bad } from '@/lib/api';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ListedCode {
  id: string;
  duration_days: number;
  max_redemptions: number | null;
  expires_on: string | null;
  note: string | null;
  status: 'active' | 'disabled';
  state: 'active' | 'disabled' | 'expired' | 'exhausted';
}

export const POST = adminRoute(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { forbidden } = await requirePromoCodeAdmin();
  if (forbidden) return forbidden;

  const { id } = await params;
  if (!UUID_RE.test(id)) return bad('Invalid promo code id.', 422, 'PROMO_NOT_FOUND');

  const dispatch = parseEmailDispatch(await req.json().catch(() => null));
  if (dispatch.kind === 'invalid') return bad(dispatch.message, dispatch.status, dispatch.code);
  if (dispatch.kind === 'none') return bad('Enter at least one e-mail address to send the replacement code to.', 422, 'PROMO_RECIPIENTS_INVALID');

  const supabase = await createClient();
  const listed = await supabase.rpc('admin_list_promo_codes');
  if (listed.error) {
    const mapped = mapPromoRpcError(listed.error);
    if (mapped) return bad(mapped.message, mapped.status, mapped.code);
    return safeDbError(listed.error, 'admin promo codes replace list');
  }
  const old = ((listed.data ?? []) as ListedCode[]).find((r) => r.id === id.toLowerCase());
  if (!old) return bad('No such promo code.', 404, 'PROMO_NOT_FOUND');
  if (old.state !== 'active') {
    return bad(`This code is ${old.state}, so it cannot be replaced from here. Create a new code instead.`, 409, 'PROMO_CODE_NOT_ACTIVE');
  }

  const baseUrl = (process.env.APP_BASE_URL || 'https://app.financialhealthplatform.com').replace(/\/+$/, '');
  const result = await createAndEmailPromoCodes({
    supabase,
    settings: {
      code: null, // always a freshly generated code
      durationDays: old.duration_days,
      // An address-bound replacement is single-use by construction, whatever the old code allowed.
      maxRedemptions: dispatch.value.bind ? 1 : old.max_redemptions,
      unlimited: dispatch.value.bind ? false : old.max_redemptions === null,
      expiresOn: old.expires_on,
      noExpiry: old.expires_on === null,
      note: old.note,
    },
    request: dispatch.value,
    mailer: createResendMailer(),
    baseUrl,
  });
  if (!result.ok) {
    if ('rpcError' in result) return safeDbError(result.rpcError, 'admin promo codes replace+email');
    return bad(result.message, result.status, result.code);
  }
  return ok(result);
});
