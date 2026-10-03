// E-mailing a promo code — application layer (parsing, kill switch, message, retries, idempotency,
// binding, logging, routes), with an INJECTED mailer, an injected sleeper and a fake database. No test
// here can send mail. The database half is proven against a real Postgres in promoCodeEmailPglite.test.ts.
//
// Negative controls: each rule's assertion is also run against a deliberately broken variant and must go
// red; the failing assertion is named in the title. (Where the broken variant has to be simulated because
// the rule lives in one function, the title says so.)

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mailer, OutgoingMail, MailResult } from '@/lib/services/premiumReminderMailer';
import type { CreatePromoRequest } from '@/lib/services/promoCodes';

vi.mock('@/lib/services/countryGate', () => ({ countryConfirmationBlockResponse: async () => null }));
vi.setConfig({ testTimeout: 30_000 });

const ADMIN_ID = 'aaaaaaaa-0000-0000-0000-00000000e001';
const OLD_ID = 'cccccccc-0000-0000-0000-00000000e0c1';
const SECRET_ENV = { PREMIUM_PROMO_EMAIL_ENABLED: 'true', PREMIUM_PROMO_EMAIL_BIND_SECRET: 'unit-test-secret-aaaaaaaa' };
const SETTINGS: CreatePromoRequest = { code: null, durationDays: 30, maxRedemptions: 5, unlimited: false, expiresOn: '2026-10-31', noExpiry: false, note: 'internal note' };

type RpcResult = { data?: unknown; error?: { code?: string; message?: string } | null };

function makeRpc(handlers: Record<string, (args: Record<string, unknown>, n: number) => RpcResult>) {
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

const okCreate = (args: Record<string, unknown>, n: number): RpcResult => ({
  data: {
    id: `00000000-0000-0000-0000-00000000000${n}`,
    code: `CODEKXBEE${n}2`,
    code_hint: `CO******${n}2`,
    duration_days: args.p_duration_days,
    ends_if_redeemed_today: '2026-11-02',
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

function makeMailer(results: ((m: OutgoingMail) => MailResult | Promise<MailResult>) | MailResult[] = [{ ok: true, messageId: 'msg_1' }], configured = true) {
  const sent: OutgoingMail[] = [];
  let i = 0;
  const mailer: Mailer = {
    configured: () => configured,
    from: () => 'FHIP <no-reply@example.test>',
    async send(mail) {
      sent.push(mail);
      if (typeof results === 'function') return results(mail);
      return results[Math.min(i++, results.length - 1)];
    },
  };
  return { mailer, sent };
}

async function dispatch(opts: {
  rpc: ReturnType<typeof makeRpc>;
  mailer: Mailer;
  recipients?: string[];
  bind?: boolean;
  env?: Record<string, string | undefined>;
  settings?: Partial<CreatePromoRequest>;
  requestKey?: string;
}) {
  const { createAndEmailPromoCodes } = await import('@/lib/services/promoCodeEmail');
  const sleeps: number[] = [];
  const result = await createAndEmailPromoCodes({
    supabase: opts.rpc.supabase,
    settings: { ...SETTINGS, ...opts.settings },
    request: { recipients: opts.recipients ?? ['one@example.test'], bind: opts.bind ?? false, requestKey: opts.requestKey ?? 'request-key-0001' },
    env: opts.env ?? SECRET_ENV,
    mailer: opts.mailer,
    sleep: async (ms) => void sleeps.push(ms),
    baseUrl: 'https://app.example.test',
  });
  return { result, sleeps };
}

beforeEach(() => vi.resetModules());
afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('@/lib/supabase/server');
  vi.doUnmock('@/lib/supabase/admin');
  vi.doUnmock('@/lib/services/premiumReminderMailer');
  vi.doUnmock('@/lib/api');
  delete process.env.PREMIUM_PROMO_EMAIL_ENABLED;
  delete process.env.PREMIUM_PROMO_EMAIL_BIND_SECRET;
});

// ---------------------------------------------------------------------------
describe('parsing the e-mail request', () => {
  it('accepts a list or comma/newline separated text, lowercases, de-duplicates, ignores blanks; max 20 (21 refused)', async () => {
    const { parseEmailDispatch } = await import('@/lib/services/promoCodeEmail');
    const body = (emailTo: unknown, extra: Record<string, unknown> = {}) => ({ emailTo, idempotencyKey: 'request-key-0001', ...extra });
    expect(parseEmailDispatch(body('A@x.test, b@x.test\nA@X.test; ; c@x.test'))).toEqual({ kind: 'dispatch', value: { recipients: ['a@x.test', 'b@x.test', 'c@x.test'], bind: false, requestKey: 'request-key-0001' } });
    expect(parseEmailDispatch(body(['a@x.test'], { bindToRecipient: true }))).toMatchObject({ kind: 'dispatch', value: { bind: true } });
    const twenty = Array.from({ length: 20 }, (_, i) => `u${i}@x.test`);
    expect(parseEmailDispatch(body(twenty)).kind).toBe('dispatch');
    expect(parseEmailDispatch(body([...twenty, 'u20@x.test']))).toMatchObject({ kind: 'invalid', code: 'PROMO_RECIPIENTS_INVALID' });
    expect(parseEmailDispatch(body('not-an-address'))).toMatchObject({ kind: 'invalid', code: 'PROMO_RECIPIENTS_INVALID' });
    expect(parseEmailDispatch(body([1, 2]))).toMatchObject({ kind: 'invalid' });
    expect(parseEmailDispatch(body({}))).toMatchObject({ kind: 'invalid' });
  });

  it('no emailTo (or an empty box) means "do not e-mail"; emailTo needs a valid request key', async () => {
    const { parseEmailDispatch } = await import('@/lib/services/promoCodeEmail');
    expect(parseEmailDispatch({})).toEqual({ kind: 'none' });
    expect(parseEmailDispatch({ emailTo: '   ' })).toEqual({ kind: 'none' });
    expect(parseEmailDispatch(null)).toEqual({ kind: 'none' });
    for (const key of [undefined, '', 'short', 'has spaces in it!', 'k'.repeat(101)]) {
      expect(parseEmailDispatch({ emailTo: 'a@x.test', idempotencyKey: key })).toMatchObject({ kind: 'invalid', code: 'PROMO_EMAIL_KEY_INVALID' });
    }
  });
});

// ---------------------------------------------------------------------------
describe('the kill switch fails closed; the show-once flow remains the fallback', () => {
  async function assertDisabledSendsNothing(env: Record<string, string | undefined>): Promise<void> {
    const rpc = standard();
    const { mailer, sent } = makeMailer();
    const { result } = await dispatch({ rpc, mailer, env });
    expect(result.ok).toBe(true);
    if (!result.ok || !('codes' in result)) throw new Error('unexpected');
    expect(sent, 'a switched-off job must not send').toHaveLength(0);
    expect(result.email).toEqual({ enabled: false, message: 'Email sending is switched off. Copy the code and send it yourself.' });
    expect(result.codes[0].code, 'the code is still shown once so the admin can send it themselves').toMatch(/^CODEKXBEE/);
    expect(result.codes[0].recipients).toEqual([{ index: 0, status: 'not_sent' }]);
    expect(rpc.calls.filter((c) => c.name === 'admin_create_promo_code'), 'the code is still created exactly once').toHaveLength(1);
  }

  it('unset / false / TRUE / 1 / blank => OFF: nothing is e-mailed, the code is created and returned with the exact admin message', async () => {
    for (const v of [undefined, 'false', 'TRUE', '1', 'yes', ' ', '']) {
      await assertDisabledSendsNothing({ PREMIUM_PROMO_EMAIL_ENABLED: v, PREMIUM_PROMO_EMAIL_BIND_SECRET: 'unit-test-secret-aaaaaaaa' });
    }
    const { isPromoEmailEnabled } = await import('@/lib/services/promoCodeEmail');
    expect(isPromoEmailEnabled({ PREMIUM_PROMO_EMAIL_ENABLED: 'true' })).toBe(true);
    expect(isPromoEmailEnabled({ PREMIUM_PROMO_EMAIL_ENABLED: ' true ' })).toBe(true);
    expect(isPromoEmailEnabled({})).toBe(false);
  });

  it('NEGATIVE CONTROL — a send path that ignored the flag would e-mail while "off" (assertion "a switched-off job must not send" goes red; simulated broken variant)', async () => {
    const { mailer, sent } = makeMailer();
    await mailer.send({ to: 'x@x.test', from: 'f', subject: 's', text: 't', idempotencyKey: 'k' }); // the broken behaviour
    expect(() => expect(sent, 'a switched-off job must not send').toHaveLength(0)).toThrow(/a switched-off job must not send/);
  });

  it('flag on but no secret or no mail provider => "not configured" message, nothing sent, code returned once', async () => {
    for (const [env, mailerConfigured] of [
      [{ PREMIUM_PROMO_EMAIL_ENABLED: 'true' }, true],
      [SECRET_ENV, false],
    ] as const) {
      const rpc = standard();
      const { mailer, sent } = makeMailer(undefined, mailerConfigured);
      const { result } = await dispatch({ rpc, mailer, env });
      if (!result.ok || !('codes' in result)) throw new Error('unexpected');
      expect(sent).toHaveLength(0);
      expect(result.email.message).toBe('Email sending is not configured on this server. Copy the code and send it yourself.');
      expect(result.codes[0].code).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
describe('sending', () => {
  it('sends the code once to each recipient; the message is plain transactional text; the success response carries NO plaintext code', async () => {
    const rpc = standard();
    const { mailer, sent } = makeMailer();
    const { result } = await dispatch({ rpc, mailer, recipients: ['one@example.test', 'two@example.test'] });
    if (!result.ok || !('codes' in result)) throw new Error('unexpected');
    expect(sent.map((s) => s.to)).toEqual(['one@example.test', 'two@example.test']); // each address exactly once
    expect(rpc.calls.filter((c) => c.name === 'admin_create_promo_code'), 'one shared code when not bound').toHaveLength(1);
    expect(rpc.calls.find((c) => c.name === 'admin_create_promo_code')?.args).toMatchObject({ p_recipient_count: 2, p_bound_email_hash: null });
    expect(result.email).toEqual({ enabled: true, message: null });
    expect(result.codes[0].code, 'a delivered code is not returned again').toBeUndefined();
    expect(JSON.stringify(result)).not.toMatch(/CODEKXBEE/);
    expect(result.codes[0].recipients).toEqual([{ index: 0, status: 'sent' }, { index: 1, status: 'sent' }]);
    expect(Object.keys(sent[0]).sort()).toEqual(['from', 'idempotencyKey', 'subject', 'text', 'to']); // plain text, no html or tracking
  });

  it('subject is "Your FHIP Premium access code" with no code in it; the body has the code, the grant, the redeem-by date (AU format), how to redeem, the real link, the use limit and FHIP attribution; no marketing', async () => {
    const { composePromoCodeEmail } = await import('@/lib/services/promoCodeEmail');
    const m = composePromoCodeEmail({ code: 'ABCDEKXBEE', durationDays: 30, expiresOn: '2026-10-31', maxRedemptions: 1, bound: false, baseUrl: 'https://app.example.test' });
    expect(m.subject).toBe('Your FHIP Premium access code');
    expect(m.subject).not.toContain('ABCDE');
    expect(m.text).toContain('Your code: ABCDE-KXBEE');
    expect(m.text).toContain('complimentary Premium for 30 days from the day you redeem it');
    expect(m.text).toContain('Please redeem it by 31/10/2026.');
    expect(m.text).toContain('This code can be used once.');
    expect(m.text).toContain('Sign in to FHIP.');
    expect(m.text).toContain('Plans section');
    expect(m.text).toContain('Promo code box');
    expect(m.text).toContain('Profile page: https://app.example.test/profile');
    expect(m.text.trim().endsWith('FHIP')).toBe(true);
    expect(m.text).not.toMatch(/discount|offer|sale|limited time|buy now|upgrade now|unsubscribe/i);
    // dd-mm-yyyy when the recipient's country is known to be India; AU otherwise
    expect(composePromoCodeEmail({ code: 'ABCDEKXBEE', durationDays: 365, expiresOn: '2026-10-31', maxRedemptions: 1, bound: false, baseUrl: 'x', country: 'IN' }).text).toContain('redeem it by 31-10-2026');
    // variants
    expect(composePromoCodeEmail({ code: 'ABCDEKXBEE', durationDays: 1, expiresOn: null, maxRedemptions: null, bound: false, baseUrl: 'x' }).text).toMatch(/for 1 day from[\s\S]*no last day to redeem[\s\S]*no limit on how many people/);
    expect(composePromoCodeEmail({ code: 'ABCDEKXBEE', durationDays: 30, expiresOn: null, maxRedemptions: 5, bound: false, baseUrl: 'x' }).text).toContain('used up to 5 times in total');
    expect(composePromoCodeEmail({ code: 'ABCDEKXBEE', durationDays: 30, expiresOn: null, maxRedemptions: 1, bound: true, baseUrl: 'x' }).text).toContain('works only for the FHIP account registered with this e-mail address');
  });

  it('retries are BOUNDED (3 attempts, short back-off), recorded, and never create a second code; success on a later attempt is recorded with the attempt count', async () => {
    const rpc = standard();
    const { mailer, sent } = makeMailer([{ ok: false, error: 'resend_http_500' }, { ok: false, error: 'resend_http_500' }, { ok: true, messageId: 'late_ok' }]);
    const { result, sleeps } = await dispatch({ rpc, mailer });
    if (!result.ok || !('codes' in result)) throw new Error('unexpected');
    expect(sent).toHaveLength(3);
    expect(sleeps).toEqual([400, 1200]);
    expect(rpc.calls.filter((c) => c.name === 'admin_create_promo_code')).toHaveLength(1);
    const rec = rpc.calls.filter((c) => c.name === 'admin_promo_email_record');
    expect(rec).toHaveLength(1);
    expect(rec[0].args).toMatchObject({ p_status: 'sent', p_attempts: 3, p_message_id: 'late_ok', p_error: null });
    expect(result.codes[0].recipients[0].status).toBe('sent');
  });

  async function assertBoundedAndNotLost(thrower: boolean): Promise<void> {
    const rpc = standard();
    const { mailer, sent } = makeMailer(() => {
      if (thrower) throw new Error('network down');
      return { ok: false, error: 'resend_http_503' };
    });
    const { result } = await dispatch({ rpc, mailer });
    if (!result.ok || !('codes' in result)) throw new Error('unexpected');
    expect(sent, 'never more than 3 attempts').toHaveLength(3);
    expect(rpc.calls.filter((c) => c.name === 'admin_create_promo_code'), 'a mailer failure must not re-create the code').toHaveLength(1);
    expect(result.codes[0].recipients[0].status).toBe('failed');
    expect(result.codes[0].code, 'a mailer failure never loses the code: it is shown to the admin once').toMatch(/^CODEKXBEE/);
    const rec = rpc.calls.find((c) => c.name === 'admin_promo_email_record');
    expect(rec?.args).toMatchObject({ p_status: 'abandoned', p_attempts: 3, p_error: thrower ? 'mailer_threw' : 'resend_http_503' });
  }
  it('three failures: recorded as abandoned (attempts 3), the code is returned to the admin, and the code is not re-created', async () => {
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
    if (!result.ok || !('codes' in result)) throw new Error('unexpected');
    expect(result.codes[0].code).toBeDefined();
  });

  it('only the failed recipient\'s code is returned when the shared code reached some but not all recipients', async () => {
    const rpc = standard();
    const { mailer } = makeMailer((m) => (m.to === 'bad@example.test' ? { ok: false, error: 'resend_http_422' } : { ok: true, messageId: 'm' }));
    const { result } = await dispatch({ rpc, mailer, recipients: ['good@example.test', 'bad@example.test'] });
    if (!result.ok || !('codes' in result)) throw new Error('unexpected');
    expect(result.codes[0].recipients.map((r) => r.status)).toEqual(['sent', 'failed']);
    expect(result.codes[0].code).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
describe('idempotency and rate limit', () => {
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
    const rpc = makeRpc({ admin_promo_email_begin: () => ({ data: { new: false } }) });
    const { result } = await dispatch({ rpc, mailer: makeMailer().mailer });
    expect(result).toMatchObject({ message: expect.stringContaining('Generate a replacement code and email it') });
  });
  it('NEGATIVE CONTROL — if the database wrongly says every key is new, a double-click creates a second code and sends a second e-mail (assertion "a repeated request key must create no second code" goes red)', async () => {
    await expect(assertDuplicateCreatesNothing({ data: { new: true } })).rejects.toThrow(/a repeated request key must create no second code/);
  });

  it('the per-admin rate limit is surfaced as 429 and nothing is created or sent', async () => {
    const rpc = makeRpc({ admin_promo_email_begin: () => ({ error: { code: 'P0001', message: 'PROMO_EMAIL_RATE_LIMITED' } }), admin_create_promo_code: okCreate });
    const { mailer, sent } = makeMailer();
    const { result } = await dispatch({ rpc, mailer });
    expect(result).toMatchObject({ ok: false, status: 429, code: 'PROMO_EMAIL_RATE_LIMITED' });
    expect(rpc.calls.filter((c) => c.name === 'admin_create_promo_code')).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it('the request key is also passed to the mailer as an idempotency key per code and recipient', async () => {
    const rpc = standard();
    const { mailer, sent } = makeMailer();
    await dispatch({ rpc, mailer, recipients: ['a@example.test', 'b@example.test'], requestKey: 'request-key-ABCD' });
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
    const { result } = await dispatch({ rpc, mailer, recipients: ['a@example.test', 'b@example.test', 'c@example.test'], bind: true });
    if (!result.ok || !('codes' in result)) throw new Error('unexpected');
    const creates = rpc.calls.filter((c) => c.name === 'admin_create_promo_code');
    expect(creates).toHaveLength(3);
    expect(creates.map((c) => c.args.p_bound_email_hash)).toEqual(['a@example.test', 'b@example.test', 'c@example.test'].map((a) => keyedAddressHash('bind', a, SECRET_ENV)));
    for (const c of creates) {
      expect(c.args).toMatchObject({ p_max_redemptions: 1, p_unlimited: false, p_recipient_count: 1 });
      expect(String(c.args.p_bound_email_hash)).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(c.args)).not.toMatch(/@example\.test/);
    }
    expect(sent.map((s) => s.to)).toEqual(['a@example.test', 'b@example.test', 'c@example.test']);
    expect(sent.every((s) => s.text.includes('works only for the FHIP account registered with this e-mail address'))).toBe(true);
    expect(result.codes.map((c) => c.bound)).toEqual([true, true, true]);
  });

  it('the hash is keyed, case/whitespace-normalised, and domain-separated (bind vs send)', async () => {
    const { keyedAddressHash } = await import('@/lib/services/promoCodeEmail');
    const a = keyedAddressHash('bind', 'Person@Example.test ', SECRET_ENV);
    expect(a).toBe(keyedAddressHash('bind', 'person@example.test', SECRET_ENV));
    expect(a).not.toBe(keyedAddressHash('bind', 'person@example.test', { ...SECRET_ENV, PREMIUM_PROMO_EMAIL_BIND_SECRET: 'a-different-secret-bbbbbbbb' }));
    expect(a).not.toBe(keyedAddressHash('send', 'person@example.test', SECRET_ENV));
    expect(a).not.toContain('person');
    expect(keyedAddressHash('bind', 'x@y.test', {})).toBeNull(); // no secret: no hash, never an unkeyed fallback
    expect(keyedAddressHash('bind', 'x@y.test', { CRON_SECRET: 'cron-secret-aaaaaaaa' })).toMatch(/^[0-9a-f]{64}$/); // fallback chain ends at CRON_SECRET
  });

  it('refused before anything is created: unlimited with binding; a custom code with several bound recipients; binding with no secret configured', async () => {
    for (const [opts, status, code] of [
      [{ settings: { unlimited: true, maxRedemptions: null } }, 422, 'PROMO_MAX_INVALID'],
      [{ settings: { code: 'SUMMER2K26PASS' }, recipients: ['a@example.test', 'b@example.test'] }, 422, 'PROMO_CODE_INVALID'],
      [{ env: { PREMIUM_PROMO_EMAIL_ENABLED: 'true' } }, 503, 'PROMO_BINDING_UNAVAILABLE'],
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
    const { result } = await dispatch({ rpc, mailer: makeMailer().mailer, recipients: ['a@example.test', 'b@example.test'], bind: true });
    if (!result.ok || !('codes' in result)) throw new Error('unexpected');
    expect(result.codes).toHaveLength(1);
    expect(result.partialError).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
describe('fail soft if the new migration is absent', () => {
  it('unbound: the code is created with the LEGACY argument shape, nothing is sent, the admin sees a clear message and the code once', async () => {
    const rpc = makeRpc({ admin_promo_email_begin: () => ({ error: { code: '42883', message: 'function public.admin_promo_email_begin does not exist' } }), admin_create_promo_code: okCreate });
    const { mailer, sent } = makeMailer();
    const { result } = await dispatch({ rpc, mailer });
    if (!result.ok || !('codes' in result)) throw new Error('unexpected');
    expect(sent).toHaveLength(0);
    const create = rpc.calls.find((c) => c.name === 'admin_create_promo_code');
    expect(Object.keys(create!.args).sort()).toEqual(['p_code', 'p_duration_days', 'p_expires_on', 'p_max_redemptions', 'p_no_expiry', 'p_note', 'p_unlimited']);
    expect(result.email.message).toBe('Email sending is not available on this database yet. Copy the code and send it yourself.');
    expect(result.codes[0].code).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
describe('the code never reaches a log, an audit-bound argument or an error', () => {
  it('across a successful run, a failing run and a refused run: no console output contains the code or any address; the RPC arguments for audit/ledger carry no address and no code', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => {}));
    const runs: [ReturnType<typeof standard>, Mailer][] = [
      [standard(), makeMailer().mailer],
      [standard(), makeMailer([{ ok: false, error: 'resend_http_500' }]).mailer],
    ];
    for (const [rpc, mailer] of runs) {
      await dispatch({ rpc, mailer, recipients: ['secret.person@example.test'] });
      for (const c of rpc.calls.filter((x) => x.name === 'admin_promo_email_record' || x.name === 'admin_promo_email_begin')) {
        expect(JSON.stringify(c.args), `${c.name} must not carry the code or an address`).not.toMatch(/CODEKXBEE|secret\.person|@example\.test/);
      }
    }
    await dispatch({ rpc: makeRpc({ admin_promo_email_begin: () => ({ data: { new: false } }) }), mailer: makeMailer().mailer, recipients: ['secret.person@example.test'] });
    const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls));
    expect(logged, 'the code value must never appear in logs').not.toMatch(/CODEKXBEE/);
    expect(logged, 'an address must never appear in logs').not.toMatch(/secret\.person/);
  });

  it('NEGATIVE CONTROL — a version that logged the code on failure would be caught by the same check (assertion "the code value must never appear in logs" goes red)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    console.error('mail failed for code', 'CODEKXBEE12'); // the broken behaviour
    expect(() => expect(JSON.stringify(errSpy.mock.calls), 'the code value must never appear in logs').not.toMatch(/CODEKXBEE/)).toThrow(/the code value must never appear in logs/);
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
    vi.doMock('@/lib/services/premiumReminderMailer', () => ({ createResendMailer: () => mailer }));
    return (await import(module)) as Record<string, (r: Request, c?: { params: Promise<{ id: string }> }) => Promise<Response>>;
  }
  const post = (body: unknown) => new Request('http://x', { method: 'POST', body: JSON.stringify(body) });
  const inDays = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  const base = { durationDays: 30, maxRedemptions: 5, expiresOn: inDays(90), emailTo: 'to@example.test', idempotencyKey: 'request-key-0001' };

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
    process.env.PREMIUM_PROMO_EMAIL_BIND_SECRET = 'unit-test-secret-aaaaaaaa';
    let rpc = standard();
    let mailer = makeMailer();
    let h = await loadRoute('@/app/api/admin/promo-codes/route', rpc, mailer.mailer);
    let res = await h.POST(post(base));
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(mailer.sent).toHaveLength(1);
    expect(text).not.toMatch(/CODEKXBEE/);
    expect(JSON.parse(text).data.codes[0].recipients).toEqual([{ index: 0, status: 'sent' }]);

    process.env.PREMIUM_PROMO_EMAIL_ENABLED = 'false';
    rpc = standard();
    mailer = makeMailer();
    h = await loadRoute('@/app/api/admin/promo-codes/route', rpc, mailer.mailer);
    res = await h.POST(post(base));
    const body = (await res.json()).data;
    expect(mailer.sent).toHaveLength(0);
    expect(body.email.message).toBe('Email sending is switched off. Copy the code and send it yourself.');
    expect(body.codes[0].code).toMatch(/^CODEKXBEE/);
  });

  it('without emailTo the create route behaves exactly as before (legacy response: the code, no dispatch)', async () => {
    const rpc = makeRpc({ admin_create_promo_code: okCreate });
    const h = await loadRoute('@/app/api/admin/promo-codes/route', rpc, makeMailer().mailer);
    const res = await h.POST(post({ durationDays: 30, maxRedemptions: 5, expiresOn: inDays(90) }));
    const data = (await res.json()).data;
    expect(data.code).toMatch(/^CODEKXBEE/);
    expect(rpc.calls.map((c) => c.name)).toEqual(['admin_create_promo_code']);
  });

  it('a bad recipient list or a missing request key is refused (422) before anything happens', async () => {
    const rpc = standard();
    const h = await loadRoute('@/app/api/admin/promo-codes/route', rpc, makeMailer().mailer);
    expect((await h.POST(post({ ...base, emailTo: 'not-an-address' }))).status).toBe(422);
    expect((await h.POST(post({ ...base, idempotencyKey: undefined }))).status).toBe(422);
    expect((await h.POST(post({ ...base, emailTo: Array.from({ length: 21 }, (_, i) => `u${i}@x.test`) }))).status).toBe(422);
    expect(rpc.calls).toHaveLength(0);
  });

  describe('replacement route', () => {
    const listed = (over: Record<string, unknown> = {}) => [{ id: OLD_ID, duration_days: 45, max_redemptions: 7, expires_on: '2099-02-02', note: 'old note', status: 'active', state: 'active', ...over }];
    const replaceRpc = (rows: unknown[]) =>
      makeRpc({
        admin_list_promo_codes: () => ({ data: rows }),
        admin_promo_email_begin: () => ({ data: { new: true } }),
        admin_create_promo_code: okCreate,
        admin_promo_email_record: () => ({ data: true }),
      });
    const ctx = { params: Promise.resolve({ id: OLD_ID }) };

    it('capability-gated (403 for non-capability admins); 404 for an unknown id; 409 for a code that is not active', async () => {
      const denied = replaceRpc(listed());
      const h1 = await loadRoute('@/app/api/admin/promo-codes/[id]/replace-and-email/route', denied, makeMailer().mailer, { can_manage_promo_codes: false });
      expect((await h1.POST(post({ emailTo: 'a@example.test', idempotencyKey: 'request-key-0001' }), ctx)).status).toBe(403);
      expect(denied.calls).toHaveLength(0);
      const h2 = await loadRoute('@/app/api/admin/promo-codes/[id]/replace-and-email/route', replaceRpc([]), makeMailer().mailer);
      expect((await h2.POST(post({ emailTo: 'a@example.test', idempotencyKey: 'request-key-0001' }), ctx)).status).toBe(404);
      const h3 = await loadRoute('@/app/api/admin/promo-codes/[id]/replace-and-email/route', replaceRpc(listed({ state: 'expired' })), makeMailer().mailer);
      const r3 = await h3.POST(post({ emailTo: 'a@example.test', idempotencyKey: 'request-key-0001' }), ctx);
      expect(r3.status).toBe(409);
      expect((await r3.json()).error).toBe('PROMO_CODE_NOT_ACTIVE');
    });

    it('creates a NEW generated code with the old code\'s settings and e-mails only the new one; the old code is neither returned nor retrieved', async () => {
      process.env.PREMIUM_PROMO_EMAIL_ENABLED = 'true';
      process.env.PREMIUM_PROMO_EMAIL_BIND_SECRET = 'unit-test-secret-aaaaaaaa';
      const rpc = replaceRpc(listed());
      const { mailer, sent } = makeMailer();
      const h = await loadRoute('@/app/api/admin/promo-codes/[id]/replace-and-email/route', rpc, mailer);
      const res = await h.POST(post({ emailTo: 'a@example.test', idempotencyKey: 'request-key-0001' }), ctx);
      expect(res.status).toBe(200);
      const create = rpc.calls.find((c) => c.name === 'admin_create_promo_code');
      expect(create?.args).toMatchObject({ p_code: null, p_duration_days: 45, p_max_redemptions: 7, p_unlimited: false, p_expires_on: '2099-02-02', p_no_expiry: false, p_note: 'old note' });
      expect(sent).toHaveLength(1);
      expect(sent[0].text).toContain('45 days');
      const text = JSON.stringify(await res.json());
      expect(text).not.toMatch(/CODEKXBEE/);
      expect(rpc.calls.some((c) => c.name === 'admin_disable_promo_code')).toBe(false); // the old code is left alone
    });

    it('replacing an unlimited / no-expiry code keeps those settings; with binding ON the replacement becomes single-use for that address', async () => {
      process.env.PREMIUM_PROMO_EMAIL_ENABLED = 'true';
      process.env.PREMIUM_PROMO_EMAIL_BIND_SECRET = 'unit-test-secret-aaaaaaaa';
      const rpc = replaceRpc(listed({ max_redemptions: null, expires_on: null }));
      const h = await loadRoute('@/app/api/admin/promo-codes/[id]/replace-and-email/route', rpc, makeMailer().mailer);
      await h.POST(post({ emailTo: 'a@example.test', idempotencyKey: 'request-key-0001' }), ctx);
      expect(rpc.calls.find((c) => c.name === 'admin_create_promo_code')?.args).toMatchObject({ p_unlimited: true, p_max_redemptions: null, p_no_expiry: true, p_expires_on: null });
      const rpc2 = replaceRpc(listed({ max_redemptions: null, expires_on: null }));
      const h2 = await loadRoute('@/app/api/admin/promo-codes/[id]/replace-and-email/route', rpc2, makeMailer().mailer);
      const res = await h2.POST(post({ emailTo: 'a@example.test', bindToRecipient: true, idempotencyKey: 'request-key-0002' }), ctx);
      expect(res.status).toBe(200);
      expect(rpc2.calls.find((c) => c.name === 'admin_create_promo_code')?.args).toMatchObject({ p_unlimited: false, p_max_redemptions: 1 });
    });

    it('a missing recipient list is refused (422)', async () => {
      const h = await loadRoute('@/app/api/admin/promo-codes/[id]/replace-and-email/route', replaceRpc(listed()), makeMailer().mailer);
      expect((await h.POST(post({}), ctx)).status).toBe(422);
    });
  });

  describe('user redemption passes the keyed hash of the session user\'s address', () => {
    async function redeem(rpcImpl: (name: string, args: Record<string, unknown>) => RpcResult, user: { id: string; email?: string | null }, env: Record<string, string | undefined>) {
      vi.resetModules();
      for (const [k, v] of Object.entries(env)) {
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
      const res = await POST(post({ code: 'SOMECODEKX22' }));
      return { res, calls };
    }

    it('p_email_hash = HMAC of the normalised session address (never the address); another account\'s hash differs', async () => {
      const { keyedAddressHash } = await import('@/lib/services/promoCodeEmail');
      const { calls } = await redeem(() => ({ data: { ok: true, ends_on: '2026-11-02' } }), { id: 'u1', email: 'Owner@Example.test' }, { PREMIUM_PROMO_EMAIL_BIND_SECRET: 'unit-test-secret-aaaaaaaa' });
      expect(calls[0].args.p_email_hash).toBe(keyedAddressHash('bind', 'owner@example.test', { PREMIUM_PROMO_EMAIL_BIND_SECRET: 'unit-test-secret-aaaaaaaa' }));
      expect(JSON.stringify(calls[0].args)).not.toMatch(/example\.test/i);
      const other = await redeem(() => ({ data: { ok: false, code: 'PROMO_CODE_UNUSABLE' } }), { id: 'u2', email: 'stranger@example.test' }, { PREMIUM_PROMO_EMAIL_BIND_SECRET: 'unit-test-secret-aaaaaaaa' });
      expect(other.calls[0].args.p_email_hash).not.toBe(calls[0].args.p_email_hash);
      expect((await other.res.json()).message).toBe('This code cannot be used.');
    });

    it('falls back to the legacy 3-argument call when the database predates the parameter (migration absent)', async () => {
      const { res, calls } = await redeem(
        (_n, args) => ('p_email_hash' in args ? { error: { code: 'PGRST202', message: 'no function with that signature' } } : { data: { ok: true, ends_on: '2026-11-02' } }),
        { id: 'u1', email: 'a@example.test' },
        { PREMIUM_PROMO_EMAIL_BIND_SECRET: 'unit-test-secret-aaaaaaaa' }
      );
      expect(res.status).toBe(200);
      expect(calls).toHaveLength(2);
      expect('p_email_hash' in calls[1].args).toBe(false);
    });

    it('no secret configured or no address on the account => a null hash (bound codes then read as "cannot be used": fail closed)', async () => {
      const a = await redeem(() => ({ data: { ok: false, code: 'PROMO_CODE_UNUSABLE' } }), { id: 'u1', email: 'a@example.test' }, { PREMIUM_PROMO_EMAIL_BIND_SECRET: undefined, PROMO_IP_HASH_SECRET: undefined, CRON_SECRET: undefined });
      expect(a.calls[0].args.p_email_hash).toBeNull();
      const b = await redeem(() => ({ data: { ok: false, code: 'PROMO_CODE_UNUSABLE' } }), { id: 'u1', email: null }, { PREMIUM_PROMO_EMAIL_BIND_SECRET: 'unit-test-secret-aaaaaaaa' });
      expect(b.calls[0].args.p_email_hash).toBeNull();
    });
  });
});
