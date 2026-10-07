// Dedicated, mandatory secrets for the promo / Premium feature (hardening 0264 item 4).
//
// NO FALLBACKS BETWEEN THEM. Earlier code read PREMIUM_PROMO_EMAIL_BIND_SECRET, falling back to PROMO_IP_HASH_SECRET,
// falling back to CRON_SECRET (and the IP hash used the last two). One leaked value then opened several doors, and
// a missing value silently weakened a control. Now each secret has ONE purpose, is read from ONE variable, and a
// feature that needs a secret that is missing, too short or reused REFUSES (an explicit 503 / disabled), never
// degrades silently.
//
//   PROMO_CODE_DIGEST_SECRET            keyed digest that identifies a promo code (hash only storage)
//   PREMIUM_PROMO_EMAIL_BIND_SECRET     keyed hash of an e-mail address (address binding + send ledger)
//   PROMO_IP_HASH_SECRET                keyed hash of the client network address (redemption rate limit)
//   CRON_SECRET                         shared secret of the scheduled routes (x-cron-secret header)
//
// Optional rotation variables for the digest key (see docs/admin/PROMO_CODE_DIGEST_KEY_ROTATION_RUNBOOK.md):
//   PROMO_CODE_DIGEST_VERSION           integer >= 1, default 1: the version stamped on newly created codes
//   PROMO_CODE_DIGEST_SECRET_PREVIOUS   the previous key, accepted for lookup only during the rotation window;
//                                       its version is CURRENT - 1
//
// This module reads names and lengths only. It never returns, logs or formats a secret value.

export const PROMO_SECRET_ENV = {
  digest: 'PROMO_CODE_DIGEST_SECRET',
  bind: 'PREMIUM_PROMO_EMAIL_BIND_SECRET',
  ip: 'PROMO_IP_HASH_SECRET',
  cron: 'CRON_SECRET',
} as const;
export type PromoSecretKey = keyof typeof PROMO_SECRET_ENV;

/** Minimum length of a dedicated secret (hex of 16 random bytes is 32). */
export const PROMO_SECRET_MIN_LENGTH = 32;

/** Which secrets each feature needs. A feature missing any of its secrets refuses. */
export const FEATURE_SECRETS = {
  /** Creating a code (no e-mail, no binding). */
  create: ['digest'],
  /** Creating a code that is bound to an address, or e-mailing a code. */
  email: ['digest', 'bind'],
  /** A user redeeming a code. */
  redeem: ['digest', 'ip', 'bind'],
  /** The scheduled routes. */
  cron: ['cron'],
} as const satisfies Record<string, readonly PromoSecretKey[]>;
export type PromoFeature = keyof typeof FEATURE_SECRETS;

type Env = Record<string, string | undefined>;

/** The secret value, or null when absent, blank or shorter than the minimum. */
export function readPromoSecret(key: PromoSecretKey, env: Env = process.env): string | null {
  const v = (env[PROMO_SECRET_ENV[key]] ?? '').trim();
  return v.length >= PROMO_SECRET_MIN_LENGTH ? v : null;
}

export interface SecretProblems {
  /** Variable NAMES that are missing, blank or too short. */
  missing: string[];
  /** Variable names that hold the same value as another dedicated secret. */
  reused: string[];
}

/** Checks the secrets a feature needs. Names only, never values. */
export function promoSecretProblems(feature: PromoFeature, env: Env = process.env): SecretProblems {
  const need = FEATURE_SECRETS[feature] as readonly PromoSecretKey[];
  const missing: string[] = [];
  for (const key of need) if (readPromoSecret(key, env) === null) missing.push(PROMO_SECRET_ENV[key]);
  // Reuse check across ALL four dedicated secrets that are set: one value in two places defeats the separation.
  const seen = new Map<string, PromoSecretKey>();
  const reused = new Set<string>();
  for (const key of Object.keys(PROMO_SECRET_ENV) as PromoSecretKey[]) {
    const v = (env[PROMO_SECRET_ENV[key]] ?? '').trim();
    if (!v) continue;
    const other = seen.get(v);
    if (other) {
      reused.add(PROMO_SECRET_ENV[key]);
      reused.add(PROMO_SECRET_ENV[other]);
    } else seen.set(v, key);
  }
  // Only a reuse that involves a secret THIS feature needs matters to it.
  const mine = new Set<string>(need.map((k) => PROMO_SECRET_ENV[k]));
  return { missing, reused: [...reused].filter((n) => mine.has(n)).sort() };
}

export type PromoSecretStatus = 'ok' | 'missing' | 'too_short' | 'reused';

/**
 * One secret's state for the Admin setup card. Names and states only, never a value or a length. 'missing' = not set
 * (or blank), 'too_short' = set but under the minimum, 'reused' = the same value is also used for another dedicated secret.
 */
export function promoSecretStatus(key: PromoSecretKey, env: Env = process.env): PromoSecretStatus {
  const own = (env[PROMO_SECRET_ENV[key]] ?? '').trim();
  if (!own) return 'missing';
  if (own.length < PROMO_SECRET_MIN_LENGTH) return 'too_short';
  for (const other of Object.keys(PROMO_SECRET_ENV) as PromoSecretKey[]) {
    if (other !== key && (env[PROMO_SECRET_ENV[other]] ?? '').trim() === own) return 'reused';
  }
  return 'ok';
}

export function promoFeatureAvailable(feature: PromoFeature, env: Env = process.env): boolean {
  const p = promoSecretProblems(feature, env);
  return p.missing.length === 0 && p.reused.length === 0;
}

/** Administrator-facing refusal (names the variables, never a value). */
export function promoSecretsAdminError(feature: PromoFeature, env: Env = process.env): { status: 503; code: string; message: string } | null {
  const p = promoSecretProblems(feature, env);
  if (p.missing.length === 0 && p.reused.length === 0) return null;
  const parts: string[] = [];
  if (p.missing.length) parts.push(`missing or too short (at least ${PROMO_SECRET_MIN_LENGTH} characters): ${p.missing.join(', ')}`);
  if (p.reused.length) parts.push(`the same value is used for more than one purpose: ${p.reused.join(', ')}`);
  return {
    status: 503,
    code: 'PROMO_SECRETS_NOT_CONFIGURED',
    message: `This feature is switched off because the server secrets are not set up correctly (${parts.join(' / ')}). Nothing was changed.`,
  };
}

export interface DigestKey {
  version: number;
  secret: string;
}
export interface DigestKeys {
  current: DigestKey;
  previous: DigestKey | null;
}

/** The digest key set, or null when the dedicated digest secret is not usable. */
export function promoDigestKeys(env: Env = process.env): DigestKeys | null {
  const secret = readPromoSecret('digest', env);
  if (!secret) return null;
  const rawVersion = (env.PROMO_CODE_DIGEST_VERSION ?? '1').trim();
  const version = Number(rawVersion);
  if (!Number.isInteger(version) || version < 1 || version > 1000) return null;
  const current: DigestKey = { version, secret };
  const prevSecret = (env.PROMO_CODE_DIGEST_SECRET_PREVIOUS ?? '').trim();
  let previous: DigestKey | null = null;
  if (prevSecret) {
    // A previous key is accepted only when it is long enough, different from the current one, and has a version to stamp.
    if (prevSecret.length < PROMO_SECRET_MIN_LENGTH || prevSecret === secret || version < 2) return null;
    previous = { version: version - 1, secret: prevSecret };
  }
  return { current, previous };
}
