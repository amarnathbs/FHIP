// Server-only. The Admin "setup check" for the promo and Premium feature (hardening, deploy safety).
//
// WHY THIS EXISTS. The feature refuses to run (fails closed) when a dedicated secret is missing, too short or reused. A
// refusal that only reaches a log is invisible to the person who can fix it. This reports, to a promo administrator, WHICH
// variables are wrong and WHICH actions are therefore switched off, in plain words. It reports names and states only: never a
// value, never a length, never a hash. It does not touch the database and it is NOT consulted by ordinary Premium use
// (billing, entitlements, plan status), so a missing secret can never break those.

import { FEATURE_SECRETS, PROMO_SECRET_ENV, PROMO_SECRET_MIN_LENGTH, promoDigestKeys, promoSecretStatus, type PromoFeature, type PromoSecretKey, type PromoSecretStatus } from '@/lib/services/promoSecrets';
import { isPromoEmailEnabled } from '@/lib/services/promoCodeEmail';
import { trustedProxyHops } from '@/lib/services/promoCodeIp';

type Env = Record<string, string | undefined>;

export const SECRET_PURPOSE: Record<PromoSecretKey, string> = {
  digest: 'Identifies a promo code without storing it (creating and redeeming codes).',
  bind: 'Ties a code to one e-mail address (address-bound codes, e-mailing codes, and every redemption).',
  ip: 'Limits repeated redemption attempts from one network address (every redemption).',
  cron: 'Authenticates the scheduled Premium reminder job.',
};

export const FEATURE_TEXT: Record<PromoFeature, string> = {
  create: 'Creating a promo code',
  email: 'E-mailing a promo code or binding it to an address',
  redeem: 'A user redeeming a promo code on the Profile page',
  cron: 'The scheduled Premium reminder job',
};

export interface PromoSecretLine {
  /** The environment variable NAME. */
  name: string;
  purpose: string;
  status: PromoSecretStatus;
}

export interface PromoFeatureLine {
  feature: PromoFeature;
  label: string;
  available: boolean;
  /** Variable names that block this feature. Empty when it is available. */
  blockedBy: string[];
}

export interface PromoSetupHealth {
  minimumSecretLength: number;
  secrets: PromoSecretLine[];
  features: PromoFeatureLine[];
  /** The e-mail switch (PREMIUM_PROMO_EMAIL_ENABLED). Reported, never changed here. */
  emailSwitchOn: boolean;
  /** False when the digest key set (secret, version, optional previous key) is not usable. */
  digestKeyUsable: boolean;
  /** The trusted proxy hop count in force, or null when the setting is invalid (then only the per-user limit applies). */
  trustedProxyHops: number | null;
  /** True when every feature is available. */
  allAvailable: boolean;
}

export function promoSetupHealth(env: Env = process.env): PromoSetupHealth {
  const keys = Object.keys(PROMO_SECRET_ENV) as PromoSecretKey[];
  const secrets: PromoSecretLine[] = keys.map((k) => ({ name: PROMO_SECRET_ENV[k], purpose: SECRET_PURPOSE[k], status: promoSecretStatus(k, env) }));
  const digestKeyUsable = promoDigestKeys(env) !== null;
  const features: PromoFeatureLine[] = (Object.keys(FEATURE_SECRETS) as PromoFeature[]).map((feature) => {
    const need = FEATURE_SECRETS[feature] as readonly PromoSecretKey[];
    const blockedBy: string[] = need.filter((k) => promoSecretStatus(k, env) !== 'ok').map((k) => PROMO_SECRET_ENV[k]);
    if (need.includes('digest') && blockedBy.length === 0 && !digestKeyUsable) blockedBy.push('PROMO_CODE_DIGEST_VERSION or PROMO_CODE_DIGEST_SECRET_PREVIOUS');
    return { feature, label: FEATURE_TEXT[feature], available: blockedBy.length === 0, blockedBy };
  });
  return {
    minimumSecretLength: PROMO_SECRET_MIN_LENGTH,
    secrets,
    features,
    emailSwitchOn: isPromoEmailEnabled(env),
    digestKeyUsable,
    trustedProxyHops: trustedProxyHops(env),
    allAvailable: features.every((f) => f.available),
  };
}
