// Promo e-mail abuse controls (hardening 0266, item 9) — constants, messages and classification helpers.
//
// The limits live in ONE SQL function, public.promo_email_limits(), because the database enforces them under an
// advisory lock. PROMO_EMAIL_LIMITS mirrors it and a test asserts they agree, so a change in one place cannot
// silently disagree with the other.

export const PROMO_EMAIL_LIMITS = Object.freeze({
  admin_recipients_per_day: 100,
  global_recipients_per_day: 300,
  replacements_per_code_per_day: 3,
  volume_alert_percent: 80,
  circuit_failure_threshold: 5,
  circuit_open_minutes: 15,
});

/** Purpose text an admin must give when e-mailing a code (audit: who, why, how many). */
export const PROMO_EMAIL_PURPOSE_MIN = 10;
export const PROMO_EMAIL_PURPOSE_MAX = 200;

const CONTROL_RE = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}-${String.fromCharCode(159)}${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}]`);

export type PurposeCheck = { ok: true; purpose: string } | { ok: false; message: string };

export function checkPurpose(input: unknown): PurposeCheck {
  if (typeof input !== 'string') return { ok: false, message: `Say why you are sending this code (${PROMO_EMAIL_PURPOSE_MIN} to ${PROMO_EMAIL_PURPOSE_MAX} characters).` };
  if (CONTROL_RE.test(input)) return { ok: false, message: 'The purpose cannot contain line breaks or control characters.' };
  const purpose = input.trim();
  if (purpose.length < PROMO_EMAIL_PURPOSE_MIN || purpose.length > PROMO_EMAIL_PURPOSE_MAX) {
    return { ok: false, message: `Say why you are sending this code (${PROMO_EMAIL_PURPOSE_MIN} to ${PROMO_EMAIL_PURPOSE_MAX} characters).` };
  }
  return { ok: true, purpose };
}

export const PROMO_EMAIL_CIRCUIT_OPEN_MESSAGE =
  'E-mail sending is paused for a few minutes because the mail provider failed several times in a row. Copy the code and send it yourself, or try again later.';

/**
 * Which mailer failures count against the provider circuit breaker. Only PROVIDER level trouble does: a network
 * error, a server error, rate limiting, rejected credentials. A refusal of one address (a 4xx other than those) is
 * a problem with that recipient and must not pause e-mail for everyone.
 */
export function isProviderFailure(error: string | undefined): boolean {
  if (!error) return true;
  if (error === 'resend_network_error' || error === 'resend_timeout' || error === 'mailer_threw' || error === 'mailer_not_configured') return true;
  const m = /^resend_http_(\d{3})$/.exec(error);
  if (!m) return true; // an unrecognised failure is treated as provider level (fail towards pausing)
  const status = Number(m[1]);
  return status >= 500 || status === 429 || status === 401 || status === 403;
}

/** Database refusal codes returned by admin_promo_email_begin (as a result value, so its alert row commits). */
export const BEGIN_REFUSALS = ['PROMO_EMAIL_REPLACEMENT_LIMIT', 'PROMO_EMAIL_DAILY_LIMIT', 'PROMO_EMAIL_GLOBAL_LIMIT'] as const;
export type BeginRefusal = (typeof BEGIN_REFUSALS)[number];
export function isBeginRefusal(v: unknown): v is BeginRefusal {
  return typeof v === 'string' && (BEGIN_REFUSALS as readonly string[]).includes(v);
}
