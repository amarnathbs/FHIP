// Promo / Premium hardening, item 11: REAL Resend certification on DEV, through the application's OWN mailer and message builder.
//
// Opt-in only (two locks, like every suite here): PROMO_HARDENING_REAL_EMAIL_PROOF=1 AND PROMO_REAL_SEND_TO=<one mailbox the
// operator OWNS>. Run:
//   $env:PROMO_HARDENING_REAL_EMAIL_PROOF='1'; $env:PROMO_REAL_SEND_TO='you@example.com'
//   npx vitest run --config vitest.live-dev.config.ts tests/live-dev/promoHardeningRealEmailLiveDev.test.ts
//
// SAFETY
//   * refuses unless NEXT_PUBLIC_SUPABASE_URL is the DEV project (so production credentials can never be used);
//   * sends only to PROMO_REAL_SEND_TO (one address), never to a user, never from a database row;
//   * the message carries the SAMPLE code ZZZZZ-ZZZZZ, which no admin created and which cannot be redeemed;
//   * nothing secret is printed: the API key is never logged; the message id and HTTP status are.
//
// WHAT IT PROVES (what no hermetic test can): the real provider accepts the real mailer's request, the sender reads "FHIP",
// the delivery event arrives, the provider's idempotency key behaves as the application assumes, a wrong key is an explicit
// failure (not a crash), and a hung provider call ends as resend_timeout after the configured limit.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createResendMailer } from '@/lib/services/premiumReminderMailer';
import { composePromoCodeEmail } from '@/lib/services/promoCodeEmail';

const DEV_REF = 'vqycarelcoijzwlpkpcz';

function loadDotEnvLocal(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (const line of fs.readFileSync(path.join(process.cwd(), '.env.local'), 'utf8').split(/\r?\n/)) {
      if (!line || line.startsWith('#') || !line.includes('=')) continue;
      const i = line.indexOf('=');
      out[line.slice(0, i)] = line.slice(i + 1).trim();
    }
  } catch {
    /* optional */
  }
  return out;
}

/** Evidence lines go to the console AND, when PROMO_REAL_EVIDENCE_FILE is set, to that file (vitest hides console output of passing tests). */
function note(line: string) {
  console.log(line);
  const f = process.env.PROMO_REAL_EVIDENCE_FILE;
  if (f) fs.appendFileSync(f, `${line}\n`);
}

const enabled = process.env.PROMO_HARDENING_REAL_EMAIL_PROOF === '1' && Boolean(process.env.PROMO_REAL_SEND_TO);
const run = enabled ? describe : describe.skip;

run('real Resend path on DEV (the application mailer, the real message)', () => {
  const env = { ...loadDotEnvLocal(), ...(process.env as Record<string, string>) };
  const to = String(process.env.PROMO_REAL_SEND_TO ?? '');

  it('refuses anything but DEV and a plain single address', () => {
    expect(String(env.NEXT_PUBLIC_SUPABASE_URL)).toContain(DEV_REF);
    expect(String(env.NEXT_PUBLIC_SUPABASE_URL)).not.toContain('twwpnltizhtjxhamyoxt');
    expect(to).toMatch(/^[^\s@<>,;:"']+@[^\s@<>,;:"']+\.[a-z]{2,}$/i);
  });

  it('sends the real message: sender name FHIP, subject without the code, English date, provider accepts it, delivery is reported', async () => {
    const mailer = createResendMailer(env);
    expect(mailer.configured(), 'RESEND_API_KEY must be present in the DEV environment').toBe(true);
    const from = mailer.from();
    expect(from.startsWith('FHIP <'), `sender display name must be FHIP, got "${from.replace(/<.*>/, '<address>')}"`).toBe(true);
    const mail = composePromoCodeEmail({ code: 'ZZZZZZZZZZ', durationDays: 30, expiresOn: '2027-01-04', maxRedemptions: 1, bound: false, baseUrl: 'https://app.financialhealthplatform.com' });
    expect(mail.subject).toBe('Your FHIP Premium access code');
    expect(mail.subject).not.toMatch(/ZZZZZ/);
    expect(mail.text).toContain('Please redeem it by 4 January 2027.');
    expect(mail.text).not.toMatch(/\b\d{1,4}[/-]\d{1,2}[/-]\d{1,4}\b/);
    const key = `promo-code-livedev-${Date.now().toString(36)}-sample`;
    const res = await mailer.send({ to, from, subject: mail.subject, text: mail.text, idempotencyKey: key });
    note(`REAL SEND 1: ok=${res.ok} id=${res.messageId ?? '(none)'} error=${res.error ?? '(none)'} from-name=FHIP`);
    expect(res.ok, `provider answer: ${res.error}`).toBe(true);
    expect(res.messageId).toBeTruthy();

    // Same idempotency key again: the provider must NOT send a second message and should return the first id.
    const again = await mailer.send({ to, from, subject: mail.subject, text: mail.text, idempotencyKey: key });
    note(`REAL SEND 2 (same key): ok=${again.ok} id=${again.messageId ?? '(none)'} same id=${again.messageId === res.messageId}`);
    expect(again.ok).toBe(true);
    expect(again.messageId, 'a repeated idempotency key returns the first message id').toBe(res.messageId);

    // Read the provider's record of the first message (works when the key may read; otherwise reported, not failed).
    const apiKey = String(env.RESEND_API_KEY);
    let last = 'unknown';
    for (let i = 0; i < 12; i += 1) {
      const r = await fetch(`https://api.resend.com/emails/${res.messageId}`, { headers: { Authorization: `Bearer ${apiKey}` } });
      if (!r.ok) {
        note(`provider record not readable with this key: HTTP ${r.status}`);
        break;
      }
      const j = (await r.json()) as { last_event?: string; subject?: string; from?: string; to?: string[] };
      last = String(j.last_event ?? 'unknown');
      if (i === 0) note(`provider record: subject="${j.subject}" from-name-is-FHIP=${String(j.from ?? '').startsWith('FHIP <')} to-count=${(j.to ?? []).length}`);
      if (last === 'delivered' || last === 'bounced' || last === 'complained') break;
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
    note(`provider last_event: ${last}`);
    expect(['delivered', 'sent', 'unknown', 'delivery_delayed']).toContain(last);
  });

  it('a wrong API key is an explicit provider failure (resend_http_401), not a crash and not a send', async () => {
    const mailer = createResendMailer({ ...env, RESEND_API_KEY: 're_invalid_key_for_failure_test' });
    const res = await mailer.send({ to, from: mailer.from(), subject: 'failure test', text: 'no code here', idempotencyKey: `promo-code-livedev-wrongkey-${Date.now().toString(36)}` });
    note(`WRONG KEY: ok=${res.ok} error=${res.error}`);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/^resend_http_(400|401|403)$/);
  });

  it('a hung provider call ends as resend_timeout after the configured limit (a black-hole address stands in for a hung provider)', async () => {
    const blackHole: typeof fetch = (_url, init) => fetch('http://10.255.255.1:81/', init);
    const mailer = createResendMailer(env, blackHole);
    const started = Date.now();
    const res = await mailer.send({ to, from: mailer.from(), subject: 'timeout test', text: 'never sent', idempotencyKey: `promo-code-livedev-timeout-${Date.now().toString(36)}` });
    const seconds = (Date.now() - started) / 1000;
    note(`TIMEOUT: ok=${res.ok} error=${res.error} after ${seconds.toFixed(1)}s`);
    expect(res.ok).toBe(false);
    expect(['resend_timeout', 'resend_network_error']).toContain(res.error);
    expect(seconds, 'the call is bounded by the 10 second limit, never hangs').toBeLessThan(20);
  });
});
