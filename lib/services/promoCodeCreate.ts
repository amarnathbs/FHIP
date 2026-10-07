// Server-only. Creating ONE promo code the hash only way (hardening 0264 item 1): the code is generated (or the admin's
// typed code is normalised) HERE, only its keyed digest and masked hint go to the database, and the plain code is
// returned to the caller exactly once (the create response, or the e-mail). Used by the plain create route and by the
// e-mail orchestrator so both follow the same path.

import type { SupabaseClient } from '@supabase/supabase-js';
import { isValidPromoCodeShape, mapPromoRpcError, normalisePromoCode, type CreatePromoRequest } from '@/lib/services/promoCodes';
import { generatePromoCode, digestForCreate, promoCodeHint, type RandomIndex } from '@/lib/services/promoCodeDigest';
import type { DigestKeys } from '@/lib/services/promoSecrets';
import type { RouteError } from '@/lib/services/premiumGrantAdmin';

/** Generated codes retry on the (astronomically unlikely) digest collision this many times. */
export const PROMO_CODE_GENERATION_ATTEMPTS = 6;

export interface CreatedPromoCode {
  /** The ONLY copy of the plain code. Show it once; never log or store it. */
  plain: string;
  row: {
    id: string;
    code_hint: string;
    duration_days: number;
    ends_if_redeemed_today?: string;
    expires_on: string | null;
    max_redemptions: number | null;
    bound?: boolean;
  };
}

export type CreateCodeResult =
  | ({ ok: true } & CreatedPromoCode)
  | ({ ok: false } & RouteError)
  | { ok: false; rpcError: { code?: string; message?: string } };

export async function createPromoCodeWithDigest(opts: {
  supabase: Pick<SupabaseClient, 'rpc'>;
  settings: CreatePromoRequest;
  keys: DigestKeys;
  bindHash?: string | null;
  recipientCount?: number;
  random?: RandomIndex;
}): Promise<CreateCodeResult> {
  const { supabase, settings, keys } = opts;
  let last: { data: unknown; error: { code?: string; message?: string } | null } | null = null;
  let plain = '';
  for (let attempt = 1; attempt <= PROMO_CODE_GENERATION_ATTEMPTS; attempt += 1) {
    plain = settings.code ? normalisePromoCode(settings.code) : generatePromoCode(undefined, opts.random);
    if (!isValidPromoCodeShape(plain)) return { ok: false, status: 422, code: 'PROMO_CODE_INVALID', message: 'That code is not valid.' };
    const { digest, version } = digestForCreate(plain, keys);
    last = await supabase.rpc('admin_create_promo_code', {
      p_code_digest: digest,
      p_code_hint: promoCodeHint(plain),
      p_digest_version: version,
      p_duration_days: settings.durationDays,
      p_max_redemptions: settings.maxRedemptions,
      p_unlimited: settings.unlimited,
      p_expires_on: settings.expiresOn,
      p_no_expiry: settings.noExpiry,
      p_note: settings.note,
      p_bound_email_hash: opts.bindHash ?? null,
      p_recipient_count: opts.recipientCount ?? 0,
    });
    const collided = Boolean(last.error) && /PROMO_CODE_EXISTS/.test(last.error?.message ?? '');
    if (!collided || settings.code) break; // only a GENERATED code is retried
  }
  if (!last || last.error || !last.data) {
    const mapped = last?.error ? mapPromoRpcError(last.error) : null;
    return mapped ? { ok: false, ...mapped } : { ok: false, rpcError: last?.error ?? { message: 'no result' } };
  }
  return { ok: true, plain, row: last.data as CreatedPromoCode['row'] };
}
