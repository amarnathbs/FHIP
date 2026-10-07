// Items 1, 4 and 6: dedicated mandatory secrets with NO fallbacks, the keyed code digest, and the trusted client address.
//
// NAMED NEGATIVE CONTROLS
//   NC-S1  a secret reader that falls back to another secret (the OLD behaviour) hides a missing secret: "a missing bind secret is not rescued by another secret";
//   NC-S2  a digest without the key version in its message collides across versions: "digests of different key versions never collide";
//   NC-S3  a digest that is not keyed (plain SHA-256) is guessable: "the digest depends on the secret";
//   NC-I1  the OLD first-hop address reader lets a forged X-Forwarded-For choose the bucket: "a forged left hand entry cannot change the address".

import { describe, it, expect } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import {
  FEATURE_SECRETS,
  PROMO_SECRET_ENV,
  PROMO_SECRET_MIN_LENGTH,
  promoDigestKeys,
  promoFeatureAvailable,
  promoSecretProblems,
  promoSecretsAdminError,
  readPromoSecret,
} from '@/lib/services/promoSecrets';
import { promoEmailSecret, keyedAddressHash } from '@/lib/services/promoCodeEmail';
import { computePromoDigest, digestCandidates, digestForCreate, generatePromoCode, promoCodeHint } from '@/lib/services/promoCodeDigest';
import { clientIpFromHeaders, hashClientIp, isNonPublicAddress, trustedProxyHops } from '@/lib/services/promoCodeIp';
import { PROMO_ALPHABET } from '@/lib/services/promoCodes';
import { TEST_ENV, expectNamedFailure, testKeys } from '../support/promoTestHelpers';

const without = (name: string): Record<string, string> => {
  const e = { ...TEST_ENV };
  delete e[name];
  return e;
};
const headers = (h: Record<string, string>) => ({ get: (k: string) => h[k.toLowerCase()] ?? null });

describe('dedicated secrets, no fallbacks (item 4)', () => {
  it('with all four set and different, every feature is available', () => {
    for (const f of Object.keys(FEATURE_SECRETS) as (keyof typeof FEATURE_SECRETS)[]) expect(promoFeatureAvailable(f, TEST_ENV), f).toBe(true);
  });

  it('each feature refuses when ANY of its secrets is missing, and names only the variable (never a value)', () => {
    for (const [feature, keys] of Object.entries(FEATURE_SECRETS)) {
      for (const key of keys) {
        const name = PROMO_SECRET_ENV[key as keyof typeof PROMO_SECRET_ENV];
        const env = without(name);
        expect(promoFeatureAvailable(feature as keyof typeof FEATURE_SECRETS, env), `${feature} without ${name}`).toBe(false);
        const err = promoSecretsAdminError(feature as keyof typeof FEATURE_SECRETS, env);
        expect(err?.status).toBe(503);
        expect(err?.message).toContain(name);
        for (const v of Object.values(TEST_ENV)) expect(err?.message).not.toContain(v);
      }
    }
  });

  it('a secret shorter than the minimum is treated as missing; blank and whitespace too', () => {
    expect(readPromoSecret('digest', { ...TEST_ENV, PROMO_CODE_DIGEST_SECRET: 'x'.repeat(PROMO_SECRET_MIN_LENGTH - 1) })).toBeNull();
    expect(readPromoSecret('digest', { ...TEST_ENV, PROMO_CODE_DIGEST_SECRET: '   ' })).toBeNull();
    expect(readPromoSecret('digest', { ...TEST_ENV, PROMO_CODE_DIGEST_SECRET: 'x'.repeat(PROMO_SECRET_MIN_LENGTH) })).not.toBeNull();
  });

  it('NO FALLBACK: the address key does not come from the IP secret or the cron secret, and the IP key does not come from the cron secret', () => {
    const noBind = without('PREMIUM_PROMO_EMAIL_BIND_SECRET');
    expect(promoEmailSecret(noBind), 'a missing bind secret is not rescued by another secret').toBeNull();
    expect(keyedAddressHash('bind', 'a@b.com', noBind)).toBeNull();
    const noIp = without('PROMO_IP_HASH_SECRET');
    expect(hashClientIp(headers({ 'x-forwarded-for': '9.9.9.9, 198.51.100.7' }), noIp), 'a missing IP secret is not rescued by CRON_SECRET').toBeNull();
    expect(promoDigestKeys(without('PROMO_CODE_DIGEST_SECRET'))).toBeNull();
  });

  it('NC-S1: the old fallback chain would have hidden a missing secret', async () => {
    const assertNoRescue = (read: (env: Record<string, string>) => string | null) =>
      expect(read(without('PREMIUM_PROMO_EMAIL_BIND_SECRET')), 'a missing bind secret is not rescued by another secret').toBeNull();
    assertNoRescue((e) => promoEmailSecret(e));
    const oldBehaviour = (e: Record<string, string>) => e.PREMIUM_PROMO_EMAIL_BIND_SECRET || e.PROMO_IP_HASH_SECRET || e.CRON_SECRET || null;
    await expectNamedFailure(() => assertNoRescue(oldBehaviour), 'a missing bind secret is not rescued by another secret');
  });

  it('REUSE: the same value in two dedicated secrets makes the features that need either of them refuse', () => {
    const env = { ...TEST_ENV, PROMO_IP_HASH_SECRET: TEST_ENV.CRON_SECRET };
    expect(promoSecretProblems('redeem', env).reused).toEqual(['PROMO_IP_HASH_SECRET']);
    expect(promoSecretProblems('cron', env).reused).toEqual(['CRON_SECRET']);
    expect(promoFeatureAvailable('redeem', env)).toBe(false);
    expect(promoFeatureAvailable('cron', env)).toBe(false);
    // a feature that needs neither is unaffected
    expect(promoFeatureAvailable('create', env)).toBe(true);
  });

  it('digest key set: version default 1, a previous key only with a higher current version, never equal to the current key', () => {
    expect(promoDigestKeys(TEST_ENV)?.current.version).toBe(1);
    expect(promoDigestKeys(TEST_ENV)?.previous).toBeNull();
    const prev = 'previous-key-eeeeeeeeeeeeeeeeeeeeeeeeeeeee-0005';
    const rotated = promoDigestKeys({ ...TEST_ENV, PROMO_CODE_DIGEST_VERSION: '2', PROMO_CODE_DIGEST_SECRET_PREVIOUS: prev });
    expect(rotated?.current.version).toBe(2);
    expect(rotated?.previous).toEqual({ version: 1, secret: prev });
    expect(promoDigestKeys({ ...TEST_ENV, PROMO_CODE_DIGEST_SECRET_PREVIOUS: prev }), 'a previous key at version 1 has no version to carry').toBeNull();
    expect(promoDigestKeys({ ...TEST_ENV, PROMO_CODE_DIGEST_VERSION: '2', PROMO_CODE_DIGEST_SECRET_PREVIOUS: TEST_ENV.PROMO_CODE_DIGEST_SECRET })).toBeNull();
    expect(promoDigestKeys({ ...TEST_ENV, PROMO_CODE_DIGEST_VERSION: '0' })).toBeNull();
    expect(promoDigestKeys({ ...TEST_ENV, PROMO_CODE_DIGEST_VERSION: 'abc' })).toBeNull();
  });
});

describe('keyed code digest and masked hint (item 1)', () => {
  const keys = testKeys();

  it('generated codes use only the unambiguous alphabet, 10 characters, and the injected random index is honoured', () => {
    const code = generatePromoCode();
    expect(code).toHaveLength(10);
    for (const ch of code) expect(PROMO_ALPHABET).toContain(ch);
    let i = 0;
    expect(generatePromoCode(5, () => i++ % PROMO_ALPHABET.length)).toBe('ABCDE');
    expect(new Set(Array.from({ length: 200 }, () => generatePromoCode())).size, 'two hundred generated codes are all different').toBe(200);
  });

  it('the hint shows the first two and last two characters only, with a run of asterisks between', () => {
    expect(promoCodeHint('ABCDEFGHJK')).toBe('AB******JK');
    expect(promoCodeHint('ABCDEF')).toBe('AB**EF');
    expect(promoCodeHint('ABCDEFGH').length).toBe(8);
    expect(promoCodeHint('ABCDEFGHJK')).not.toContain('CDEF');
  });

  it('the digest is deterministic, ignores case, spaces and hyphens (normalised first), and is 64 hex characters', () => {
    const a = computePromoDigest('ABCDE-FGHJK', keys.current);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(computePromoDigest('abcde fghjk', keys.current)).toBe(a);
    expect(computePromoDigest('ABCDEFGHJL', keys.current)).not.toBe(a);
  });

  it('the digest equals HMAC-SHA256 with the domain prefix and the version (so an auditor can reproduce it)', () => {
    const expected = createHmac('sha256', keys.current.secret).update('promo-code:v1:ABCDEFGHJK').digest('hex');
    expect(computePromoDigest('ABCDEFGHJK', keys.current)).toBe(expected);
  });

  it('NC-S3: an unkeyed SHA-256 of the code would not depend on the secret', async () => {
    const dependsOnSecret = (digest: (code: string, secret: string) => string) =>
      expect(digest('ABCDEFGHJK', 'one-secret-one-secret-one-secret-1') !== digest('ABCDEFGHJK', 'two-secret-two-secret-two-secret-2'), 'the digest depends on the secret').toBe(true);
    dependsOnSecret((c, s) => computePromoDigest(c, { version: 1, secret: s }));
    await expectNamedFailure(() => dependsOnSecret((c) => createHash('sha256').update(c).digest('hex')), 'the digest depends on the secret');
  });

  it('NC-S2: key versions are domain separated, so a version 1 digest never equals a version 2 digest of the same secret', async () => {
    const separated = (digest: (code: string, version: number) => string) =>
      expect(digest('ABCDEFGHJK', 1) !== digest('ABCDEFGHJK', 2), 'digests of different key versions never collide').toBe(true);
    separated((c, v) => computePromoDigest(c, { version: v, secret: keys.current.secret }));
    await expectNamedFailure(() => separated((c) => createHmac('sha256', keys.current.secret).update(`promo-code:${c}`).digest('hex')), 'digests of different key versions never collide');
  });

  it('digest candidates: current key only normally, current plus previous during a rotation window (dual verify)', () => {
    expect(digestCandidates('ABCDEFGHJK', keys)).toHaveLength(1);
    const prev = 'previous-key-eeeeeeeeeeeeeeeeeeeeeeeeeeeee-0005';
    const rotated = promoDigestKeys({ ...TEST_ENV, PROMO_CODE_DIGEST_VERSION: '2', PROMO_CODE_DIGEST_SECRET_PREVIOUS: prev })!;
    const c = digestCandidates('ABCDEFGHJK', rotated);
    expect(c).toHaveLength(2);
    // a code created under the OLD key (version 1) is found by the second candidate
    const oldDigest = computePromoDigest('ABCDEFGHJK', { version: 1, secret: prev });
    expect(c).toContain(oldDigest);
    expect(digestForCreate('ABCDEFGHJK', rotated).version, 'new codes use the current version').toBe(2);
  });
});

describe('trusted client address from X-Forwarded-For (item 6)', () => {
  const REAL = '203.0.113.7';

  it('CloudFront appends the connecting address: the RIGHTMOST entry (1 hop) is the client, whatever the client wrote on the left', () => {
    expect(clientIpFromHeaders(headers({ 'x-forwarded-for': REAL }), TEST_ENV)).toBe(REAL);
    expect(clientIpFromHeaders(headers({ 'x-forwarded-for': `9.9.9.9, ${REAL}` }), TEST_ENV)).toBe(REAL);
    expect(clientIpFromHeaders(headers({ 'x-forwarded-for': `1.1.1.1, 8.8.8.8, ${REAL}` }), TEST_ENV)).toBe(REAL);
  });

  it('with two trusted hops the client is the second from the right', () => {
    const env = { ...TEST_ENV, PROMO_TRUSTED_PROXY_HOPS: '2' };
    expect(clientIpFromHeaders(headers({ 'x-forwarded-for': `9.9.9.9, ${REAL}, 198.51.100.9` }), env)).toBe(REAL);
    expect(clientIpFromHeaders(headers({ 'x-forwarded-for': REAL }), env), 'fewer entries than the trusted hop count: no trustworthy address').toBeNull();
  });

  it('a forged left hand entry cannot change the hashed address (the per-network bucket cannot be chosen by the client)', () => {
    const h1 = hashClientIp(headers({ 'x-forwarded-for': `1.2.3.4, ${REAL}` }), TEST_ENV);
    const h2 = hashClientIp(headers({ 'x-forwarded-for': `5.6.7.8, ${REAL}` }), TEST_ENV);
    const h3 = hashClientIp(headers({ 'x-forwarded-for': REAL }), TEST_ENV);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(h1).toBe(h2);
    expect(h1).toBe(h3);
    expect(hashClientIp(headers({ 'x-forwarded-for': '1.2.3.4, 198.51.100.10' }), TEST_ENV)).not.toBe(h1);
  });

  it('NC-I1: the OLD first-hop reader lets a forged header choose the bucket', async () => {
    const forgedCannotChange = (read: (h: Record<string, string>) => string | null) =>
      expect(read({ 'x-forwarded-for': `1.2.3.4, ${REAL}` }) === read({ 'x-forwarded-for': `5.6.7.8, ${REAL}` }), 'a forged left hand entry cannot change the address').toBe(true);
    forgedCannotChange((h) => clientIpFromHeaders(headers(h), TEST_ENV));
    const oldFirstHop = (h: Record<string, string>) => h['x-forwarded-for']?.split(',')[0]?.trim() || null;
    await expectNamedFailure(() => forgedCannotChange(oldFirstHop), 'a forged left hand entry cannot change the address');
  });

  it('downgrades to "no address" (per-user limit only) instead of guessing: no header, malformed, private, loopback, link-local, wrong hop count', () => {
    for (const v of [undefined, '', 'not-an-ip', '10.0.0.5', '127.0.0.1', '192.168.1.1', '172.16.0.9', '169.254.1.1', '100.64.0.1', '::1', 'fd00::1', '0.0.0.0', '224.0.0.1']) {
      expect(clientIpFromHeaders(headers(v === undefined ? {} : { 'x-forwarded-for': v }), TEST_ENV), String(v)).toBeNull();
    }
    expect(hashClientIp(headers({}), TEST_ENV)).toBeNull();
  });

  it('a wrong (too high) hop count that lands on an internal address yields no address, never one shared bucket for everybody', () => {
    const env = { ...TEST_ENV, PROMO_TRUSTED_PROXY_HOPS: '1' };
    expect(clientIpFromHeaders(headers({ 'x-forwarded-for': `${REAL}, 10.1.2.3` }), env)).toBeNull();
  });

  it('x-real-ip and other headers a client can set are never used', () => {
    expect(clientIpFromHeaders(headers({ 'x-real-ip': REAL }), TEST_ENV)).toBeNull();
    expect(clientIpFromHeaders(headers({ 'x-forwarded-for': `${REAL}`, 'x-real-ip': '1.1.1.1', 'cf-connecting-ip': '2.2.2.2' }), TEST_ENV)).toBe(REAL);
  });

  it('ports and IPv6 are handled; an invalid hop setting means no trusted address', () => {
    expect(clientIpFromHeaders(headers({ 'x-forwarded-for': `${REAL}:51234` }), TEST_ENV)).toBe(REAL);
    expect(clientIpFromHeaders(headers({ 'x-forwarded-for': '[2001:db8::1]:443' }), TEST_ENV)).toBe('2001:db8::1');
    expect(trustedProxyHops({ PROMO_TRUSTED_PROXY_HOPS: '0' })).toBeNull();
    expect(trustedProxyHops({ PROMO_TRUSTED_PROXY_HOPS: 'x' })).toBeNull();
    expect(trustedProxyHops({})).toBe(1);
    expect(clientIpFromHeaders(headers({ 'x-forwarded-for': REAL }), { ...TEST_ENV, PROMO_TRUSTED_PROXY_HOPS: '9' })).toBeNull();
    expect(isNonPublicAddress('203.0.113.7')).toBe(false);
  });
});
