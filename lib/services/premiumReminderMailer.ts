// The mailer seam for Premium expiry reminders.
//
// REUSES THE REPO'S EXISTING PRODUCTION MAIL PATH: Resend over its HTTPS API with
// RESEND_API_KEY, exactly as the Contact form does (app/api/contact/route.ts),
// with the sender taken from PREMIUM_REMINDER_FROM_EMAIL, falling back to
// CONTACT_FROM_EMAIL, falling back to the same default address the Contact route
// uses. No new provider, no new dependency.
//
// INJECTABLE. The runner takes a `Mailer`; tests pass a fake, so no test can send
// real mail. Nothing here logs the recipient or the body.

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

const DEFAULT_FROM = 'FHIP <no-reply@auth.financialhealthplatform.com>';

export function createResendMailer(env: Record<string, string | undefined> = process.env, fetchImpl: typeof fetch = fetch): Mailer {
  const apiKey = env.RESEND_API_KEY;
  return {
    configured: () => Boolean(apiKey),
    from: () => env.PREMIUM_REMINDER_FROM_EMAIL || env.CONTACT_FROM_EMAIL || DEFAULT_FROM,
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
        });
        if (!res.ok) return { ok: false, error: `resend_http_${res.status}` };
        const json = (await res.json().catch(() => null)) as { id?: unknown } | null;
        return { ok: true, messageId: typeof json?.id === 'string' ? json.id : undefined };
      } catch {
        return { ok: false, error: 'resend_network_error' };
      }
    },
  };
}
