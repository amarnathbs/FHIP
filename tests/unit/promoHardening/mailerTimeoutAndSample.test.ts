// Item 9 and item 11: the mailer fails fast on a hung provider, and the real-send certification script uses the SAME message the application sends.
//
// NAMED NEGATIVE CONTROLS
//   NC-T1  a mailer without a timeout would wait forever on a hung provider: "the provider call carries a timeout signal";
//   NC-T2  a sample body that drifted from the real composer is caught: "the certification sample equals the real message".

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createResendMailer, PREMIUM_MAIL_TIMEOUT_MS } from '@/lib/services/premiumReminderMailer';
import { composePromoCodeEmail } from '@/lib/services/promoCodeEmail';
import { isProviderFailure } from '@/lib/services/promoEmailAbuse';
import { REPO_ROOT, expectNamedFailure } from '../support/promoTestHelpers';

const mail = { to: 'a@mail-example.com', from: 'FHIP <no-reply@mail-example.com>', subject: 'Your FHIP Premium access code', text: 'body', idempotencyKey: 'promo-code-k-1' };
const ENV = { RESEND_API_KEY: 'test-key-not-real' };

describe('mailer timeout', () => {
  it('NC-T1: the provider call carries an abort signal with the documented timeout', async () => {
    let seen: RequestInit | undefined;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      seen = init;
      return new Response(JSON.stringify({ id: 'msg_1' }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await createResendMailer(ENV, fetchImpl).send(mail);
    expect(result).toEqual({ ok: true, messageId: 'msg_1' });
    const hasSignal = (init?: RequestInit) => expect(init?.signal instanceof AbortSignal, 'the provider call carries a timeout signal').toBe(true);
    hasSignal(seen);
    expect(PREMIUM_MAIL_TIMEOUT_MS).toBe(10_000);
    await expectNamedFailure(() => hasSignal({}), 'the provider call carries a timeout signal');
  });

  it('a timeout or abort is reported as resend_timeout (a provider failure for the circuit breaker), other network errors as resend_network_error', async () => {
    const timeout = (async () => {
      throw new DOMException('The operation timed out', 'TimeoutError');
    }) as unknown as typeof fetch;
    const abort = (async () => {
      throw new DOMException('aborted', 'AbortError');
    }) as unknown as typeof fetch;
    const dns = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    expect(await createResendMailer(ENV, timeout).send(mail)).toEqual({ ok: false, error: 'resend_timeout' });
    expect(await createResendMailer(ENV, abort).send(mail)).toEqual({ ok: false, error: 'resend_timeout' });
    expect(await createResendMailer(ENV, dns).send(mail)).toEqual({ ok: false, error: 'resend_network_error' });
    expect(isProviderFailure('resend_timeout')).toBe(true);
  });

  it('what is sent to the provider: only from, to, subject and text in the body, an Authorization and an Idempotency-Key header, and no code in the subject, the sender or the metadata', async () => {
    let init: RequestInit | undefined;
    const fetchImpl = (async (_url: string, i?: RequestInit) => {
      init = i;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    await createResendMailer(ENV, fetchImpl).send({ ...mail, text: 'Your code: ABCDE-FGHJK' });
    const body = JSON.parse(String(init?.body));
    expect(Object.keys(body).sort(), 'no tags, no metadata, no headers field that could carry the code').toEqual(['from', 'subject', 'text', 'to']);
    expect(body.subject).not.toContain('ABCDE');
    expect(body.from).not.toContain('ABCDE');
    expect(Object.keys(init?.headers as Record<string, string>).sort()).toEqual(['Authorization', 'Content-Type', 'Idempotency-Key']);
    expect((init?.headers as Record<string, string>)['Idempotency-Key']).not.toContain('ABCDE');
  });

  it('a provider refusal and a missing key are explicit failures, never a throw', async () => {
    const refuse = (async () => new Response('{}', { status: 422 })) as unknown as typeof fetch;
    expect(await createResendMailer(ENV, refuse).send(mail)).toEqual({ ok: false, error: 'resend_http_422' });
    expect(await createResendMailer({}, refuse).send(mail)).toEqual({ ok: false, error: 'mailer_not_configured' });
  });
});

describe('the real-send certification sample', () => {
  const FILE = path.join(REPO_ROOT, 'docs', 'admin', 'po_apply_promo_hardening_release', 'resend_sample_body.txt');
  const sample = () =>
    composePromoCodeEmail({ code: 'ZZZZZZZZZZ', durationDays: 30, expiresOn: '2026-10-31', maxRedemptions: 1, bound: false, baseUrl: 'https://app.financialhealthplatform.com' });

  it('NC-T2: the certification sample equals the real message for the same input (so the script can never certify a different text)', async () => {
    const same = (text: string) => expect(text, 'the certification sample equals the real message').toBe(sample().text);
    same(fs.readFileSync(FILE, 'utf8'));
    await expectNamedFailure(() => same(fs.readFileSync(FILE, 'utf8').replace('31 October 2026', '31/10/2026')), 'the certification sample equals the real message');
  });

  it('the sample uses the unambiguous English date and a code that no admin can have created (it is not redeemable)', () => {
    const text = fs.readFileSync(FILE, 'utf8');
    expect(text).toContain('Please redeem it by 31 October 2026.');
    expect(text).toContain('ZZZZZ-ZZZZZ');
    expect(sample().subject).toBe('Your FHIP Premium access code');
  });
});
