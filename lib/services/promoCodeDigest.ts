// Server-only (node:crypto). Hash only promo codes (hardening 0264 item 1).
//
// A promo code is identified in the database by a KEYED DIGEST, never stored in plain text:
//   digest = HMAC-SHA256( key = PROMO_CODE_DIGEST_SECRET,  message = "promo-code:v<version>:" + normalised code )
// The version in the message domain-separates key versions, so a digest made under one key can never equal one made
// under another. The secret never reaches the database. What the database keeps for display is a MASKED HINT of the
// first two and last two characters (it is not a hash, and it reveals 4 of the 10 characters of a generated code,
// which is why it is no longer than that).
//
// The plain code exists only: (a) in the response of the request that created it, to the admin who created it,
// (b) in the e-mail to the recipient, (c) in the user's own browser while they type it. It is never logged, never
// returned by a list or history route, and never stored.

import { createHmac, randomInt } from 'node:crypto';
import { PROMO_ALPHABET, normalisePromoCode } from '@/lib/services/promoCodes';
import { promoDigestKeys, type DigestKey, type DigestKeys } from '@/lib/services/promoSecrets';

export const GENERATED_CODE_LENGTH = 10;

/** Pure, injectable random source for tests: returns an integer in [0, max). */
export type RandomIndex = (max: number) => number;

/** CSPRNG, unbiased: crypto.randomInt rejects values that would cause modulo bias. */
export function generatePromoCode(length: number = GENERATED_CODE_LENGTH, random: RandomIndex = (max) => randomInt(0, max)): string {
  let out = '';
  for (let i = 0; i < length; i += 1) out += PROMO_ALPHABET[random(PROMO_ALPHABET.length)];
  return out;
}

/** First two characters, a run of asterisks, last two characters. Same shape the database accepts (hint check). */
export function promoCodeHint(normalisedCode: string): string {
  const stars = Math.max(normalisedCode.length - 4, 2);
  return `${normalisedCode.slice(0, 2)}${'*'.repeat(stars)}${normalisedCode.slice(-2)}`;
}

export function computePromoDigest(code: string, key: DigestKey): string {
  return createHmac('sha256', key.secret).update(`promo-code:v${key.version}:${normalisePromoCode(code)}`).digest('hex');
}

/** The digest to STORE for a new code (current key only). */
export function digestForCreate(code: string, keys: DigestKeys): { digest: string; version: number } {
  return { digest: computePromoDigest(code, keys.current), version: keys.current.version };
}

/** The digests to LOOK UP an entered code with: current key, plus the previous one during a rotation window. */
export function digestCandidates(code: string, keys: DigestKeys): string[] {
  const out = [computePromoDigest(code, keys.current)];
  if (keys.previous) out.push(computePromoDigest(code, keys.previous));
  return out;
}

export function loadDigestKeys(env: Record<string, string | undefined> = process.env): DigestKeys | null {
  return promoDigestKeys(env);
}
