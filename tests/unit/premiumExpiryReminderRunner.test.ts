// Premium expiry e-mail reminders — application layer (runner, mailer, copy, route),
// with an INJECTED mailer and a fake database. No test in this file can send mail:
// the Resend mailer is exercised with an injected fetch that never leaves the process.
//
// Negative controls: each rule's assertion is also run against a deliberately
// broken variant and must go red; the failing assertion is named in the title.
// (The database rules — thresholds, send-once, retries, schedule guard — are proven
// against a real Postgres in premiumExpiryReminderPglite.test.ts.)

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { formatDateShort } from '@/lib/engines/date';
import type { Mailer, OutgoingMail, MailResult } from '@/lib/services/premiumReminderMailer';
import type { ClaimedReminder, ReminderDb } from '@/lib/services/premiumExpiryReminderRunner';

vi.setConfig({ testTimeout: 30_000 });

const TODAY = '2026-10-01';

interface FakeDbOpts {
  control?: { data: unknown; error: { code?: string; message?: string } | null } | 'throw';
  claim?: ClaimedReminder[] | { error: true };
}

function makeDb(opts: FakeDbOpts = {}) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const db: ReminderDb = {
    from: (table: string) => {
      if (table !== 'premium_reminder_job_control') throw new Error(`unexpected table ${table}`);
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => {
              if (opts.control === 'throw') throw new Error('boom');
              return opts.control ?? { data: { enabled: true }, error: null };
            },
          }),
        }),
      };
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      if (name === 'premium_reminder_claim') {
        if (opts.claim && 'error' in opts.claim) return { data: null, error: { message: 'claim failed' } };
        return { data: opts.claim ?? [], error: null };
      }
      return { data: true, error: null };
    },
  };
  return { db, calls };
}

function makeMailer(results: MailResult[] | ((m: OutgoingMail) => MailResult | Promise<MailResult>) = [{ ok: true, messageId: 'msg_1' }], configured = true) {
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

const claimed = (over: Partial<ClaimedReminder> = {}): ClaimedReminder => ({
  ledger_id: 'led-1',
  user_id: 'user-1',
  email: 'user-1@example.test',
  country: 'AU',
  entitlement_source: 'admin_grant',
  ends_on: '2026-10-31',
  threshold_days: 30,
  attempt: 1,
  ...over,
});

async function run(db: ReminderDb, mailer: Mailer, thresholds?: readonly number[]) {
  const { runPremiumExpiryReminders } = await import('@/lib/services/premiumExpiryReminderRunner');
  return runPremiumExpiryReminders({ db, mailer, today: TODAY, baseUrl: 'https://app.example.test', thresholds });
}

beforeEach(() => vi.resetModules());
afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('@/lib/supabase/admin');
  vi.doUnmock('@/lib/services/premiumReminderMailer');
});

describe('the kill switch fails closed', () => {
  it('disabled / missing / unreadable / not literally true => nothing is claimed and nothing is sent', async () => {
    const variants: FakeDbOpts['control'][] = [
      { data: { enabled: false }, error: null },
      { data: null, error: null },
      { data: { enabled: 'true' }, error: null },
      { data: { enabled: 1 }, error: null },
      { data: { enabled: true }, error: { message: 'read error' } },
      'throw',
    ];
    for (const control of variants) {
      const { db, calls } = makeDb({ control, claim: [claimed()] });
      const { mailer, sent } = makeMailer();
      const r = await run(db, mailer);
      expect(r, JSON.stringify(control)).toEqual({ status: 'disabled', claimed: 0, sent: 0, failed: 0 });
      expect(calls.filter((c) => c.name === 'premium_reminder_claim'), 'a disabled job must not claim').toHaveLength(0);
      expect(sent, 'a disabled job must not send').toHaveLength(0);
    }
  });

  it('NEGATIVE CONTROL — a runner that ignored the switch would claim and send (assertion "a disabled job must not send" goes red)', async () => {
    const { db } = makeDb({ control: { data: { enabled: false }, error: null }, claim: [claimed()] });
    const { mailer, sent } = makeMailer();
    // The broken variant: skip the switch and go straight to claim + send.
    const rows = ((await db.rpc('premium_reminder_claim', {})).data as ClaimedReminder[]) ?? [];
    for (const r of rows) await mailer.send({ to: r.email, from: mailer.from(), subject: 's', text: 't', idempotencyKey: 'k' });
    expect(() => expect(sent, 'a disabled job must not send').toHaveLength(0)).toThrow(/a disabled job must not send/);
  });

  it('an enabled job with the mailer not configured claims nothing (no ledger row is burned)', async () => {
    const { db, calls } = makeDb({ claim: [claimed()] });
    const { mailer } = makeMailer(undefined, false);
    expect(await run(db, mailer)).toMatchObject({ status: 'mailer_not_configured', claimed: 0 });
    expect(calls.filter((c) => c.name === 'premium_reminder_claim')).toHaveLength(0);
  });

  it('a failed claim is reported and sends nothing', async () => {
    const { db } = makeDb({ claim: { error: true } });
    const { mailer, sent } = makeMailer();
    expect(await run(db, mailer)).toMatchObject({ status: 'claim_failed', sent: 0 });
    expect(sent).toHaveLength(0);
  });
});

describe('sending', () => {
  it('sends exactly one plain-text e-mail to the claimed row\'s own address and records it with the provider id', async () => {
    const { db, calls } = makeDb({ claim: [claimed()] });
    const { mailer, sent } = makeMailer([{ ok: true, messageId: 'msg_abc' }]);
    const r = await run(db, mailer);
    expect(r).toEqual({ status: 'ran', claimed: 1, sent: 1, failed: 0 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: 'user-1@example.test', from: 'FHIP <no-reply@example.test>', idempotencyKey: 'premium-expiry-led-1' });
    expect(Object.keys(sent[0]).sort()).toEqual(['from', 'idempotencyKey', 'subject', 'text', 'to']); // no html, no tracking fields
    const rec = calls.find((c) => c.name === 'premium_reminder_record');
    expect(rec?.args).toMatchObject({ p_ledger_id: 'led-1', p_ok: true, p_message_id: 'msg_abc', p_error: null });
  });

  it('a mailer failure is RECORDED (short, non-identifying) and not retried within the run; the next row is still sent', async () => {
    const { db, calls } = makeDb({ claim: [claimed({ ledger_id: 'a', email: 'a@example.test' }), claimed({ ledger_id: 'b', email: 'b@example.test' })] });
    const { mailer, sent } = makeMailer([{ ok: false, error: 'resend_http_500' }, { ok: true, messageId: 'm2' }]);
    const r = await run(db, mailer);
    expect(r).toEqual({ status: 'ran', claimed: 2, sent: 1, failed: 1 });
    expect(sent.map((s) => s.to)).toEqual(['a@example.test', 'b@example.test']); // each address once
    const recs = calls.filter((c) => c.name === 'premium_reminder_record').map((c) => c.args);
    expect(recs[0]).toMatchObject({ p_ledger_id: 'a', p_ok: false, p_error: 'resend_http_500', p_max_attempts: 3 });
    expect(JSON.stringify(recs)).not.toContain('a@example.test'); // no address in the recorded error
    expect(recs[1]).toMatchObject({ p_ledger_id: 'b', p_ok: true });
  });

  it('a mailer that throws is recorded as a failure and does not stop the run or double-send', async () => {
    const { db, calls } = makeDb({ claim: [claimed({ ledger_id: 'x' }), claimed({ ledger_id: 'y' })] });
    let n = 0;
    const { mailer, sent } = makeMailer(() => {
      n += 1;
      if (n === 1) throw new Error('network down');
      return { ok: true, messageId: 'm' };
    });
    const r = await run(db, mailer);
    expect(r).toMatchObject({ claimed: 2, sent: 1, failed: 1 });
    expect(sent).toHaveLength(2);
    expect(calls.filter((c) => c.name === 'premium_reminder_record')[0].args).toMatchObject({ p_ledger_id: 'x', p_ok: false, p_error: 'mailer_threw' });
  });

  async function assertNeverMailsPaid(mail: (rows: ClaimedReminder[], send: (to: string) => void) => Promise<void> | void): Promise<void> {
    const sentTo: string[] = [];
    await mail([claimed({ entitlement_source: 'payment' as never, email: 'paid@example.test' }), claimed({ ledger_id: 'ok', email: 'granted@example.test' })], (to) => sentTo.push(to));
    expect(sentTo, 'a paid entitlement is never e-mailed').toEqual(['granted@example.test']);
  }

  it('defence in depth: a claim row that is not an admin grant / promo, or has no address, is never mailed', async () => {
    await assertNeverMailsPaid(async (rows, send) => {
      const { db } = makeDb({ claim: rows });
      const { mailer } = makeMailer((m) => (send(m.to), { ok: true, messageId: 'm' }));
      const r = await run(db, mailer);
      expect(r.failed).toBe(1);
    });
    const { db } = makeDb({ claim: [claimed({ email: '' }), claimed({ ledger_id: 'n', email: 'not-an-address' })] });
    const { mailer, sent } = makeMailer();
    expect(await run(db, mailer)).toMatchObject({ claimed: 2, sent: 0, failed: 2 });
    expect(sent).toHaveLength(0);
  });

  it('NEGATIVE CONTROL — a runner without that check would mail a paid entitlement (assertion "a paid entitlement is never e-mailed" goes red)', async () => {
    await expect(
      assertNeverMailsPaid((rows, send) => {
        for (const r of rows) send(r.email); // no source check
      })
    ).rejects.toThrow(/a paid entitlement is never e-mailed/);
  });

  it('thresholds are one named list passed through to the database (default [30]; [30, 7] enables the second e-mail)', async () => {
    const { PREMIUM_EXPIRY_EMAIL_THRESHOLD_DAYS } = await import('@/lib/services/premiumExpiryReminderEmail');
    expect([...PREMIUM_EXPIRY_EMAIL_THRESHOLD_DAYS]).toEqual([30]);
    const a = makeDb();
    await run(a.db, makeMailer().mailer);
    expect(a.calls[0].args).toMatchObject({ p_thresholds: [30], p_batch: 50, p_max_attempts: 3 });
    const b = makeDb();
    await run(b.db, makeMailer().mailer, [30, 7]);
    expect(b.calls[0].args.p_thresholds).toEqual([30, 7]);
  });
});

describe('the e-mail copy', () => {
  it('is plain, observation-style and transactional: end date in the user\'s country format, the real continuation paths, no promo code, no marketing', async () => {
    const { composeExpiryReminderEmail } = await import('@/lib/services/premiumExpiryReminderEmail');
    const au = composeExpiryReminderEmail({ endsOn: '2026-10-31', daysLeft: 30, country: 'AU', baseUrl: 'https://app.example.test' });
    const inn = composeExpiryReminderEmail({ endsOn: '2026-10-31', daysLeft: 30, country: 'IN', baseUrl: 'https://app.example.test' });
    expect(au.subject).toBe('Your complimentary Premium access ends on 31/10/2026');
    expect(inn.subject).toBe('Your complimentary Premium access ends on 31-10-2026');
    expect(au.subject).toContain(formatDateShort('2026-10-31', 'AUD')); // the repo's canonical formatter
    expect(inn.subject).toContain(formatDateShort('2026-10-31', 'INR'));
    expect(au.text).toContain('ends on 31/10/2026 (in 30 days)');
    expect(au.text).toContain('https://app.example.test/profile');
    expect(au.text).toContain('https://app.example.test/contact');
    expect(au.text).toContain('not marketing');
    expect(au.text).not.toMatch(/promo|code|discount|offer|sale|limited time|buy now|unsubscribe/i);
    // unknown / missing country falls back to the AU format, never to a locale-dependent one
    expect(composeExpiryReminderEmail({ endsOn: '2026-10-31', daysLeft: 1, country: null, baseUrl: 'x' }).subject).toContain('31/10/2026');
    expect(composeExpiryReminderEmail({ endsOn: '2026-10-31', daysLeft: 1, country: 'AU', baseUrl: 'x' }).text).toContain('(in 1 day)');
    expect(composeExpiryReminderEmail({ endsOn: '2026-10-31', daysLeft: 0, country: 'AU', baseUrl: 'x' }).text).toContain('(today)');
  });

  it('carries no PII beyond what the recipient already holds: no name, no user id, no source, no amount', async () => {
    const { composeExpiryReminderEmail } = await import('@/lib/services/premiumExpiryReminderEmail');
    const m = composeExpiryReminderEmail({ endsOn: '2026-10-31', daysLeft: 30, country: 'AU', baseUrl: 'https://app.example.test' });
    expect(m.text).not.toMatch(/user-1|@|admin|granted by|\$|AUD|INR/);
    expect(m.text.startsWith('Hello,')).toBe(true);
  });
});

describe('the Resend mailer reuses the Contact path and cannot send in tests', () => {
  it('not configured without RESEND_API_KEY (never calls fetch); sender falls back PREMIUM_REMINDER_FROM_EMAIL -> CONTACT_FROM_EMAIL -> default', async () => {
    const { createResendMailer } = await import('@/lib/services/premiumReminderMailer');
    const fetchSpy = vi.fn();
    const none = createResendMailer({}, fetchSpy as never);
    expect(none.configured()).toBe(false);
    expect(await none.send({ to: 'a@b.test', from: 'f', subject: 's', text: 't', idempotencyKey: 'k' })).toEqual({ ok: false, error: 'mailer_not_configured' });
    expect(fetchSpy).not.toHaveBeenCalled();
    // The ADDRESS chain is unchanged; the display name is now the separate PREMIUM_PROMO_EMAIL_FROM_NAME (default "FHIP").
    expect(createResendMailer({ RESEND_API_KEY: 'k', PREMIUM_REMINDER_FROM_EMAIL: 'P <p@x.test>', CONTACT_FROM_EMAIL: 'C <c@x.test>' }, fetchSpy as never).from()).toBe('FHIP <p@x.test>');
    expect(createResendMailer({ RESEND_API_KEY: 'k', CONTACT_FROM_EMAIL: 'C <c@x.test>' }, fetchSpy as never).from()).toBe('FHIP <c@x.test>');
    expect(createResendMailer({ RESEND_API_KEY: 'k' }, fetchSpy as never).from()).toMatch(/no-reply@auth\.financialhealthplatform\.com/);
  });

  it('posts to the Resend HTTPS API like the Contact route; maps success / HTTP failure / network error without leaking the address or body', async () => {
    const { createResendMailer } = await import('@/lib/services/premiumReminderMailer');
    const calls: { url: string; init: RequestInit }[] = [];
    const ok = createResendMailer({ RESEND_API_KEY: 'key_test' }, (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: 'resend_123' }), { status: 200 });
    }) as never);
    expect(await ok.send({ to: 'a@b.test', from: 'F <f@x.test>', subject: 'S', text: 'T', idempotencyKey: 'premium-expiry-1' })).toEqual({ ok: true, messageId: 'resend_123' });
    expect(calls[0].url).toBe('https://api.resend.com/emails');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer key_test');
    expect((calls[0].init.headers as Record<string, string>)['Idempotency-Key']).toBe('premium-expiry-1');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ from: 'F <f@x.test>', to: ['a@b.test'], subject: 'S', text: 'T' });

    const bad = createResendMailer({ RESEND_API_KEY: 'k' }, (async () => new Response('secret detail a@b.test', { status: 422 })) as never);
    const r = await bad.send({ to: 'a@b.test', from: 'f', subject: 's', text: 't', idempotencyKey: 'k' });
    expect(r).toEqual({ ok: false, error: 'resend_http_422' });
    const net = createResendMailer({ RESEND_API_KEY: 'k' }, (async () => {
      throw new Error('ECONNRESET a@b.test');
    }) as never);
    expect(await net.send({ to: 'a@b.test', from: 'f', subject: 's', text: 't', idempotencyKey: 'k' })).toEqual({ ok: false, error: 'resend_network_error' });
  });
});

describe('POST /api/premium/cron/expiry-reminders', () => {
  async function callRoute(headers: Record<string, string>, dbOpts: FakeDbOpts, mailerResult: MailResult = { ok: true, messageId: 'm' }) {
    const { db, calls } = makeDb(dbOpts);
    const { mailer, sent } = makeMailer([mailerResult]);
    vi.resetModules();
    vi.doMock('@/lib/supabase/admin', () => ({ createAdminClient: () => db }));
    vi.doMock('@/lib/services/premiumReminderMailer', () => ({ createResendMailer: () => mailer }));
    process.env.CRON_SECRET = 'cron-secret-for-tests';
    const { POST } = await import('@/app/api/premium/cron/expiry-reminders/route');
    const res = await POST(new Request('http://x', { method: 'POST', headers }));
    return { res, calls, sent };
  }

  it('requires the shared cron secret: missing / wrong -> 401 and nothing happens', async () => {
    for (const headers of [{}, { 'x-cron-secret': 'wrong' }, { 'x-cron-secret': '' }] as Record<string, string>[]) {
      const { res, calls, sent } = await callRoute(headers, { claim: [claimed()] });
      expect(res.status, JSON.stringify(headers)).toBe(401);
      expect(calls).toHaveLength(0);
      expect(sent).toHaveLength(0);
    }
  });

  it('with the kill switch OFF (the shipped default) an authorised call is a no-op that sends nothing', async () => {
    const { res, calls, sent } = await callRoute({ 'x-cron-secret': 'cron-secret-for-tests' }, { control: { data: { enabled: false }, error: null }, claim: [claimed()] });
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ status: 'disabled', claimed: 0, sent: 0, failed: 0 });
    expect(calls).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it('enabled: sends through the (injected) mailer and reports counts only — no address or body in the response', async () => {
    const { res, sent } = await callRoute({ 'x-cron-secret': 'cron-secret-for-tests' }, { claim: [claimed({ email: 'someone@example.test' })] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ status: 'ran', claimed: 1, sent: 1, failed: 0 });
    expect(JSON.stringify(body)).not.toContain('someone@example.test');
    expect(sent).toHaveLength(1);
  });
});
