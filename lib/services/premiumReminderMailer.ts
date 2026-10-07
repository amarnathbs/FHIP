// The mailer seam for Premium expiry reminders.
//
// REUSES THE REPO'S EXISTING PRODUCTION MAIL PATH: Resend over its HTTPS API with
// RESEND_API_KEY, exactly as the Contact form does (app/api/contact/route.ts),
// with the sender ADDRESS taken from PREMIUM_REMINDER_FROM_EMAIL, falling back to
// CONTACT_FROM_EMAIL, falling back to the same default address the Contact route
// uses, and a SEPARATE display name (PREMIUM_PROMO_EMAIL_FROM_NAME, default "FHIP"). No new provider, no new dependency.
//
// INJECTABLE. The runner takes a `Mailer`; tests pass a fake, so no test can send
// real mail. Nothing here logs the recipient or the body.

import { buildFromHeader, DEFAULT_FROM_ADDRESS } from '@/lib/services/mailFromHeader';

export interface OutgoingMail {
  to: string;
  from: string;
  subject: string;
  text: string;
  /** Stable per ledger row; sent as Resend's Idempotency-Key as best-effort extra protection (the ledger is the real guarantee). */
  idempotencyKey: string;
}

export interface MailResult {
  ok: boolean;
  messageId?: string;
  /** Short, non-identifying failure description (status code / reason). Never the body or the address. */
  error?: string;
}

export interface Mailer {
  /** False when the sender is not configured; the runner then claims nothing. */
  configured(): boolean;
  from(): string;
  send(mail: OutgoingMail): Promise<MailResult>;
}

const DEFAULT_FROM = `FHIP <${DEFAULT_FROM_ADDRESS}>`;

/** A provider call that has not answered in this long is a failure (hardening mission, item 11): a hung provider must never hang an admin request or a cron run. */
export const PREMIUM_MAIL_TIMEOUT_MS = 10_000;

export function createResendMailer(env: Record<string, string | undefined> = process.env, fetchImpl: typeof fetch = fetch): Mailer {
  const apiKey = env.RESEND_API_KEY;
  return {
    configured: () => Boolean(apiKey),
    // The ADDRESS is unchanged (PREMIUM_REMINDER_FROM_EMAIL, else CONTACT_FROM_EMAIL, else the default); only the
    // display name is replaced, so these e-mails read "FHIP" rather than the Contact form's display name.
    // Name: PREMIUM_PROMO_EMAIL_FROM_NAME (default "FHIP"), sanitised against header injection.
    from: () => buildFromHeader(env.PREMIUM_REMINDER_FROM_EMAIL || env.CONTACT_FROM_EMAIL || DEFAULT_FROM, env.PREMIUM_PROMO_EMAIL_FROM_NAME),
    async send(mail) {
      if (!apiKey) return { ok: false, error: 'mailer_not_configured' };
      try {
        const res = await fetchImpl('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': mail.idempotencyKey,
          },
          body: JSON.stringify({ from: mail.from, to: [mail.to], subject: mail.subject, text: mail.text }),
          signal: AbortSignal.timeout(PREMIUM_MAIL_TIMEOUT_MS),
        });
        if (!res.ok) return { ok: false, error: `resend_http_${res.status}` };
        const json = (await res.json().catch(() => null)) as { id?: unknown } | null;
        return { ok: true, messageId: typeof json?.id === 'string' ? json.id : undefined };
      } catch (e) {
        const name = e instanceof Error ? e.name : '';
        return { ok: false, error: name === 'TimeoutError' || name === 'AbortError' ? 'resend_timeout' : 'resend_network_error' };
      }
    },
  };
}
