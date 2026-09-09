// LR-10 WP-12 (activation control) — a single, narrow place that decides
// whether Stripe is actually usable right now, and enforces that a DEV/test
// key can never reach production and a live key can never reach a non-
// production environment. Every payment route imports this rather than
// constructing its own `new Stripe(...)` — one place to get the safety
// check right, matching this codebase's own established single-hard-gate
// pattern used by other feature-activation checks elsewhere in the app.
import Stripe from 'stripe';

export type StripeUnavailableReason = 'NOT_CONFIGURED' | 'KEY_ENVIRONMENT_MISMATCH';

let cached: Stripe | null = null;
let cachedKey: string | null = null;

/** True in whatever this codebase already treats as "this is a real production deploy" — mirrors APP_BASE_URL's own convention rather than inventing a second one. */
function isProductionEnvironment(): boolean {
  return process.env.NODE_ENV === 'production';
}

/**
 * A Stripe secret key's own prefix distinguishes test-mode from live-mode —
 * this is not a heuristic FHIP invented, it is how Stripe itself formats
 * every key it issues (sk_test_.../sk_live_...), documented in Stripe's own
 * API reference. Restricted keys (rk_test_/rk_live_) follow the identical
 * convention.
 */
function isLiveStripeKey(key: string): boolean {
  return key.startsWith('sk_live_') || key.startsWith('rk_live_');
}

export function getStripeUnavailableReason(): StripeUnavailableReason | null {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return 'NOT_CONFIGURED';
  const live = isLiveStripeKey(key);
  // WP-12: "DEV/test provider modes must never leak into production and vice versa."
  if (live !== isProductionEnvironment()) return 'KEY_ENVIRONMENT_MISMATCH';
  return null;
}

/** Returns null (never throws) when Stripe is not safely usable right now — callers must check getStripeUnavailableReason() first for a specific, honest reason to surface. */
export function getStripeClient(): Stripe | null {
  if (getStripeUnavailableReason() !== null) return null;
  const key = process.env.STRIPE_SECRET_KEY!;
  if (cached && cachedKey === key) return cached;
  cached = new Stripe(key, { apiVersion: '2026-08-26.dahlia' });
  cachedKey = key;
  return cached;
}
