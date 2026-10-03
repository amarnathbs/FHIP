// Sender display name for the Premium e-mails (promo codes, expiry reminders).
//
// PO request: these e-mails must read "FHIP", not the Contact form's display name, without changing the
// Contact form's own e-mails, the sending ADDRESS, or the verified domain. The name is a separate optional
// setting (PREMIUM_PROMO_EMAIL_FROM_NAME, default "FHIP") and must be safe against header injection.
//
// Negative controls: each rule's assertion is also run against a deliberately broken variant and must go red;
// the failing assertion is named in the title.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildFromHeader, extractFromAddress, sanitiseFromName, DEFAULT_FROM_ADDRESS, MAX_FROM_NAME_LENGTH } from '@/lib/services/mailFromHeader';
import { createResendMailer } from '@/lib/services/premiumReminderMailer';

const LS = String.fromCharCode(0x2028); // Unicode line separator
const PS = String.fromCharCode(0x2029); // Unicode paragraph separator
const CONTROL_OR_SEPARATOR = new RegExp(`[\r\n\u0000-\u001f\u007f${LS}${PS}]`);
const CONTACT_FROM = 'FHIP Contact Form <no-reply@auth.financialhealthplatform.com>';

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('@/lib/supabase/admin');
  delete process.env.RESEND_API_KEY;
  delete process.env.CONTACT_FROM_EMAIL;
  delete process.env.PREMIUM_PROMO_EMAIL_FROM_NAME;
});

describe('default name and unchanged address', () => {
  async function assertDefaultFhipSameAddress(from: (env: Record<string, string | undefined>) => string): Promise<void> {
    // The Contact form's configured value (with ITS display name) becomes "FHIP <same address>".
    expect(from({ RESEND_API_KEY: 'k', CONTACT_FROM_EMAIL: CONTACT_FROM }), 'the default name must be FHIP').toBe('FHIP <no-reply@auth.financialhealthplatform.com>');
    expect(from({ RESEND_API_KEY: 'k', PREMIUM_REMINDER_FROM_EMAIL: 'Reminders <reminders@auth.financialhealthplatform.com>', CONTACT_FROM_EMAIL: CONTACT_FROM }), 'the address part must be unchanged').toBe(
      'FHIP <reminders@auth.financialhealthplatform.com>'
    );
    expect(from({ RESEND_API_KEY: 'k' }), 'no configuration: the default address, named FHIP').toBe('FHIP <no-reply@auth.financialhealthplatform.com>');
    // a bare address is fine too
    expect(from({ RESEND_API_KEY: 'k', CONTACT_FROM_EMAIL: 'support@auth.financialhealthplatform.com' })).toBe('FHIP <support@auth.financialhealthplatform.com>');
  }

  it('the Premium mailer\'s From is "FHIP <address>": the configured address is kept character for character, the Contact form\'s display name is dropped', async () => {
    await assertDefaultFhipSameAddress((env) => createResendMailer(env, vi.fn() as never).from());
  });

  it('NEGATIVE CONTROL — the OLD behaviour (the configured value passed through) fails the default-name assertion (assertion "the default name must be FHIP" goes red)', async () => {
    const legacy = (env: Record<string, string | undefined>) => env.PREMIUM_REMINDER_FROM_EMAIL || env.CONTACT_FROM_EMAIL || 'FHIP <no-reply@auth.financialhealthplatform.com>';
    await expect(assertDefaultFhipSameAddress(legacy)).rejects.toThrow(/the default name must be FHIP/);
  });

  it('NEGATIVE CONTROL — a variant that rebuilt the address (e.g. a different domain) fails the address assertion (assertion "the address part must be unchanged" goes red)', async () => {
    const wrongAddress = (env: Record<string, string | undefined>) => `FHIP <no-reply@auth.financialhealthplatform.com>`.replace('no-reply', env.PREMIUM_REMINDER_FROM_EMAIL ? 'other' : 'no-reply');
    await expect(
      (async () => {
        expect(wrongAddress({ PREMIUM_REMINDER_FROM_EMAIL: 'Reminders <reminders@auth.financialhealthplatform.com>' }), 'the address part must be unchanged').toBe('FHIP <reminders@auth.financialhealthplatform.com>');
      })()
    ).rejects.toThrow(/the address part must be unchanged/);
  });

  it('PREMIUM_PROMO_EMAIL_FROM_NAME sets the name; the address is still the configured one; the same mailer serves promo and reminder e-mails', async () => {
    const m = createResendMailer({ RESEND_API_KEY: 'k', CONTACT_FROM_EMAIL: CONTACT_FROM, PREMIUM_PROMO_EMAIL_FROM_NAME: 'FHIP Premium' }, vi.fn() as never);
    expect(m.from()).toBe('FHIP Premium <no-reply@auth.financialhealthplatform.com>');
  });

  it('the From header actually sent to Resend is the built header', async () => {
    const calls: { body: string }[] = [];
    const mailer = createResendMailer({ RESEND_API_KEY: 'k', CONTACT_FROM_EMAIL: CONTACT_FROM }, (async (_u: string, init: RequestInit) => {
      calls.push({ body: String(init.body) });
      return new Response(JSON.stringify({ id: 'x' }), { status: 200 });
    }) as never);
    await mailer.send({ to: 'a@b.test', from: mailer.from(), subject: 's', text: 't', idempotencyKey: 'k' });
    expect(JSON.parse(calls[0].body).from).toBe('FHIP <no-reply@auth.financialhealthplatform.com>');
  });
});

describe('header-injection attempts in the name are neutralised', () => {
  const ATTACKS = [
    'FHIP\r\nBcc: attacker@evil.test',
    'FHIP\nSubject: pwned',
    'FHIP" <evil@evil.test>, "Other',
    'FHIP <evil@evil.test>',
    'Name\u0000Null',
    `FHIP${LS}Bcc: x@y.test`,
    `FHIP${PS}Bcc: x@y.test`,
    'A, B; C: D@E (F) \\ G',
  ];

  async function assertSafe(build: (name: string) => string): Promise<void> {
    for (const attack of ATTACKS) {
      const header = build(attack);
      expect(header, `header injection must be neutralised: ${JSON.stringify(attack)}`).not.toMatch(CONTROL_OR_SEPARATOR);
      // exactly one address, and it is the configured one; nothing else can look like a header or a second recipient
      expect(header.match(/@/g)?.length, `header injection must be neutralised: ${JSON.stringify(attack)}`).toBe(1);
      expect(header, `header injection must be neutralised: ${JSON.stringify(attack)}`).toMatch(/^[\p{L}\p{N} .&_-]+ <no-reply@auth\.financialhealthplatform\.com>$/u);
    }
  }

  it('CR/LF, quotes, angle brackets, commas, colons, "@", parentheses, backslashes and control characters cannot survive into the header', async () => {
    await assertSafe((name) => createResendMailer({ RESEND_API_KEY: 'k', CONTACT_FROM_EMAIL: CONTACT_FROM, PREMIUM_PROMO_EMAIL_FROM_NAME: name }, vi.fn() as never).from());
  });

  it('NEGATIVE CONTROL — naive string concatenation (`${name} <${address}>`) lets the attacks through (assertion "header injection must be neutralised" goes red)', async () => {
    await expect(assertSafe((name) => `${name} <no-reply@auth.financialhealthplatform.com>`)).rejects.toThrow(/header injection must be neutralised/);
  });

  it('the name is length-capped and an empty / blank / all-invalid / non-string value falls back to "FHIP"', () => {
    expect(sanitiseFromName('x'.repeat(500)).length).toBeLessThanOrEqual(MAX_FROM_NAME_LENGTH);
    for (const v of ['', '   ', '<>"\r\n', '\r\n', undefined, null]) expect(sanitiseFromName(v as never)).toBe('FHIP');
    expect(sanitiseFromName('  FHIP   Premium  ')).toBe('FHIP Premium');
    expect(sanitiseFromName('FHIP & Co.')).toBe('FHIP & Co.');
    expect(sanitiseFromName('Fhìp')).toBe('Fhìp'); // letters in any script are kept
  });

  it('an unsafe or malformed configured ADDRESS falls back to the default address and is never merged into the header', () => {
    for (const bad of ['no-at-sign', 'a b@c.test', 'x@y.test\r\nBcc: z@z.test', 'Name <a@b.test> <c@d.test>', '<>', '']) {
      expect(buildFromHeader(bad, 'FHIP'), JSON.stringify(bad)).toBe(`FHIP <${DEFAULT_FROM_ADDRESS}>`);
    }
    expect(extractFromAddress('"Quoted, Name" <ok@auth.financialhealthplatform.com>')).toBe('ok@auth.financialhealthplatform.com');
    expect(extractFromAddress('ok@auth.financialhealthplatform.com')).toBe('ok@auth.financialhealthplatform.com');
  });
});

describe('the Contact form is unchanged', () => {
  const ROOT = path.resolve(__dirname, '..', '..');

  async function contactFrom(env: Record<string, string | undefined>): Promise<string> {
    vi.resetModules();
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    const sentBodies: string[] = [];
    vi.stubGlobal('fetch', async (_u: string, init: RequestInit) => {
      sentBodies.push(String(init.body));
      return new Response('{}', { status: 200 });
    });
    vi.doMock('@/lib/supabase/admin', () => ({
      createAdminClient: () => ({
        from: () => ({ insert: () => ({ select: () => ({ single: async () => ({ data: { id: 'row-1' }, error: null }) }) }), update: () => ({ eq: async () => ({ error: null }) }) }),
      }),
    }));
    const { POST } = await import('@/app/api/contact/route');
    const res = await POST(new Request('http://x', { method: 'POST', body: JSON.stringify({ name: 'Visitor', email: 'visitor@example.test', message: 'Hello there' }) }));
    expect(res.status).toBe(200);
    vi.unstubAllGlobals();
    return JSON.parse(sentBodies[0]).from;
  }

  async function assertContactFromUnchanged(read: (env: Record<string, string | undefined>) => Promise<string>): Promise<void> {
    expect(await read({ RESEND_API_KEY: 'k', CONTACT_FROM_EMAIL: CONTACT_FROM, PREMIUM_PROMO_EMAIL_FROM_NAME: 'Something Else' }), 'contact-form From is unchanged').toBe(CONTACT_FROM);
    expect(await read({ RESEND_API_KEY: 'k', CONTACT_FROM_EMAIL: undefined, PREMIUM_PROMO_EMAIL_FROM_NAME: undefined }), 'contact-form From is unchanged').toBe('FHIP Contact Form <no-reply@auth.financialhealthplatform.com>');
  }

  it('the Contact route still sends exactly the configured / default "FHIP Contact Form <address>" and ignores PREMIUM_PROMO_EMAIL_FROM_NAME', async () => {
    await assertContactFromUnchanged(contactFrom);
  });

  it('NEGATIVE CONTROL — had the Contact route used the Premium From builder its sender would change (assertion "contact-form From is unchanged" goes red)', async () => {
    const throughPremiumBuilder = async (env: Record<string, string | undefined>) => buildFromHeader(env.CONTACT_FROM_EMAIL ?? 'FHIP Contact Form <no-reply@auth.financialhealthplatform.com>', env.PREMIUM_PROMO_EMAIL_FROM_NAME);
    await expect(assertContactFromUnchanged(throughPremiumBuilder)).rejects.toThrow(/contact-form From is unchanged/);
  });

  it('source guard: app/api/contact/route.ts does not import the Premium From helper', () => {
    const src = readFileSync(path.join(ROOT, 'app/api/contact/route.ts'), 'utf8');
    expect(src).not.toMatch(/mailFromHeader|premiumReminderMailer|PREMIUM_PROMO_EMAIL_FROM_NAME/);
  });
});
