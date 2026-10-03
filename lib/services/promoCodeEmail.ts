// Promo codes — e-mailing a code to a user from the admin console.
//
// DESIGN (PO request 2026-10-03)
//   * The plaintext code is sent ONCE, from the SAME request that creates it. This module
//     never stores it, never logs it, never puts it in a URL, an error message or an audit
//     row. The send ledger (promo_email_sends) holds only a KEYED HASH of each recipient
//     address, a status and an attempt count; the audit event records the recipient COUNT
//     and a bound flag with the masked code hint. For an already-created code the admin
//     console offers "Generate a replacement code and email it" instead of retrieving the old one.
//   * Idempotent per request key: a double-click, retry or concurrent resubmission cannot create
//     a second code or send a second e-mail (admin_promo_email_begin(), a unique key).
//   * Bounded retries on mailer failure (MAX_SEND_ATTEMPTS, short back-off) are recorded and never
//     re-create the code. A code whose e-mail was not sent is returned to the admin once, exactly
//     like the existing show-once copy flow, so a mailer failure never loses a code.
//   * Optional address binding: the code row stores an HMAC of the normalised address, never the
//     address; redemption by any other account is the same generic "This code cannot be used.".
//   * Fail closed behind PREMIUM_PROMO_EMAIL_ENABLED (default OFF). When it is off the code is still
//     created and shown once, with the message "Email sending is switched off. Copy the code and
//     send it yourself."
//   * Fail soft if the migration is absent: no sending; a binding request creates nothing.
//
// The mailer, the sleeper and the environment are injected so tests can never send real mail.

import { createHmac } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { formatDateShort } from '@/lib/engines/date';
import { formatPromoCode, mapPromoRpcError, type CreatePromoRequest } from '@/lib/services/promoCodes';
import { FEATURE_UNAVAILABLE, isMissingDbObjectError, type RouteError } from '@/lib/services/premiumGrantAdmin';
import type { Mailer } from '@/lib/services/premiumReminderMailer';

export const PROMO_EMAIL_MAX_RECIPIENTS = 20;
/** Attempts per recipient, including the first. */
export const PROMO_EMAIL_MAX_SEND_ATTEMPTS = 3;
/** Wait before attempt 2 and attempt 3 (milliseconds). */
export const PROMO_EMAIL_BACKOFF_MS: readonly number[] = [400, 1200];

export const PROMO_EMAIL_SWITCHED_OFF_MESSAGE = 'Email sending is switched off. Copy the code and send it yourself.';
export const PROMO_EMAIL_NOT_CONFIGURED_MESSAGE = 'Email sending is not configured on this server. Copy the code and send it yourself.';
export const PROMO_EMAIL_UNAVAILABLE_MESSAGE = 'Email sending is not available on this database yet. Copy the code and send it yourself.';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_MAX = 254;
const KEY_RE = /^[A-Za-z0-9_-]{8,100}$/;

// -- flag and secret (server environment only) -------------------------------

/** Fail closed: only the exact text "true" enables sending. */
export function isPromoEmailEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.PREMIUM_PROMO_EMAIL_ENABLED ?? '').trim() === 'true';
}

/**
 * Key for the keyed address hashes: PREMIUM_PROMO_EMAIL_BIND_SECRET, else PROMO_IP_HASH_SECRET, else
 * CRON_SECRET. Rotating it makes already-bound codes unusable (fail closed: they read as "cannot be used").
 */
export function promoEmailSecret(env: Record<string, string | undefined> = process.env): string | null {
  return env.PREMIUM_PROMO_EMAIL_BIND_SECRET || env.PROMO_IP_HASH_SECRET || env.CRON_SECRET || null;
}

export function normaliseEmailAddress(input: string): string {
  return input.trim().toLowerCase();
}

/** Domain-separated HMAC-SHA256 of a normalised address. 'bind' = the redemption binding; 'send' = the dispatch ledger. */
export function keyedAddressHash(kind: 'bind' | 'send', email: string, env: Record<string, string | undefined> = process.env): string | null {
  const secret = promoEmailSecret(env);
  const normalised = normaliseEmailAddress(email);
  if (!secret || !normalised) return null;
  return createHmac('sha256', secret).update(`promo-${kind}:${normalised}`).digest('hex');
}

// -- request parsing ---------------------------------------------------------

export interface EmailDispatchRequest {
  recipients: string[];
  bind: boolean;
  requestKey: string;
}

export type ParseDispatchResult =
  | { kind: 'none' }
  | { kind: 'dispatch'; value: EmailDispatchRequest }
  | ({ kind: 'invalid' } & RouteError);

const invalid = (code: string, message: string): ParseDispatchResult => ({ kind: 'invalid', status: 422, code, message });

/** Reads `emailTo` (array or text split on commas, semicolons, spaces and newlines), `bindToRecipient`, `idempotencyKey`. */
export function parseEmailDispatch(body: unknown): ParseDispatchResult {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { kind: 'none' };
  const b = body as Record<string, unknown>;
  if (b.emailTo === undefined || b.emailTo === null) return { kind: 'none' };

  const raw: unknown[] = Array.isArray(b.emailTo) ? b.emailTo : typeof b.emailTo === 'string' ? b.emailTo.split(/[\s,;]+/) : [];
  if (!Array.isArray(b.emailTo) && typeof b.emailTo !== 'string') return invalid('PROMO_RECIPIENTS_INVALID', 'emailTo must be a list of e-mail addresses.');
  const seen = new Set<string>();
  const recipients: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') return invalid('PROMO_RECIPIENTS_INVALID', 'Every recipient must be an e-mail address.');
    const address = normaliseEmailAddress(item);
    if (address === '') continue;
    if (address.length > EMAIL_MAX || !EMAIL_RE.test(address)) return invalid('PROMO_RECIPIENTS_INVALID', 'One of the recipient addresses is not a valid e-mail address.');
    if (!seen.has(address)) {
      seen.add(address);
      recipients.push(address);
    }
  }
  if (recipients.length === 0) return { kind: 'none' }; // an empty box means "do not e-mail"
  if (recipients.length > PROMO_EMAIL_MAX_RECIPIENTS) return invalid('PROMO_RECIPIENTS_INVALID', `You can e-mail at most ${PROMO_EMAIL_MAX_RECIPIENTS} addresses at a time.`);

  if (typeof b.idempotencyKey !== 'string' || !KEY_RE.test(b.idempotencyKey)) {
    return invalid('PROMO_EMAIL_KEY_INVALID', 'A request key of 8 to 100 letters, digits, "-" or "_" is required when e-mailing a code.');
  }
  return { kind: 'dispatch', value: { recipients, bind: b.bindToRecipient === true, requestKey: b.idempotencyKey } };
}

// -- message -----------------------------------------------------------------

export interface PromoEmailInput {
  /** Normalised code; formatted for display here. */
  code: string;
  durationDays: number;
  /** YYYY-MM-DD the code can be redeemed until, or null. */
  expiresOn: string | null;
  /** null = unlimited. */
  maxRedemptions: number | null;
  bound: boolean;
  /** The recipient's country when known ('IN' gives dd-mm-yyyy); admin-triggered mails default to AU. */
  country?: string | null;
  baseUrl: string;
}

export function composePromoCodeEmail(input: PromoEmailInput): { subject: string; text: string } {
  const key = input.country === 'IN' ? 'INR' : 'AUD';
  const days = `${input.durationDays} day${input.durationDays === 1 ? '' : 's'}`;
  const redeemBy = input.expiresOn ? formatDateShort(input.expiresOn, key) : null;
  const uses =
    input.maxRedemptions === 1
      ? 'This code can be used once.'
      : input.maxRedemptions === null
        ? 'There is no limit on how many people can use this code.'
        : `This code can be used up to ${input.maxRedemptions} times in total.`;
  const lines = [
    'Hello,',
    '',
    'You have been given a Premium access code for FHIP.',
    '',
    `Your code: ${formatPromoCode(input.code)}`,
    '',
    `It gives complimentary Premium for ${days} from the day you redeem it.`,
    redeemBy ? `Please redeem it by ${redeemBy}.` : 'There is no last day to redeem it.',
    uses,
  ];
  if (input.bound) lines.push('It works only for the FHIP account registered with this e-mail address.');
  lines.push(
    '',
    'To redeem it:',
    '1. Sign in to FHIP.',
    '2. Open your Profile page and find the Plans section.',
    '3. Enter the code in the Promo code box and choose Apply code.',
    `Profile page: ${input.baseUrl}/profile`,
    '',
    'A code cannot be applied on top of a paid subscription, and it will not shorten Premium you already have.',
    '',
    'This is a service message sent by FHIP at the request of a FHIP administrator. It is not marketing. If you were not expecting it, you can ignore it.',
    '',
    'FHIP'
  );
  return { subject: 'Your FHIP Premium access code', text: lines.join('\n') };
}

// -- orchestration -----------------------------------------------------------

type RpcClient = Pick<SupabaseClient, 'rpc'>;

export type RecipientStatus = 'sent' | 'failed' | 'not_sent';

export interface DispatchedCode {
  id: string;
  code_hint: string;
  duration_days: number;
  ends_if_redeemed_today: string | null;
  expires_on: string | null;
  max_redemptions: number | null;
  bound: boolean;
  /** Present ONLY when at least one e-mail was not sent (or none was attempted): the show-once fallback. */
  code?: string;
  recipients: { index: number; status: RecipientStatus }[];
}

export interface DispatchOutcome {
  ok: true;
  codes: DispatchedCode[];
  email: { enabled: boolean; message: string | null };
  /** Set when a later group could not be created after earlier ones were; earlier codes are still in `codes`. */
  partialError?: RouteError;
}
export type DispatchResult = DispatchOutcome | ({ ok: false } & RouteError) | { ok: false; rpcError: { code?: string; message?: string } };

export interface DispatchDeps {
  supabase: RpcClient;
  settings: CreatePromoRequest;
  request: EmailDispatchRequest;
  env?: Record<string, string | undefined>;
  mailer: Mailer;
  sleep?: (ms: number) => Promise<void>;
  baseUrl: string;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function fail(status: number, code: string, message: string): { ok: false } & RouteError {
  return { ok: false, status, code, message };
}

export async function createAndEmailPromoCodes(deps: DispatchDeps): Promise<DispatchResult> {
  const env = deps.env ?? process.env;
  const sleep = deps.sleep ?? defaultSleep;
  const { supabase, request } = deps;
  const settings = { ...deps.settings };
  const recipients = request.recipients;

  // 1. Validate combinations before anything is created.
  if (request.bind) {
    if (settings.unlimited) return fail(422, 'PROMO_MAX_INVALID', 'A code bound to one e-mail address is single-use; it cannot be unlimited.');
    if (recipients.length > 1 && settings.code) return fail(422, 'PROMO_CODE_INVALID', 'With "only this address can redeem" and several recipients, leave the code blank: one code is generated per recipient.');
    settings.maxRedemptions = 1; // one recipient, one redemption
    settings.unlimited = false;
    if (!promoEmailSecret(env)) {
      return fail(503, 'PROMO_BINDING_UNAVAILABLE', 'Binding a code to an address is not configured on this server. Nothing was created.');
    }
  }

  // 2. Can this server send at all? (fail closed)
  const flagOn = isPromoEmailEnabled(env);
  const secretOk = promoEmailSecret(env) !== null;
  const mailerOk = deps.mailer.configured();
  let sendBlockedMessage: string | null = null;
  if (!flagOn) sendBlockedMessage = PROMO_EMAIL_SWITCHED_OFF_MESSAGE;
  else if (!secretOk || !mailerOk) sendBlockedMessage = PROMO_EMAIL_NOT_CONFIGURED_MESSAGE;

  // 3. Idempotency + per-admin rate limit (database). Absent migration: no sending, and no binding.
  let ledgerAvailable = true;
  const begin = await supabase.rpc('admin_promo_email_begin', {
    p_request_key: request.requestKey,
    p_recipient_count: recipients.length,
    p_bound: request.bind,
  });
  if (begin.error) {
    if (isMissingDbObjectError(begin.error)) {
      ledgerAvailable = false;
      if (request.bind) return fail(FEATURE_UNAVAILABLE.status, FEATURE_UNAVAILABLE.code, FEATURE_UNAVAILABLE.message);
      sendBlockedMessage = PROMO_EMAIL_UNAVAILABLE_MESSAGE;
    } else {
      const mapped = mapPromoRpcError(begin.error);
      return mapped ? { ok: false, ...mapped } : { ok: false, rpcError: begin.error };
    }
  } else if ((begin.data as { new?: boolean } | null)?.new === false) {
    return fail(
      409,
      'PROMO_EMAIL_DUPLICATE_REQUEST',
      'This request was already submitted, so no new code was created and nothing was sent again. If the recipient did not receive the code, use "Generate a replacement code and email it".'
    );
  }
  const canSend = sendBlockedMessage === null;

  // 4. One code per recipient when bound; otherwise one code shared by all recipients.
  const groups: string[][] = request.bind ? recipients.map((r) => [r]) : [recipients];
  const codes: DispatchedCode[] = [];
  let partialError: RouteError | undefined;
  let nextIndex = 0;

  for (const group of groups) {
    const bindHash = request.bind ? keyedAddressHash('bind', group[0], env) : null;
    const args: Record<string, unknown> = {
      p_code: settings.code,
      p_duration_days: settings.durationDays,
      p_max_redemptions: settings.maxRedemptions,
      p_unlimited: settings.unlimited,
      p_expires_on: settings.expiresOn,
      p_no_expiry: settings.noExpiry,
      p_note: settings.note,
    };
    if (ledgerAvailable) {
      args.p_bound_email_hash = bindHash;
      args.p_recipient_count = group.length;
    }
    const created = await supabase.rpc('admin_create_promo_code', args);
    if (created.error || !created.data) {
      const mapped = created.error ? mapPromoRpcError(created.error) : null;
      if (codes.length === 0) return mapped ? { ok: false, ...mapped } : { ok: false, rpcError: created.error ?? { message: 'no result' } };
      partialError = mapped ?? { status: 500, code: 'PROMO_PARTIAL', message: 'Some codes could not be created. The codes created so far are shown below.' };
      break;
    }
    const c = created.data as {
      id: string; code: string; code_hint: string; duration_days: number; ends_if_redeemed_today?: string;
      expires_on: string | null; max_redemptions: number | null; bound?: boolean;
    };

    const item: DispatchedCode = {
      id: c.id,
      code_hint: c.code_hint,
      duration_days: c.duration_days,
      ends_if_redeemed_today: c.ends_if_redeemed_today ?? null,
      expires_on: c.expires_on ?? null,
      max_redemptions: c.max_redemptions ?? null,
      bound: c.bound === true,
      recipients: [],
    };
    let allSent = canSend;

    for (const address of group) {
      const index = nextIndex++;
      if (!canSend) {
        item.recipients.push({ index, status: 'not_sent' });
        continue;
      }
      const recipientHash = keyedAddressHash('send', address, env) as string;
      const mail = composePromoCodeEmail({
        code: c.code,
        durationDays: c.duration_days,
        expiresOn: c.expires_on ?? null,
        maxRedemptions: c.max_redemptions ?? null,
        bound: c.bound === true,
        baseUrl: deps.baseUrl,
      });
      let result: { ok: boolean; messageId?: string; error?: string } = { ok: false, error: 'not_attempted' };
      let attempts = 0;
      while (attempts < PROMO_EMAIL_MAX_SEND_ATTEMPTS) {
        attempts += 1;
        try {
          result = await deps.mailer.send({
            to: address,
            from: deps.mailer.from(),
            subject: mail.subject,
            text: mail.text,
            idempotencyKey: `promo-code-${request.requestKey}-${c.id}-${recipientHash.slice(0, 16)}`,
          });
        } catch {
          result = { ok: false, error: 'mailer_threw' };
        }
        if (result.ok) break;
        if (attempts < PROMO_EMAIL_MAX_SEND_ATTEMPTS) await sleep(PROMO_EMAIL_BACKOFF_MS[Math.min(attempts - 1, PROMO_EMAIL_BACKOFF_MS.length - 1)]);
      }
      // Record the outcome (keyed hash only). A recording failure never changes what the admin is shown.
      try {
        await supabase.rpc('admin_promo_email_record', {
          p_request_key: request.requestKey,
          p_promo_code_id: c.id,
          p_recipient_hash: recipientHash,
          p_status: result.ok ? 'sent' : 'abandoned',
          p_attempts: attempts,
          p_message_id: result.ok ? result.messageId ?? null : null,
          p_error: result.ok ? null : result.error ?? 'send failed',
        });
      } catch {
        /* the ledger is best-effort evidence; the code is still returned below if needed */
      }
      item.recipients.push({ index, status: result.ok ? 'sent' : 'failed' });
      if (!result.ok) allSent = false;
    }

    // The plaintext is returned ONLY when it was not (fully) delivered by e-mail: the show-once fallback.
    if (!allSent) item.code = c.code;
    codes.push(item);
  }

  return { ok: true, codes, email: { enabled: canSend, message: canSend ? null : sendBlockedMessage }, partialError };
}
