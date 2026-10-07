// The operator scripts of the hardening mission: their guards and (for the backfill) digest parity with the application.
//
// NAMED NEGATIVE CONTROLS
//   NC-O1  a backfill digest without the version domain prefix would disagree with the application: "the backfill digest equals the application digest";
//   NC-O2  a guard that forgot the production check would let the backfill run against production: "production needs the explicit flag".

import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { computePromoDigest } from '@/lib/services/promoCodeDigest';
import { digestOf, parseArgs, refusal, projectRefOf } from '../../../scripts/promo_code_digest_backfill.mjs';
import { refusal as devProofRefusal } from '../../../scripts/promo_hardening_release_dev_proof.mjs';
import { TEST_ENV, expectNamedFailure } from '../support/promoTestHelpers';

const PROD = 'https://twwpnltizhtjxhamyoxt.supabase.co';
const DEV = 'https://vqycarelcoijzwlpkpcz.supabase.co';
const env = (url: string) => ({ NEXT_PUBLIC_SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: 'x', PROMO_CODE_DIGEST_SECRET: TEST_ENV.PROMO_CODE_DIGEST_SECRET });

describe('backfill script', () => {
  it('NC-O1: its digest equals the application digest for the same code, secret and version (including case and separators)', async () => {
    const same = (digest: (code: string) => string) => {
      for (const code of ['ABCDEFGHJK', 'abcde-fghjk', 'ABCDE FGHJK', 'MNPQRSTUVW']) {
        expect(digest(code), 'the backfill digest equals the application digest').toBe(computePromoDigest(code, { version: 1, secret: TEST_ENV.PROMO_CODE_DIGEST_SECRET }));
      }
    };
    same((c) => digestOf(c, TEST_ENV.PROMO_CODE_DIGEST_SECRET, 1));
    await expectNamedFailure(() => same((c) => createHmac('sha256', TEST_ENV.PROMO_CODE_DIGEST_SECRET).update(c).digest('hex')), 'the backfill digest equals the application digest');
    expect(digestOf('ABCDEFGHJK', TEST_ENV.PROMO_CODE_DIGEST_SECRET, 2)).not.toBe(digestOf('ABCDEFGHJK', TEST_ENV.PROMO_CODE_DIGEST_SECRET, 1));
  });

  it('is a dry run unless told otherwise, and each dangerous step needs its own explicit flags', () => {
    expect(parseArgs([])).toEqual({ apply: false, finaliseDry: false, finalise: false, backup: false, production: false });
    expect(refusal(parseArgs([]), env(DEV))).toBeNull();
    expect(refusal(parseArgs(['--apply']), env(DEV))).toBeNull();
    expect(refusal(parseArgs(['--finalise']), env(DEV)), 'blanking needs a backup confirmation').toMatch(/backup/);
    expect(refusal(parseArgs(['--finalise', '--i-have-a-backup']), env(DEV))).toBeNull();
    expect(refusal(parseArgs(['--finalise', '--apply', '--i-have-a-backup']), env(DEV)), 'apply and finalise are separate steps').toMatch(/separate steps/);
  });

  it('NC-O2: production needs the explicit flag; a missing or short secret, a missing key and a non-Supabase URL are refused', async () => {
    const guarded = (e: Record<string, string>, args: string[] = []) => expect(String(refusal(parseArgs(args), e)), 'production needs the explicit flag').toMatch(/PRODUCTION/);
    guarded(env(PROD));
    expect(refusal(parseArgs(['--production']), env(PROD))).toBeNull();
    await expectNamedFailure(() => guarded(env(DEV)), 'production needs the explicit flag');
    expect(refusal(parseArgs([]), { ...env(DEV), PROMO_CODE_DIGEST_SECRET: 'short' })).toMatch(/shorter than 32/);
    expect(refusal(parseArgs([]), { ...env(DEV), SUPABASE_SERVICE_ROLE_KEY: '' })).toMatch(/SERVICE_ROLE_KEY/);
    expect(refusal(parseArgs([]), env('https://example.com'))).toMatch(/not a Supabase project URL/);
    expect(projectRefOf(PROD)).toBe('twwpnltizhtjxhamyoxt');
  });
});

describe('DEV proof script', () => {
  const full = { ...env(DEV), NEXT_PUBLIC_SUPABASE_ANON_KEY: 'a', PREMIUM_PROMO_EMAIL_BIND_SECRET: TEST_ENV.PREMIUM_PROMO_EMAIL_BIND_SECRET };
  const args = ['--confirm-dev', '--fixtures', 'f.json'];
  it('refuses without --confirm-dev, against production or any other project, without the fixtures file and with a missing or short secret', () => {
    expect(devProofRefusal(['--fixtures', 'f.json'], full)).toMatch(/--confirm-dev/);
    expect(devProofRefusal(args, full)).toBeNull();
    expect(devProofRefusal(args, { ...full, NEXT_PUBLIC_SUPABASE_URL: PROD }), 'never production').toMatch(/only against DEV/);
    expect(devProofRefusal(args, { ...full, NEXT_PUBLIC_SUPABASE_URL: 'https://abcdefghij.supabase.co' })).toMatch(/only against DEV/);
    expect(devProofRefusal(['--confirm-dev'], full)).toMatch(/--fixtures/);
    expect(devProofRefusal(args, { ...full, PROMO_CODE_DIGEST_SECRET: 'short' })).toMatch(/PROMO_CODE_DIGEST_SECRET/);
    expect(devProofRefusal(args, { ...full, PREMIUM_PROMO_EMAIL_BIND_SECRET: '' })).toMatch(/PREMIUM_PROMO_EMAIL_BIND_SECRET/);
    expect(devProofRefusal(args, { ...full, SUPABASE_SERVICE_ROLE_KEY: '' })).toMatch(/SUPABASE_SERVICE_ROLE_KEY/);
  });
});

describe('real send certification script (skeleton): refuses unless told, never production', () => {
  const sendEnv = { NEXT_PUBLIC_SUPABASE_URL: DEV, RESEND_API_KEY: 'k', PREMIUM_REMINDER_FROM_EMAIL: 'FHIP <no-reply@mail-example.com>' };
  const run = async (argv: string[], e: Record<string, string>) => {
    const m = await import('../../../scripts/promo_email_resend_dev_certification.mjs');
    return m.sendRefusal(m.parseArgs(argv), e);
  };
  it('prints the plan by default and sends nothing: only --send reaches the checks', async () => {
    expect(await run([], {})).toBeNull();
    expect(await run(['--to', 'a@mail-example.com'], {}), 'without --send nothing is sent').toBeNull();
  });
  it('NC-O3: --send without the owned-mailbox confirmation, with no recipient, too many, a bad address, a non-DEV project or no key is refused', async () => {
    const guarded = async (argv: string[], e: Record<string, string>, expected: RegExp) => expect(String(await run(argv, e)), 'a real send needs every safety flag').toMatch(expected);
    await guarded(['--send', '--to', 'a@mail-example.com'], sendEnv, /confirm-owned-mailboxes/);
    await guarded(['--send', '--confirm-owned-mailboxes'], sendEnv, /between 1 and 5/);
    await guarded(['--send', '--confirm-owned-mailboxes', ...Array.from({ length: 6 }, (_, i) => ['--to', `u${i}@mail-example.com`]).flat()], sendEnv, /between 1 and 5/);
    await guarded(['--send', '--confirm-owned-mailboxes', '--to', 'not an address'], sendEnv, /plain e-mail address/);
    await guarded(['--send', '--confirm-owned-mailboxes', '--to', 'a@mail-example.com'], { ...sendEnv, NEXT_PUBLIC_SUPABASE_URL: PROD }, /DEV environment/);
    await guarded(['--send', '--confirm-owned-mailboxes', '--to', 'a@mail-example.com'], { ...sendEnv, RESEND_API_KEY: '' }, /RESEND_API_KEY/);
    expect(await run(['--send', '--confirm-owned-mailboxes', '--to', 'a@mail-example.com'], sendEnv)).toBeNull();
    await expectNamedFailure(async () => expect(String(await run(['--send', '--confirm-owned-mailboxes', '--to', 'a@mail-example.com'], sendEnv)), 'a real send needs every safety flag').toMatch(/DEV environment/), 'a real send needs every safety flag');
  });
});
