// Promo codes — e-mailing a code to a user from the admin console.
//
// DESIGN
//   * The plaintext code is generated HERE (CSPRNG) and sent ONCE, from the SAME request that creates it. The database
//     receives only a keyed digest and a masked hint (hardening 0264 item 1). This module never stores the code, never
//     logs it, never puts it in a URL, an error message or an audit row. The send ledger (promo_email_sends) holds only
//     a KEYED HASH of each recipient address, a status and an attempt count.
//   * Idempotent per request key: a double-click, retry or concurrent resubmission cannot create a second code or send a
//     second e-mail (admin_promo_email_begin(), a unique key). A repeated key returns the per-recipient STATUS from the
//     ledger (never the code), so a refresh or a lost response can be reconciled.
//   * PARTIAL FAILURE (up to 20 recipients). Each recipient is settled on its own. The plaintext code is returned to the
//     initiating admin ONLY for a code at least one recipient did not receive, and then ONCE: a bound code has one
//     recipient so a failed recipient's code is shown only for that recipient; a recipient whose e-mail succeeded never has
//     its code in the response. An unbound shared code is the same code for everyone, so when some recipients failed it is
//     shown (they already hold it). A failed recipient is retried only through "Generate a replacement code and email it".
//   * Abuse controls (0266): purpose is mandatory, daily limits per admin and platform, a replacement limit per code,
//     recipient validation (header injection, malformed, reserved domains), a circuit breaker after repeated provider failures.
//   * Optional address binding: the code row stores an HMAC of the normalised address, never the address; redemption by any
//     other account, or by an account whose address is not verified, is the same generic "This code cannot be used.".
//   * Fail closed behind PREMIUM_PROMO_EMAIL_ENABLED (default OFF) and the dedicated secrets (no fallbacks, see promoSecrets.ts).
//     When sending is off the code is still created and shown once.
//
// The mailer, the sleeper, the random source and the environment are injected so tests can never send real mail.

import { createHmac } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { formatPromoCode, mapPromoRpcError, type CreatePromoRequest } from '@/lib/services/promoCodes';
import { FEATURE_UNAVAILABLE, isMissingDbObjectError, type RouteError } from '@/lib/services/premiumGrantAdmin';
import type { Mailer } from '@/lib/services/premiumReminderMailer';
import { checkRecipientAddress, normaliseEmailAddress, type AddressRejection } from '@/lib/services/emailAddressContract';
import { formatEnglishLongDate } from '@/lib/services/englishLongDate';
import type { RandomIndex } from '@/lib/services/promoCodeDigest';
import { createPromoCodeWithDigest } from '@/lib/services/promoCodeCreate';
import { promoDigestKeys, promoSecretProblems, promoSecretsAdminError, readPromoSecret } from '@/lib/services/promoSecrets';
import { checkPurpose, isBeginRefusal, isProviderFailure, PROMO_EMAIL_CIRCUIT_OPEN_MESSAGE } from '@/lib/services/promoEmailAbuse';

export { normaliseEmailAddress };

export const PROMO_EMAIL_MAX_RECIPIENTS = 20;
/** Attempts per recipient, including the first. */
export const PROMO_EMAIL_MAX_SEND_ATTEMPTS = 3;
/** Wait before attempt 2 and attempt 3 (milliseconds). */
export const PROMO_EMAIL_BACKOFF_MS: readonly number[] = [400, 1200];

export const PROMO_EMAIL_SWITCHED_OFF_MESSAGE = 'Email sending is switched off. Copy the code and send it yourself.';
export const PROMO_EMAIL_NOT_CONFIGURED_MESSAGE = 'Email sending is not configured on this server. Copy the code and send it yourself.';
export const PROMO_EMAIL_UNAVAILABLE_MESSAGE = 'Email sending is not available on this database yet. Copy the code and send it yourself.';

const KEY_RE = /^[A-Za-z0-9_-]{8,100}$/;

// -- flag and secret (server environment only) -------------------------------

/** Fail closed: only the exact text "true" enables sending. */
export function isPromoEmailEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.PREMIUM_PROMO_EMAIL_ENABLED ?? '').trim() === 'true';
}

/**
 * Key for the keyed address hashes: PREMIUM_PROMO_EMAIL_BIND_SECRET ONLY. There is no fallback to any other secret
 * (hardening 0264 item 4). Rotating it makes already-bound codes unusable (fail closed: they read as "cannot be used").
 */
export function promoEmailSecret(env: Record<string, string | undefined> = process.env): string | null {
  return readPromoSecret('bind', env);
}

/** Domain-separated HMAC-SHA256 of a normalised address. 'bind' = the redemption binding. 'send' = the dispatch ledger. */
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
  /** Why the admin is sending this (audit). 10 to 200 characters. */
  purpose: string;
}

export type ParseDispatchResult =
  | { kind: 'none' }
  | { kind: 'dispatch'; value: EmailDispatchRequest }
  | ({ kind: 'invalid' } & RouteError);

const invalid = (code: string, message: string): ParseDispatchResult => ({ kind: 'invalid', status: 422, code, message });

const REJECTION_TEXT: Record<AddressRejection, string> = {
  empty: 'is empty',
  too_long: 'is too long',
  control_characters: 'contains a line break or another control character',
  forbidden_characters: 'contains a character that is not allowed in an address (spaces, brackets, quotes, commas and similar)',
  malformed: 'is not an e-mail address',
  bad_local_part: 'has a part before the @ sign that is not valid',
  bad_domain: 'has a domain that is not valid for public mail',
};

/** Reads `emailTo` (array or text split on commas, semicolons, spaces and newlines), `bindToRecipient`, `idempotencyKey`, `purpose`. */
export function parseEmailDispatch(body: unknown): ParseDispatchResult {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { kind: 'none' };
  const b = body as Record<string, unknown>;
  if (b.emailTo === undefined || b.emailTo === null) return { kind: 'none' };

  if (!Array.isArray(b.emailTo) && typeof b.emailTo !== 'string') return invalid('PROMO_RECIPIENTS_INVALID', 'emailTo must be a list of e-mail addresses.');
  // A text box is split on commas, semicolons and whitespace. Control characters are checked BEFORE the split, because a
  // line break inside the box is a legitimate separator but one inside a single array item is not.
  const raw: unknown[] = Array.isArray(b.emailTo) ? b.emailTo : (b.emailTo as string).split(/[\s,;]+/);
  const seen = new Set<string>();
  const recipients: string[] = [];
  let position = 0;
  for (const item of raw) {
    if (typeof item === 'string' && item.trim() === '' && !Array.isArray(b.emailTo)) continue;
    position += 1;
    if (typeof item !== 'string') return invalid('PROMO_RECIPIENTS_INVALID', `Recipient ${position} is not an e-mail address.`);
    const checked = checkRecipientAddress(item);
    if (!checked.ok) {
      if (checked.reason === 'empty') continue;
      return invalid('PROMO_RECIPIENTS_INVALID', `Recipient ${position} ${REJECTION_TEXT[checked.reason]}.`);
    }
    if (!seen.has(checked.address)) {
      seen.add(checked.address);
      recipients.push(checked.address);
    }
  }
  if (recipients.length === 0) return { kind: 'none' }; // an empty box means "do not e-mail"
  if (recipients.length > PROMO_EMAIL_MAX_RECIPIENTS) return invalid('PROMO_RECIPIENTS_INVALID', `You can e-mail at most ${PROMO_EMAIL_MAX_RECIPIENTS} addresses at a time.`);

  if (typeof b.idempotencyKey !== 'string' || !KEY_RE.test(b.idempotencyKey)) {
    return invalid('PROMO_EMAIL_KEY_INVALID', 'A request key of 8 to 100 letters, digits, "-" or "_" is required when e-mailing a code.');
  }
  const purpose = checkPurpose(b.purpose);
  if (!purpose.ok) return invalid('PROMO_EMAIL_PURPOSE_REQUIRED', purpose.message);
  return { kind: 'dispatch', value: { recipients, bind: b.bindToRecipient === true, requestKey: b.idempotencyKey, purpose: purpose.purpose } };
}

// -- message -----------------------------------------------------------------

export interface PromoEmailInput {
  /** Normalised code; formatted for display here. */
  code: string;
  durationDays: number;
  /** Year-month-day text the code can be redeemed until, or null. */
  expiresOn: string | null;
  /** null = unlimited. */
  maxRedemptions: number | null;
  bound: boolean;
  baseUrl: string;
}

/**
 * The code e-mail. An ADMINISTRATOR triggers it, so its date is the unambiguous English form ("3 October 2026") and the
 * recipient's country is not consulted. Subject: no code, no date, no name.
 */
export function composePromoCodeEmail(input: PromoEmailInput): { subject: string; text: string } {
  const days = `${input.durationDays} day${input.durationDays === 1 ? '' : 's'}`;
  const redeemBy = input.expiresOn ? formatEnglishLongDate(input.expiresOn) : '';
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
    `It gives complimentary Premium for ${days}, counting the day you redeem it.`,
    redeemBy ? `Please redeem it by ${redeemBy}.` : 'There is no last day to redeem it.',
    uses,
  ];
  if (input.bound) lines.push('It works only for the FHIP account registered with this e-mail address, and that address must be verified.');
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

/** sent = delivered. failed = tried and not delivered (or deliberately not tried, with a recorded reason). not_sent = nothing was attempted. unknown = no ledger row (the outcome was never recorded). */
export type RecipientStatus = 'sent' | 'failed' | 'not_sent' | 'unknown';

export interface DispatchedCode {
  id: string;
  code_hint: string;
  duration_days: number;
  ends_if_redeemed_today: string | null;
  expires_on: string | null;
  max_redemptions: number | null;
  bound: boolean;
  /** Present ONLY when at least one e-mail for this code was not sent (or none was attempted): the show-once fallback. */
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
export type DispatchFailure = { ok: false } & RouteError & { recipients?: { index: number; status: RecipientStatus }[] };
export type DispatchResult = DispatchOutcome | DispatchFailure | { ok: false; rpcError: { code?: string; message?: string } };

/** The provider circuit breaker (service role on the server). Optional: without it nothing pauses sending. */
export interface CircuitBreaker {
  status(): Promise<{ open: boolean } | null>;
  report(ok: boolean): Promise<{ open: boolean } | null>;
}

export interface DispatchDeps {
  supabase: RpcClient;
  settings: CreatePromoRequest;
  request: EmailDispatchRequest;
  /** 'replace' for "Generate a replacement code and email it". */
  kind?: 'create' | 'replace';
  replacesPromoCodeId?: string;
  env?: Record<string, string | undefined>;
  mailer: Mailer;
  breaker?: CircuitBreaker;
  sleep?: (ms: number) => Promise<void>;
  /** Injectable random index source (tests only). */
  random?: RandomIndex;
  baseUrl: string;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function fail(status: number, code: string, message: string): DispatchFailure {
  return { ok: false, status, code, message };
}

const DB_TO_STATUS: Record<string, RecipientStatus> = { sent: 'sent', failed: 'failed', abandoned: 'failed', pending: 'unknown' };

/**
 * Per recipient status for an earlier request, from the ledger (keyed hashes recomputed from the addresses the admin
 * supplies). Never returns a code, an address or a hash. A recipient with no ledger row is 'unknown'.
 */
export async function getEmailRequestStatus(
  supabase: RpcClient,
  requestKey: string,
  recipients: string[],
  env: Record<string, string | undefined> = process.env
): Promise<{ ok: true; requestExists: boolean; recipients: { index: number; status: RecipientStatus }[] } | DispatchFailure> {
  if (!KEY_RE.test(requestKey)) return fail(422, 'PROMO_EMAIL_KEY_INVALID', 'A request key of 8 to 100 letters, digits, "-" or "_" is required.');
  if (!promoEmailSecret(env)) return fail(503, 'PROMO_SECRETS_NOT_CONFIGURED', promoSecretsAdminError('email', env)?.message ?? 'Server secrets are not configured.');
  const hashes = recipients.map((r) => keyedAddressHash('send', r, env) as string);
  const res = await supabase.rpc('admin_promo_email_request_status', { p_request_key: requestKey, p_recipient_hashes: hashes });
  if (res.error) {
    if (isMissingDbObjectError(res.error)) return fail(FEATURE_UNAVAILABLE.status, FEATURE_UNAVAILABLE.code, FEATURE_UNAVAILABLE.message);
    const mapped = mapPromoRpcError(res.error);
    return mapped ? { ok: false, ...mapped } : fail(500, 'PROMO_STATUS_FAILED', 'The request status could not be read.');
  }
  const data = res.data as { request_exists?: boolean; recipients?: { recipient_hash: string; status: string }[] } | null;
  if (!data?.request_exists) return { ok: true, requestExists: false, recipients: recipients.map((_, index) => ({ index, status: 'unknown' as const })) };
  const byHash = new Map((data.recipients ?? []).map((r) => [r.recipient_hash, r.status]));
  return {
    ok: true,
    requestExists: true,
    recipients: hashes.map((h, index) => ({ index, status: DB_TO_STATUS[byHash.get(h) ?? 'unknown'] ?? 'unknown' })),
  };
}

export async function createAndEmailPromoCodes(deps: DispatchDeps): Promise<DispatchResult> {
  const env = deps.env ?? process.env;
  const sleep = deps.sleep ?? defaultSleep;
  const { supabase, request } = deps;
  const kind = deps.kind ?? 'create';
  const settings = { ...deps.settings };
  const recipients = request.recipients;

  // 0. The dedicated digest secret is mandatory for creating ANY code (no fallback).
  const keys = promoDigestKeys(env);
  const createProblem = promoSecretsAdminError('create', env);
  if (!keys || createProblem) {
    const p = createProblem ?? { status: 503 as const, code: 'PROMO_SECRETS_NOT_CONFIGURED', message: 'The promo code key is not configured correctly. Nothing was created.' };
    return fail(p.status, p.code, p.message);
  }

  // 1. Validate combinations before anything is created.
  if (request.bind) {
    if (settings.unlimited) return fail(422, 'PROMO_MAX_INVALID', 'A code bound to one e-mail address is single-use; it cannot be unlimited.');
    if (recipients.length > 1 && settings.code) return fail(422, 'PROMO_CODE_INVALID', 'With "only this address can redeem" and several recipients, leave the code blank: one code is generated per recipient.');
    settings.maxRedemptions = 1; // one recipient, one redemption
    settings.unlimited = false;
    const bindProblem = promoSecretsAdminError('email', env);
    if (bindProblem) return fail(503, 'PROMO_BINDING_UNAVAILABLE', `Binding a code to an address is not configured on this server. ${bindProblem.message}`);
  }

  // 2. Can this server send at all? (fail closed)
  const flagOn = isPromoEmailEnabled(env);
  const emailProblems = promoSecretProblems('email', env);
  const secretOk = emailProblems.missing.length === 0 && emailProblems.reused.length === 0;
  const mailerOk = deps.mailer.configured();
  let sendBlockedMessage: string | null = null;
  let blockedReason = 'email_switched_off';
  if (!flagOn) sendBlockedMessage = PROMO_EMAIL_SWITCHED_OFF_MESSAGE;
  else if (!secretOk || !mailerOk) {
    sendBlockedMessage = PROMO_EMAIL_NOT_CONFIGURED_MESSAGE;
    blockedReason = 'not_configured';
  }

  // 3. Idempotency, purpose, limits (database). Absent migration 0266: no sending, no replacement.
  let ledgerAvailable = true;
  const begin = await supabase.rpc('admin_promo_email_begin', {
    p_request_key: request.requestKey,
    p_recipient_count: recipients.length,
    p_bound: request.bind,
    p_kind: kind,
    p_purpose: request.purpose,
    p_replaces: deps.replacesPromoCodeId ?? null,
  });
  if (begin.error) {
    if (isMissingDbObjectError(begin.error)) {
      ledgerAvailable = false;
      if (request.bind || kind === 'replace') return fail(FEATURE_UNAVAILABLE.status, FEATURE_UNAVAILABLE.code, FEATURE_UNAVAILABLE.message);
      sendBlockedMessage = PROMO_EMAIL_UNAVAILABLE_MESSAGE;
      blockedReason = 'ledger_unavailable';
    } else {
      const mapped = mapPromoRpcError(begin.error);
      return mapped ? { ok: false, ...mapped } : { ok: false, rpcError: begin.error };
    }
  } else {
    const verdict = (begin.data ?? {}) as { new?: boolean; refused?: unknown };
    if (isBeginRefusal(verdict.refused)) {
      const mapped = mapPromoRpcError({ message: verdict.refused });
      return mapped ? { ok: false, ...mapped } : fail(429, verdict.refused, 'The e-mail limit has been reached.');
    }
    if (verdict.new === false) {
      // A repeated request key: nothing is created and nothing is sent. Report what the ledger says about each recipient.
      const status = await getEmailRequestStatus(supabase, request.requestKey, recipients, env);
      return {
        ...fail(
          409,
          'PROMO_EMAIL_DUPLICATE_REQUEST',
          'This request was already submitted, so no new code was created and nothing was sent again. The status of each recipient is shown. For a recipient who did not receive the code, use "Generate a replacement code and email it" (a new code is created, the old one stays valid until you disable it).'
        ),
        recipients: status.ok ? status.recipients : undefined,
      };
    }
  }

  // 3b. Provider circuit breaker: paused sending shows each code once instead.
  if (sendBlockedMessage === null && deps.breaker) {
    const state = await deps.breaker.status().catch(() => null);
    if (state?.open) {
      sendBlockedMessage = PROMO_EMAIL_CIRCUIT_OPEN_MESSAGE;
      blockedReason = 'circuit_open';
    }
  }
  let canSend = sendBlockedMessage === null;
  const emailEnabledAtStart = canSend;

  // 4. One code per recipient when bound; otherwise one code shared by all recipients.
  const groups: string[][] = request.bind ? recipients.map((r) => [r]) : [recipients];
  const codes: DispatchedCode[] = [];
  let partialError: RouteError | undefined;
  let nextIndex = 0;

  const record = async (codeId: string, recipientHash: string, ok: boolean, attempts: number, result: { messageId?: string; error?: string }, reason?: string) => {
    if (!ledgerAvailable) return;
    try {
      await supabase.rpc('admin_promo_email_record', {
        p_request_key: request.requestKey,
        p_promo_code_id: codeId,
        p_recipient_hash: recipientHash,
        p_status: ok ? 'sent' : 'failed',
        p_attempts: Math.max(attempts, 1),
        p_message_id: ok ? result.messageId ?? null : null,
        p_error: ok ? null : reason ?? result.error ?? 'send failed',
      });
    } catch {
      /* the ledger is best-effort evidence; the code is still returned below if needed */
    }
  };

  for (const group of groups) {
    const bindHash = request.bind ? keyedAddressHash('bind', group[0], env) : null;

    // Create the code (generated here unless the admin typed one). Only the digest and hint reach the database.
    const made = await createPromoCodeWithDigest({ supabase, settings, keys, bindHash, recipientCount: group.length, random: deps.random });
    if (!made.ok) {
      if (codes.length === 0) return made;
      partialError =
        'rpcError' in made
          ? { status: 500, code: 'PROMO_PARTIAL', message: 'Some codes could not be created. The codes created so far are shown below.' }
          : { status: made.status, code: made.code, message: made.message };
      break;
    }
    const plain = made.plain;
    const c = made.row;

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
    let allSent = true;

    for (const address of group) {
      const index = nextIndex++;
      const recipientHash = keyedAddressHash('send', address, env);
      if (!canSend || !recipientHash) {
        item.recipients.push({ index, status: 'not_sent' });
        allSent = false;
        if (recipientHash) await record(c.id, recipientHash, false, 1, {}, blockedReason);
        continue;
      }
      const mail = composePromoCodeEmail({
        code: plain,
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
      await record(c.id, recipientHash, result.ok, attempts, result);
      item.recipients.push({ index, status: result.ok ? 'sent' : 'failed' });
      if (!result.ok) allSent = false;

      // Circuit breaker: only provider level failures count. If it opens, the remaining recipients are not attempted.
      if (deps.breaker) {
        const after = await deps.breaker.report(result.ok || !isProviderFailure(result.error)).catch(() => null);
        if (after?.open) {
          canSend = false;
          sendBlockedMessage = PROMO_EMAIL_CIRCUIT_OPEN_MESSAGE;
          blockedReason = 'circuit_open';
        }
      }
    }

    // The plaintext is returned ONLY when it was not (fully) delivered by e-mail: the show-once fallback.
    if (!allSent) item.code = plain;
    codes.push(item);
  }

  return { ok: true, codes, email: { enabled: emailEnabledAtStart, message: sendBlockedMessage }, partialError };
}
