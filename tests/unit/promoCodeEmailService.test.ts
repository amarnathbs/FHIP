// E-mailing a promo code — application layer (parsing, kill switch, message, retries, idempotency, binding, partial
// failure of a multi-recipient send, abuse controls, logging, routes), with an INJECTED mailer, sleeper and random source and a
// fake database. No test here can send mail. The database half is proven against a real Postgres in
// promoCodeEmailPglite.test.ts and promoHardeningPglite.test.ts.
//
// HASH ONLY (hardening 0264): the application generates the code and sends the database only a keyed digest and a masked hint,
// so the fake database below never sees (and cannot return) a plain code. A code appears in a result only because the
// orchestrator put it there, which is exactly what the partial failure tests pin down.
//
// Negative controls: each rule's assertion is also run against a deliberately broken variant and must go red; the failing
// assertion is named in the title. (Where the broken variant has to be simulated because the rule lives in one function, the
// title says so.)

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mailer, OutgoingMail, MailResult } from '@/lib/services/premiumReminderMailer';
import type { CreatePromoRequest } from '@/lib/services/promoCodes';
import { TEST_ENV, expectNamedFailure } from './support/promoTestHelpers';

vi.mock('@/lib/services/countryGate', () => ({ countryConfirmationBlockResponse: async () => null }));
vi.setConfig({ testTimeout: 30_000 });

const ADMIN_ID = 'aaaaaaaa-0000-0000-0000-00000000e001';
const OLD_ID = 'cccccccc-0000-0000-0000-00000000e0c1';
const SECRET_ENV: Record<string, string> = { ...TEST_ENV, PREMIUM_PROMO_EMAIL_ENABLED: 'true' };
const PURPOSE = 'Pilot cohort welcome codes';
const SETTINGS: CreatePromoRequest = { code: null, durationDays: 30, maxRedemptions: 5, unlimited: false, expiresOn: '2026-10-31', noExpiry: false, note: 'internal note' };

// Deterministic generated codes: indexes advance 0,1,2,... over the 31 letter alphabet, 10 per code.
//   code 1 = ABCDEFGHJK, code 2 = MNPQRSTUVW, code 3 = XYZ2345678, code 4 = 9ABCDEFGHJ ...
const CODE1 = 'ABCDEFGHJK';
const CODE2 = 'MNPQRSTUVW';
const CODE3 = 'XYZ2345678';
const sequentialRandom = () => {
  let i = 0;
  return () => i++ % 31;
};
const ANY_GENERATED = /[A-HJ-KM-NP-Z2-9]{10}/;

type RpcResult = { data?: unknown; error?: { code?: string; message?: string } | null };
type Handler = (args: Record<string, unknown>, n: number) => RpcResult;

function makeRpc(handlers: Record<string, Handler>) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  let created = 0;
  const rpc = async (name: string, args: Record<string, unknown> = {}) => {
    calls.push({ name, args });
    const h = handlers[name];
    if (h) {
      const r = h(args, name === 'admin_create_promo_code' ? ++created : calls.filter((c) => c.name === name).length);
      return { data: r.data ?? null, error: r.error ?? null };
    }
    return { data: null, error: null };
  };
  return { supabase: { rpc } as never, calls, rpc };
}

/** What the DATABASE returns for a create: the id and settings. Never a code (it does not know it). */
const okCreate: Handler = (args, n) => ({
  data: {
    id: `00000000-0000-0000-0000-00000000000${n}`,
    code_hint: `${String(args.p_code_hint).slice(0, 2)}******${String(args.p_code_hint).slice(-2)}`,
    duration_days: args.p_duration_days,
    ends_if_redeemed_today: '2026-11-28',
    expires_on: args.p_expires_on,
    max_redemptions: args.p_max_redemptions,
    bound: args.p_bound_email_hash != null,
  },
});

const standard = () =>
  makeRpc({
    admin_promo_email_begin: () => ({ data: { new: true } }),
    admin_create_promo_code: okCreate,
    admin_promo_email_record: () => ({ data: true }),
  });

/** An in-memory model of the ledger semantics (idempotent begin, per recipient record, status by hash). */
function makeLedger() {
  const requests = new Set<string>();
  const sends = new Map<string, { status: string }>();
  let created = 0;
  const rpc = makeRpc({
    admin_promo_email_begin: (a) => {
      const key = String(a.p_request_key);
      if (requests.has(key)) return { data: { new: false } };
      requests.add(key);
      return { data: { new: true } };
    },
    admin_create_promo_code: (a) => okCreate(a, ++created),
    admin_promo_email_record: (a) => {
      const k = `${a.p_request_key}|${a.p_recipient_hash}`;
      if (sends.get(k)?.status !== 'sent') sends.set(k, { status: String(a.p_status) });
      return { data: true };
    },
    admin_promo_email_request_status: (a) => ({
      data: {
        request_exists: requests.has(String(a.p_request_key)),
        recipients: (a.p_recipient_hashes as string[]).map((h) => ({ recipient_hash: h, status: sends.get(`${a.p_request_key}|${h}`)?.status ?? 'unknown' })),
      },
    }),
  });
  return { rpc, requests, sends };
}

function makeMailer(results: ((m: OutgoingMail) => MailResult | Promise<MailResult>) | MailResult[] = [{ ok: true, messageId: 'msg_1' }], configured = true) {
  const sent: OutgoingMail[] = [];
  let i = 0;
  const mailer: Mailer = {
    configured: () => configured,
    from: () => 'FHIP <no-reply@mail-example.com>',
    async send(mail) {
      sent.push(mail);
      if (typeof results === 'function') return results(mail);
      return results[Math.min(i++, results.length - 1)];
    },
  };
  return { mailer, sent };
}

interface DispatchOpts {
  rpc: ReturnType<typeof makeRpc>;
  mailer: Mailer;
  recipients?: string[];
  bind?: boolean;
  env?: Record<string, string | undefined>;
  settings?: Partial<CreatePromoRequest>;
  requestKey?: string;
  kind?: 'create' | 'replace';
  replaces?: string;
  breaker?: import('@/lib/services/promoCodeEmail').CircuitBreaker;
  purpose?: string;
  random?: (max: number) => number;
}

async function dispatch(opts: DispatchOpts) {
  const { createAndEmailPromoCodes } = await import('@/lib/services/promoCodeEmail');
  const sleeps: number[] = [];
  const result = await createAndEmailPromoCodes({
    supabase: opts.rpc.supabase,
    settings: { ...SETTINGS, ...opts.settings },
    request: { recipients: opts.recipients ?? ['one@mail-example.com'], bind: opts.bind ?? false, requestKey: opts.requestKey ?? 'request-key-0001', purpose: opts.purpose ?? PURPOSE },
    kind: opts.kind,
    replacesPromoCodeId: opts.replaces,
    env: opts.env ?? SECRET_ENV,
    mailer: opts.mailer,
    breaker: opts.breaker,
    sleep: async (ms) => void sleeps.push(ms),
    random: opts.random ?? sequentialRandom(),
    baseUrl: 'https://app.example.test',
  });
  return { result, sleeps };
}

type Outcome = Extract<Awaited<ReturnType<typeof dispatch>>['result'], { ok: true; codes: unknown }>;
function asOutcome(r: Awaited<ReturnType<typeof dispatch>>['result']): Outcome {
  if (!r.ok || !('codes' in r)) throw new Error(`unexpected result: ${JSON.stringify(r)}`);
  return r as Outcome;
}

beforeEach(() => {
  for (const [k, v] of Object.entries(TEST_ENV)) process.env[k] = v;
  vi.resetModules();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('@/lib/supabase/server');
  vi.doUnmock('@/lib/supabase/admin');
  vi.doUnmock('@/lib/services/premiumReminderMailer');
  vi.doUnmock('@/lib/services/promoEmailBreaker');
  vi.doUnmock('@/lib/api');
  delete process.env.PREMIUM_PROMO_EMAIL_ENABLED;
  for (const k of Object.keys(TEST_ENV)) delete process.env[k];
});

// ---------------------------------------------------------------------------
describe('parsing the e-mail request (recipient validation, purpose)', () => {
  const body = (emailTo: unknown, extra: Record<string, unknown> = {}) => ({ emailTo, idempotencyKey: 'request-key-0001', purpose: PURPOSE, ...extra });

  it('accepts a list or comma/newline separated text, lowercases, de-duplicates, ignores blanks; max 20 (21 refused)', async () => {
    const { parseEmailDispatch } = await import('@/lib/services/promoCodeEmail');
    expect(parseEmailDispatch(body('A@mail-example.com, b@mail-example.com\nA@MAIL-example.com; ; c@mail-example.com'))).toEqual({
      kind: 'dispatch',
      value: { recipients: ['a@mail-example.com', 'b@mail-example.com', 'c@mail-example.com'], bind: false, requestKey: 'request-key-0001', purpose: PURPOSE },
    });
    expect(parseEmailDispatch(body(['a@mail-example.com'], { bindToRecipient: true }))).toMatchObject({ kind: 'dispatch', value: { bind: true } });
    const twenty = Array.from({ length: 20 }, (_, i) => `u${i}@mail-example.com`);
    expect(parseEmailDispatch(body(twenty)).kind).toBe('dispatch');
    expect(parseEmailDispatch(body([...twenty, 'u20@mail-example.com']))).toMatchObject({ kind: 'invalid', code: 'PROMO_RECIPIENTS_INVALID' });
    expect(parseEmailDispatch(body('not-an-address'))).toMatchObject({ kind: 'invalid', code: 'PROMO_RECIPIENTS_INVALID' });
    expect(parseEmailDispatch(body([1, 2]))).toMatchObject({ kind: 'invalid' });
    expect(parseEmailDispatch(body({}))).toMatchObject({ kind: 'invalid' });
  });

  it('no emailTo (or an empty box) means "do not e-mail"; emailTo needs a valid request key and a purpose', async () => {
    const { parseEmailDispatch } = await import('@/lib/services/promoCodeEmail');
    expect(parseEmailDispatch({})).toEqual({ kind: 'none' });
    expect(parseEmailDispatch({ emailTo: '   ' })).toEqual({ kind: 'none' });
    expect(parseEmailDispatch(null)).toEqual({ kind: 'none' });
    for (const key of [undefined, '', 'short', 'has spaces in it!', 'k'.repeat(101)]) {
      expect(parseEmailDispatch({ emailTo: 'a@mail-example.com', idempotencyKey: key, purpose: PURPOSE })).toMatchObject({ kind: 'invalid', code: 'PROMO_EMAIL_KEY_INVALID' });
    }
    for (const purpose of [undefined, '', 'short', 'x'.repeat(201), 'two\nlines of purpose text', 42]) {
      expect(parseEmailDispatch({ emailTo: 'a@mail-example.com', idempotencyKey: 'request-key-0001', purpose }), String(purpose)).toMatchObject({ kind: 'invalid', code: 'PROMO_EMAIL_PURPOSE_REQUIRED' });
    }
  });

  it('header injection and malformed addresses are refused before anything happens: control characters, extra headers, display names, reserved domains', async () => {
    const { parseEmailDispatch } = await import('@/lib/services/promoCodeEmail');
    const refused = (emailTo: unknown) => expect(parseEmailDispatch(body(emailTo)), JSON.stringify(emailTo)).toMatchObject({ kind: 'invalid', code: 'PROMO_RECIPIENTS_INVALID' });
    refused(['a@mail-example.com\r\nBcc: victim@mail-example.com']);
    refused(['a@mail-example.com\nSubject: hi']);
    refused('a@mail-example.com\r\nBcc: victim@mail-example.com'); // pasted into the box: the extra token is not an address
    refused(['Name <a@mail-example.com>']);
    refused(['a@mail-example.com,b@mail-example.com']);
    refused(['a@localhost']);
    refused(['a@mail-example.test']);
    refused(['a@1.2.3.4']);
    refused(['a b@mail-example.com']);
    const r = parseEmailDispatch(body(['ok@mail-example.com', 'a@mail-example.com\r\nBcc: v@x.com']));
    expect(r).toMatchObject({ kind: 'invalid', message: expect.stringContaining('Recipient 2') });
    expect(JSON.stringify(r), 'the message names the position, never echoes the address').not.toContain('victim');
  });
});

// ---------------------------------------------------------------------------
describe('the kill switch fails closed; the show-once flow remains the fallback', () => {
  async function assertDisabledSendsNothing(env: Record<string, string | undefined>): Promise<void> {
    const rpc = standard();
    const { mailer, sent } = makeMailer();
    const { result } = await dispatch({ rpc, mailer, env });
    const out = asOutcome(result);
    expect(sent, 'a switched-off job must not send').toHaveLength(0);
    expect(out.email).toEqual({ enabled: false, message: 'Email sending is switched off. Copy the code and send it yourself.' });
    expect(out.codes[0].code, 'the code is still shown once so the admin can send it themselves').toBe(CODE1);
    expect(out.codes[0].recipients).toEqual([{ index: 0, status: 'not_sent' }]);
    expect(rpc.calls.filter((c) => c.name === 'admin_create_promo_code'), 'the code is still created exactly once').toHaveLength(1);
    // the ledger says WHY it was not sent, so a later status check is explicit
    expect(rpc.calls.find((c) => c.name === 'admin_promo_email_record')?.args).toMatchObject({ p_status: 'failed', p_error: 'email_switched_off' });
  }

  it('unset / false / TRUE / 1 / blank => OFF: nothing is e-mailed, the code is created and returned with the exact admin message', async () => {
    for (const v of [undefined, 'false', 'TRUE', '1', 'yes', ' ', '']) await assertDisabledSendsNothing({ ...TEST_ENV, PREMIUM_PROMO_EMAIL_ENABLED: v });
    const { isPromoEmailEnabled } = await import('@/lib/services/promoCodeEmail');
    expect(isPromoEmailEnabled({ PREMIUM_PROMO_EMAIL_ENABLED: 'true' })).toBe(true);
    expect(isPromoEmailEnabled({ PREMIUM_PROMO_EMAIL_ENABLED: ' true ' })).toBe(true);
    expect(isPromoEmailEnabled({})).toBe(false);
  });

  it('NEGATIVE CONTROL — a send path that ignored the flag would e-mail while "off" (assertion "a switched-off job must not send" goes red; simulated broken variant)', async () => {
    const { mailer, sent } = makeMailer();
    await mailer.send({ to: 'x@mail-example.com', from: 'f', subject: 's', text: 't', idempotencyKey: 'k' }); // the broken behaviour
    expect(() => expect(sent, 'a switched-off job must not send').toHaveLength(0)).toThrow(/a switched-off job must not send/);
  });

  it('flag on but no bind secret (or one that is reused) or no mail provider => "not configured", nothing sent, code returned once', async () => {
    const withoutBind = { ...SECRET_ENV };
    delete withoutBind.PREMIUM_PROMO_EMAIL_BIND_SECRET;
    for (const [env, mailerConfigured] of [
      [withoutBind, true],
      [{ ...SECRET_ENV, PREMIUM_PROMO_EMAIL_BIND_SECRET: SECRET_ENV.PROMO_IP_HASH_SECRET }, true], // reused: refuses, never shares
      [SECRET_ENV, false],
    ] as const) {
      const rpc = standard();
      const { mailer, sent } = makeMailer(undefined, mailerConfigured);
      const { result } = await dispatch({ rpc, mailer, env });
      const out = asOutcome(result);
      expect(sent).toHaveLength(0);
      expect(out.email.message).toBe('Email sending is not configured on this server. Copy the code and send it yourself.');
      expect(out.codes[0].code).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
describe('mandatory dedicated secrets: no fallbacks', () => {
  it('creating any code without the digest secret refuses (503) and creates nothing; CRON_SECRET and the bind secret are not substituted', async () => {
    const env = { ...SECRET_ENV };
    delete env.PROMO_CODE_DIGEST_SECRET;
    const rpc = standard();
    const { result } = await dispatch({ rpc, mailer: makeMailer().mailer, env });
    expect(result).toMatchObject({ ok: false, status: 503, code: 'PROMO_SECRETS_NOT_CONFIGURED' });
    expect(JSON.stringify(result)).toContain('PROMO_CODE_DIGEST_SECRET');
    expect(rpc.calls, 'nothing is created or recorded').toHaveLength(0);
  });

  it('binding without the bind secret refuses (503) before anything is created, and the message names the variable but never a value', async () => {
    const env = { ...SECRET_ENV };
    delete env.PREMIUM_PROMO_EMAIL_BIND_SECRET;
    const rpc = standard();
    const { result } = await dispatch({ rpc, mailer: makeMailer().mailer, env, bind: true });
    expect(result).toMatchObject({ ok: false, status: 503, code: 'PROMO_BINDING_UNAVAILABLE' });
    expect(JSON.stringify(result)).toContain('PREMIUM_PROMO_EMAIL_BIND_SECRET');
    for (const v of Object.values(TEST_ENV)) expect(JSON.stringify(result)).not.toContain(v);
    expect(rpc.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe('the message (an administrator triggers it, so the date is unambiguous English)', () => {
  it('subject is "Your FHIP Premium access code" with no code in it; the body has the code, the inclusive grant wording, the redeem-by date in English, how to redeem, the real link, the use limit and FHIP attribution; no marketing', async () => {
    const { composePromoCodeEmail } = await import('@/lib/services/promoCodeEmail');
    const m = composePromoCodeEmail({ code: 'ABCDEKXBEE', durationDays: 30, expiresOn: '2026-10-31', maxRedemptions: 1, bound: false, baseUrl: 'https://app.example.test' });
    expect(m.subject).toBe('Your FHIP Premium access code');
    expect(m.subject).not.toContain('ABCDE');
    expect(m.text).toContain('Your code: ABCDE-KXBEE');
    expect(m.text).toContain('complimentary Premium for 30 days, counting the day you redeem it');
    expect(m.text).toContain('Please redeem it by 31 October 2026.');
    expect(m.text, 'no numeric date that could be read as day-first or month-first').not.toMatch(/\d{1,2}[/-]\d{1,2}[/-]\d{2,4}/);
    expect(m.text).toContain('This code can be used once.');
    expect(m.text).toContain('Sign in to FHIP.');
    expect(m.text).toContain('Plans section');
    expect(m.text).toContain('Promo code box');
    expect(m.text).toContain('Profile page: https://app.example.test/profile');
    expect(m.text.trim().endsWith('FHIP')).toBe(true);
    expect(m.text).not.toMatch(/discount|offer|sale|limited time|buy now|upgrade now|unsubscribe/i);
    // variants
    expect(composePromoCodeEmail({ code: 'ABCDEKXBEE', durationDays: 1, expiresOn: null, maxRedemptions: null, bound: false, baseUrl: 'x' }).text).toMatch(/for 1 day, counting[\s\S]*no last day to redeem[\s\S]*no limit on how many people/);
    expect(composePromoCodeEmail({ code: 'ABCDEKXBEE', durationDays: 30, expiresOn: null, maxRedemptions: 5, bound: false, baseUrl: 'x' }).text).toContain('used up to 5 times in total');
    expect(composePromoCodeEmail({ code: 'ABCDEKXBEE', durationDays: 30, expiresOn: null, maxRedemptions: 1, bound: true, baseUrl: 'x' }).text).toContain('works only for the FHIP account registered with this e-mail address');
  });

  it('the English long date is the same whatever the recipient country (it is never looked up), for single digit days and the leap day too', async () => {
    const { formatEnglishLongDate } = await import('@/lib/services/englishLongDate');
    expect(formatEnglishLongDate('2026-10-03')).toBe('3 October 2026');
    expect(formatEnglishLongDate('2024-02-29')).toBe('29 February 2024');
    expect(formatEnglishLongDate('2026-12-31')).toBe('31 December 2026');
    expect(formatEnglishLongDate('2026-02-30')).toBe('');
    expect(formatEnglishLongDate('03/10/2026')).toBe('');
    expect(formatEnglishLongDate(null)).toBe('');
  });
});

// ---------------------------------------------------------------------------
describe('sending', () => {
  it('sends the code once to each recipient; the message is plain transactional text; the success response carries NO plaintext code', async () => {
    const rpc = standard();
    const { mailer, sent } = makeMailer();
    const { result } = await dispatch({ rpc, mailer, recipients: ['one@mail-example.com', 'two@mail-example.com'] });
    const out = asOutcome(result);
    expect(sent.map((s) => s.to)).toEqual(['one@mail-example.com', 'two@mail-example.com']); // each address exactly once
    expect(rpc.calls.filter((c) => c.name === 'admin_create_promo_code'), 'one shared code when not bound').toHaveLength(1);
    expect(rpc.calls.find((c) => c.name === 'admin_create_promo_code')?.args).toMatchObject({ p_recipient_count: 2, p_bound_email_hash: null });
    expect(out.email).toEqual({ enabled: true, message: null });
    expect(out.codes[0].code, 'a delivered code is not returned again').toBeUndefined();
    expect(JSON.stringify(out)).not.toContain(CODE1);
    expect(out.codes[0].recipients).toEqual([{ index: 0, status: 'sent' }, { index: 1, status: 'sent' }]);
    expect(Object.keys(sent[0]).sort()).toEqual(['from', 'idempotencyKey', 'subject', 'text', 'to']); // plain text, no html or tracking
    expect(sent[0].text, 'the code is in the BODY only').toContain('ABCDE-FGHJK');
    expect(sent[0].subject).not.toContain('ABCDE');
    expect(JSON.stringify([sent[0].from, sent[0].subject, sent[0].idempotencyKey]), 'no code in the subject, sender or idempotency key').not.toContain(CODE1);
  });

  it('the database receives the keyed digest and the masked hint, NEVER the plain code', async () => {
    const rpc = standard();
    await dispatch({ rpc, mailer: makeMailer().mailer });
    const args = rpc.calls.find((c) => c.name === 'admin_create_promo_code')!.args;
    const { computePromoDigest, promoCodeHint } = await import('@/lib/services/promoCodeDigest');
    expect(args.p_code_digest).toBe(computePromoDigest(CODE1, { version: 1, secret: TEST_ENV.PROMO_CODE_DIGEST_SECRET }));
    expect(args.p_code_hint).toBe(promoCodeHint(CODE1));
    expect(args.p_digest_version).toBe(1);
    expect(JSON.stringify(rpc.calls)).not.toContain(CODE1);
  });

  it('retries are BOUNDED (3 attempts, short back-off), recorded, and never create a second code; success on a later attempt is recorded with the attempt count', async () => {
    const rpc = standard();
    const { mailer, sent } = makeMailer([{ ok: false, error: 'resend_http_500' }, { ok: false, error: 'resend_http_500' }, { ok: true, messageId: 'late_ok' }]);
    const { result, sleeps } = await dispatch({ rpc, mailer });
    const out = asOutcome(result);
    expect(sent).toHaveLength(3);
    expect(sleeps).toEqual([400, 1200]);
    expect(rpc.calls.filter((c) => c.name === 'admin_create_promo_code')).toHaveLength(1);
    const rec = rpc.calls.filter((c) => c.name === 'admin_promo_email_record');
    expect(rec).toHaveLength(1);
    expect(rec[0].args).toMatchObject({ p_status: 'sent', p_attempts: 3, p_message_id: 'late_ok', p_error: null });
    expect(out.codes[0].recipients[0].status).toBe('sent');
  });

  async function assertBoundedAndNotLost(thrower: boolean): Promise<void> {
    const rpc = standard();
    const { mailer, sent } = makeMailer(() => {
      if (thrower) throw new Error('network down');
      return { ok: false, error: 'resend_http_503' };
    });
    const { result } = await dispatch({ rpc, mailer });
    const out = asOutcome(result);
    expect(sent, 'never more than 3 attempts').toHaveLength(3);
    expect(rpc.calls.filter((c) => c.name === 'admin_create_promo_code'), 'a mailer failure must not re-create the code').toHaveLength(1);
    expect(out.codes[0].recipients[0].status).toBe('failed');
    expect(out.codes[0].code, 'a mailer failure never loses the code: it is shown to the admin once').toBe(CODE1);
    const rec = rpc.calls.find((c) => c.name === 'admin_promo_email_record');
    expect(rec?.args).toMatchObject({ p_status: 'failed', p_attempts: 3, p_error: thrower ? 'mailer_threw' : 'resend_http_503' });
  }
  it('three failures: recorded as failed (attempts 3), the code is returned to the admin, and the code is not re-created', async () => {
    await assertBoundedAndNotLost(false);
    await assertBoundedAndNotLost(true);
  });

  it('a failed LEDGER write never changes what the admin sees (the code is still returned when it was not delivered)', async () => {
    const rpc = makeRpc({
      admin_promo_email_begin: () => ({ data: { new: true } }),
      admin_create_promo_code: okCreate,
      admin_promo_email_record: () => {
        throw new Error('ledger down');
      },
    });
    const { mailer } = makeMailer([{ ok: false, error: 'resend_http_500' }]);
    const { result } = await dispatch({ rpc, mailer });
    expect(asOutcome(result).codes[0].code).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
describe('item 8 — multi-recipient partial failure, retry, refresh and lost responses', () => {
  const FAILS = 'bad@mail-example.com';
  const failOne = () => makeMailer((m) => (m.to === FAILS ? { ok: false, error: 'resend_http_422' } : { ok: true, messageId: 'm' }));

  it('SHARED code, some recipients failed: the one shared code is returned once, with a status per recipient (the recipients who got it already hold it)', async () => {
    const { result } = await dispatch({ rpc: standard(), mailer: failOne().mailer, recipients: ['good@mail-example.com', FAILS] });
    const out = asOutcome(result);
    expect(out.codes[0].recipients.map((r) => r.status)).toEqual(['sent', 'failed']);
    expect(out.codes[0].code).toBe(CODE1);
    expect(JSON.stringify(out).split(CODE1)).toHaveLength(2); // exactly one occurrence in the whole response
  });

  it('BOUND codes, one failed in the middle: only the failed recipient\'s code is returned; the delivered recipients\' codes are NOT in the response, so no recipient\'s code is exposed to the admin or to another recipient', async () => {
    const rpc = standard();
    const { mailer, sent } = failOne();
    const recipients = ['first@mail-example.com', FAILS, 'third@mail-example.com'];
    const { result } = await dispatch({ rpc, mailer, recipients, bind: true });
    const out = asOutcome(result);
    expect(out.codes.map((c) => c.recipients[0].status)).toEqual(['sent', 'failed', 'sent']);
    expect(out.codes[0].code, 'a delivered recipient\'s code is not returned').toBeUndefined();
    expect(out.codes[2].code).toBeUndefined();
    expect(out.codes[1].code, 'the failed recipient\'s code is shown, once, to the initiating admin').toBe(CODE2);
    const text = JSON.stringify(out);
    expect(text).not.toContain(CODE1);
    expect(text).not.toContain(CODE3);
    expect(text.split(CODE2)).toHaveLength(2);
    // each mailer call carried only ITS OWN recipient's code (no recipient ever received another one's code)
    const bodies = new Map(sent.map((s) => [s.to, s.text]));
    expect(bodies.get('first@mail-example.com')).toContain('ABCDE-FGHJK');
    expect(bodies.get('first@mail-example.com')).not.toContain('MNPQR');
    expect(bodies.get('third@mail-example.com')).toContain('XYZ23-45678');
    expect(bodies.get('third@mail-example.com')).not.toContain('MNPQR');
    expect(bodies.get(FAILS)).not.toContain('XYZ23');
  });

  it('NEGATIVE CONTROL — an orchestrator that returned every code, delivered or not, would expose the delivered recipients\' codes (assertion "a delivered recipient\'s code is not returned" goes red; simulated broken variant)', async () => {
    const { result } = await dispatch({ rpc: standard(), mailer: failOne().mailer, recipients: ['first@mail-example.com', FAILS], bind: true });
    const out = asOutcome(result);
    const assertion = (r: Outcome) => expect(r.codes[0].code, 'a delivered recipient\'s code is not returned').toBeUndefined();
    assertion(out);
    const broken = { ...out, codes: out.codes.map((c, i) => ({ ...c, code: i === 0 ? CODE1 : CODE2 })) } as Outcome;
    await expectNamedFailure(() => assertion(broken), 'a delivered recipient\'s code is not returned');
  });

  it('the ledger records ONLY keyed hashes per recipient: no address, no code; one record per recipient with its own status', async () => {
    const ledger = makeLedger();
    const { result } = await dispatch({ rpc: ledger.rpc, mailer: failOne().mailer, recipients: ['good@mail-example.com', FAILS] });
    asOutcome(result);
    const records = ledger.rpc.calls.filter((c) => c.name === 'admin_promo_email_record').map((c) => c.args);
    expect(records.map((r) => r.p_status)).toEqual(['sent', 'failed']);
    for (const r of records) expect(r.p_recipient_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(ledger.rpc.calls.filter((c) => c.name !== 'admin_create_promo_code'))).not.toMatch(/@mail-example|ABCDE|FGHJK/);
  });

  it('RETRYING a partly completed request with the same key is idempotent: no new code, nothing re-sent to anyone, and the response is the per recipient STATUS (no code)', async () => {
    const ledger = makeLedger();
    const recipients = ['good@mail-example.com', FAILS, 'also-good@mail-example.com'];
    const first = await dispatch({ rpc: ledger.rpc, mailer: failOne().mailer, recipients, bind: true });
    asOutcome(first.result);
    const createsBefore = ledger.rpc.calls.filter((c) => c.name === 'admin_create_promo_code').length;
    const retryMailer = makeMailer();
    const retry = await dispatch({ rpc: ledger.rpc, mailer: retryMailer.mailer, recipients, bind: true });
    expect(retry.result).toMatchObject({ ok: false, status: 409, code: 'PROMO_EMAIL_DUPLICATE_REQUEST' });
    expect((retry.result as { recipients?: unknown }).recipients).toEqual([
      { index: 0, status: 'sent' },
      { index: 1, status: 'failed' },
      { index: 2, status: 'sent' },
    ]);
    expect(ledger.rpc.calls.filter((c) => c.name === 'admin_create_promo_code'), 'no second code').toHaveLength(createsBefore);
    expect(retryMailer.sent, 'nothing is sent again, not even to the failed recipient (a resend is an explicit replacement)').toHaveLength(0);
    expect(JSON.stringify(retry.result)).not.toMatch(/ABCDE|MNPQR|XYZ23|[A-Z2-9]{10}/);
  });

  it('BROWSER REFRESH after a partial delivery: the status route reads the ledger (admin supplies the key and the addresses again) and never returns a code', async () => {
    const ledger = makeLedger();
    const recipients = ['good@mail-example.com', FAILS];
    asOutcome((await dispatch({ rpc: ledger.rpc, mailer: failOne().mailer, recipients, bind: true })).result);
    vi.resetModules();
    vi.doMock('@/lib/supabase/server', () => ({
      createClient: async () => ({
        auth: { getUser: async () => ({ data: { user: { id: ADMIN_ID } } }) },
        from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { can_manage_promo_codes: true }, error: null }) }) }) }),
        rpc: ledger.rpc.rpc,
      }),
    }));
    const { POST } = await import('@/app/api/admin/promo-codes/email-requests/status/route');
    const res = await POST(new Request('http://x', { method: 'POST', body: JSON.stringify({ requestKey: 'request-key-0001', emailTo: recipients.join(', ') }) }));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text).data).toEqual({ requestExists: true, recipients: [{ index: 0, status: 'sent' }, { index: 1, status: 'failed' }] });
    expect(text).not.toMatch(/ABCDE|MNPQR|[A-Z2-9]{10}/);
    // a different key (or someone else\'s request) reports "unknown", never "sent"
    const other = await POST(new Request('http://x', { method: 'POST', body: JSON.stringify({ requestKey: 'some-other-key-1', emailTo: recipients[0] }) }));
    expect((await other.json()).data).toEqual({ requestExists: false, recipients: [{ index: 0, status: 'unknown' }] });
  });

  it('a LOST RESPONSE: the ledger still tells which recipients were reached, and a recipient with no row is "unknown", never assumed delivered', async () => {
    const ledger = makeLedger();
    const recipients = ['good@mail-example.com', FAILS];
    asOutcome((await dispatch({ rpc: ledger.rpc, mailer: failOne().mailer, recipients })).result); // the response is thrown away
    const { getEmailRequestStatus } = await import('@/lib/services/promoCodeEmail');
    const status = await getEmailRequestStatus(ledger.rpc.supabase, 'request-key-0001', [...recipients, 'never-attempted@mail-example.com'], SECRET_ENV);
    expect(status).toMatchObject({ ok: true, requestExists: true });
    expect(status.ok && status.recipients.map((r) => r.status)).toEqual(['sent', 'failed', 'unknown']);
  });

  it('a lost response is recovered only by an EXPLICIT replacement: a NEW code (different digest), sent only to the recipients supplied, the old code untouched and the replacement limit applied by the database', async () => {
    const ledger = makeLedger();
    const random = sequentialRandom(); // one random source across both requests, as in production (each code is fresh)
    asOutcome((await dispatch({ rpc: ledger.rpc, mailer: failOne().mailer, recipients: ['good@mail-example.com', FAILS], random })).result);
    const second = makeMailer();
    const { result } = await dispatch({ rpc: ledger.rpc, mailer: second.mailer, recipients: [FAILS], requestKey: 'request-key-0002', kind: 'replace', replaces: OLD_ID, random });
    const out = asOutcome(result);
    expect(second.sent.map((s) => s.to)).toEqual([FAILS]);
    const creates = ledger.rpc.calls.filter((c) => c.name === 'admin_create_promo_code');
    expect(creates).toHaveLength(2);
    expect(creates[1].args.p_code_digest, 'a replacement is a NEW code').not.toBe(creates[0].args.p_code_digest);
    const begin = ledger.rpc.calls.filter((c) => c.name === 'admin_promo_email_begin')[1];
    expect(begin.args).toMatchObject({ p_kind: 'replace', p_replaces: OLD_ID, p_purpose: PURPOSE });
    expect(out.codes[0].code, 'delivered, so not returned').toBeUndefined();
    expect(ledger.rpc.calls.some((c) => c.name === 'admin_disable_promo_code')).toBe(false);
  });

  it('the first request and a request with another key are independent: a second admin action never reuses or reveals the first request\'s code', async () => {
    const ledger = makeLedger();
    const a = asOutcome((await dispatch({ rpc: ledger.rpc, mailer: failOne().mailer, recipients: [FAILS], requestKey: 'request-key-0001' })).result);
    const b = asOutcome((await dispatch({ rpc: ledger.rpc, mailer: failOne().mailer, recipients: [FAILS], requestKey: 'request-key-0002' })).result);
    expect(a.codes[0].code).toBe(CODE1);
    expect(b.codes[0].code).toBe(CODE1); // sequentialRandom restarts per dispatch call in this test harness: same text, distinct requests
    expect(ledger.requests.size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
describe('idempotency, limits and the provider circuit breaker', () => {
  async function assertDuplicateCreatesNothing(beginReply: RpcResult): Promise<void> {
    const rpc = makeRpc({ admin_promo_email_begin: () => beginReply, admin_create_promo_code: okCreate, admin_promo_email_record: () => ({ data: true }) });
    const { mailer, sent } = makeMailer();
    const { result } = await dispatch({ rpc, mailer });
    expect(result, 'a repeated request key must create no second code').toMatchObject({ ok: false, status: 409, code: 'PROMO_EMAIL_DUPLICATE_REQUEST' });
    expect(rpc.calls.filter((c) => c.name === 'admin_create_promo_code'), 'a repeated request key must create no second code').toHaveLength(0);
    expect(sent, 'a repeated request must send nothing').toHaveLength(0);
  }
  it('a duplicate request key (double-click / retry) creates no code and sends nothing, with a clear message', async () => {
    await assertDuplicateCreatesNothing({ data: { new: false } });
    const { result } = await dispatch({ rpc: makeRpc({ admin_promo_email_begin: () => ({ data: { new: false } }) }), mailer: makeMailer().mailer });
    expect(result).toMatchObject({ message: expect.stringContaining('Generate a replacement code and email it') });
  });
  it('NEGATIVE CONTROL — if the database wrongly says every key is new, a double-click creates a second code and sends a second e-mail (assertion "a repeated request key must create no second code" goes red)', async () => {
    await expect(assertDuplicateCreatesNothing({ data: { new: true } })).rejects.toThrow(/a repeated request key must create no second code/);
  });

  it('the hourly rate limit and every daily or replacement limit are surfaced as 429 and nothing is created or sent', async () => {
    const hourly = makeRpc({ admin_promo_email_begin: () => ({ error: { code: 'P0001', message: 'PROMO_EMAIL_RATE_LIMITED' } }), admin_create_promo_code: okCreate });
    const m1 = makeMailer();
    expect((await dispatch({ rpc: hourly, mailer: m1.mailer })).result).toMatchObject({ ok: false, status: 429, code: 'PROMO_EMAIL_RATE_LIMITED' });
    for (const refusal of ['PROMO_EMAIL_DAILY_LIMIT', 'PROMO_EMAIL_GLOBAL_LIMIT', 'PROMO_EMAIL_REPLACEMENT_LIMIT']) {
      const rpc = makeRpc({ admin_promo_email_begin: () => ({ data: { new: false, refused: refusal } }), admin_create_promo_code: okCreate });
      const m = makeMailer();
      expect((await dispatch({ rpc, mailer: m.mailer })).result, refusal).toMatchObject({ ok: false, status: 429, code: refusal });
      expect(rpc.calls.filter((c) => c.name === 'admin_create_promo_code')).toHaveLength(0);
      expect(m.sent).toHaveLength(0);
    }
    expect(hourly.calls.filter((c) => c.name === 'admin_create_promo_code')).toHaveLength(0);
  });

  it('the begin call carries the initiating purpose, the kind, the recipient COUNT and the bound flag, and no address', async () => {
    const rpc = standard();
    await dispatch({ rpc, mailer: makeMailer().mailer, recipients: ['a@mail-example.com', 'b@mail-example.com'], bind: true });
    expect(rpc.calls.find((c) => c.name === 'admin_promo_email_begin')?.args).toEqual({
      p_request_key: 'request-key-0001',
      p_recipient_count: 2,
      p_bound: true,
      p_kind: 'create',
      p_purpose: PURPOSE,
      p_replaces: null,
    });
  });

  function fakeBreaker(threshold = 5, startOpen = false) {
    let failures = 0;
    let open = startOpen;
    const reports: boolean[] = [];
    return {
      reports,
      breaker: {
        status: async () => ({ open }),
        report: async (ok: boolean) => {
          reports.push(ok);
          failures = ok ? 0 : failures + 1;
          if (ok) open = false;
          else if (failures >= threshold) open = true;
          return { open };
        },
      },
    };
  }

  it('a breaker that is already OPEN sends nothing: the code is created and shown once with the pause message', async () => {
    const b = fakeBreaker(5, true);
    const { mailer, sent } = makeMailer();
    const { result } = await dispatch({ rpc: standard(), mailer, breaker: b.breaker });
    const out = asOutcome(result);
    expect(sent).toHaveLength(0);
    expect(out.email.message).toMatch(/paused for a few minutes/);
    expect(out.codes[0].code).toBe(CODE1);
  });

  it('repeated PROVIDER failures open the breaker: after 5 failing recipients the rest are not attempted, their codes are shown once, and the ledger says circuit_open', async () => {
    const b = fakeBreaker(5);
    const rpc = standard();
    const recipients = Array.from({ length: 8 }, (_, i) => `u${i}@mail-example.com`);
    const { mailer, sent } = makeMailer(() => ({ ok: false, error: 'resend_http_503' }));
    const { result } = await dispatch({ rpc, mailer, recipients, bind: true, breaker: b.breaker });
    const out = asOutcome(result);
    expect(sent, 'five recipients x three attempts, then nothing').toHaveLength(15);
    expect(out.codes.map((c) => c.recipients[0].status)).toEqual(['failed', 'failed', 'failed', 'failed', 'failed', 'not_sent', 'not_sent', 'not_sent']);
    expect(out.codes.every((c) => typeof c.code === 'string'), 'every undelivered code is shown once to the admin').toBe(true);
    const errors = rpc.calls.filter((c) => c.name === 'admin_promo_email_record').map((c) => c.args.p_error);
    expect(errors.slice(5)).toEqual(['circuit_open', 'circuit_open', 'circuit_open']);
    expect(out.email.message).toMatch(/paused/);
  });

  it('a refusal of ONE address (a 422) is not a provider failure and never opens the breaker; a success resets it', async () => {
    const b = fakeBreaker(2);
    const { mailer } = makeMailer(() => ({ ok: false, error: 'resend_http_422' }));
    await dispatch({ rpc: standard(), mailer, recipients: ['a@mail-example.com', 'b@mail-example.com', 'c@mail-example.com'], bind: true, breaker: b.breaker });
    expect(b.reports, 'every 422 reports "not a provider failure"').toEqual([true, true, true]);
    const { isProviderFailure } = await import('@/lib/services/promoEmailAbuse');
    for (const e of ['resend_network_error', 'mailer_threw', 'resend_http_500', 'resend_http_503', 'resend_http_429', 'resend_http_401', 'resend_http_403', 'weird']) expect(isProviderFailure(e), e).toBe(true);
    for (const e of ['resend_http_400', 'resend_http_422', 'resend_http_404']) expect(isProviderFailure(e), e).toBe(false);
  });

  it('the request key is also passed to the mailer as an idempotency key per code and recipient', async () => {
    const rpc = standard();
    const { mailer, sent } = makeMailer();
    await dispatch({ rpc, mailer, recipients: ['a@mail-example.com', 'b@mail-example.com'], requestKey: 'request-key-ABCD' });
    expect(sent[0].idempotencyKey).toMatch(/^promo-code-request-key-ABCD-00000000-0000-0000-0000-000000000001-[0-9a-f]{16}$/);
    expect(sent[0].idempotencyKey).not.toBe(sent[1].idempotencyKey);
  });
});

// ---------------------------------------------------------------------------
describe('"Only this email address can redeem"', () => {
  it('one single-use code PER recipient, each bound to that address\'s KEYED hash (never the address); the call carries only hashes', async () => {
    const { keyedAddressHash } = await import('@/lib/services/promoCodeEmail');
    const rpc = standard();
    const { mailer, sent } = makeMailer();
    const addrs = ['a@mail-example.com', 'b@mail-example.com', 'c@mail-example.com'];
    const { result } = await dispatch({ rpc, mailer, recipients: addrs, bind: true });
    const out = asOutcome(result);
    const creates = rpc.calls.filter((c) => c.name === 'admin_create_promo_code');
    expect(creates).toHaveLength(3);
    expect(creates.map((c) => c.args.p_bound_email_hash)).toEqual(addrs.map((a) => keyedAddressHash('bind', a, SECRET_ENV)));
    for (const c of creates) {
      expect(c.args).toMatchObject({ p_max_redemptions: 1, p_unlimited: false, p_recipient_count: 1 });
      expect(String(c.args.p_bound_email_hash)).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(c.args)).not.toMatch(/@mail-example\.com/);
    }
    expect(sent.map((s) => s.to)).toEqual(addrs);
    expect(sent.every((s) => s.text.includes('works only for the FHIP account registered with this e-mail address'))).toBe(true);
    expect(out.codes.map((c) => c.bound)).toEqual([true, true, true]);
  });

  it('the hash is keyed, case/whitespace-normalised, domain-separated (bind vs send), and has NO fallback to another secret', async () => {
    const { keyedAddressHash } = await import('@/lib/services/promoCodeEmail');
    const a = keyedAddressHash('bind', 'Person@Mail-Example.com ', SECRET_ENV);
    expect(a).toBe(keyedAddressHash('bind', 'person@mail-example.com', SECRET_ENV));
    expect(a).not.toBe(keyedAddressHash('bind', 'person@mail-example.com', { ...SECRET_ENV, PREMIUM_PROMO_EMAIL_BIND_SECRET: 'a-different-secret-bbbbbbbbbbbbbbbbbbbbbbbb' }));
    expect(a).not.toBe(keyedAddressHash('send', 'person@mail-example.com', SECRET_ENV));
    expect(a).not.toContain('person');
    expect(keyedAddressHash('bind', 'x@y.com', {})).toBeNull();
    expect(keyedAddressHash('bind', 'x@y.com', { CRON_SECRET: SECRET_ENV.CRON_SECRET }), 'CRON_SECRET is no longer a fallback').toBeNull();
    expect(keyedAddressHash('bind', 'x@y.com', { PROMO_IP_HASH_SECRET: SECRET_ENV.PROMO_IP_HASH_SECRET }), 'the IP secret is no longer a fallback').toBeNull();
    // Gmail style variants are different addresses (no rewriting)
    expect(keyedAddressHash('bind', 'first.last@gmail.com', SECRET_ENV)).not.toBe(keyedAddressHash('bind', 'firstlast@gmail.com', SECRET_ENV));
    expect(keyedAddressHash('bind', 'first+tag@gmail.com', SECRET_ENV)).not.toBe(keyedAddressHash('bind', 'first@gmail.com', SECRET_ENV));
  });

  it('refused before anything is created: unlimited with binding; a custom code with several bound recipients', async () => {
    for (const [opts, status, code] of [
      [{ settings: { unlimited: true, maxRedemptions: null } }, 422, 'PROMO_MAX_INVALID'],
      [{ settings: { code: 'SUMMER2K26PASS' }, recipients: ['a@mail-example.com', 'b@mail-example.com'] }, 422, 'PROMO_CODE_INVALID'],
    ] as const) {
      const rpc = standard();
      const { result } = await dispatch({ rpc, mailer: makeMailer().mailer, bind: true, ...opts } as never);
      expect(result, code).toMatchObject({ ok: false, status, code });
      expect(rpc.calls, 'nothing is created or recorded').toHaveLength(0);
    }
  });

  it('binding with the migration absent refuses (503) and creates NOTHING — it never silently creates an unbound code', async () => {
    const rpc = makeRpc({ admin_promo_email_begin: () => ({ error: { code: 'PGRST202', message: 'Could not find the function' } }), admin_create_promo_code: okCreate });
    const { result } = await dispatch({ rpc, mailer: makeMailer().mailer, bind: true });
    expect(result).toMatchObject({ ok: false, status: 503, code: 'FEATURE_UNAVAILABLE' });
    expect(rpc.calls.filter((c) => c.name === 'admin_create_promo_code')).toHaveLength(0);
  });

  it('a later group failing does not lose the codes already created (partialError + earlier codes returned)', async () => {
    let n = 0;
    const rpc = makeRpc({
      admin_promo_email_begin: () => ({ data: { new: true } }),
      admin_create_promo_code: (args) => (++n === 2 ? { error: { code: 'XX000', message: 'boom' } } : okCreate(args, n)),
      admin_promo_email_record: () => ({ data: true }),
    });
    const { result } = await dispatch({ rpc, mailer: makeMailer().mailer, recipients: ['a@mail-example.com', 'b@mail-example.com'], bind: true });
    const out = asOutcome(result);
    expect(out.codes).toHaveLength(1);
    expect(out.partialError).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
describe('fail soft if the e-mail migration is absent', () => {
  it('unbound: the code is still created (hash only), nothing is sent, the admin sees a clear message and the code once', async () => {
    const rpc = makeRpc({ admin_promo_email_begin: () => ({ error: { code: '42883', message: 'function public.admin_promo_email_begin does not exist' } }), admin_create_promo_code: okCreate });
    const { mailer, sent } = makeMailer();
    const { result } = await dispatch({ rpc, mailer });
    const out = asOutcome(result);
    expect(sent).toHaveLength(0);
    expect(out.email.message).toBe('Email sending is not available on this database yet. Copy the code and send it yourself.');
    expect(out.codes[0].code).toBe(CODE1);
  });

  it('a replacement refuses (503) when the migration is absent, because it cannot be limited or recorded', async () => {
    const rpc = makeRpc({ admin_promo_email_begin: () => ({ error: { code: 'PGRST202', message: 'Could not find the function' } }), admin_create_promo_code: okCreate });
    const { result } = await dispatch({ rpc, mailer: makeMailer().mailer, kind: 'replace', replaces: OLD_ID });
    expect(result).toMatchObject({ ok: false, status: 503 });
    expect(rpc.calls.filter((c) => c.name === 'admin_create_promo_code')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe('the code never reaches a log, an audit-bound argument or an error', () => {
  it('across a successful run, a failing run and a refused run: no console output contains the code or any address; the ledger arguments carry no address and no code', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => {}));
    const runs: [ReturnType<typeof standard>, Mailer][] = [
      [standard(), makeMailer().mailer],
      [standard(), makeMailer([{ ok: false, error: 'resend_http_500' }]).mailer],
    ];
    for (const [rpc, mailer] of runs) {
      await dispatch({ rpc, mailer, recipients: ['secret.person@mail-example.com'] });
      for (const c of rpc.calls.filter((x) => x.name === 'admin_promo_email_record' || x.name === 'admin_promo_email_begin')) {
        expect(JSON.stringify(c.args), `${c.name} must not carry the code or an address`).not.toMatch(/ABCDEFGHJK|secret\.person|@mail-example\.com/);
      }
    }
    await dispatch({ rpc: makeRpc({ admin_promo_email_begin: () => ({ data: { new: false } }) }), mailer: makeMailer().mailer, recipients: ['secret.person@mail-example.com'] });
    const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls));
    expect(logged, 'the code value must never appear in logs').not.toMatch(/ABCDEFGHJK/);
    expect(logged, 'an address must never appear in logs').not.toMatch(/secret\.person/);
  });

  it('NEGATIVE CONTROL — a version that logged the code on failure would be caught by the same check (assertion "the code value must never appear in logs" goes red)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    console.error('mail failed for code', 'ABCDEFGHJK'); // the broken behaviour
    expect(() => expect(JSON.stringify(errSpy.mock.calls), 'the code value must never appear in logs').not.toMatch(/ABCDEFGHJK/)).toThrow(/the code value must never appear in logs/);
  });
});

// ---------------------------------------------------------------------------
describe('routes: capability, create + e-mail, replacement, redeem hash', () => {
  function fakeSession(opts: { adminRow?: Record<string, unknown> | null; user?: { id: string } | null; rpc: ReturnType<typeof makeRpc> }) {
    return {
      auth: { getUser: async () => ({ data: { user: opts.user === undefined ? { id: ADMIN_ID } : opts.user } }) },
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: opts.adminRow ?? null, error: null }) }) }) }),
      rpc: opts.rpc.rpc,
    };
  }
  async function loadRoute(module: string, rpc: ReturnType<typeof makeRpc>, mailer: Mailer, adminRow: Record<string, unknown> | null = { can_manage_promo_codes: true }, user?: { id: string } | null) {
    vi.resetModules();
    const session = fakeSession({ adminRow, rpc, user });
    vi.doMock('@/lib/supabase/server', () => ({ createClient: async () => session }));
    vi.doMock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ rpc: async () => ({ data: { open: false }, error: null }) }) }));
    vi.doMock('@/lib/services/premiumReminderMailer', () => ({ createResendMailer: () => mailer }));
    return (await import(module)) as Record<string, (r: Request, c?: { params: Promise<{ id: string }> }) => Promise<Response>>;
  }
  const post = (body: unknown) => new Request('http://x', { method: 'POST', body: JSON.stringify(body) });
  const inDays = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  const base = { durationDays: 30, maxRedemptions: 5, expiresOn: inDays(90), emailTo: 'to@mail-example.com', idempotencyKey: 'request-key-0001', purpose: PURPOSE };

  it('create + e-mail: non-capability admins get 403 (and an entitlement-only admin too), unauthenticated 401; nothing is called', async () => {
    for (const [row, user, status] of [
      [null, undefined, 403],
      [{ can_manage_promo_codes: false, can_manage_premium_entitlements: true }, undefined, 403],
      [{ can_manage_promo_codes: true }, null, 401],
    ] as const) {
      const rpc = standard();
      const { mailer, sent } = makeMailer();
      const h = await loadRoute('@/app/api/admin/promo-codes/route', rpc, mailer, row as never, user as never);
      const res = await h.POST(post(base));
      expect(res.status).toBe(status);
      expect(rpc.calls).toHaveLength(0);
      expect(sent).toHaveLength(0);
    }
  });

  it('create + e-mail with the flag ON: e-mails once, the JSON response has NO plaintext code; flag OFF: the response has the code once and the exact admin message', async () => {
    process.env.PREMIUM_PROMO_EMAIL_ENABLED = 'true';
    let rpc = standard();
    let mailer = makeMailer();
    let h = await loadRoute('@/app/api/admin/promo-codes/route', rpc, mailer.mailer);
    let res = await h.POST(post(base));
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(mailer.sent).toHaveLength(1);
    const sentCode = /Your code: ([A-Z2-9-]{11})/.exec(mailer.sent[0].text)?.[1]?.replace('-', '') ?? '';
    expect(sentCode).toMatch(ANY_GENERATED);
    expect(text, 'the response does not carry the code that was e-mailed').not.toContain(sentCode);
    expect(JSON.parse(text).data.codes[0].recipients).toEqual([{ index: 0, status: 'sent' }]);

    process.env.PREMIUM_PROMO_EMAIL_ENABLED = 'false';
    rpc = standard();
    mailer = makeMailer();
    h = await loadRoute('@/app/api/admin/promo-codes/route', rpc, mailer.mailer);
    res = await h.POST(post({ ...base, idempotencyKey: 'request-key-0002' }));
    const body = (await res.json()).data;
    expect(mailer.sent).toHaveLength(0);
    expect(body.email.message).toBe('Email sending is switched off. Copy the code and send it yourself.');
    expect(body.codes[0].code).toMatch(ANY_GENERATED);
  });

  it('a duplicate request over HTTP returns 409 with the per recipient status and no code', async () => {
    process.env.PREMIUM_PROMO_EMAIL_ENABLED = 'true';
    const ledger = makeLedger();
    const h = await loadRoute('@/app/api/admin/promo-codes/route', ledger.rpc, makeMailer().mailer);
    expect((await h.POST(post(base))).status).toBe(200);
    const again = await h.POST(post(base));
    expect(again.status).toBe(409);
    const json = await again.json();
    expect(json.error).toBe('PROMO_EMAIL_DUPLICATE_REQUEST');
    expect(json.recipients).toEqual([{ index: 0, status: 'sent' }]);
    expect(JSON.stringify(json)).not.toMatch(/[A-Z2-9]{10}/);
  });

  it('without emailTo the create route returns the generated code once and creates through the digest path only', async () => {
    const rpc = makeRpc({ admin_create_promo_code: okCreate });
    const h = await loadRoute('@/app/api/admin/promo-codes/route', rpc, makeMailer().mailer);
    const res = await h.POST(post({ durationDays: 30, maxRedemptions: 5, expiresOn: inDays(90) }));
    const data = (await res.json()).data;
    expect(data.code).toMatch(/^[A-HJ-KM-NP-Z2-9]{10}$/);
    expect(rpc.calls.map((c) => c.name)).toEqual(['admin_create_promo_code']);
    expect(JSON.stringify(rpc.calls[0].args)).not.toContain(data.code);
  });

  it('a bad recipient list, a missing request key or a missing purpose is refused (422) before anything happens', async () => {
    const rpc = standard();
    const h = await loadRoute('@/app/api/admin/promo-codes/route', rpc, makeMailer().mailer);
    expect((await h.POST(post({ ...base, emailTo: 'not-an-address' }))).status).toBe(422);
    expect((await h.POST(post({ ...base, idempotencyKey: undefined }))).status).toBe(422);
    expect((await h.POST(post({ ...base, purpose: undefined }))).status).toBe(422);
    expect((await h.POST(post({ ...base, emailTo: Array.from({ length: 21 }, (_, i) => `u${i}@mail-example.com`) }))).status).toBe(422);
    expect(rpc.calls).toHaveLength(0);
  });

  describe('replacement route', () => {
    const listed = (over: Record<string, unknown> = {}) => [{ id: OLD_ID, duration_days: 45, max_redemptions: 7, expires_on: '2099-02-02', note: 'old note', status: 'active', state: 'active', code_hint: 'AB******CD', ...over }];
    const replaceRpc = (rows: unknown[]) =>
      makeRpc({
        admin_list_promo_codes_v2: () => ({ data: rows }),
        admin_promo_email_begin: () => ({ data: { new: true } }),
        admin_create_promo_code: okCreate,
        admin_promo_email_record: () => ({ data: true }),
      });
    const ctx = { params: Promise.resolve({ id: OLD_ID }) };
    const reqBody = { emailTo: 'a@mail-example.com', idempotencyKey: 'request-key-0001', purpose: PURPOSE };

    it('capability-gated (403 for non-capability admins); 404 for an unknown id; 409 for a code that is not active', async () => {
      const denied = replaceRpc(listed());
      const h1 = await loadRoute('@/app/api/admin/promo-codes/[id]/replace-and-email/route', denied, makeMailer().mailer, { can_manage_promo_codes: false });
      expect((await h1.POST(post(reqBody), ctx)).status).toBe(403);
      expect(denied.calls).toHaveLength(0);
      const h2 = await loadRoute('@/app/api/admin/promo-codes/[id]/replace-and-email/route', replaceRpc([]), makeMailer().mailer);
      expect((await h2.POST(post(reqBody), ctx)).status).toBe(404);
      const h3 = await loadRoute('@/app/api/admin/promo-codes/[id]/replace-and-email/route', replaceRpc(listed({ state: 'expired' })), makeMailer().mailer);
      const r3 = await h3.POST(post(reqBody), ctx);
      expect(r3.status).toBe(409);
      expect((await r3.json()).error).toBe('PROMO_CODE_NOT_ACTIVE');
    });

    it('creates a NEW generated code with the old code\'s settings, e-mails only the new one, records kind replace and the replaced id; the old code is neither returned nor retrievable', async () => {
      process.env.PREMIUM_PROMO_EMAIL_ENABLED = 'true';
      const rpc = replaceRpc(listed());
      const { mailer, sent } = makeMailer();
      const h = await loadRoute('@/app/api/admin/promo-codes/[id]/replace-and-email/route', rpc, mailer);
      const res = await h.POST(post(reqBody), ctx);
      expect(res.status).toBe(200);
      const create = rpc.calls.find((c) => c.name === 'admin_create_promo_code');
      expect(create?.args).toMatchObject({ p_duration_days: 45, p_max_redemptions: 7, p_unlimited: false, p_expires_on: '2099-02-02', p_no_expiry: false, p_note: 'old note' });
      expect(String(create?.args.p_code_digest)).toMatch(/^[0-9a-f]{64}$/);
      expect(rpc.calls.find((c) => c.name === 'admin_promo_email_begin')?.args).toMatchObject({ p_kind: 'replace', p_replaces: OLD_ID, p_purpose: PURPOSE });
      expect(sent).toHaveLength(1);
      expect(sent[0].text).toContain('45 days');
      expect(JSON.stringify(await res.json())).not.toMatch(/[A-Z2-9]{10}/);
      expect(rpc.calls.some((c) => c.name === 'admin_disable_promo_code')).toBe(false); // the old code is left alone
    });

    it('replacing an unlimited / no-expiry code keeps those settings; with binding ON the replacement becomes single-use for that address', async () => {
      process.env.PREMIUM_PROMO_EMAIL_ENABLED = 'true';
      const rpc = replaceRpc(listed({ max_redemptions: null, expires_on: null }));
      const h = await loadRoute('@/app/api/admin/promo-codes/[id]/replace-and-email/route', rpc, makeMailer().mailer);
      await h.POST(post(reqBody), ctx);
      expect(rpc.calls.find((c) => c.name === 'admin_create_promo_code')?.args).toMatchObject({ p_unlimited: true, p_max_redemptions: null, p_no_expiry: true, p_expires_on: null });
      const rpc2 = replaceRpc(listed({ max_redemptions: null, expires_on: null }));
      const h2 = await loadRoute('@/app/api/admin/promo-codes/[id]/replace-and-email/route', rpc2, makeMailer().mailer);
      const res = await h2.POST(post({ ...reqBody, bindToRecipient: true, idempotencyKey: 'request-key-0002' }), ctx);
      expect(res.status).toBe(200);
      expect(rpc2.calls.find((c) => c.name === 'admin_create_promo_code')?.args).toMatchObject({ p_unlimited: false, p_max_redemptions: 1 });
    });

    it('a missing recipient list is refused (422)', async () => {
      const h = await loadRoute('@/app/api/admin/promo-codes/[id]/replace-and-email/route', replaceRpc(listed()), makeMailer().mailer);
      expect((await h.POST(post({}), ctx)).status).toBe(422);
    });
  });

  describe('user redemption: only the VERIFIED session address, hashed with the bind secret', () => {
    async function redeem(
      rpcImpl: (name: string, args: Record<string, unknown>) => RpcResult,
      user: { id: string; email?: string | null; email_confirmed_at?: string | null },
      env: Record<string, string | undefined> = {},
      body: unknown = { code: 'SOMECODEKX22' }
    ) {
      vi.resetModules();
      for (const [k, v] of Object.entries({ ...TEST_ENV, ...env })) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      const calls: { name: string; args: Record<string, unknown> }[] = [];
      vi.doMock('@/lib/supabase/admin', () => ({
        createAdminClient: () => ({
          rpc: async (name: string, args: Record<string, unknown>) => {
            calls.push({ name, args });
            const r = rpcImpl(name, args);
            return { data: r.data ?? null, error: r.error ?? null };
          },
        }),
      }));
      vi.doMock('@/lib/api', async () => {
        const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
        return { ...actual, requireCountryConfirmedUser: async () => ({ user, unauthenticated: null }) };
      });
      const { POST } = await import('@/app/api/payments/promo/redeem/route');
      const res = await POST(post(body));
      return { res, calls };
    }
    const VERIFIED = '2026-01-01T00:00:00Z';

    it('p_email_hash = keyed hash of the normalised VERIFIED session address (never the address); another account\'s hash differs', async () => {
      const { keyedAddressHash } = await import('@/lib/services/promoCodeEmail');
      const { calls } = await redeem(() => ({ data: { ok: true, ends_on: '2026-11-02' } }), { id: 'u1', email: 'Owner@Mail-Example.com', email_confirmed_at: VERIFIED });
      expect(calls[0].args.p_email_hash).toBe(keyedAddressHash('bind', 'owner@mail-example.com', TEST_ENV));
      expect(JSON.stringify(calls[0].args)).not.toMatch(/mail-example\.com/i);
      const other = await redeem(() => ({ data: { ok: false, code: 'PROMO_CODE_UNUSABLE' } }), { id: 'u2', email: 'stranger@mail-example.com', email_confirmed_at: VERIFIED });
      expect(other.calls[0].args.p_email_hash).not.toBe(calls[0].args.p_email_hash);
      expect((await other.res.json()).message).toBe('This code cannot be used.');
    });

    it('an UNVERIFIED address, no address, or an address the browser claims in the body: the hash is null (bound codes then read as "cannot be used")', async () => {
      const unverified = await redeem(() => ({ data: { ok: false, code: 'PROMO_CODE_UNUSABLE' } }), { id: 'u1', email: 'a@mail-example.com', email_confirmed_at: null });
      expect(unverified.calls[0].args.p_email_hash).toBeNull();
      const none = await redeem(() => ({ data: { ok: false, code: 'PROMO_CODE_UNUSABLE' } }), { id: 'u1', email: null, email_confirmed_at: VERIFIED });
      expect(none.calls[0].args.p_email_hash).toBeNull();
      const claimed = await redeem(() => ({ data: { ok: false, code: 'PROMO_CODE_UNUSABLE' } }), { id: 'u1', email: null, email_confirmed_at: VERIFIED }, {}, { code: 'SOMECODEKX22', email: 'victim@mail-example.com', emailHash: 'f'.repeat(64) });
      expect(claimed.calls[0].args.p_email_hash, 'a browser supplied address or hash is never read').toBeNull();
      expect(JSON.stringify(claimed.calls[0].args)).not.toContain('victim');
    });

    it('EMAIL CHANGE between issue and redemption: the same account with a new address has a different hash, so the bound code stays unusable; no silent rebind', async () => {
      const { keyedAddressHash } = await import('@/lib/services/promoCodeEmail');
      const issuedFor = keyedAddressHash('bind', 'before@mail-example.com', TEST_ENV);
      const now = await redeem(() => ({ data: { ok: false, code: 'PROMO_CODE_UNUSABLE' } }), { id: 'u1', email: 'after@mail-example.com', email_confirmed_at: VERIFIED });
      expect(now.calls[0].args.p_email_hash).not.toBe(issuedFor);
      expect(now.calls[0].args.p_email_hash).toBe(keyedAddressHash('bind', 'after@mail-example.com', TEST_ENV));
    });

    it('a missing function (migration not applied) is "unavailable" (503) and there is NO legacy fallback call that could redeem by plain code', async () => {
      const { res, calls } = await redeem(() => ({ error: { code: 'PGRST202', message: 'no function with that signature' } }), { id: 'u1', email: 'a@mail-example.com', email_confirmed_at: VERIFIED });
      expect(res.status).toBe(503);
      expect(calls).toHaveLength(1);
    });

    it('each missing dedicated secret refuses the redemption explicitly (503) before the database is called, and nothing is granted', async () => {
      for (const name of ['PROMO_CODE_DIGEST_SECRET', 'PROMO_IP_HASH_SECRET', 'PREMIUM_PROMO_EMAIL_BIND_SECRET']) {
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const { res, calls } = await redeem(() => ({ data: { ok: true, ends_on: '2026-11-02' } }), { id: 'u1', email: 'a@mail-example.com', email_confirmed_at: VERIFIED }, { [name]: undefined });
        expect(res.status, name).toBe(503);
        expect((await res.json()).error).toBe('PROMO_UNAVAILABLE');
        expect(calls, `${name}: the database is never called`).toHaveLength(0);
        expect(JSON.stringify(spy.mock.calls), 'the log names the variable').toContain(name);
        for (const v of Object.values(TEST_ENV)) expect(JSON.stringify(spy.mock.calls)).not.toContain(v);
        spy.mockRestore();
      }
    });

    it('NEGATIVE CONTROL — the OLD fallback chain would have let a missing bind secret be silently replaced (assertion "a missing secret refuses the redemption" goes red; simulated broken variant)', async () => {
      const refuses = (res: number) => expect(res, 'a missing secret refuses the redemption').toBe(503);
      const { res } = await redeem(() => ({ data: { ok: true } }), { id: 'u1', email: 'a@mail-example.com', email_confirmed_at: VERIFIED }, { PREMIUM_PROMO_EMAIL_BIND_SECRET: undefined });
      refuses(res.status);
      await expectNamedFailure(() => refuses(200), 'a missing secret refuses the redemption');
    });
  });
});
